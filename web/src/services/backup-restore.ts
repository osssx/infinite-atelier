import { saveAs } from "file-saver";
import localforage from "localforage";
import { createZip, readZip } from "@/lib/zip";
import { getImageBlob, setImageBlob, deleteStoredImages } from "@/services/image-storage";
import { getMediaBlob, setMediaBlob, deleteStoredMedia } from "@/services/file-storage";
import { flushOpenCanvasForBackup } from "@/services/canvas-backup-sync";
import { validateBackup, type AppBackupFile, type BackupItem } from "@/services/backup-validation";
import { awaitCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { awaitAssetStorePersistence, useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore } from "@/stores/use-config-store";
import {redactedExportConfig} from "@/features/backend-sync/ui-settings-client";
import { exportSkill, listSkills, restoreSkillSnapshot, snapshotSkills, type SkillBackupSnapshot } from "@/features/skills/skill-registry";
import { importSkillFile } from "@/features/skills/skill-import";
import { exportComfyBackupTemplates, verifyComfyBackupTemplates, unbindImportedComfyProjects } from "@/features/comfy-workflow/backup-workflows";
import { installComfyBackupVersions } from "@/features/comfy-workflow/template-registry";

const imageStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const mediaStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
let busy = false;

async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (busy) throw new Error("A backup or restore is already in progress");
    busy = true;
    try { return await operation(); }
    finally { busy = false; }
}

async function ensureReady() {
    if (!useCanvasStore.getState().hydrated || !useAssetStore.getState().hydrated ||
        !useConfigStore.persist.hasHydrated()) {
        throw new Error("Data is still loading; retry once all projects and assets are ready");
    }
}

async function synchronizeCanvas() {
    flushOpenCanvasForBackup();
    await Promise.all([awaitCanvasStorePersistence(), awaitAssetStorePersistence()]);
}

/** Retain ZIP backup.json version 1 (logical projects + original media, no IDB revision keys). */
export async function exportAppBackup() {
    return exclusive(async () => {
        await ensureReady();
        await synchronizeCanvas();
        const { projects } = useCanvasStore.getState();
        if(JSON.stringify(projects).includes("cas:") || JSON.stringify(projects).includes("/api/v1/blobs/"))
            throw Error("旧版浏览器 ZIP 不包含 Canvas SQLite/CAS 文件：请使用 npm run backup:data 的完整冷备份");
        const { assets } = useAssetStore.getState();
        if(assets.some(a=>a.kind!=="text"&&a.data.storageKey?.startsWith("cas:")))
            throw Error("旧版浏览器 ZIP 不能完整备份 SQLite 素材库：请使用 npm run backup:data 的完整冷备份");
        const { config } = useConfigStore.getState();
        const files: BackupItem[] = [];
        const zipFiles: { name: string; data: BlobPart }[] = [];
        await collectStoreFiles(imageStore, files, zipFiles);
        await collectStoreFiles(mediaStore, files, zipFiles);
        // The legacy browser ZIP cannot faithfully restore a v13 SQLite registry.
        // Never label this archive a full backup while Skills would be omitted.
        if ((await listSkills()).length)
            throw Error("SQLite Skills 已纳入 backup:data 冷备份；旧版浏览器 ZIP 不能备份 Skill 注册表");
        const skillSnapshot = await snapshotSkills();
        const skillRecords: NonNullable<AppBackupFile["skills"]>["packages"] = [];
        for (const pkg of skillSnapshot.packages) {
            const { id, version } = pkg.manifest;
            const path = "skills/" + id + "/" + version + ".zip";
            zipFiles.push({ name: path, data: await exportSkill(id, version) });
            skillRecords.push({ id, version, path });
        }
        const comfy = await exportComfyBackupTemplates(projects);
        for (const [name, blob] of comfy.files) zipFiles.push({ name, data: blob });
        const data: AppBackupFile = {
            app: "infinite-canvas", version: comfy.records.length ? 2 : 1, exportedAt: new Date().toISOString(),
            projects, assets, config:redactedExportConfig(config), files,
            skills: { catalog: skillSnapshot.catalog, packages: skillRecords },
            ...(comfy.records.length ? { comfyWorkflows: comfy.records } : {}),
        };
        // Never export a ZIP with dangling local media references.
        validateBackup(data, new Map(zipFiles.map(({ name, data }) => [name, new Blob([data])])));
        zipFiles.push({ name: "backup.json", data: new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }) });
        const zip = await createZip(zipFiles);
        saveAs(zip, `infinite-canvas-backup-${new Date().toISOString().slice(0, 10)}.zip`);
    });
}

