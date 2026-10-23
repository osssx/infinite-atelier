import { unzipSync, zipSync } from "fflate";

type ZipFile = {
    name: string;
    data: BlobPart;
};

export async function createZip(files: ZipFile[]) {
    const entries = await Promise.all(
        files.map(async (file) => {
            const data = new Uint8Array(await new Blob([file.data]).arrayBuffer());
            return [file.name, data] as const;
        }),
    );
    return new Blob([zipSync(Object.fromEntries(entries), { level: 0 })], { type: "application/zip" });
}

export type ZipReadLimits = { maxFiles: number; maxUncompressedBytes: number; maxEntryBytes: number; maxArchiveBytes: number };
export async function readZip(file: Blob, limits?: ZipReadLimits) {
    if (limits && file.size > limits.maxArchiveBytes) throw new Error("Archive exceeds size limit");
    let count = 0, total = 0;
    const seen = new Set<string>();
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), limits ? {
        filter: ({name,originalSize}) => {
            if (++count > limits.maxFiles || !Number.isFinite(originalSize) || originalSize < 0 ||
                originalSize > limits.maxEntryBytes || (total += originalSize) > limits.maxUncompressedBytes)
                throw new Error("Archive decompression limit exceeded");
            if (!name || name.startsWith("/") || name.includes("\\\\") || name.split("/").includes("..") ||
                seen.has(name)) throw new Error("Unsafe or duplicate archive path");
            seen.add(name);
            return true;
        },
    } : undefined);
    return new Map(Object.entries(entries).map(([name, data]) => [name, new Blob([data])]));
}
