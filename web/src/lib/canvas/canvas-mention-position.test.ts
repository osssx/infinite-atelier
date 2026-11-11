import { describe, expect, it } from "vitest";
import { anchoredMentionMenuPlacement, canvasMentionPosition, keepMentionOptionVisible } from "./canvas-mention-position";

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


describe("shared anchored @ image and / Skill menu placement", () => {
    const screen = { width: 1200, height: 800 };
    const nearBottom = { left: 500, top: 750, bottom: 770 };
    it("anchors a single @ reference directly above the caret without an empty 224px offset", () => {
        const one = anchoredMentionMenuPlacement(nearBottom, screen, { width: 256, count: 1 });
        expect(one).toEqual({ left: 500, width: 256, maxHeight: 224, bottom: 56 });
        expect(one.top).toBeUndefined();
        expect(one.maxHeight).toBeGreaterThanOrEqual(58); // a 48px row + padding/border
    });
    it("keeps 2-3 candidates anchored without changing distance from the caret", () => {
        for (const count of [2, 3]) {
            const result = anchoredMentionMenuPlacement(nearBottom, screen, { width: 256, count });
            expect(result.bottom).toBe(56);
            expect(result.maxHeight).toBe(224);
        }
    });
    it("opens below the caret when a single row fits instead of moving the popup far above", () => {
        const result = anchoredMentionMenuPlacement({ left: 380, top: 220, bottom: 240 }, screen, { width: 256, count: 1 });
        expect(result.top).toBe(246);
        expect(result.bottom).toBeUndefined();
    });
    it("clips a long list and clamps x to viewport CSS pixels", () => {
        const result = anchoredMentionMenuPlacement({ left: 1180, top: 580, bottom: 600 }, screen, { width: 256, count: 12 });
        expect(result.left).toBe(936);
        expect(result.bottom).toBe(226);
        expect(result.maxHeight).toBe(224);
    });
    it("remains within a short viewport without shifting relative to zoomed canvas coordinates", () => {
        const result = anchoredMentionMenuPlacement(
            { left: -100, top: 55, bottom: 73 }, { width: 220, height: 125 }, { width: 256, count: 1 },
        );
        expect(result.left).toBe(8);
        expect(result.width).toBe(204);
        expect(result.maxHeight).toBeLessThanOrEqual(44);
        if (result.top !== undefined) expect(result.top + result.maxHeight).toBeLessThanOrEqual(117);
        else expect(result.bottom).toBeGreaterThan(0);
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
