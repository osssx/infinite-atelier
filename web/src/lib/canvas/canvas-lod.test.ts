import { describe, expect, it } from "vitest";

import { shouldUseCompactNodeLayer } from "./canvas-lod";

describe("overview node LOD threshold", () => {
    it("retains fully interactive nodes when there are fewer than 72 visible", () => {
        expect(shouldUseCompactNodeLayer(71, 0.1)).toBe(false);
        expect(shouldUseCompactNodeLayer(30, 0.05)).toBe(false);
    });

    it("retains full nodes at readable zoom even when 200 are visible", () => {
        expect(shouldUseCompactNodeLayer(200, 0.35)).toBe(false);
        expect(shouldUseCompactNodeLayer(200, 1)).toBe(false);
    });

    it("uses compact hit rectangles for crowded overview, including exactly 72", () => {
        expect(shouldUseCompactNodeLayer(72, 0.34)).toBe(true);
        expect(shouldUseCompactNodeLayer(200, 0.05)).toBe(true);
    });
});
