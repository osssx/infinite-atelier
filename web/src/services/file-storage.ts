import { uploadCanvasMedia } from "@/features/backend-sync/canvas-media";
import { isCanvasCasKey, canvasCasUrl, getCanvasBlob } from "@/features/backend-sync/canvas-cas";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

/** Canvas media uploads are durable backend CAS blobs; prefix is retained for API compatibility. */
export async function uploadMediaFile(input: string | Blob, _prefix = "file"): Promise<UploadedFile> {
    if (typeof input === "string" && /^(?:image|video|audio|file|director):/.test(input)) throw new Error("legacy_canvas_media_unavailable");
    const response = typeof input === "string" ? await fetch(input, { credentials: "same-origin" }) : null;
    if (response && !response.ok) throw new Error("canvas_media_download_failed");
    const blob = response ? await response.blob() : input as Blob;
    const kind = blob.type.startsWith("audio/") ? "audio" : "video";
    return uploadCanvasMedia(blob, kind);
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return safeFallback(fallback);
    const url = canvasCasUrl(storageKey);
    if (url) return url;
    // Historical browser keys are unavailable after the IndexedDB media store is retired.
    return safeFallback(fallback);
}

export async function getMediaBlob(storageKey: string): Promise<Blob | null> {
    if (!isCanvasCasKey(storageKey)) return null;
    return getCanvasBlob(storageKey);
}

function safeFallback(value: string) {
    if (!value || /^(?:image|video|audio|file|director):/.test(value)) return "";
    return value;
}
