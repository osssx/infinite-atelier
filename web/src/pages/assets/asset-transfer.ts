import { saveAs } from "file-saver";

import { createZip, readZip } from "@/lib/zip";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import {isCanvasCasKey} from "@/features/backend-sync/canvas-cas";
import {uploadCanvasImage,uploadCanvasMedia} from "@/features/backend-sync/canvas-media";
import type { Asset } from "@/stores/use-asset-store";

type AssetExportFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    assets: Asset[];
    files: AssetExportItem[];
};

type AssetExportItem = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export async function exportAssets(assets: Asset[], filename: string) {
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];

    const included=new Set<string>();
    await Promise.all(
        assets.map(async (asset) => {
            if (asset.kind !== "image" && asset.kind !== "video") return;
            const storageKey = asset.data.storageKey;
            if (!storageKey) throw Error("asset_package_nonportable_media");
            if(included.has(storageKey))return;
            included.add(storageKey);
            const blob = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
            if (!blob) throw Error("asset_package_media_missing");
            const path = `files/${safeFileName(storageKey)}.${fileExtension(blob.type, asset.kind)}`;
            files.push({ storageKey, path, mimeType: blob.type || asset.data.mimeType, bytes: blob.size });
            zipFiles.push({ name: path, data: blob });
        }),
    );

    const data: AssetExportFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), assets, files };
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, filename);
}

export async function readAssetPackage(file: File): Promise<Asset[]> {
    const zip = await readZip(file);
    const assetFile = zip.get("assets.json");
    if (!assetFile || assetFile.size > 3 * 1024 * 1024) throw Error("asset_package_invalid");
    let data: AssetExportFile;
    try { data = JSON.parse(await assetFile.text()) as AssetExportFile; }
    catch { throw Error("asset_package_invalid"); }
    if (!data || data.app !== "infinite-canvas" || data.version !== 1 ||
        !Array.isArray(data.assets) || data.assets.length > 5000 || !Array.isArray(data.files) ||
        data.files.length > 5000) throw Error("asset_package_invalid");
    // Validate references and bytes before publishing any CAS media.
    const expected = new Map<string, "image" | "video">();
    for (const asset of data.assets) {
        if (!asset || !["text", "image", "video"].includes(asset.kind)) throw Error("asset_package_invalid");
        if (asset.kind === "text") continue;
        if (!asset.data || typeof asset.data.storageKey !== "string") throw Error("asset_package_media_missing");
        const key = asset.data.storageKey;
        const previous = expected.get(key);
        if (previous && previous !== asset.kind) throw Error("asset_package_invalid");
        expected.set(key, asset.kind);
    }
    const uploaded = new Map<string, Awaited<ReturnType<typeof uploadCanvasImage>> | Awaited<ReturnType<typeof uploadCanvasMedia>>>();
    const seen = new Set<string>(), paths = new Set<string>();
    const pending: Array<{storageKey:string;kind:"image"|"video";blob:Blob}> = [];
    for (const item of data.files) {
        if (!item || typeof item.storageKey !== "string" || !expected.has(item.storageKey) ||
            seen.has(item.storageKey) || typeof item.path !== "string" ||
            !/^files\/[a-zA-Z0-9_.-]+$/.test(item.path) || paths.has(item.path) ||
            typeof item.mimeType !== "string" || !["image/", "video/"].some(p => item.mimeType.startsWith(p)) ||
            !Number.isSafeInteger(item.bytes) || item.bytes < 1)
            throw Error("asset_package_invalid");
        seen.add(item.storageKey); paths.add(item.path);
        const blob = zip.get(item.path);
        if (!blob || blob.size !== item.bytes) throw Error("asset_package_media_missing");
        const kind = expected.get(item.storageKey)!;
        if (!item.mimeType.startsWith(kind + "/")) throw Error("asset_package_invalid");
        pending.push({ storageKey: item.storageKey, kind, blob: blob.slice(0, blob.size, item.mimeType) });
    }
    if (seen.size !== expected.size) throw Error("asset_package_media_missing");
    for (const item of pending) {
        const saved = item.kind === "image" ?
            await uploadCanvasImage(item.blob) : await uploadCanvasMedia(item.blob, "video");
        // Old image:/video: keys are replaced with immutable CAS identities.
        if (isCanvasCasKey(item.storageKey) && saved.storageKey !== item.storageKey)
            throw Error("asset_package_cas_mismatch");
        uploaded.set(item.storageKey, saved);
    }
    return data.assets.map((asset): Asset => {
        if (asset.kind === "text") return asset;
        const saved = uploaded.get(asset.data.storageKey!);
        if (!saved) throw Error("asset_package_media_missing");
        const coverUrl = asset.coverUrl.startsWith("blob:") || asset.coverUrl.startsWith("data:") ?
            (asset.kind === "image" ? saved.url : "") : asset.coverUrl;
        return asset.kind === "image" ?
            {...asset, coverUrl, data: {...asset.data, storageKey:saved.storageKey,
                dataUrl:saved.url, mimeType:saved.mimeType, bytes:saved.bytes}} :
            {...asset, coverUrl, data: {...asset.data, storageKey:saved.storageKey,
                url:saved.url, mimeType:saved.mimeType, bytes:saved.bytes}};
    });
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, kind: Asset["kind"]) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    return kind === "image" ? "png" : "bin";
}
