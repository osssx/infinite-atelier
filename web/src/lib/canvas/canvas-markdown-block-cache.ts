import { parseMarkdownIntoBlocks } from "streamdown";

/**
 * Cache only Streamdown's pure static block splitting, not the rendered React tree.
 * The latter owns clipboard, syntax-highlight and wrap state and must remain live.
 *
 * Count + byte bounds avoid retaining large AI generations and stale content forever.
 * Reads refresh LRU order, writes evict old entries; long one-off documents bypass it.
 */
// A dense viewport can expose around 100-200 text nodes; 64 entries caused
// every entry to be evicted by the next recovery pass. Cap memory at 2 MiB.
const MAX_BLOCK_CACHE_ENTRIES = 256;
const MAX_BLOCK_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_SINGLE_DOCUMENT_BYTES = 48 * 1024;
const blockCache = new Map<string, { blocks: string[]; bytes: number }>();
let blockCacheBytes = 0;

export function cachedCanvasMarkdownBlocks(content: string): string[] {
    const existing = blockCache.get(content);
    if (existing) {
        blockCache.delete(content);
        blockCache.set(content, existing);
        return existing.blocks;
    }
    const blocks = parseMarkdownIntoBlocks(content);
    const bytes = (content.length + blocks.reduce((n, block) => n + block.length, 0)) * 2;
    // Streamdown can memoize its own split arrays. Oversized documents must
    // bypass *all* array-identity reuse, not only our bounded LRU map.
    if (bytes > MAX_SINGLE_DOCUMENT_BYTES) return [...blocks];
    blockCache.set(content, { blocks, bytes });
    blockCacheBytes += bytes;
    while (blockCache.size > MAX_BLOCK_CACHE_ENTRIES || blockCacheBytes > MAX_BLOCK_CACHE_BYTES) {
        const oldest = blockCache.keys().next().value;
        if (oldest === undefined) break;
        blockCacheBytes -= blockCache.get(oldest)!.bytes;
        blockCache.delete(oldest);
    }
    return blocks;
}

export function getCanvasMarkdownCacheStats() {
    return { entries: blockCache.size, bytes: blockCacheBytes };
}

/** Test-only reset; never run this on a node mount/unmount. */
export function clearCanvasMarkdownBlockCache() {
    blockCache.clear();
    blockCacheBytes = 0;
}