/**
 * Validate the full archive before touching state; retain overwritten Blobs and old
 * Zustand data until all writes complete. Attempt rollback if a write fails.
 */
export async function importAppBackup(file: File) {
    return exclusive(async () => {
        await ensureReady();
        if(useAssetStore.getState().assets.length||useCanvasStore.getState().projects.length)
            throw Error("旧版浏览器 ZIP 不能覆盖已有的 SQLite 项目或素材；请使用新目录完整冷备份恢复");
        const zip = await readZip(file, { maxFiles: 10000, maxUncompressedBytes: 2 * 1024 ** 3, maxEntryBytes: 512 * 1024 ** 2, maxArchiveBytes: 2 * 1024 ** 3 });
        const manifest = zip.get("backup.json");
        if (!manifest) throw new Error("Invalid application backup: missing backup.json");
        let parsed: unknown;
        try { parsed = JSON.parse(await manifest.text()); }
        catch { throw new Error("Invalid application backup: invalid JSON manifest"); }
        const data = validateBackup(parsed, zip);
        if(data.assets.some(a=>a.kind!=="text"&&a.data.storageKey?.startsWith("cas:")))
            throw Error("不能通过旧版浏览器 ZIP 覆盖 SQLite CAS 素材，请使用完整冷备份恢复");
        if (data.skills?.catalog.length || data.skills?.packages.length)
            throw Error("旧浏览器 ZIP 包含 Skills；禁止覆盖 SQLite 注册表，请使用已有管理器单独导入 Skill 文件");
        // Validate actual content hashes and every Comfy graph/port binding BEFORE any project or Blob mutation.
        const comfyToRestore = data.version === 2 ? await verifyComfyBackupTemplates(data.comfyWorkflows || [], zip) : [];
        // Validate every nested SKILL ZIP and its claimed version before mutating browser data.
        let skillsToRestore: SkillBackupSnapshot | undefined;
        if (data.skills?.packages.length) {
            const packages = [];
            for (const entry of data.skills.packages) {
                const blob = zip.get(entry.path)!;
                const pkg = await importSkillFile(Object.assign(blob, { name: entry.id + ".zip" }));
                if (pkg.manifest.id !== entry.id || pkg.manifest.version !== entry.version) {
                    throw new Error("Invalid application backup: Skill content hash mismatch");
                }
                packages.push(pkg);
            }
            for (const entry of data.skills.catalog) {
                const active = packages.find((pkg) => pkg.manifest.id === entry.id && pkg.manifest.version === entry.activeVersion);
                if (!active || active.manifest.name !== entry.name || active.manifest.description !== entry.description) {
                    throw new Error("Invalid application backup: Skill catalog metadata mismatch");
                }
            }
            skillsToRestore = { catalog: data.skills.catalog, packages };
        }
        await synchronizeCanvas();
        const old = {
            projects: useCanvasStore.getState().projects,
            assets: useAssetStore.getState().assets,
            config: useConfigStore.getState().config,
            skills: await snapshotSkills(),
        };
        // Save only keys that will be overwritten. These are Blob references, not decoded media.
        const originals = new Map<string, Blob | null>();
        for (const item of data.files) {
            const prev = item.storageKey.startsWith("image:")
                ? await getImageBlob(item.storageKey) : await getMediaBlob(item.storageKey);
            originals.set(item.storageKey, prev);
        }
        const written: string[] = [];
        let changedProjects = false;
        let changedAssets = false;
        let changedSkills = false;
        let rollbackComfyTemplates: (() => Promise<void>) | undefined;
        try {
            // Install immutable versions exactly once, before any browser media/project mutations.
            // If later writes fail, remove only versions introduced by this import.
            rollbackComfyTemplates = await installComfyBackupVersions(comfyToRestore);
            for (const item of data.files) {
                const blob = zip.get(item.path)!; // Every entry was checked by validateBackup.
                const restored = blob.slice(0, blob.size, item.mimeType || "application/octet-stream");
                written.push(item.storageKey);
                if (item.storageKey.startsWith("image:")) await setImageBlob(item.storageKey, restored);
                else await setMediaBlob(item.storageKey, restored);
            }
            changedProjects = true;
            useCanvasStore.getState().replaceProjects(data.version === 2 ? unbindImportedComfyProjects(data.projects, comfyToRestore) : data.projects);
            await awaitCanvasStorePersistence();
            changedAssets = true;
            useAssetStore.getState().replaceAssets(data.assets);
            await awaitAssetStorePersistence();
            useConfigStore.setState({ config: data.config });
            if (skillsToRestore) {
                changedSkills = true;
                await restoreSkillSnapshot(skillsToRestore);
            }
        } catch (error) {
            const rollbackErrors: unknown[] = [];
            if (rollbackComfyTemplates) {
                try { await rollbackComfyTemplates(); }
                catch (cause) { rollbackErrors.push(cause); }
            }
            if (changedProjects) {
                try {
                    useCanvasStore.getState().replaceProjects(old.projects);
                    await awaitCanvasStorePersistence();
                } catch (cause) { rollbackErrors.push(cause); }
            }
            if (changedAssets) {
                try {
                    useAssetStore.getState().replaceAssets(old.assets);
                    await awaitAssetStorePersistence();
                } catch (cause) { rollbackErrors.push(cause); }
            }
            useConfigStore.setState({ config: old.config });
            if (changedSkills) {
                try { await restoreSkillSnapshot(old.skills); }
                catch (cause) { rollbackErrors.push(cause); }
            }
            for (const key of [...new Set(written)].reverse()) {
                try {
                    const prior = originals.get(key);
                    if (prior) {
                        if (key.startsWith("image:")) await setImageBlob(key, prior);
                        else await setMediaBlob(key, prior);
                    } else if (key.startsWith("image:")) await deleteStoredImages([key]);
                    else await deleteStoredMedia([key]);
                } catch (cause) { rollbackErrors.push(cause); }
            }
            if (rollbackErrors.length) {
                throw new AggregateError([error, ...rollbackErrors],
                    "Restore failed and rollback was incomplete; preserve the current browser data");
            }
            throw error;
        }
    });
}

async function collectStoreFiles(store: LocalForage, files: BackupItem[], zipFiles: { name: string; data: BlobPart }[]) {
    await store.iterate((value, key) => {
        if (!(value instanceof Blob)) return;
        const path = `files/${files.length}-${safeFileName(key)}.${fileExtension(value.type)}`;
        files.push({ storageKey: key, path, mimeType: value.type || "application/octet-stream" });
        zipFiles.push({ name: path, data: value });
    });
}

function safeFileName(value: string) { return value.replace(/[\\/:*?"<>|]/g, "_"); }
function fileExtension(type: string) {
    if (type.includes("png")) return "png";
    if (type.includes("jpeg")) return "jpg";
    if (type.includes("webp")) return "webp";
    if (type.includes("gif")) return "gif";
    if (type.includes("mp4")) return "mp4";
    if (type.includes("webm")) return "webm";
    if (type.includes("mp3")) return "mp3";
    if (type.includes("wav")) return "wav";
    return "bin";
}