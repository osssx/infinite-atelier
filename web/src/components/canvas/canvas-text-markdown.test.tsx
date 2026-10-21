import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasTextMarkdown } from "./canvas-text-markdown";

describe("CanvasTextMarkdown code wrapping", () => {
    it("creates separate code toolbar targets for fenced blocks, not inline code", () => {
        const content = [
            "Inline `value` remains inline.",
            "",
            "```typescript",
            "const example = 'a very long line of code';",
            "```",
            "",
            "```",
            "plain block",
            "```",
        ].join("\n");

        const markup = renderToStaticMarkup(<CanvasTextMarkdown content={content} theme={canvasThemes.light} />);

        expect(markup.match(/data-canvas-code-wrap="off"/g)).toHaveLength(2);
        // The wrap button portals into Streamdown's copy toolbar after mount.
        // Static HTML must expose one target for each fenced block, not for inline code.
        expect(markup.match(/data-streamdown="code-block-actions"/g)).toHaveLength(2);
        expect(markup).not.toContain('aria-label="Enable code wrapping"');
        expect(markup).toContain('data-streamdown="inline-code"');
        expect(markup).toContain('data-streamdown="code-block"');
        expect(markup.match(/data-streamdown="code-block"/g)).toHaveLength(2);
    });
});
