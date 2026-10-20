import { describe, expect, it } from "vitest";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canScheduleNodePromotions, choosePromotionBatch, orderNodePromotions, PROMOTION_GESTURE_QUIET_MS } from "./canvas-node-promotion";

const make = (id: string, x: number, type: CanvasNodeData["type"] = CanvasNodeType.Image): CanvasNodeData =>
    ({ id, type, position: { x, y: 0 }, width: 100, height: 100, title: id, metadata: {} }) as CanvasNodeData;

describe("canvas full-node promotion scheduler", () => {
    it("keeps dense-node hydration out of active gestures and their release paint", () => {
        expect(PROMOTION_GESTURE_QUIET_MS).toBeGreaterThanOrEqual(100);
        expect(canScheduleNodePromotions(false, false, true, 200)).toBe(true);
        expect(canScheduleNodePromotions(false, true, true, 200)).toBe(false);
        expect(canScheduleNodePromotions(false, false, false, 200)).toBe(false);
        expect(canScheduleNodePromotions(true, false, true, 200)).toBe(false);
        expect(canScheduleNodePromotions(false, false, true, 23)).toBe(false);
    });

    it("prioritizes interaction targets then nearest nodes and preserves deterministic ties", () => {
        const candidates = orderNodePromotions([make("far", 1000), make("near", 0), make("selected", 2000), make("tie", 0)], 50, 50, new Set(["selected"]));
        expect(candidates.map(({ id }) => id)).toEqual(["selected", "near", "tie", "far"]);
    });

    it("adapts admission to observed pressure, avoiding a large decoder batch", () => {
        const nodes = orderNodePromotions([make("a", 0), make("b", 100), make("c", 200), make("d", 300)], 0, 0, new Set());
        expect(choosePromotionBatch(nodes, new Set(), 16.7, 1)).toEqual(["a", "b"]);
        expect(choosePromotionBatch(nodes, new Set(), 21, 1)).toEqual(["a"]);
        expect(choosePromotionBatch(nodes, new Set(), 16.7, 9)).toEqual(["a"]);
        expect(choosePromotionBatch(nodes, new Set(["a"]), 16.7, 1)).toEqual(["b", "c"]);
        expect(choosePromotionBatch(nodes, new Set(nodes.map((n) => n.id)), 16.7, 1)).toEqual([]);
    });

    it("admits at least one video even when the budget is smaller than its weight", () => {
        const nodes = orderNodePromotions([make("video", 0, CanvasNodeType.Video), make("text", 110, CanvasNodeType.Text)], 0, 0, new Set());
        expect(choosePromotionBatch(nodes, new Set(), 36, 10)).toEqual(["video"]);
    });
});
