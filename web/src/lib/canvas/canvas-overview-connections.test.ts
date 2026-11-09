import { describe, expect, it } from "vitest";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { buildOverviewConnectionPaths, findOverviewConnectionAtPoint, partitionConnectionsForMovingNodes, refreshStationaryNodeMap, shouldUseOverviewConnections } from "./canvas-overview-connections";
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
    it("separates only edges incident to moving nodes for drag rendering", () => {
        const split = partitionConnectionsForMovingNodes(connections, new Set(["b"]));
        expect(split.moving.map((connection) => connection.id)).toEqual(["ab", "bc"]);
        expect(split.stationary).toEqual([]);
        const stationaryGraph = partitionConnectionsForMovingNodes(connections, new Set(["a"]));
        expect(stationaryGraph.moving.map((connection) => connection.id)).toEqual(["ab"]);
        expect(stationaryGraph.stationary.map((connection) => connection.id)).toEqual(["bc"]);
    });
    it("freezes moving-node geometry while refreshing unrelated nodes during a gesture", () => {
        const moved = { ...a, position: { x: 10, y: 0 } };
        const changedOther = { ...b, position: { x: 410, y: 110 } };
        const previous = new Map([[a.id, a], [b.id, b]]);
        const current = new Map([[a.id, moved], [b.id, changedOther], [c.id, c]]);
        const refreshed = refreshStationaryNodeMap(previous, current, new Set([a.id]));
        expect(refreshed).not.toBe(previous);
        expect(refreshed.get(a.id)).toBe(a);
        expect(refreshed.get(b.id)).toBe(changedOther);
        expect(refreshed.get(c.id)).toBe(c);
        expect(refreshStationaryNodeMap(previous, new Map([[a.id, moved], [b.id, b]]), new Set([a.id]))).toBe(previous);
    });
    it("batches the vector layer for every wheel zoom and preserves scale hysteresis afterward", () => {
        expect(shouldUseOverviewConnections(0.8,false,true)).toBe(true);
        expect(shouldUseOverviewConnections(0.8,true,false)).toBe(false);
        expect(shouldUseOverviewConnections(0.18,true,false)).toBe(true);
        expect(shouldUseOverviewConnections(0.22,false,false)).toBe(false);
        expect(shouldUseOverviewConnections(0.16,false,false)).toBe(true);
    });
    it("preserves cubic geometry and groups active edges without duplicating hit paths", () => {
        const paths = buildOverviewConnectionPaths(connections, byId, null, new Set(["bc"]));
        const ab = connectionControlPoints(a, b);
        const expected = `M ${ab.startX} ${ab.startY} C ${ab.control1X} ${ab.control1Y}, ${ab.control2X} ${ab.control2Y}, ${ab.endX} ${ab.endY}`;
        expect(paths.ordinary).toBe(expected);
        expect(paths.highlighted).toContain("M 520 150 C");
        expect(paths.hit.match(/M /g)).toHaveLength(2);
        expect(paths.curves.map((entry) => entry.id)).toEqual(["ab", "bc"]);
    });
    it("rebuilds incident edge geometry from transient drag deltas without replacing node data", () => {
        const delta = new Map([["a", { x: 35, y: -12 }]]);
        const moved = buildOverviewConnectionPaths([connections[0]], byId, null, new Set(), delta);
        const expected = connectionControlPoints({ ...a, position: { x: 35, y: -12 } }, b);
        expect(moved.curves[0]).toMatchObject({ x0: expected.startX, y0: expected.startY, x1: expected.control1X, y1: expected.control1Y });
        expect(a.position).toEqual({ x: 0, y: 0 });
        expect(buildOverviewConnectionPaths([connections[0]], byId, null, new Set()).curves[0]).not.toEqual(moved.curves[0]);
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
