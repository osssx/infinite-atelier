import { describe, expect, it } from "vitest";
import { shouldUseOriginalCanvasImage as useOriginal } from "./canvas-image-resolution";

describe("canvas image resolution gating", () => {
    it("keeps thumbnails for small images even on a fully rendered node", () => {
        expect(useOriginal(0.5, 220, 180, 1280, 800)).toBe(false);
        expect(useOriginal(1, 256, 256, 1280, 800)).toBe(false);
        expect(useOriginal(0.5, 650, 500, 1280, 800)).toBe(false);
    });
    it("switches to full image when screen coverage and rendered edge are both substantial", () => {
        expect(useOriginal(1, 560, 420, 1280, 800)).toBe(true);
        expect(useOriginal(0.8, 1000, 620, 1280, 800)).toBe(true);
        expect(useOriginal(1.5, 340, 300, 390, 844)).toBe(true);
    });
    it("uses hysteresis around the cutoff without oscillating on wheel ticks", () => {
        expect(useOriginal(1, 370, 280, 1280, 800, false)).toBe(true);
        expect(useOriginal(0.9, 370, 280, 1280, 800, true)).toBe(true);
        expect(useOriginal(0.9, 370, 280, 1280, 800, false)).toBe(false);
        expect(useOriginal(0.5, 370, 280, 1280, 800, true)).toBe(false);
    });
    it("rejects invalid sizes", () => {
        for (const n of [0, -1, NaN, Infinity]) {
            expect(useOriginal(n, 500, 400, 1280, 800)).toBe(false);
            expect(useOriginal(1, n, 400, 1280, 800)).toBe(false);
        }
    });
});
