/**
 * Below readable zoom, large visible sets switch from full editor nodes to lightweight
 * hit rectangles. Keep editing zoom and modest scenes fully interactive.
 */
export function shouldUseCompactNodeLayer(visibleCount: number, scale: number): boolean {
    return visibleCount >= 72 && scale < 0.35;
}

/** Promote the node back to its full interactive editor when it is the actual interaction target. */
export function shouldRenderFullNode(
    nodeId: string,
    compactMode: boolean,
    selectedNodeIds: ReadonlySet<string>,
    activeNodeId: string | null,
    connectionTargetNodeId: string | null,
    panelNodeId: string | null,
): boolean {
    return !compactMode ||
        panelNodeId === nodeId ||
        connectionTargetNodeId === nodeId ||
        activeNodeId === nodeId ||
        (selectedNodeIds.size === 1 && selectedNodeIds.has(nodeId));
}