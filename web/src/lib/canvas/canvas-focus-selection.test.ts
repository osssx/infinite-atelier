import { describe, expect, it } from "vitest";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { focusSelectionViewport, isFocusSelectionKey } from "./canvas-focus-selection";

const node = (id: string, x: number, y: number, width = 200, height = 100, type = CanvasNodeType.Image): CanvasNodeData => ({ id, type, title: id, position: { x, y }, width, height });
const size = { width: 1000, height: 800 };

describe("focus selection viewport", () => {
    it("centres an offscreen node at negative coordinates without magnifying it", () => {
        const selected = node("a", -5000, -3000);
        const result = focusSelectionViewport([selected], new Set(["a"]), size)!;
        expect(result.k).toBe(1);
        expect((selected.position.x + selected.width / 2) * result.k + result.x).toBe(500);
        expect((selected.position.y + selected.height / 2) * result.k + result.y).toBe(400);
    });

    it("fits only selected nodes with 80px padding and keeps selection and nodes intact", () => {
        const nodes = [node("a", 0, 0), node("b", 1800, 900), node("unselected", 100000, 100000)];
        const ids = new Set(["a", "b", "deleted"]);
        const original = structuredClone(nodes);
        const result = focusSelectionViewport(nodes, ids, size)!;
        expect(result.k).toBeCloseTo(840 / 2000);
        expect(result.x).toBeCloseTo(80);
        expect(1000 * result.k + result.x).toBeCloseTo(500);
        expect(500 * result.k + result.y).toBeCloseTo(400);
        expect(nodes).toEqual(original);
        expect([...ids]).toEqual(["a", "b", "deleted"]);
    });

    it.each([[10000, 100], [100, 10000]])("fits a %dx%d group by its rectangle", (width, height) => {
        const selected = node("group", 2000, 3000, width, height, CanvasNodeType.Group);
        const result = focusSelectionViewport([selected, node("child", 100000, 100000)], new Set(["group"]), size)!;
        expect(result.k).toBeGreaterThanOrEqual(0.05);
        expect(result.k).toBeLessThanOrEqual(1);
        expect(width * result.k).toBeLessThanOrEqual(840);
        expect(height * result.k).toBeLessThanOrEqual(640);
        expect((selected.position.x + width / 2) * result.k + result.x).toBeCloseTo(500);
        expect((selected.position.y + height / 2) * result.k + result.y).toBeCloseTo(400);
    });

    it("preserves the canvas minimum zoom for extremely large selections", () => {
        const result = focusSelectionViewport([node("huge", 0, 0, 100000, 100000)], new Set(["huge"]), size)!;
        expect(result.k).toBe(0.05);
    });

    it("does nothing for empty, stale or not-yet-measured selections", () => {
        const nodes = [node("a", 0, 0)];
        expect(focusSelectionViewport(nodes, new Set(), size)).toBeNull();
        expect(focusSelectionViewport(nodes, new Set(["deleted"]), size)).toBeNull();
        expect(focusSelectionViewport(nodes, new Set(["a"]), { width: 0, height: 0 })).toBeNull();
    });
});

describe("focus shortcut", () => {
    const event = { key: "f", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false, defaultPrevented: false };
    it("accepts F including Caps Lock", () => {
        expect(isFocusSelectionKey(event)).toBe(true);
        expect(isFocusSelectionKey({ ...event, key: "F" })).toBe(true);
        expect(isFocusSelectionKey({ ...event, key: "g" })).toBe(false);
    });
    it.each(["ctrlKey", "metaKey", "shiftKey", "altKey", "repeat", "isComposing", "defaultPrevented"] as const)("ignores %s", (flag) => {
        expect(isFocusSelectionKey({ ...event, [flag]: true })).toBe(false);
    });
});
