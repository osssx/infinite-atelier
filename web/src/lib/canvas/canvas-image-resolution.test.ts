import { describe, expect, it } from "vitest";
import {
    IMAGE_ORIGINAL_ENTER_AREA,
    IMAGE_ORIGINAL_ENTER_EDGE_PX,
    IMAGE_ORIGINAL_EXIT_AREA,
    IMAGE_ORIGINAL_EXIT_EDGE_PX,
    shouldUseOriginalCanvasImage as useOriginal,
} from "./canvas-image-resolution";

describe("canvas image resolution gating", () => {
    it("keeps small projected images as thumbnails", () => {
        expect(useOriginal(0.5, 220, 180, 1280, 800)).toBe(false);
        expect(useOriginal(1, 256, 256, 1280, 800)).toBe(false);
        expect(useOriginal(0.4, 650, 500, 1280, 800)).toBe(false);
    });
    it("promotes sufficiently large images without waiting for 10% of the browser window", () => {
        expect(useOriginal(1, 560, 420, 1280, 800)).toBe(true);
        expect(useOriginal(0.8, 1000, 620, 1280, 800)).toBe(true);
        expect(useOriginal(1.5, 340, 300, 390, 844)).toBe(true);
        // 2K display at Windows 125%: 420x420 CSS px covers roughly 7.5%
        // of a 2048x1152 CSS-px content viewport, but 525 physical pixels.
        expect(useOriginal(1, 420, 420, 2048, 1152, false, 1.25)).toBe(true);
        expect(useOriginal(1, 420, 420, 2048, 1152, false, 1)).toBe(true);
    });
    it("uses actual physical pixel demand instead of only CSS size", () => {
        // Covering 8.2% is insufficient at DPR=1 if edge is only 290 physical px.
        expect(useOriginal(1, 290, 290, 1280, 800, false, 1)).toBe(false);
        expect(useOriginal(1, 290, 290, 1280, 800, false, 1.25)).toBe(true);
        expect(useOriginal(1, 290, 290, 1280, 800, false, 2)).toBe(true);
    });
    it("calculates the area against the drawable canvas, not the full browser window", () => {
        // 350x280px = 4.15% of the canvas, 2.66% of the outer window.
        expect(useOriginal(1, 350, 280, 2048, 1152, false, 1.25)).toBe(true);
        expect(useOriginal(1, 350, 280, 2560, 1440, false, 1.25)).toBe(false);
    });
    it("retains hysteresis across the 4%/2.5% and 320/256 physical-px thresholds", () => {
        expect([IMAGE_ORIGINAL_ENTER_AREA, IMAGE_ORIGINAL_EXIT_AREA]).toEqual([0.04, 0.025]);
        expect([IMAGE_ORIGINAL_ENTER_EDGE_PX, IMAGE_ORIGINAL_EXIT_EDGE_PX]).toEqual([320, 256]);
        expect(useOriginal(1, 350, 200, 1280, 800, false)).toBe(true);
        expect(useOriginal(0.8, 350, 200, 1280, 800, true)).toBe(true);
        expect(useOriginal(0.8, 350, 200, 1280, 800, false)).toBe(false);
        expect(useOriginal(0.5, 350, 200, 1280, 800, true)).toBe(false);
    });
    it("never promotes invalid input including bad display pixel ratios", () => {
        for (const n of [0, -1, NaN, Infinity]) {
            expect(useOriginal(n, 500, 400, 1280, 800)).toBe(false);
            expect(useOriginal(1, n, 400, 1280, 800)).toBe(false);
            expect(useOriginal(1, 500, 400, 1280, 800, false, n)).toBe(false);
        }
    });
    it("does not promote any of 200 thumbnail-scale overview images", () => {
        // Small visible images should not decode their originals even on a 2x display.
        for (let i = 0; i < 200; i++) {
            expect(useOriginal(0.25, 360 + i % 10, 300, 1280, 800, false, 2)).toBe(false);
        }
    });
});
