import { describe, expect, it } from "vitest";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { buildOverviewConnectionPaths, findOverviewConnectionAtPoint } from "./canvas-overview-connections";
import { connectionControlPoints } from "./canvas-connection-culling";

const n = (id: string, x: number, y: number): CanvasNodeData => ({
    id, type: CanvasNodeType.Image, title: id, position: { x, y }, width: 120, height: 80, metadata: {},
});
const a = n("a", 0, 0);
const b = n("b", 400, 110);
const c = n("c", 840, 350);
const byId = new Map([a, b, c].map((node) => [node.id, node]));
const connections = [
    { id: "ab", fromNodeId: "a", toNodeId: "b" },
    { id: "bc", fromNodeId: "b", toNodeId: "c" },
];
describe("batched overview connections", () => {
    it("preserves cubic geometry and groups active edges without duplicating hit paths", () => {
        const paths = buildOverviewConnectionPaths(connections, byId, null, new Set(["bc"]));
        const ab = connectionControlPoints(a, b);
        const expected = `M ${ab.startX} ${ab.startY} C ${ab.control1X} ${ab.control1Y}, ${ab.control2X} ${ab.control2Y}, ${ab.endX} ${ab.endY}`;
        expect(paths.ordinary).toBe(expected);
        expect(paths.highlighted).toContain("M 520 150 C");
        expect(paths.hit.match(/M /g)).toHaveLength(2);
        expect(paths.curves.map((entry) => entry.id)).toEqual(["ab", "bc"]);
    });
    it("leaves a selected edge out of the combined visual and hit paths", () => {
        const paths = buildOverviewConnectionPaths(connections, byId, "ab", new Set());
        expect(paths.curves.map((entry) => entry.id)).toEqual(["bc"]);
        expect(paths.ordinary.match(/M /g)).toHaveLength(1);
    });
    it("skips removed endpoints and does not return an arbitrary connection on empty space", () => {
        const paths = buildOverviewConnectionPaths([
            ...connections, { id: "missing", fromNodeId: "b", toNodeId: "gone" },
        ], byId, null, new Set());
        expect(paths.curves).toHaveLength(2);
        expect(findOverviewConnectionAtPoint(paths.curves, -100, -100)).toBeNull();
    });
    it("retains a narrow hit region for very long curved edges", () => {
        const tall = n("tall", 3000, 20000);
        const paths = buildOverviewConnectionPaths([{ id: "long", fromNodeId: "a", toNodeId: "tall" }],
            new Map([[a.id, a], [tall.id, tall]]), null, new Set());
        const c = paths.curves[0];
        const t = 0.517, u = 1 - t;
        const x = u ** 3 * c.x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x3;
        const y = u ** 3 * c.y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y3;
        expect(findOverviewConnectionAtPoint(paths.curves, x, y)).toBe("long");
    });
    it("selects the nearest edge when the click is on a Bézier curve", () => {
        const paths = buildOverviewConnectionPaths(connections, byId, null, new Set());
        const ab = paths.curves[0];
        const x = (ab.x0 + 3 * ab.x1 + 3 * ab.x2 + ab.x3) / 8;
        const y = (ab.y0 + 3 * ab.y1 + 3 * ab.y2 + ab.y3) / 8;
        expect(findOverviewConnectionAtPoint(paths.curves, x, y)).toBe("ab");
        expect(findOverviewConnectionAtPoint(paths.curves, x, y + 100)).toBeNull();
    });
});
