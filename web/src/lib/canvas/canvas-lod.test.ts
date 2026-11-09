import { describe, expect, it } from "vitest";
import { shouldUseCompactNodeLayer, compactCanvasTextOutlineStyle, shouldShowCompactCanvasTextSummary } from "./canvas-lod";

describe("compact text readability threshold", () => {
    it("shows the short summary only once projected glyphs reach readable size", () => {
        expect(shouldShowCompactCanvasTextSummary(0.49, 14, false)).toBe(false);
        expect(shouldShowCompactCanvasTextSummary(0.58, 14, false)).toBe(true);
        expect(shouldShowCompactCanvasTextSummary(0.58, 12, false)).toBe(false);
        expect(shouldShowCompactCanvasTextSummary(0.67, 12, false)).toBe(true);
    });
    it("keeps the full editor representation during direct interaction", () => {
        expect(shouldShowCompactCanvasTextSummary(0.2, 14, true)).toBe(true);
    });
    it("uses three low-cost CSS lines with no glyph content for unreadable compact text", () => {
        const style = compactCanvasTextOutlineStyle("#abcdef");
        expect(style.backgroundImage.match(/linear-gradient\(/g)).toHaveLength(3);
        expect(style.backgroundSize).toBe("85% 6px, 60% 6px, 75% 6px");
        expect(style.backgroundPosition).toBe("0 0, 0 16px, 0 32px");
        expect(style.backgroundRepeat).toBe("no-repeat");
        expect(style.opacity).toBe(0.4);
    });
});

 describe("stable spatial LOD", () => {
 it("does not downgrade ordinary wheel gestures", () => {
 expect(shouldUseCompactNodeLayer(100, 1, true, false)).toBe(false);
 expect(shouldUseCompactNodeLayer(100, .29, true, false)).toBe(true);
 expect(shouldUseCompactNodeLayer(60, .35, true, true)).toBe(true);
 expect(shouldUseCompactNodeLayer(60, .42, false, true)).toBe(false);
 expect(shouldUseCompactNodeLayer(55, .2, false, true)).toBe(false);
 });
 });
