import i18n from "@/i18n";
import { proxyApiUrl } from "@/lib/api-proxy";
import { isCanvasCasKey, canvasCasUrl, getCanvasBlob } from "@/features/backend-sync/canvas-cas";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return safeFallback(fallback);
    const url = canvasCasUrl(storageKey);
    if (url) return url;
    // Do not interpret historical IndexedDB keys as URLs or attempt a browser-side migration.
    return safeFallback(fallback);
}

export async function getImageBlob(storageKey: string): Promise<Blob | null> {
    if (!isCanvasCasKey(storageKey)) return null;
    return getCanvasBlob(storageKey);
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const direct = image.dataUrl;
    if (direct?.startsWith("data:")) return direct;
    const url = image.storageKey ? await resolveImageUrl(image.storageKey, image.url || direct || "") : safeFallback(direct || image.url || "");
    if (!url) return "";
    if (url.startsWith("data:")) return url;
    if (/^(?:image|video|audio|file|director):/.test(url)) return "";
    const response = await fetch(proxyRemoteMediaUrl(url), { credentials: "same-origin" });
    if (!response.ok) throw new Error(i18n.t("common.imageReadFailed"));
    return blobToDataUrl(await response.blob());
}

function proxyRemoteMediaUrl(url: string) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? proxyApiUrl(url) : url;
    } catch {
        return url;
    }
}

function safeFallback(value: string) {
    if (!value || /^(?:image|video|audio|file|director):/.test(value)) return "";
    return value;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}
