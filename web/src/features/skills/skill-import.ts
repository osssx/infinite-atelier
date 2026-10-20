import { unzipSync } from "fflate";
import { buildSkillManifest, validateSkillPath } from "./skill-parser";
import { MAX_SKILL_FILES, MAX_SKILL_PACKAGE_BYTES, MAX_SKILL_TEXT_BYTES, type SkillPackage } from "./types";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const enc = new TextEncoder();
type ZipEntry = { path: string; originalSize: number; isDirectory: boolean };
const u16 = (v: DataView, offset: number) => v.getUint16(offset, true);
const u32 = (v: DataView, offset: number) => v.getUint32(offset, true);
const signature = (v: DataView, offset: number) => u32(v, offset);

/** Inspect ZIP central directory before inflate to stop traversal, links and ZIP bombs. */
function inspectZip(bytes: Uint8Array): ZipEntry[] {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (signature(data, i) === 0x06054b50 && i + 22 + u16(data, i + 20) === bytes.length) { end = i; break; }
    }
    if (end < 0) throw new Error("Invalid ZIP: missing central directory");
    if (u16(data, end + 4) || u16(data, end + 6)) throw new Error("Multi-disk ZIP is unsupported");
    const count = u16(data, end + 10);
    if (count !== u16(data, end + 8) || count === 0xffff || count > MAX_SKILL_FILES) throw new Error("ZIP has too many entries or unsupported ZIP64");
    const size = u32(data, end + 12), start = u32(data, end + 16);
    if (size === 0xffffffff || start === 0xffffffff || start + size > end) throw new Error("Invalid ZIP directory offsets");
    let offset = start, total = 0;
    const paths = new Set<string>();
    const entries: ZipEntry[] = [];
    for (let i = 0; i < count; i++) {
        if (offset + 46 > start + size || signature(data, offset) !== 0x02014b50) throw new Error("Invalid ZIP central entry");
        const flags = u16(data, offset + 8), method = u16(data, offset + 10);
        const compressed = u32(data, offset + 20), originalSize = u32(data, offset + 24);
        const pathLength = u16(data, offset + 28), extraLength = u16(data, offset + 30), commentLength = u16(data, offset + 32);
        const madeBy = u16(data, offset + 4) >>> 8;
        const mode = u32(data, offset + 38) >>> 16;
        const entryEnd = offset + 46 + pathLength + extraLength + commentLength;
        if (entryEnd > start + size || !pathLength || compressed === 0xffffffff || originalSize === 0xffffffff) throw new Error("Invalid ZIP entry size");
        if ((flags & 1) || (flags & 0x40) || ![0, 8].includes(method)) throw new Error("Encrypted or unsupported ZIP entry");
        if (madeBy === 3 && (mode & 0xf000) === 0xa000) throw new Error("ZIP symlinks are not allowed");
        let path: string;
        try { path = utf8.decode(bytes.subarray(offset + 46, offset + 46 + pathLength)); }
        catch { throw new Error("ZIP filenames must be valid UTF-8"); }
        const isDirectory = path.endsWith("/");
        const normalized = validateSkillPath(isDirectory ? path.slice(0, -1) : path);
        if (paths.has(normalized)) throw new Error("Duplicate ZIP paths");
        paths.add(normalized);
        if (!isDirectory) {
            total += originalSize;
            if (total > MAX_SKILL_PACKAGE_BYTES) throw new Error("Skill ZIP expanded size exceeds 5 MiB");
            if (originalSize > 0 && compressed === 0) throw new Error("Invalid ZIP compression metadata");
            if (originalSize > Math.max(1024, compressed * 200)) throw new Error("Suspicious ZIP compression ratio");
            if ((normalized === "SKILL.md" || normalized.endsWith("/SKILL.md") || /\.(?:md|txt|markdown)$/i.test(normalized)) && originalSize > MAX_SKILL_TEXT_BYTES) {
                throw new Error("Skill text file exceeds 512 KiB");
            }
        }
        entries.push({ path: normalized, originalSize, isDirectory });
        offset = entryEnd;
    }
    if (offset !== start + size) throw new Error("Invalid ZIP central directory length");
    return entries;
}

async function calculateHash(files: Map<string, Uint8Array>): Promise<string> {
    const parts: Uint8Array[] = [];
    let length = 0;
    for (const [path, bytes] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const prefix = enc.encode(path + "\u0000" + bytes.length + "\u0000");
        parts.push(prefix, bytes);
        length += prefix.length + bytes.length;
    }
    const combined = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { combined.set(part, offset); offset += part.length; }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function decodeText(bytes: Uint8Array) {
    if (bytes.length > MAX_SKILL_TEXT_BYTES) throw new Error("Skill text file exceeds 512 KiB");
    const text = utf8.decode(bytes);
    if (text.includes("\u0000")) throw new Error("Binary data is not valid Skill text");
    return text;
}
export async function parseSkillFiles(input: Map<string, Uint8Array>, archive?: Blob): Promise<SkillPackage> {
    if (input.size < 1 || input.size > MAX_SKILL_FILES) throw new Error("Invalid number of Skill package files");
    const roots = [...input.keys()].filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"));
    if (roots.length !== 1) throw new Error("Skill ZIP must contain exactly one SKILL.md");
    const root = roots[0].slice(0, -"SKILL.md".length);
    if (root && root.slice(0, -1).includes("/")) throw new Error("Skill must be at archive root or one top-level directory");
    const normalized = new Map<string, Uint8Array>();
    let size = 0;
    for (const [originalPath, bytes] of input) {
        validateSkillPath(originalPath);
        if (root && !originalPath.startsWith(root)) throw new Error("ZIP contains files outside the Skill root");
        const path = root ? originalPath.slice(root.length) : originalPath;
        validateSkillPath(path);
        if (normalized.has(path)) throw new Error("Duplicate Skill resource");
        normalized.set(path, bytes);
        size += bytes.byteLength;
        if (size > MAX_SKILL_PACKAGE_BYTES) throw new Error("Skill package expanded size exceeds 5 MiB");
    }
    const skillMd = decodeText(normalized.get("SKILL.md")!);
    const resources: Record<string, string> = {};
    for (const [path, bytes] of normalized) {
        if (/^references\/.+\.(?:md|txt|markdown)$/i.test(path)) resources[path] = decodeText(bytes);
    }
    const manifest = buildSkillManifest(skillMd, await calculateHash(normalized), [...normalized.keys()]);
    return { manifest, skillMd, resources, ...(archive ? { sourceArchive: archive } : {}) };
}
export async function importSkillFile(file: Blob & { name?: string }): Promise<SkillPackage> {
    if (file.size > MAX_SKILL_PACKAGE_BYTES) throw new Error("Skill package exceeds 5 MiB");
    const filename = file.name || "";
    if (filename.toLowerCase().endsWith(".zip")) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const entries = inspectZip(bytes);
        const expanded = unzipSync(bytes);
        const map = new Map<string, Uint8Array>();
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            const decoded = expanded[entry.path];
            if (!decoded || decoded.byteLength !== entry.originalSize) throw new Error("ZIP entry is missing or corrupt");
            map.set(entry.path, decoded);
        }
        return parseSkillFiles(map, file);
    }
    if (filename && filename.toLowerCase() !== "skill.md") throw new Error("Import a SKILL.md file or ZIP package");
    const data = new Uint8Array(await file.arrayBuffer());
    return parseSkillFiles(new Map([["SKILL.md", data]]));
}
