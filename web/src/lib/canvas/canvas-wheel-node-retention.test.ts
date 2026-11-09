import { describe, expect, it } from "vitest";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { CANVAS_WHEEL_NODE_RETENTION_LIMIT, updateCanvasWheelNodeRetention, type CanvasWheelNodeRetention } from "./canvas-wheel-node-retention";

function node(id: string, x = 0, title = id): CanvasNodeData {
    return { id, type: CanvasNodeType.Text, title, position: { x, y: 0 }, width: 180, height: 120, metadata: { content: `${title} body` } };
}

const emptyRetention: CanvasWheelNodeRetention = { nodes: [], seenIds: [] };

describe("wheel gesture node retention", () => {
    it("unions prior and current visible nodes using canonical latest objects", () => {
        const a = node("a");
        const b = node("b");
        const c = node("c");
        const first = updateCanvasWheelNodeRetention([a, b], [a, b, c], emptyRetention, true, new Set());
        const latestA = node("a", 25, "updated a");
        const next = updateCanvasWheelNodeRetention([c], [latestA, b, c], first, true, new Set());
        expect(next.nodes.map(({ id }) => id)).toEqual(["a", "b", "c"]);
        expect(next.nodes[0]).toBe(latestA);
        expect(next.nodes[0].position.x).toBe(25);
    });

    it("immediately removes deleted IDs from retained DOM and keeps active nodes", () => {
        const a = node("a");
        const b = node("b");
        const first = updateCanvasWheelNodeRetention([a, b], [a, b], emptyRetention, true, new Set());
        const next = updateCanvasWheelNodeRetention([], [a], first, true, new Set(["a"]));
        expect(next.nodes.map(({ id }) => id)).toEqual(["a"]);
        expect(next.seenIds).not.toContain("b");
    });

    it("releases the retained set when wheel input ends and returns the actual visible array", () => {
        const a = node("a");
        const b = node("b");
        const visible = [b];
        const during = updateCanvasWheelNodeRetention([a, b], [a, b], emptyRetention, true, new Set());
        const ended = updateCanvasWheelNodeRetention(visible, [a, b], during, false, new Set());
        expect(ended.nodes).toBe(visible);
        expect(ended.nodes.map(({ id }) => id)).toEqual(["b"]);
        expect(ended.seenIds).toEqual([]);
    });

    it("bounds retention to 512 IDs while prioritizing active nodes and visible order", () => {
        const graph = Array.from({ length: CANVAS_WHEEL_NODE_RETENTION_LIMIT + 88 }, (_, index) => node(`n-${index}`));
        const result = updateCanvasWheelNodeRetention(graph, graph, emptyRetention, true, new Set(["n-599"]));
        expect(result.nodes).toHaveLength(CANVAS_WHEEL_NODE_RETENTION_LIMIT);
        expect(result.seenIds).toHaveLength(CANVAS_WHEEL_NODE_RETENTION_LIMIT);
        expect(result.nodes.some(({ id }) => id === "n-599")).toBe(true);
        expect(result.nodes[0].id).toBe("n-0");
    });

    it("does not exceed the cap when active IDs already fill it before visible or previous IDs", () => {
        const graph = Array.from({ length: CANVAS_WHEEL_NODE_RETENTION_LIMIT + 2 }, (_, index) => node(`edge-${index}`));
        const active = new Set(graph.slice(0, CANVAS_WHEEL_NODE_RETENTION_LIMIT).map(({ id }) => id));
        const previous = { nodes: graph.slice(0, CANVAS_WHEEL_NODE_RETENTION_LIMIT), seenIds: ["edge-513"] };
        const result = updateCanvasWheelNodeRetention([graph[512]], graph, previous, true, active);
        expect(result.nodes).toHaveLength(CANVAS_WHEEL_NODE_RETENTION_LIMIT);
        expect(result.seenIds).toHaveLength(CANVAS_WHEEL_NODE_RETENTION_LIMIT);
        expect(result.nodes.some(({ id }) => id === "edge-512" || id === "edge-513")).toBe(false);
    });

    it("reuses the ordered render array when canonical node objects do not change", () => {
        const a = node("a");
        const b = node("b");
        const first = updateCanvasWheelNodeRetention([a, b], [a, b], emptyRetention, true, new Set());
        const second = updateCanvasWheelNodeRetention([b], [a, b], first, true, new Set());
        expect(second.nodes).toBe(first.nodes);
    });
});
