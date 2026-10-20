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
import { exportSkill, restoreSkillSnapshot, snapshotSkills, type SkillBackupSnapshot } from "@/features/skills/skill-registry";
import { importSkillFile } from "@/features/skills/skill-import";

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
        const { assets } = useAssetStore.getState();
        const { config } = useConfigStore.getState();
        const files: BackupItem[] = [];
        const zipFiles: { name: string; data: BlobPart }[] = [];
        await collectStoreFiles(imageStore, files, zipFiles);
        await collectStoreFiles(mediaStore, files, zipFiles);
        const skillSnapshot = await snapshotSkills();
        const skillRecords: NonNullable<AppBackupFile["skills"]>["packages"] = [];
        for (const pkg of skillSnapshot.packages) {
            const { id, version } = pkg.manifest;
            const path = "skills/" + id + "/" + version + ".zip";
            zipFiles.push({ name: path, data: await exportSkill(id, version) });
            skillRecords.push({ id, version, path });
        }
        const data: AppBackupFile = {
            app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(),
            projects, assets, config, files,
            skills: { catalog: skillSnapshot.catalog, packages: skillRecords },
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
        const zip = await readZip(file);
        const manifest = zip.get("backup.json");
        if (!manifest) throw new Error("Invalid application backup: missing backup.json");
        let parsed: unknown;
        try { parsed = JSON.parse(await manifest.text()); }
        catch { throw new Error("Invalid application backup: invalid JSON manifest"); }
        const data = validateBackup(parsed, zip);
        // Validate every nested SKILL ZIP and its claimed version before mutating browser data.
        let skillsToRestore: SkillBackupSnapshot | undefined;
        if (data.skills) {
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
        try {
            for (const item of data.files) {
                const blob = zip.get(item.path)!; // Every entry was checked by validateBackup.
                const restored = blob.slice(0, blob.size, item.mimeType || "application/octet-stream");
                written.push(item.storageKey);
                if (item.storageKey.startsWith("image:")) await setImageBlob(item.storageKey, restored);
                else await setMediaBlob(item.storageKey, restored);
            }
            changedProjects = true;
            useCanvasStore.getState().replaceProjects(data.projects);
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