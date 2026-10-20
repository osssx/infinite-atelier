import localforage from "localforage";
import { createZip } from "@/lib/zip";
import { PERF_MODE } from "@/lib/perf-mode";
import { validateSkillPath } from "./skill-parser";
import { type SkillCatalogEntry, type SkillPackage } from "./types";

const store = localforage.createInstance({ name: PERF_MODE ? "infinite-canvas-perf" : "infinite-canvas", storeName: "skill_packages" });
const CATALOG_KEY = "catalog:v1";
const packageKey = (id: string, version: string) => "package:" + id + ":" + version;
const copyCatalog = (entries: SkillCatalogEntry[]) => entries.map((item) => ({ ...item, versions: [...item.versions] }));

// Mutating transactions are serialized so parallel imports cannot overwrite catalog changes.
let operation = Promise.resolve();
function serialize<T>(run: () => Promise<T>): Promise<T> {
    const current = operation.then(run);
    operation = current.then(() => undefined, () => undefined);
    return current;
}
export async function listSkills(): Promise<SkillCatalogEntry[]> {
    await operation;
    return copyCatalog((await store.getItem<SkillCatalogEntry[]>(CATALOG_KEY)) || []);
}
async function rawCatalog() { return (await store.getItem<SkillCatalogEntry[]>(CATALOG_KEY)) || []; }

export async function registerSkill(pkg: SkillPackage): Promise<SkillCatalogEntry> {
    return serialize(async () => {
        const { manifest } = pkg;
        const catalog = await rawCatalog();
        const index = catalog.findIndex((entry) => entry.id === manifest.id);
        const existing = catalog[index];
        const version = manifest.version;
        if (!existing && catalog.length >= 100) throw new Error("Skill library is limited to 100 skills");
        if (existing && !existing.versions.includes(version) && existing.versions.length >= 30) {
            throw new Error("Skill version history is limited to 30 versions");
        }
        if (!existing?.versions.includes(version) && catalog.reduce((sum, item) => sum + item.versions.length, 0) >= 500) {
            throw new Error("Skill library is limited to 500 versions in total");
        }
        const stored = await store.getItem<SkillPackage>(packageKey(manifest.id, version));
        if (stored && stored.manifest.hash !== manifest.hash) throw new Error("Skill version hash conflict");
        await store.setItem(packageKey(manifest.id, version), pkg);
        const next: SkillCatalogEntry = {
            id: manifest.id, name: manifest.name, description: manifest.description,
            enabled: existing?.enabled ?? true, activeVersion: version,
            versions: [...new Set([...(existing?.versions || []), version])],
            updatedAt: new Date().toISOString(),
        };
        if (index >= 0) catalog[index] = next;
        else catalog.push(next);
        await store.setItem(CATALOG_KEY, catalog);
        return { ...next, versions: [...next.versions] };
    });
}
export async function setSkillEnabled(id: string, enabled: boolean) {
    return serialize(async () => {
        const catalog = await rawCatalog();
        const entry = catalog.find((skill) => skill.id === id);
        if (!entry) throw new Error("Skill does not exist");
        entry.enabled = enabled;
        await store.setItem(CATALOG_KEY, catalog);
    });
}
export async function activateSkillVersion(id: string, version: string) {
    return serialize(async () => {
        const catalog = await rawCatalog();
        const entry = catalog.find((skill) => skill.id === id);
        if (!entry?.versions.includes(version)) throw new Error("Unknown Skill version");
        const pkg = await store.getItem<SkillPackage>(packageKey(id, version));
        if (!pkg || pkg.manifest.version !== version) throw new Error("Skill version content missing");
        entry.activeVersion = version;
        entry.name = pkg.manifest.name;
        entry.description = pkg.manifest.description;
        entry.updatedAt = new Date().toISOString();
        await store.setItem(CATALOG_KEY, catalog);
    });
}
export async function removeSkill(id: string) {
    return serialize(async () => {
        const catalog = await rawCatalog();
        const found = catalog.find((entry) => entry.id === id);
        if (!found) return;
        await store.setItem(CATALOG_KEY, catalog.filter((entry) => entry.id !== id));
        for (const version of found.versions) await store.removeItem(packageKey(id, version));
    });
}
export async function getSkillPackage(id: string, version?: string): Promise<SkillPackage | null> {
    const catalog = await listSkills();
    const entry = catalog.find((item) => item.id === id);
    if (!entry || (version && !entry.versions.includes(version))) return null;
    const selected = version || entry.activeVersion;
    const pkg = await store.getItem<SkillPackage>(packageKey(id, selected));
    if (!pkg || pkg.manifest.id !== id || pkg.manifest.version !== selected) throw new Error("Skill package content is missing or corrupt");
    return pkg;
}
/** Run-specific allowlisting must be enforced by a future Skill dispatcher. */
export async function readSkillResource(id: string, path: string, version?: string): Promise<string> {
    validateSkillPath(path);
    if (!/^references\/.+\.(?:md|txt|markdown)$/i.test(path)) throw new Error("Skill resource is not model-readable");
    const pkg = await getSkillPackage(id, version);
    if (!pkg) throw new Error("Unknown Skill");
    if (!Object.hasOwn(pkg.resources, path)) throw new Error("Unknown Skill reference");
    return pkg.resources[path];
}
export async function exportSkill(id: string, version?: string): Promise<Blob> {
    const pkg = await getSkillPackage(id, version);
    if (!pkg) throw new Error("Unknown Skill");
    if (pkg.sourceArchive) return pkg.sourceArchive;
    return createZip([{ name: "SKILL.md", data: pkg.skillMd }, ...Object.entries(pkg.resources).map(([name, data]) => ({ name, data }))]);
}

/** Complete snapshot for backup and rollback. */
export type SkillBackupSnapshot = { catalog: SkillCatalogEntry[]; packages: SkillPackage[] };
export async function snapshotSkills(): Promise<SkillBackupSnapshot> {
    const catalog = await listSkills();
    const packages: SkillPackage[] = [];
    for (const entry of catalog) for (const version of entry.versions) {
        const pkg = await getSkillPackage(entry.id, version);
        if (!pkg) throw new Error("Skill package unavailable during backup");
        packages.push(pkg);
    }
    return { catalog, packages };
}
export async function restoreSkillSnapshot(snapshot: SkillBackupSnapshot) {
    return serialize(async () => {
        const old = await rawCatalog();
        const expected = new Set(snapshot.catalog.flatMap((entry) => entry.versions.map((version) => packageKey(entry.id, version))));
        for (const entry of snapshot.catalog) for (const version of entry.versions) {
            const pkg = snapshot.packages.find((item) => item.manifest.id === entry.id && item.manifest.version === version);
            if (!pkg) throw new Error("Invalid Skill backup: missing package");
        }
        for (const pkg of snapshot.packages) await store.setItem(packageKey(pkg.manifest.id, pkg.manifest.version), pkg);
        await store.setItem(CATALOG_KEY, copyCatalog(snapshot.catalog));
        for (const entry of old) for (const version of entry.versions) {
            const key = packageKey(entry.id, version);
            if (!expected.has(key)) await store.removeItem(key);
        }
    });
}
