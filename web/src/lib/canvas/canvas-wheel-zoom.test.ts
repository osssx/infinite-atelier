import { describe, expect, it } from "vitest";

import { applyAnchoredWheelZoom } from "./canvas-wheel-zoom";

describe("anchored wheel composition", () => {
    const start = { x: 135, y: -75, k: 0.05 };

    it("preserves every delta in a five-event burst across 20 frames", () => {
        let viewport = start;
        for (let frame = 0; frame < 20; frame++) {
            for (let event = 0; event < 5; event++) viewport = applyAnchoredWheelZoom(viewport, -20, 400, 200);
        }
        expect(viewport.k).toBeCloseTo(0.05 * Math.pow(1.1, 20), 12);
    });

    it("preserves the anchored world point for every event", () => {
        let viewport = { x: 20, y: 60, k: 0.7 };
        for (const [x, y, delta] of [[100, 40, -30], [500, 210, 55], [25, 400, -100]]) {
            const worldX = (x - viewport.x) / viewport.k;
            const worldY = (y - viewport.y) / viewport.k;
            viewport = applyAnchoredWheelZoom(viewport, delta, x, y);
            expect((x - viewport.x) / viewport.k).toBeCloseTo(worldX, 9);
            expect((y - viewport.y) / viewport.k).toBeCloseTo(worldY, 9);
        }
    });

    it("does not lose direction changes within one render batch", () => {
        const after = [-60, -25, 85].reduce((vp, delta) => applyAnchoredWheelZoom(vp, delta, 300, 160), start);
        expect(after.k).toBeCloseTo(start.k, 12);
        expect(after.x).toBeCloseTo(start.x, 9);
        expect(after.y).toBeCloseTo(start.y, 9);
    });

    it("clamps zoom at both limits without moving the anchor at a clamped limit", () => {
        const min = applyAnchoredWheelZoom(start, 1000, 300, 200);
        expect(min).toBe(start);
        const max = applyAnchoredWheelZoom({ x: 0, y: 0, k: 5 }, -100, 300, 200);
        expect(max).toEqual({ x: 0, y: 0, k: 5 });
    });
});
