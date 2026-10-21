import { describe, expect, it } from "vitest";
import { compactCanvasMarkdown, safeCanvasMarkdownHref, safeCanvasMarkdownImageSrc } from "./canvas-markdown-utils";

describe("canvas Markdown URL safety", () => {
    it("allows web links, anchors, and mail links", () => {
        expect(safeCanvasMarkdownHref("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
        expect(safeCanvasMarkdownHref("http://example.com")).toBe("http://example.com");
        expect(safeCanvasMarkdownHref("mailto:hello@example.com")).toBe("mailto:hello@example.com");
        expect(safeCanvasMarkdownHref("#local")).toBe("#local");
        expect(safeCanvasMarkdownHref("/images/a.png")).toBe("/images/a.png");
    });
    it("blocks scripts, ambiguous relative links and executable image URLs", () => {
        for (const url of ["javascript:alert(1)", "data:text/html,hello", "//example.com", "vbscript:alert(1)", "file:///private", "foo/page"]) {
            expect(safeCanvasMarkdownHref(url)).toBeUndefined();
            expect(safeCanvasMarkdownImageSrc(url)).toBeUndefined();
        }
        expect(safeCanvasMarkdownImageSrc("https://example.com/a.png")).toBe("https://example.com/a.png");
        expect(safeCanvasMarkdownImageSrc("/public/a.webp")).toBe("/public/a.webp");
    });
});

describe("compact canvas Markdown preview", () => {
    it("preserves readable text without expensive Markdown rendering", () => {
        const preview = compactCanvasMarkdown("# Heading\n- **Bold** and [Docs](https://example.com)\n> `sample`");
        expect(preview).toBe("Heading\n• Bold and Docs\nsample");
    });
    it("bounds very large documents in overview", () => {
        expect(compactCanvasMarkdown("x".repeat(10000)).length).toBe(900);
        expect(compactCanvasMarkdown("ok", 5)).toBe("ok");
    });
});
