import { describe, expect, it } from "vitest";
import { buildCanvasFixture } from "./canvas-fixtures";

describe("dense browser performance fixture", () => {
    it("reuses the same graph/media while clustering its geometry", () => {
        const normal = buildCanvasFixture({ nodeCount: 200, seed: 7, mediaMode: "none" });
        const dense = buildCanvasFixture({ nodeCount: 200, seed: 7, mediaMode: "none", layout: "clustered" });
        expect(dense.nodes).toHaveLength(200);
        expect(dense.connections).toEqual(normal.connections);
        expect(dense.nodes.map(({ id, type }) => [id, type])).toEqual(normal.nodes.map(({ id, type }) => [id, type]));
        expect(Math.max(...dense.nodes.map((node) => node.position.x))).toBeLessThan(700);
        expect(Math.max(...dense.nodes.map((node) => node.width))).toBeLessThanOrEqual(220);
        expect(normal.nodes[10].position).not.toEqual(dense.nodes[10].position);
    });
});
