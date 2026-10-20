import { describe, expect, it } from "vitest";
import { reuseCanvasVisibleList } from "./canvas-visible-list";

describe("visible canvas list identity", () => {
    it("reuses the exact previous list when viewport changes but the ordered nodes do not", () => {
        const a = { id: "a" }, b = { id: "b" };
        const previous = [a, b];
        expect(reuseCanvasVisibleList(previous, [a, b])).toBe(previous);
        expect(reuseCanvasVisibleList([], [])).toBeDefined();
    });
    it("invalidates when any element changes reference, order, or membership", () => {
        const a = { id: "a" }, b = { id: "b" };
        const previous = [a, b];
        expect(reuseCanvasVisibleList(previous, [a, { id: "b" }])).not.toBe(previous);
        expect(reuseCanvasVisibleList(previous, [b, a])).not.toBe(previous);
        expect(reuseCanvasVisibleList(previous, [a])).not.toBe(previous);
        expect(reuseCanvasVisibleList(previous, [a, b, b])).not.toBe(previous);
    });
});
