import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { Asset } from "@/stores/use-asset-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { SkillCatalogEntry } from "@/features/skills/types";

export type BackupItem = { storageKey: string; path: string; mimeType: string };
export type AppBackupFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    projects: CanvasProject[];
    assets: Asset[];
    config: AiConfig;
    files: BackupItem[];
    /** Optional to preserve compatibility with pre-Skill v1 backups. */
    skills?: {
        catalog: SkillCatalogEntry[];
        packages: Array<{ id: string; version: string; path: string }>;
    };
};

/** v1 was a logical data backup, not an IndexedDB snapshot. Preserve this format. */
export function validateBackup(data: unknown, zip: ReadonlyMap<string, Blob>): AppBackupFile {
    const invalid = (detail: string): never => { throw new Error(`Invalid application backup: ${detail}`); };
    if (!data || typeof data !== "object") return invalid("missing manifest");
    const file = data as Partial<AppBackupFile>;
    if (file.app !== "infinite-canvas" || file.version !== 1 ||
        !Array.isArray(file.projects) || !Array.isArray(file.assets) ||
        !file.config || typeof file.config !== "object" || !Array.isArray(file.files)) return invalid("unsupported v1 format");
    const ids = new Set<string>();
    for (const project of file.projects) {
        if (!project || typeof project.id !== "string" || !project.id || ids.has(project.id) ||
            !Array.isArray(project.nodes) || !Array.isArray(project.connections) || !Array.isArray(project.chatSessions)) return invalid("invalid/duplicate project");
        ids.add(project.id);
    }
    const keys = new Set<string>(), paths = new Set<string>();
    for (const item of file.files) {
        if (!item || typeof item.storageKey !== "string" || !item.storageKey ||
            typeof item.path !== "string" || !item.path.startsWith("files/") ||
            item.path.includes("..") || !item.path.slice(6) ||
            typeof item.mimeType !== "string" ||
            keys.has(item.storageKey) || paths.has(item.path)) return invalid("duplicate or unsafe media record");
        if (!zip.has(item.path)) return invalid(`missing media file: ${item.path}`);
        keys.add(item.storageKey);
        paths.add(item.path);
    }
    if (file.skills !== undefined) {
        const skills = file.skills;
        if (!Array.isArray(skills.catalog) || !Array.isArray(skills.packages) || skills.catalog.length > 100 || skills.packages.length > 500) return invalid("invalid Skill manifest");
        const registered = new Set<string>();
        for (const entry of skills.catalog) {
            if (!entry || typeof entry.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) ||
                registered.has(entry.id) || typeof entry.description !== "string" || typeof entry.enabled !== "boolean" ||
                typeof entry.activeVersion !== "string" || !Array.isArray(entry.versions) ||
                entry.versions.length < 1 || entry.versions.length > 30 || !entry.versions.includes(entry.activeVersion) ||
                new Set(entry.versions).size !== entry.versions.length ||
                (entry.scope !== undefined &&
                    (typeof entry.scope !== "object" || entry.scope === null ||
                    (entry.scope.type !== "global" &&
                    (entry.scope.type !== "project" || typeof entry.scope.projectId !== "string" ||
                     !entry.scope.projectId.trim() || entry.scope.projectId.length > 256)))))
                return invalid("invalid Skill catalog");
            registered.add(entry.id);
        }
        const expected = new Set(skills.catalog.flatMap((entry) => entry.versions.map((version) => entry.id + ":" + version)));
        const found = new Set<string>();
        for (const entry of skills.packages) {
            if (!entry || !registered.has(entry.id) || typeof entry.version !== "string" ||
                !/^[0-9a-f]{12}$/.test(entry.version) ||
                entry.path !== "skills/" + entry.id + "/" + entry.version + ".zip" || !zip.has(entry.path)) {
                return invalid("invalid or missing Skill package");
            }
            const key = entry.id + ":" + entry.version;
            if (found.has(key) || !expected.has(key)) return invalid("duplicate or unexpected Skill package");
            found.add(key);
            if (zip.get(entry.path)!.size > 5 * 1024 * 1024) return invalid("Skill archive exceeds 5 MiB");
        }
        if (found.size !== expected.size) return invalid("missing Skill package");
    }
    // Local media references must have corresponding blobs. Ignore other plugin-specific
    // arbitrary storageKey strings and external URLs, which are not local media records.
    const refs = new Set<string>();
    const scan = (value: unknown, seen = new WeakSet<object>()) => {
        if (!value || typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        if ("storageKey" in value && typeof value.storageKey === "string" &&
            /^(image|video|audio|file):/.test(value.storageKey)) refs.add(value.storageKey);
        for (const child of Object.values(value)) scan(child, seen);
    };
    scan(file.projects);
    scan(file.assets);
    for (const key of refs) if (!keys.has(key)) return invalid(`missing referenced media: ${key}`);
    return file as AppBackupFile;
}
