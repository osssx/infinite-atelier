import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createSeededRandom } from "./canvas-fixtures";
import { findGroupDropTarget, findGroupDropTargetFromDelta } from "./canvas-node-geometry";

const group = (id: string, x: number, y: number, width: number, height: number): CanvasNodeData => ({ id, type: CanvasNodeType.Group, title: id, position: { x, y }, width, height, metadata: {} });
const image = (id: string, x: number, y: number, width = 200, height = 150): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x, y }, width, height, metadata: {} });

/** Mirrors the preview array the old per-mousemove path built. */
function previewNodes(nodes: CanvasNodeData[], movedIds: Set<string>, dx: number, dy: number) {
    return nodes.map((node) => (movedIds.has(node.id) ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node));
}

function buildScene() {
    return [
        group("g-0", -400, -300, 900, 700),
        group("g-1", 600, -200, 800, 600),
        group("g-2", -1200, 400, 1000, 800),
        image("n-0", -300, -200),
        image("n-1", 700, -100),
        image("n-2", -1100, 500),
        image("n-3", 2500, 1800),
        image("n-4", -2600, -1900),
        image("n-5", 100, 100),
    ];
}

describe("findGroupDropTargetFromDelta", () => {
    it("agrees with findGroupDropTarget for deltas that land a node inside a group", () => {
        const nodes = buildScene();
        // For each node/group pair, the delta that centres the node in the group.
        for (const target of nodes.filter((node) => node.type === CanvasNodeType.Group)) {
            for (const moving of nodes.filter((node) => node.type !== CanvasNodeType.Group)) {
                const dx = target.position.x + target.width / 2 - (moving.position.x + moving.width / 2);
                const dy = target.position.y + target.height / 2 - (moving.position.y + moving.height / 2);
                expectEquivalent(nodes, new Set([moving.id]), dx, dy);
            }
        }
    });

    it("agrees with findGroupDropTarget across random selections and deltas", () => {
        const random = createSeededRandom(2024);
        const nodes = buildScene();

        for (let attempt = 0; attempt < 500; attempt += 1) {
            const movedIds = new Set<string>();
            for (const node of nodes) if (random() < 0.4) movedIds.add(node.id);
            if (!movedIds.size) movedIds.add(nodes[Math.floor(random() * nodes.length)].id);

            const dx = Math.floor((random() - 0.5) * 4000);
            const dy = Math.floor((random() - 0.5) * 4000);
            expectEquivalent(nodes, movedIds, dx, dy);
        }
    });

    it("returns null whenever a group itself is being dragged", () => {
        const nodes = buildScene();
        const movedIds = new Set(["g-0", "n-0"]);

        expect(findGroupDropTarget(movedIds, previewNodes(nodes, movedIds, 500, 300))).toBeNull();
        expect(findGroupDropTargetFromDelta(nodes.filter((node) => movedIds.has(node.id)), nodes.filter((node) => node.type === CanvasNodeType.Group && !movedIds.has(node.id)).reverse(), 500, 300)).toBeNull();
    });

    it("prefers the last group in document order when several contain the node", () => {
        // Overlapping groups: g-1 is later in the array, so it wins.
        const nodes = [group("g-0", 0, 0, 800, 800), group("g-1", 100, 100, 800, 800), image("n-0", 2000, 2000)];
        const movedIds = new Set(["n-0"]);
        const dx = 300 - 2000;
        const dy = 300 - 2000;

        const legacy = findGroupDropTarget(movedIds, previewNodes(nodes, movedIds, dx, dy));
        const next = findGroupDropTargetFromDelta(nodes.filter((node) => movedIds.has(node.id)), nodes.filter((node) => node.type === CanvasNodeType.Group && !movedIds.has(node.id)).reverse(), dx, dy);

        expect(legacy?.id).toBe("g-1");
        expect(next?.id).toBe("g-1");
    });
});

function expectEquivalent(nodes: CanvasNodeData[], movedIds: Set<string>, dx: number, dy: number) {
    const legacy = findGroupDropTarget(movedIds, previewNodes(nodes, movedIds, dx, dy));
    const next = findGroupDropTargetFromDelta(
        nodes.filter((node) => movedIds.has(node.id)),
        nodes.filter((node) => node.type === CanvasNodeType.Group && !movedIds.has(node.id)).reverse(),
        dx,
        dy,
    );
    expect(next?.id ?? null, `moved ${[...movedIds].join(",")} by (${dx}, ${dy})`).toBe(legacy?.id ?? null);
}
