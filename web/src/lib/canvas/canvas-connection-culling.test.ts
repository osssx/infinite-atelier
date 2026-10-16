import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { buildCanvasFixture, createSeededRandom } from "./canvas-fixtures";
import { connectionControlHull, connectionControlPoints, cullConnections, rectsIntersect, type WorldRect } from "./canvas-connection-culling";

// Mirrors the path string built in canvas-connections.tsx, independently of the module under test:
//   M startX startY C (startX + curvature) startY, (endX - curvature) endY, endX endY
// with curvature = max(|endX - startX| / 2, 50).
function expectedControlPoints(from: CanvasNodeData, to: CanvasNodeData) {
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
    return { startX, startY, endX, endY, control1X: startX + curvature, control1Y: startY, control2X: endX - curvature, control2Y: endY };
}

function sampleCurve(points: ReturnType<typeof expectedControlPoints>, t: number) {
    const mt = 1 - t;
    return {
        x: mt ** 3 * points.startX + 3 * t * mt ** 2 * points.control1X + 3 * t ** 2 * mt * points.control2X + t ** 3 * points.endX,
        y: mt ** 3 * points.startY + 3 * t * mt ** 2 * points.control1Y + 3 * t ** 2 * mt * points.control2Y + t ** 3 * points.endY,
    };
}

const SAMPLES = 400;
const samplePoints = (from: CanvasNodeData, to: CanvasNodeData) => {
    const points = expectedControlPoints(from, to);
    return Array.from({ length: SAMPLES + 1 }, (_, index) => sampleCurve(points, index / SAMPLES));
};

const node = (id: string, x: number, y: number, width: number, height: number): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x, y }, width, height, metadata: {} });

describe("connection culling", () => {
    it("derives the same control points as the rendered path", () => {
        const { nodes, connections } = buildCanvasFixture({ nodeCount: 40, seed: 5 });
        const byId = new Map(nodes.map((item) => [item.id, item]));

        for (const connection of connections) {
            const from = byId.get(connection.fromNodeId)!;
            const to = byId.get(connection.toNodeId)!;
            expect(connectionControlPoints(from, to)).toEqual(expectedControlPoints(from, to));
        }
    });

    it("keeps the whole curve inside the control hull, including backwards edges", () => {
        const { nodes, connections } = buildCanvasFixture({ nodeCount: 60, seed: 11 });
        const byId = new Map(nodes.map((item) => [item.id, item]));
        // A pair whose curve loops back past both endpoints.
        const backwards = [node("b-from", 5000, 0, 120, 80), node("b-to", 0, 400, 120, 80)];

        for (const [from, to] of [...connections.map((connection) => [byId.get(connection.fromNodeId)!, byId.get(connection.toNodeId)!] as const), [backwards[0], backwards[1]] as const]) {
            const hull = connectionControlHull(from, to);
            for (const point of samplePoints(from, to)) {
                expect(point.x).toBeGreaterThanOrEqual(hull.left - 1e-6);
                expect(point.x).toBeLessThanOrEqual(hull.right + 1e-6);
                expect(point.y).toBeGreaterThanOrEqual(hull.top - 1e-6);
                expect(point.y).toBeLessThanOrEqual(hull.bottom + 1e-6);
            }
        }
    });

    it("never drops a connection whose curve crosses the viewport", () => {
        const random = createSeededRandom(99);
        const { nodes, connections } = buildCanvasFixture({ nodeCount: 60, seed: 3, connectionRatio: 2 });
        const byId = new Map(nodes.map((item) => [item.id, item]));

        for (let attempt = 0; attempt < 200; attempt += 1) {
            const left = Math.floor((random() - 0.5) * 14000);
            const top = Math.floor((random() - 0.5) * 14000);
            const rect: WorldRect = { left, top, right: left + Math.floor(random() * 2500), bottom: top + Math.floor(random() * 1800) };
            const kept = new Set(cullConnections(connections, byId, rect).map((connection) => connection.id));

            for (const connection of connections) {
                const from = byId.get(connection.fromNodeId)!;
                const to = byId.get(connection.toNodeId)!;
                // A curve actually inside the rect must have been kept. Extra kept edges are fine —
                // the test is conservative, only false negatives are failures.
                const crosses = samplePoints(from, to).some((point) => point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom);
                if (crosses) expect(kept.has(connection.id), `${connection.id} crossed the viewport but was culled`).toBe(true);
            }
        }
    });

    it("keeps a backwards edge that crosses the viewport with both endpoints outside it", () => {
        const from = node("from", 5000, 0, 120, 80);
        const to = node("to", 0, 400, 120, 80);
        const byId = new Map([
            [from.id, from],
            [to.id, to],
        ]);
        const connection = { id: "loop", fromNodeId: from.id, toNodeId: to.id };

        const middle = sampleCurve(expectedControlPoints(from, to), 0.5);
        const rect: WorldRect = { left: middle.x - 40, top: middle.y - 40, right: middle.x + 40, bottom: middle.y + 40 };

        // Guard the premise: this is only interesting if neither endpoint box touches the viewport.
        expect(rectsIntersect({ left: from.position.x, top: from.position.y, right: from.position.x + from.width, bottom: from.position.y + from.height }, rect)).toBe(false);
        expect(rectsIntersect({ left: to.position.x, top: to.position.y, right: to.position.x + to.width, bottom: to.position.y + to.height }, rect)).toBe(false);

        expect(cullConnections([connection], byId, rect).map((item) => item.id)).toEqual(["loop"]);
    });

    it("drops connections with a missing endpoint, as the renderer did", () => {
        const from = node("from", 0, 0, 100, 100);
        const byId = new Map([[from.id, from]]);
        const rect: WorldRect = { left: -1000, top: -1000, right: 1000, bottom: 1000 };

        expect(cullConnections([{ id: "dangling", fromNodeId: "from", toNodeId: "gone" }], byId, rect)).toEqual([]);
    });

    it("always keeps the selected connection, even off screen", () => {
        const from = node("from", 0, 0, 100, 100);
        const to = node("to", 400, 0, 100, 100);
        const byId = new Map([
            [from.id, from],
            [to.id, to],
        ]);
        const connection = { id: "selected", fromNodeId: "from", toNodeId: "to" };
        const rect: WorldRect = { left: 100000, top: 100000, right: 100100, bottom: 100100 };

        expect(cullConnections([connection], byId, rect)).toEqual([]);
        expect(cullConnections([connection], byId, rect, { keepIds: new Set(["selected"]) }).map((item) => item.id)).toEqual(["selected"]);
    });
});
