/**
 * Below readable zoom, large visible sets switch from full editor nodes to lightweight
 * hit rectangles. Keep editing zoom and modest scenes fully interactive.
 */
/**
 * Hysteresis prevents the same group of nodes from alternating between compact/full when
 * wheel input oscillates near a threshold. Start compact at <0.30 and return full at >=0.42.
 * A wheel burst can temporarily force compact while at least 24 nodes are visible.
 */
export function shouldUseCompactNodeLayer(
    visibleCount: number,
    scale: number,
    wheelZoomActive = false,
    wasCompact = false,
): boolean {
    if (wheelZoomActive && visibleCount >= 24) return true;
    if (wasCompact) return visibleCount >= 56 && scale < 0.42;
    return visibleCount >= 72 && scale < 0.30;
}

/** Tiny overview nodes should not mount a full editor just because the cursor grazes them. */
export function shouldPromoteHoveredNode(
    scale: number,
    width: number,
    height: number,
    wheelZoomActive = false,
): boolean {
    return !wheelZoomActive && Math.min(width, height) * scale >= 72;
}

/** Promote the node back to its full interactive editor when it is the actual interaction target. */
export function shouldRenderFullNode(
    nodeId: string,
    compactMode: boolean,
    selectedNodeIds: ReadonlySet<string>,
    activeNodeId: string | null,
    connectionTargetNodeId: string | null,
    panelNodeId: string | null,
    isMediaPlaying = false,
): boolean {
    return !compactMode ||
        isMediaPlaying ||
        panelNodeId === nodeId ||
        connectionTargetNodeId === nodeId ||
        activeNodeId === nodeId ||
        (selectedNodeIds.size === 1 && selectedNodeIds.has(nodeId));
}