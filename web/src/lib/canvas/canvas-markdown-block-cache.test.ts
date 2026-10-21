import { beforeEach, describe, expect, it } from "vitest";
import { parseMarkdownIntoBlocks } from "streamdown";
import { cachedCanvasMarkdownBlocks, clearCanvasMarkdownBlockCache, getCanvasMarkdownCacheStats } from "./canvas-markdown-block-cache";
import { isSimpleCanvasText } from "./canvas-markdown-plain";

describe("canvas text Markdown optimization", () => {
    beforeEach(() => clearCanvasMarkdownBlockCache());

    it("bypasses Markdown only for simple single-line literal text", () => {
        expect(isSimpleCanvasText("A 6-second shot: close-up of a quiet room.")).toBe(true);
        expect(isSimpleCanvasText("简单的提示词，保持文字内容。")).toBe(true);
        for (const markdown of [
            "# Heading", "**bold**", "\`code\`", "item [link](https://example.com)",
            "https://example.com", "hello@example.com", "Text &amp; markup",
            "first\nsecond", "   - list", "1. numbered", "\\*escaped", "<b>HTML</b>",
            "    indented code", "~~removed~~", "some | table",
        ]) expect(isSimpleCanvasText(markdown)).toBe(false);
    });

    it("preserves Streamdown splitting and reuses exact content across remounts", () => {
        const markdown = "# Heading\n\n- one\n- two\n\n\`\`\`ts\nconst x = 1;\n\`\`\`";
        const first = cachedCanvasMarkdownBlocks(markdown);
        expect(first).toEqual(parseMarkdownIntoBlocks(markdown));
        expect(cachedCanvasMarkdownBlocks(markdown)).toBe(first);
        expect(cachedCanvasMarkdownBlocks(markdown + "\nend")).not.toBe(first);
        expect(getCanvasMarkdownCacheStats().entries).toBe(2);
    });

    it("keeps a dense viewport's 200 distinct documents warm", () => {
        const documents = Array.from({ length: 200 }, (_, i) => "# Prompt " + i + "\n\n- " + "scene ".repeat(60));
        const first = documents.map(cachedCanvasMarkdownBlocks);
        const repeated = documents.map(cachedCanvasMarkdownBlocks);
        expect(getCanvasMarkdownCacheStats().entries).toBe(200);
        for (let i = 0; i < documents.length; i++) expect(repeated[i]).toBe(first[i]);
    });

    it("enforces LRU count/size bounds and bypasses oversized documents", () => {
        const first = cachedCanvasMarkdownBlocks("# 0\n\nfirst");
        for (let i = 1; i <= 300; i++) cachedCanvasMarkdownBlocks("# " + i + "\n\nSome content " + i);
        expect(getCanvasMarkdownCacheStats().entries).toBeLessThanOrEqual(256);
        expect(getCanvasMarkdownCacheStats().bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(cachedCanvasMarkdownBlocks("# 0\n\nfirst")).not.toBe(first);
        const oversized = "# Huge\n\n" + "long markdown line \n\n".repeat(3500);
        const parsed = cachedCanvasMarkdownBlocks(oversized);
        expect(parsed).toEqual(parseMarkdownIntoBlocks(oversized));
        expect(cachedCanvasMarkdownBlocks(oversized)).not.toBe(parsed);
    });
});
