import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { ViewportTransform } from "@/types/canvas";

/** One document per revision; a manifest switch is the only visibility/commit point. */
export type CanvasManifest = {
    version: 1;
    revision: number;
    entries: { id: string; key: string; viewport?: ViewportTransform; updatedAt?: string }[];
};

export type CanvasRecordStore = {
    getItem<T>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<unknown>;
    removeItem(key: string): Promise<unknown>;
};

export type CanvasWriteMetrics = {
    stringifyMs: number;
    bytes: number;
    changedProjects: number;
    writeMs: number;
};

const CURRENT = "current";
const PREVIOUS = "previous";

/** A viewport-only change leaves the expensive nodes, links and chat references untouched. */
function unchangedExceptViewport(previous: CanvasProject | undefined, next: CanvasProject): boolean {
    return Boolean(previous &&
        previous.id === next.id &&
        previous.title === next.title &&
        previous.createdAt === next.createdAt &&
        previous.nodes === next.nodes &&
        previous.connections === next.connections &&
        previous.chatSessions === next.chatSessions &&
        previous.activeChatId === next.activeChatId &&
        previous.backgroundMode === next.backgroundMode &&
        previous.showImageInfo === next.showImageInfo &&
        previous.comfyInstanceId === next.comfyInstanceId);
}

function sameViewport(a: ViewportTransform | undefined, b: ViewportTransform): boolean {
    return Boolean(a && a.x === b.x && a.y === b.y && a.k === b.k);
}

function validManifest(value: CanvasManifest | null): value is CanvasManifest {
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) ||
        !Array.isArray(value.entries)) return false;
    const seen = new Set<string>();
    return value.entries.every((entry) => {
        if (!entry || typeof entry.id !== "string" || !entry.id ||
            typeof entry.key !== "string" || !entry.key || seen.has(entry.id)) return false;
        seen.add(entry.id);
        return (!entry.viewport || [entry.viewport.x, entry.viewport.y, entry.viewport.k].every(Number.isFinite)) &&
            (entry.updatedAt === undefined || typeof entry.updatedAt === "string");
    });
}

/**
 * Crash-safe, per-project persistence.
 *
 * 1. Write new project snapshots under immutable revision keys (never overwrite a committed key).
 * 2. Store the currently committed manifest as rollback.
 * 3. Atomically switch the small current manifest to the new set of keys.
 * 4. Reclaim snapshots that neither the current nor rollback manifest references.
 *
 * The old monolithic Zustand record is deliberately not touched. It remains a migration
 * safety net, but once a split manifest exists we NEVER silently load the stale legacy
 * snapshot when a split record is missing: that could silently lose recent user edits.
 */
export class CanvasProjectRecords {
    private manifest: CanvasManifest | null = null;
    private rollback: CanvasManifest | null = null;
    private references = new Map<string, CanvasProject>();
    private repairRequired = false;

    constructor(private readonly projects: CanvasRecordStore, private readonly meta: CanvasRecordStore) {}

    async load(): Promise<CanvasProject[] | null> {
        const [active, previous] = await Promise.all([
            this.meta.getItem<CanvasManifest>(CURRENT),
            this.meta.getItem<CanvasManifest>(PREVIOUS),
        ]);
        if (active === null && previous === null) return null;

        for (const candidate of [active, previous]) {
            if (!validManifest(candidate)) continue;
            try {
                const decoded = await Promise.all(candidate.entries.map(async ({ id, key, viewport, updatedAt }) => {
                    const json = await this.projects.getItem<string>(key);
                    if (typeof json !== "string") throw new Error(`Missing canvas project snapshot: ${key}`);
                    const project = JSON.parse(json) as CanvasProject;
                    if (!project || project.id !== id) throw new Error(`Invalid canvas project snapshot: ${key}`);
                    // The manifest carries viewport edits without rewriting expensive node data.
                    if (viewport) project.viewport = viewport;
                    if (updatedAt) project.updatedAt = updatedAt;
                    return project;
                }));
                this.manifest = candidate;
                this.rollback = candidate === active && validManifest(previous) ? previous : null;
                this.references = new Map(decoded.map((project) => [project.id, project]));
                this.repairRequired = candidate !== active;
                return decoded;
            } catch {
                // A partially written/corrupt manifest may have a last-known-good predecessor.
            }
        }
        throw new Error("Canvas split storage is incomplete. Refusing to restore stale legacy data.");
    }

