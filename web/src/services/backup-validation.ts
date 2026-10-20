import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { Asset } from "@/stores/use-asset-store";
import type { AiConfig } from "@/stores/use-config-store";

export type BackupItem = { storageKey: string; path: string; mimeType: string };
export type AppBackupFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    projects: CanvasProject[];
    assets: Asset[];
    config: AiConfig;
    files: BackupItem[];
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
