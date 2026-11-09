import type { CanvasNodeData } from "@/types/canvas";

export const CANVAS_WHEEL_NODE_RETENTION_LIMIT = 512;

export type CanvasWheelNodeRetention = {
    /** Render order stays in canonical graph order. */
    nodes: CanvasNodeData[];
    /** Most recently prioritized IDs retained for this wheel gesture only. */
    seenIds: string[];
};

/** Preserve lightweight LOD roots crossed during one wheel gesture, without changing graph geometry. */
export function updateCanvasWheelNodeRetention(
    visibleNodes: CanvasNodeData[],
    canonicalNodes: CanvasNodeData[],
    previous: CanvasWheelNodeRetention,
    wheelActive: boolean,
    activeNodeIds: ReadonlySet<string>,
    limit = CANVAS_WHEEL_NODE_RETENTION_LIMIT,
): CanvasWheelNodeRetention {
    if (!wheelActive) return { nodes: visibleNodes, seenIds: [] };

    const safeLimit = Math.max(0, Math.floor(Number.isFinite(limit) ? limit : CANVAS_WHEEL_NODE_RETENTION_LIMIT));
    if (safeLimit === 0) return { nodes: [], seenIds: [] };
    const canonicalById = new Map(canonicalNodes.map((node) => [node.id, node]));
    const prioritizedIds = new Set<string>();
    for (const nodeId of activeNodeIds) {
        if (prioritizedIds.size >= safeLimit) break;
        if (canonicalById.has(nodeId)) prioritizedIds.add(nodeId);
    }
    for (const node of visibleNodes) {
        if (prioritizedIds.size >= safeLimit) break;
        if (canonicalById.has(node.id)) prioritizedIds.add(node.id);
    }
    for (const nodeId of previous.seenIds) {
        if (prioritizedIds.size >= safeLimit) break;
        if (canonicalById.has(nodeId)) prioritizedIds.add(nodeId);
    }

    const seenIds = [...prioritizedIds];
    const nodes = canonicalNodes.filter((node) => prioritizedIds.has(node.id));
    const sameNodes = previous.nodes.length === nodes.length && previous.nodes.every((node, index) => node === nodes[index]);
    return {
        nodes: sameNodes ? previous.nodes : nodes,
        seenIds: sameIds(previous.seenIds, seenIds) ? previous.seenIds : seenIds,
    };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((id, index) => id === right[index]);
}