    async save(next: readonly CanvasProject[]): Promise<CanvasWriteMetrics> {
        const started = performance.now();
        const ids = new Set<string>();
        for (const project of next) {
            if (!project.id || ids.has(project.id)) throw new Error("Duplicate or empty canvas project ID");
            ids.add(project.id);
        }
        const previousEntries = new Map(this.manifest?.entries.map((e) => [e.id, e]) ?? []);
        const unchanged = next.every((project) => {
            const entry = previousEntries.get(project.id);
            return Boolean(entry && unchangedExceptViewport(this.references.get(project.id), project) &&
                sameViewport(entry.viewport, project.viewport) && entry.updatedAt === project.updatedAt);
        });
        const orderUnchanged = this.manifest?.entries.length === next.length &&
            next.every((project, index) => this.manifest!.entries[index].id === project.id);
        if (unchanged && orderUnchanged && !this.repairRequired) {
            return { stringifyMs: 0, bytes: 0, changedProjects: 0, writeMs: 0 };
        }
        const revision = this.manifest ? this.manifest.revision + 1 : 1;
        const entries: CanvasManifest["entries"] = [];
        const changed: { key: string; json: string }[] = [];
        let stringifyMs = 0;
        for (const project of next) {
            const oldEntry = previousEntries.get(project.id);
            const entryExtras = {
                viewport: { ...project.viewport },
                updatedAt: project.updatedAt,
            };
            if (oldEntry && unchangedExceptViewport(this.references.get(project.id), project)) {
                entries.push({ id: project.id, key: oldEntry.key, ...entryExtras });
                continue;
            }
            const key = `project:${encodeURIComponent(project.id)}:revision:${revision}`;
            const begin = performance.now();
            const json = JSON.stringify(project);
            stringifyMs += performance.now() - begin;
            changed.push({ key, json });
            entries.push({ id: project.id, key, ...entryExtras });
        }
        const nextManifest: CanvasManifest = { version: 1, revision, entries };
        // Immutable keys ensure a crash before this point cannot change the visible projects.
        for (const { key, json } of changed) await this.projects.setItem(key, json);
        // The two small index writes precede/commit in that order. The old manifest is kept
        // for fallback if any subsequent snapshot or index becomes corrupt or unavailable.
        if (this.manifest) await this.meta.setItem(PREVIOUS, this.manifest);
        else await this.meta.removeItem(PREVIOUS);
        await this.meta.setItem(CURRENT, nextManifest);

        const stale = this.rollback;
        this.rollback = this.manifest;
        this.manifest = nextManifest;
        this.references = new Map(next.map((project) => [project.id, project]));
        this.repairRequired = false;

        // Best effort GC: both rollback and current must remain readable. A failed deletion
        // leaks only an unreachable record, not user data or an active snapshot.
        const retained = new Set([...nextManifest.entries, ...(this.rollback?.entries ?? [])].map((item) => item.key));
        for (const entry of stale?.entries ?? []) {
            if (!retained.has(entry.key)) {
                try { await this.projects.removeItem(entry.key); }
                catch { /* Safe to retry maintenance later. */ }
            }
        }
        return {
            stringifyMs, bytes: changed.reduce((sum, item) => sum + item.json.length, 0),
            changedProjects: changed.length, writeMs: performance.now() - started,
        };
    }

    /** Used by clearStorage; an empty committed manifest prevents legacy resurrection. */
    async clear(): Promise<void> {
        await this.save([]);
    }
}
