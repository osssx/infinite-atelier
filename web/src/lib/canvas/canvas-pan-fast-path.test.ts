import { describe, expect, it } from "vitest";
import { canFastPanAtScale, FAST_PAN_COMMIT_INTERVAL_MS, gridPositionForViewport, worldTransformForViewport } from "./canvas-pan-fast-path";

describe("low zoom pan visual transform", () => {
    it("only enables the direct transform for low zoom", () => {
        expect(canFastPanAtScale(.05)).toBe(true);
        expect(canFastPanAtScale(.16)).toBe(true);
        expect(canFastPanAtScale(.17)).toBe(false);
        expect(canFastPanAtScale(0)).toBe(false);
        expect(canFastPanAtScale(Number.NaN)).toBe(false);
    });
    it("produces the same CSS values as the committed React viewport", () => {
        expect(worldTransformForViewport({ x: 211, y: -53, k: .1 })).toBe("translate(211px, -53px) scale(0.1)");
        const [x, y] = gridPositionForViewport({ x: 10, y: -8, k: .1 }).split(" ").map(parseFloat);
        expect(x).toBeCloseTo(0.4, 8);
        expect(y).toBeCloseTo(-3.2, 8);
    });
    it("bounds the React update cadence while keeping pointer movement at frame rate", () => {
        expect(FAST_PAN_COMMIT_INTERVAL_MS).toBeGreaterThanOrEqual(32);
        expect(FAST_PAN_COMMIT_INTERVAL_MS).toBeLessThanOrEqual(120);
    });
});

