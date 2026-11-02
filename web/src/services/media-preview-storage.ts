import { canvasCasPreviewUrl, isCanvasCasKey } from "@/features/backend-sync/canvas-cas";

export type PreviewKind = "image" | "video";
const urls = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();
const pending: Array<() => Promise<void>> = [];
let working = false;
// Independent gesture owners must not resume preview fetches while another is active.
const suspendedBy = new Set<string>();
export function setPreviewGenerationSuspended(active: boolean, reason: "wheel" | "pan" | "canvas-edit" = "wheel") {
    if (active) suspendedBy.add(reason);
    else suspendedBy.delete(reason);
}
export function isPreviewGenerationSuspended() { return suspendedBy.size > 0; }

const keyOf = (kind: PreviewKind, key: string) => `${kind}:${key}`;

// Work is serialized and begins only in an idle callback, never in a zoom-wheel event.
function queueIdle(task: () => Promise<void>) {
    pending.push(task);
    if (!working) void drain();
}
async function drain() {
    working = true;
    while (pending.length) {
        await new Promise<void>((resolve) => {
            if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 3000 });
            else setTimeout(resolve, 180);
        });
        if (isPreviewGenerationSuspended()) { await new Promise<void>((resolve) => setTimeout(resolve, 180)); continue; }
        try { await pending.shift()?.(); } catch { /* Failed posters remain placeholders. */ }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    working = false;
}

async function fetchCasPreview(kind: PreviewKind, storageKey: string): Promise<string | null> {
    const id = keyOf(kind, storageKey);
    const cached = urls.get(id);
    if (cached) return cached;
    const ongoing = inFlight.get(id);
    if (ongoing) return ongoing;
    const previewUrl = canvasCasPreviewUrl(storageKey);
    if (!previewUrl) return null;
    const task = new Promise<string | null>((resolve) => {
        queueIdle(async () => {
            try {
                const response = await fetch(previewUrl, { credentials: "same-origin" });
                if (!response.ok) { resolve(null); return; }
                const blob = await response.blob();
                if (blob.type !== "image/png") { resolve(null); return; }
                const object = URL.createObjectURL(blob);
                urls.set(id, object);
                resolve(object);
            } catch { resolve(null); }
        });
    });
    inFlight.set(id, task);
    try { return await task; }
    finally { if (inFlight.get(id) === task) inFlight.delete(id); }
}

/** Only fetches server generated CAS thumbnails. It never reads or decodes original media. */
export async function getExistingMediaPreview(kind: PreviewKind, storageKey: string): Promise<string | null> {
    if (!isCanvasCasKey(storageKey)) return null;
    return fetchCasPreview(kind, storageKey);
}

/** Preview lookup is server CAS only; original blobs are never read or decoded here. */
export async function resolveMediaPreview(kind: PreviewKind, storageKey: string): Promise<string | null> {
    if (!isCanvasCasKey(storageKey)) return null;
    return fetchCasPreview(kind, storageKey);
}
