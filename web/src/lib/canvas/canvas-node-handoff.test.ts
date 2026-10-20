import { describe, expect, it } from "vitest";
import { keepCompactDuringHandoff } from "./canvas-node-handoff";

describe("canvas node handoff", () => {
    it("retains the compact hit target while hydrating and crossfading", () => {
        expect(keepCompactDuringHandoff(true, "image-v2", null, null)).toBe(true);
        expect(keepCompactDuringHandoff(true, "image-v2", "image-v2", null)).toBe(true);
        expect(keepCompactDuringHandoff(true, "image-v2", "image-v2", "image-v2")).toBe(false);
    });
    it("returns a compact node on downgrade or new media source", () => {
        expect(keepCompactDuringHandoff(false, "image-v2", "image-v2", "image-v2")).toBe(true);
        expect(keepCompactDuringHandoff(true, "image-v3", "image-v2", "image-v2")).toBe(true);
    });
});
