import localforage from "localforage";
import { PERF_MODE } from "@/lib/perf-mode";

export type PreviewKind = "image" | "video";
export const PREVIEW_EDGE = 256;
const previews = localforage.createInstance({
    name: PERF_MODE ? "infinite-canvas-perf" : "infinite-canvas",
    storeName: "media_previews",
});
const urls = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();
const pending: Array<() => Promise<void>> = [];
let working = false;
// Independent gesture owners must not resume decoding while another is active.
const suspendedBy = new Set<string>();
export function setPreviewGenerationSuspended(active: boolean, reason: "wheel" | "pan" | "canvas-edit" = "wheel") {
    if (active) suspendedBy.add(reason);
    else suspendedBy.delete(reason);
}
export function isPreviewGenerationSuspended() { return suspendedBy.size > 0; }
const versions = new Map<string, number>();
const keyOf = (kind: PreviewKind, key: string) => `preview:v1:${kind}:${key}`;

export function previewSize(width: number, height: number, edge = PREVIEW_EDGE) {
    if (!(width > 0) || !(height > 0)) return { width: edge, height: edge };
    const scale = Math.min(1, edge / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

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

async function blobToPreview(image: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/webp", quality: .75 });
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", .75));
}

async function imagePreview(blob: Blob, dimensions?: { width: number; height: number }): Promise<Blob | null> {
    const size = dimensions ? previewSize(dimensions.width, dimensions.height) : null;
    const bitmap = size
        ? await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" })
        : await createImageBitmap(blob);
    try {
        const fitted = size || previewSize(bitmap.width, bitmap.height);
        return blobToPreview(bitmap, fitted.width, fitted.height);
    } finally { bitmap.close(); }
}

async function videoPoster(blob: Blob): Promise<Blob | null> {
    if (typeof document === "undefined") return null;
    const source = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
        const frameReady = new Promise<void>((resolve, reject) => {
            const onReady = () => { cleanup(); resolve(); };
            const onError = () => { cleanup(); reject(new Error("video poster decode failed")); };
            const cleanup = () => {
                video.removeEventListener("loadeddata", onReady);
                video.removeEventListener("error", onError);
                clearTimeout(timer);
            };
            const timer = setTimeout(onError, 8000);
            video.addEventListener("loadeddata", onReady, { once: true });
            video.addEventListener("error", onError, { once: true });
        });
        video.src = source;
        await frameReady;
        if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;
        const { width, height } = previewSize(video.videoWidth, video.videoHeight);
        return blobToPreview(video, width, height);
    } finally {
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(source);
    }
}

export async function deleteMediaPreview(kind: PreviewKind, storageKey: string) {
    if (!storageKey) return;
    const id = keyOf(kind, storageKey);
    versions.set(id, (versions.get(id) || 0) + 1);
    inFlight.delete(id);
    const url = urls.get(id);
    if (url) URL.revokeObjectURL(url);
    urls.delete(id);
    await previews.removeItem(id);
}

/**
 * Resolve small persisted preview. On first use after upload/restore, an idle task builds
 * it from the ORIGINAL blob, but never supplies the original media URL to the compact DOM.
 */
export async function resolveMediaPreview(
    kind: PreviewKind, storageKey: string, loadBlob: () => Promise<Blob | null>,
    dimensions?: { width: number; height: number },
): Promise<string | null> {
    if (!storageKey) return null;
    const id = keyOf(kind, storageKey);
    const url = urls.get(id);
    if (url) return url;
    const current = inFlight.get(id);
    if (current) return current;
    const version = versions.get(id) || 0;
    const task = new Promise<string | null>((resolve) => {
        queueIdle(async () => {
            try {
                // Deleted/replaced previews must not reopen obsolete originals.
                if ((versions.get(id) || 0) !== version) { resolve(null); return; }
                let blob = await previews.getItem<Blob>(id);
                if ((versions.get(id) || 0) !== version) { resolve(null); return; }
                if (!blob) {
                    const original = await loadBlob();
                    if (!original) { resolve(null); return; }
                    blob = kind === "image" ? await imagePreview(original, dimensions) : await videoPoster(original);
                    if (!blob) { resolve(null); return; }
                    if ((versions.get(id) || 0) !== version) { resolve(null); return; }
                    await previews.setItem(id, blob);
                }
                if ((versions.get(id) || 0) !== version) { resolve(null); return; }
                const created = URL.createObjectURL(blob);
                urls.set(id, created);
                resolve(created);
            } catch { resolve(null); }
        });
    });
    inFlight.set(id, task);
    try { return await task; }
    finally { if (inFlight.get(id) === task) inFlight.delete(id); }
}
