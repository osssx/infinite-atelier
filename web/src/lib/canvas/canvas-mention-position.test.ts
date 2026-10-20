import { describe, expect, it } from "vitest";
import { canvasMentionPosition, keepMentionOptionVisible } from "./canvas-mention-position";

describe("portaled canvas @ reference picker placement", () => {
    const screen = { width: 1200, height: 800 };
    const popup = { width: 256, maxHeight: 224 };
    it("anchors just below the measured caret, not the canvas or composer bottom", () => {
        expect(canvasMentionPosition({ left: 380, top: 280, bottom: 300 }, screen, popup)).toEqual({
            left: 380, top: 306, width: 256, maxHeight: 224,
        });
    });
    it("opens above the caret when the bottom is too close to the screen edge", () => {
        expect(canvasMentionPosition({ left: 500, top: 760, bottom: 780 }, screen, popup)).toEqual({
            left: 500, top: 530, width: 256, maxHeight: 224,
        });
    });
    it("clamps horizontally near right edge at different canvas zoom levels", () => {
        expect(canvasMentionPosition({ left: 1100, top: 100, bottom: 120 }, screen, popup).left).toBe(936);
        expect(canvasMentionPosition({ left: -100, top: 100, bottom: 120 }, screen, popup).left).toBe(8);
    });
    it("keeps the popup accessible on narrow and short viewports", () => {
        const pos = canvasMentionPosition({ left: 240, top: 35, bottom: 55 }, { width: 220, height: 112 }, popup);
        expect(pos.width).toBe(204);
        expect(pos.maxHeight).toBe(43);
        expect(pos.left).toBe(8);
        expect(pos.top).toBe(61);
        expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(104);
    });
    it("automatically reduces height to remaining space when neither side fits", () => {
        const pos = canvasMentionPosition({ left: 200, top: 130, bottom: 150 }, { width: 900, height: 300 }, popup);
        expect(pos.maxHeight).toBe(136);
        expect(pos.top).toBe(156);
        expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(292);
    });
});


describe("mention menu selected item scrolling", () => {
    it("scrolls only the dropdown contents if selected item falls below or above", () => {
        const menu = { scrollTop: 10, getBoundingClientRect: () => ({ top: 100, bottom: 200 }) } as unknown as HTMLElement;
        const below = { getBoundingClientRect: () => ({ top: 190, bottom: 230 }) } as unknown as HTMLElement;
        const above = { getBoundingClientRect: () => ({ top: 80, bottom: 110 }) } as unknown as HTMLElement;
        keepMentionOptionVisible(menu, below);
        expect(menu.scrollTop).toBe(40);
        keepMentionOptionVisible(menu, above);
        expect(menu.scrollTop).toBe(20);
        keepMentionOptionVisible(null, above);
    });
});
