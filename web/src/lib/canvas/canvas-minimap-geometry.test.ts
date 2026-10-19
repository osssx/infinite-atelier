import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { buildCanvasFixture } from "./canvas-fixtures";
import { getMinimapProjection, minimapNodeRect, minimapScreenToWorld, minimapWorldToScreen, MINIMAP_WIDTH, MINIMAP_HEIGHT } from "./canvas-minimap-geometry";

const node = (id: string, x: number, y: number, w: number, h: number): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Image,
    title: id,
    position: { x, y },
    width: w,
    height: h,
});

describe("minimap projection and bitmap layout", () => {
    it("preserves the old empty canvas projection", () => {
        const projection = getMinimapProjection([]);
        expect(projection).toEqual({ originX: -500, originY: -500, scale: 0.16, offsetX: 40, offsetY: 0 });
        expect(minimapWorldToScreen(projection, 0, 0)).toEqual({ x: 120, y: 80 });
    });

    it("roundtrips pointer positions through the same projection used to draw", () => {
        const nodes = [node("a", -1200, -400, 220, 170), node("b", 500, 250, 470, 300)];
        const projection = getMinimapProjection(nodes);
        for (const [x, y] of [[-1300, 100], [600, 800], [0, 0]]) {
            const canvasPoint = minimapWorldToScreen(projection, x, y);
            const world = minimapScreenToWorld(projection, canvasPoint.x, canvasPoint.y);
            expect(world.x).toBeCloseTo(x, 8);
            expect(world.y).toBeCloseTo(y, 8);
        }
        expect(minimapNodeRect(projection, nodes[0]).width).toBeGreaterThanOrEqual(2);
    });

    it("fits all 200 nodes, including large groups and negative coordinates, in one bitmap", () => {
        const { nodes } = buildCanvasFixture({ nodeCount: 200, seed: 17 });
        const projection = getMinimapProjection(nodes);
        expect(projection.scale).toBeGreaterThan(0);
        for (const item of nodes) {
            const topLeft = minimapWorldToScreen(projection, item.position.x, item.position.y);
            const bottomRight = minimapWorldToScreen(projection, item.position.x + item.width, item.position.y + item.height);
            expect(topLeft.x).toBeGreaterThanOrEqual(-0.000001);
            expect(topLeft.y).toBeGreaterThanOrEqual(-0.000001);
            expect(bottomRight.x).toBeLessThanOrEqual(MINIMAP_WIDTH + 0.000001);
            expect(bottomRight.y).toBeLessThanOrEqual(MINIMAP_HEIGHT + 0.000001);
        }
    });

    it("does not mutate node data or lose tiny node hit visibility", () => {
        const tiny = node("tiny", 0, 0, 1, 1);
        const projection = getMinimapProjection([tiny]);
        expect(minimapNodeRect(projection, tiny)).toMatchObject({ width: 2, height: 2 });
        expect(tiny.width).toBe(1);
    });
});
