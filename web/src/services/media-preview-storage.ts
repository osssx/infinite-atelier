import { canvasCasPreviewUrl, isCanvasCasKey } from "@/features/backend-sync/canvas-cas";

export type PreviewKind = "image" | "video";
export type PreviewPriority = "background" | "visible" | "selected";
type CachedPreview = { url: string; bytes: number; refs: number; lastUsed: number };
type PreviewTask = {
    id: string;
    url: string;
    priority: number;
    refs: number;
    controller: AbortController;
    promise: Promise<string | null>;
    resolve: (url: string | null) => void;
};

const CACHE_MAX_ITEMS = 256;
const CACHE_MAX_BYTES = 128 * 1024 * 1024;
const MAX_CONCURRENT_FETCHES = 4;
const urls = new Map<string, CachedPreview>();
const inFlight = new Map<string, PreviewTask>();
const pending: PreviewTask[] = [];
let activeCount = 0;
let idleScheduled = false;
let idleFallback: ReturnType<typeof setTimeout> | null = null;
let cachedBytes = 0;
// Independent gesture owners must not resume preview fetches while another is active.
const suspendedBy = new Set<string>();

const priorityValue: Record<PreviewPriority, number> = { background: 0, visible: 1, selected: 2 };
const keyOf = (kind: PreviewKind, key: string) => `${kind}:${key}`;

export function setPreviewGenerationSuspended(active: boolean, reason: "wheel" | "pan" | "canvas-edit" = "wheel") {
    if (active) suspendedBy.add(reason);
    else suspendedBy.delete(reason);
    if (!active) scheduleDrain();
}
export function isPreviewGenerationSuspended() { return suspendedBy.size > 0; }

function pruneCache() {
    if (urls.size <= CACHE_MAX_ITEMS && cachedBytes <= CACHE_MAX_BYTES) return;
    const evictable = [...urls.entries()].filter(([, entry]) => entry.refs === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id, entry] of evictable) {
        if (urls.size <= CACHE_MAX_ITEMS && cachedBytes <= CACHE_MAX_BYTES) break;
        urls.delete(id);
        cachedBytes -= entry.bytes;
        URL.revokeObjectURL(entry.url);
    }
}

function requestIdleStart(callback: () => void) {
    if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => callback(), { timeout: 1500 });
        return;
    }
    idleFallback = setTimeout(() => {
        idleFallback = null;
        callback();
    }, 0);
}

function scheduleDrain() {
    if (idleScheduled || isPreviewGenerationSuspended() || !pending.length) return;
    idleScheduled = true;
    requestIdleStart(() => {
        idleScheduled = false;
        if (isPreviewGenerationSuspended()) return;
        while (activeCount < MAX_CONCURRENT_FETCHES && pending.length) {
            pending.sort((a, b) => b.priority - a.priority);
            const task = pending.shift()!;
            if (!inFlight.has(task.id) || task.refs === 0 && task.controller.signal.aborted) continue;
            activeCount += 1;
            void runTask(task).finally(() => {
                activeCount -= 1;
                if (inFlight.get(task.id) === task) inFlight.delete(task.id);
                scheduleDrain();
            });
        }
    });
}

async function runTask(task: PreviewTask) {
    try {
        const response = await fetch(task.url, { credentials: "same-origin", signal: task.controller.signal });
        if (!response.ok) { task.resolve(null); return; }
        const blob = await response.blob();
        if (blob.type !== "image/png") { task.resolve(null); return; }
        if (task.controller.signal.aborted && task.refs === 0) { task.resolve(null); return; }
        const objectUrl = URL.createObjectURL(blob);
        urls.set(task.id, { url: objectUrl, bytes: blob.size, refs: task.refs, lastUsed: performance.now() });
        cachedBytes += blob.size;
        pruneCache();
        task.resolve(objectUrl);
    } catch {
        // Failed posters remain placeholders; aborted orphaned work is silently discarded.
        task.resolve(null);
    }
}

function getCached(id: string): CachedPreview | null {
    const entry = urls.get(id);
    if (!entry) return null;
    entry.lastUsed = performance.now();
    return entry;
}

type PreviewLease = { promise: Promise<string | null>; release: () => void };

/** Retained preview handle; release cancels queued/orphaned work and makes the cache entry evictable. */
export function acquireMediaPreview(kind: PreviewKind, storageKey: string, priority: PreviewPriority = "visible"): PreviewLease {
    if (!isCanvasCasKey(storageKey)) return { promise: Promise.resolve(null), release: () => {} };
    const id = keyOf(kind, storageKey);
    const cached = getCached(id);
    if (cached) {
        cached.refs += 1;
        let released = false;
        return { promise: Promise.resolve(cached.url), release: () => {
            if (released) return;
            released = true;
            cached.refs = Math.max(0, cached.refs - 1);
            cached.lastUsed = performance.now();
            pruneCache();
        } };
    }
    const url = canvasCasPreviewUrl(storageKey);
    if (!url) return { promise: Promise.resolve(null), release: () => {} };
    let task = inFlight.get(id);
    if (!task || task.controller.signal.aborted) {
        let resolve!: (result: string | null) => void;
        const promise = new Promise<string | null>((done) => { resolve = done; });
        task = { id, url, priority: priorityValue[priority], refs: 0, controller: new AbortController(), promise, resolve };
        inFlight.set(id, task);
        pending.push(task);
    } else task.priority = Math.max(task.priority, priorityValue[priority]);
    task.refs += 1;
    scheduleDrain();
    let released = false;
    return {
        promise: task.promise,
        release: () => {
            if (released) return;
            released = true;
            task!.refs = Math.max(0, task!.refs - 1);
            const entry = urls.get(id);
            if (entry) {
                entry.refs = Math.max(0, entry.refs - 1);
                entry.lastUsed = performance.now();
                pruneCache();
            } else if (task!.refs === 0) {
                task!.controller.abort();
                const queued = pending.indexOf(task!);
                if (queued >= 0) pending.splice(queued, 1);
                if (inFlight.get(id) === task && queued >= 0) {
                    inFlight.delete(id);
                    task!.resolve(null);
                }
            }
        },
    };
}

async function fetchCasPreview(kind: PreviewKind, storageKey: string, priority: PreviewPriority = "visible"): Promise<string | null> {
    if (!isCanvasCasKey(storageKey)) return null;
    const id = keyOf(kind, storageKey);
    const cached = getCached(id);
    if (cached) return cached.url;
    const existing = inFlight.get(id);
    if (existing) {
        existing.priority = Math.max(existing.priority, priorityValue[priority]);
        return existing.promise;
    }
    const lease = acquireMediaPreview(kind, storageKey, priority);
    try { return await lease.promise; }
    finally { lease.release(); }
}

/** Only fetches server generated CAS thumbnails. It never reads or decodes original media. */
export async function getExistingMediaPreview(kind: PreviewKind, storageKey: string, priority: PreviewPriority = "visible"): Promise<string | null> {
    return fetchCasPreview(kind, storageKey, priority);
}

/** Preview lookup is server CAS only; original blobs are never read or decoded here. */
export async function resolveMediaPreview(kind: PreviewKind, storageKey: string, priority: PreviewPriority = "visible"): Promise<string | null> {
    return fetchCasPreview(kind, storageKey, priority);
}
