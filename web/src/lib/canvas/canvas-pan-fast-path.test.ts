import { describe, expect, it } from "vitest";
import { canFastPanAtScale, FAST_PAN_COMMIT_INTERVAL_MS, FAST_WHEEL_COMMIT_INTERVAL_MS, gridPositionForViewport, shouldCommitFastPan, shouldCommitFastViewport, worldTransformForViewport } from "./canvas-pan-fast-path";

describe("low zoom pan visual transform", () => {
    it("only enables the direct transform for low zoom", () => {
        expect(canFastPanAtScale(.05)).toBe(true);
        expect(canFastPanAtScale(.16)).toBe(true);
        expect(canFastPanAtScale(.17)).toBe(true);
        expect(canFastPanAtScale(1)).toBe(true);
        expect(canFastPanAtScale(5)).toBe(true);
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
    it("commits by time or before traversing the culling overscan", () => {
        const committed = { x: 0, y: 0, k: 1 };
        expect(shouldCommitFastPan({ x: 199, y: 0, k: 1 }, committed, 47)).toBe(false);
        expect(shouldCommitFastPan({ x: 200, y: 0, k: 1 }, committed, 10)).toBe(true);
        expect(shouldCommitFastPan({ x: 0, y: 0, k: 1 }, committed, 48)).toBe(true);
    });
    it("commits a direct wheel transform at bounded time, translation, or scale ratio", () => {
        const committed = { x: 0, y: 0, k: 1 };
        expect(shouldCommitFastViewport({ x: 0, y: 0, k: 1.119 }, committed, 47)).toBe(false);
        expect(shouldCommitFastViewport({ x: 0, y: 0, k: 1.12 }, committed, 1)).toBe(true);
        expect(shouldCommitFastViewport({ x: 200, y: 0, k: 1 }, committed, 1)).toBe(true);
        expect(FAST_WHEEL_COMMIT_INTERVAL_MS).toBe(48);
        expect(shouldCommitFastViewport({ x: 0, y: 0, k: 1 }, committed, FAST_WHEEL_COMMIT_INTERVAL_MS - 1)).toBe(false);
        expect(shouldCommitFastViewport({ x: 0, y: 0, k: 1 }, committed, FAST_WHEEL_COMMIT_INTERVAL_MS)).toBe(true);
        expect(shouldCommitFastPan({ x: 0, y: 0, k: 1 }, committed, FAST_PAN_COMMIT_INTERVAL_MS)).toBe(true);
    });
});

