import { describe, expect, it } from "vitest";

import { shouldRenderFullNode, shouldUseCompactNodeLayer } from "./canvas-lod";

describe("overview node LOD threshold", () => {
    it("retains fully interactive nodes when there are fewer than 72 visible", () => {
        expect(shouldUseCompactNodeLayer(71, 0.1)).toBe(false);
        expect(shouldUseCompactNodeLayer(30, 0.05)).toBe(false);
    });

    it("restores full editing, connector handles and content for a single selected or hovered node", () => {
        const none = new Set<string>();
        const single = new Set(["image-a"]);
        const many = new Set(["image-a", "image-b"]);
        expect(shouldRenderFullNode("image-a", true, none, null, null, null)).toBe(false);
        expect(shouldRenderFullNode("image-a", true, single, null, null, null)).toBe(true);
        expect(shouldRenderFullNode("image-a", true, many, null, null, null)).toBe(false);
        expect(shouldRenderFullNode("image-a", true, none, "image-a", null, null)).toBe(true);
        expect(shouldRenderFullNode("image-a", true, none, null, "image-a", null)).toBe(true);
        expect(shouldRenderFullNode("image-a", true, none, null, null, "image-a")).toBe(true);
        expect(shouldRenderFullNode("image-b", true, single, "image-a", null, null)).toBe(false);
        expect(shouldRenderFullNode("image-a", false, none, null, null, null)).toBe(true);
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
