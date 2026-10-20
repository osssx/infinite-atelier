import { memo, useCallback, useEffect, useRef, useState } from "react";

import type { CanvasNodeData } from "@/types/canvas";
import { shouldPromoteHoveredNode, shouldRenderFullNode, shouldUseCompactNodeLayer } from "@/lib/canvas/canvas-lod";
import { shouldShowCompactImage } from "@/lib/canvas/canvas-lod-preview";
import type { CanvasNodeProps } from "./canvas-node";
import { CanvasNodeHandoff } from "./canvas-node-handoff";

/**
 * Everything a node needs except its own data and the values the layer computes per node. Callers
 * pass this as one object so the layer's prop list stays readable; `CanvasNode` still receives each
 * entry as its own prop, so `React.memo` on the node compares them individually and an unstable
 * entry re-renders only the nodes it actually affects.
 */
export type SharedNodeProps = Omit<
    CanvasNodeProps,
    "data" | "isSelected" | "isRelated" | "isFocusRelated" | "isConnectionTarget" | "isConnecting" | "showPanel" | "showImageInfo" | "groupChildCount" | "isGroupDropTarget" | "batchExpanded"
>;

type NodeLayerProps = {
    /** Already culled to the viewport by the controller. */
    nodes: CanvasNodeData[];
    /** Wheel activity temporarily pins crowded scenes in lightweight mode. */
    wheelZoomActive: boolean;
    /** A primitive scale used only to decide when tiny image previews become legible. */
    scale: number;
    shared: SharedNodeProps;
    selectedNodeIds: ReadonlySet<string>;
    relatedNodeIds: ReadonlySet<string>;
    activeNodeId: string | null;
    connectionTargetNodeId: string | null;
    isConnecting: boolean;
    /** The node whose lower panel is open, if any. */
    panelNodeId: string | null;
    isNodeResizing: boolean;
    /** True while a marquee is being dragged; panels are suppressed then. */
    isMarqueeActive: boolean;
    dropTargetGroupId: string | null;
    expandedImageNodeIds: ReadonlySet<string>;
    showImageInfo: boolean;
    groupChildCountById: ReadonlyMap<string, number>;
};

/**
 * Memoized so controller state that no node cares about — open dialogs, title drafts, history
 * buttons, the draft connection's pointer position — never reaches the node tree.
 */
export const NodeLayer = memo(function NodeLayer({
    nodes,
    shared,
    wheelZoomActive,
    scale,
    selectedNodeIds,
    relatedNodeIds,
    activeNodeId,
    connectionTargetNodeId,
    isConnecting,
    panelNodeId,
    isNodeResizing,
    isMarqueeActive,
    dropTargetGroupId,
    expandedImageNodeIds,
    showImageInfo,
    groupChildCountById,
}: NodeLayerProps) {
    // Pin actively playing media in the full node while it is visible, even after selection
    // and hover end. Otherwise compact LOD unmounts the <video>/<audio>, losing playback.
    const [playingNodeIds, setPlayingNodeIds] = useState<ReadonlySet<string>>(() => new Set());
    const onMediaPlaybackChange = useCallback((nodeId: string, playing: boolean) => {
        setPlayingNodeIds((previous) => {
            if (previous.has(nodeId) === playing) return previous;
            const next = new Set(previous);
            if (playing) next.add(nodeId);
            else next.delete(nodeId);
            return next;
        });
    }, []);

    // Keep a stable decision across 0.30–0.42 zoom and moderate visible-count changes.
    const compactRef = useRef(false);
    const compactMode = shouldUseCompactNodeLayer(nodes.length, scale, wheelZoomActive, compactRef.current);
    compactRef.current = compactMode;

    // After a dense zoom we must not mount every JPEG/video/editor in the same frame.
    // Revealing a few full nodes per paint distributes decode and DOM creation over frames,
    // including the post-wheel settling period (which the interactive zoom sample misses).
    const [revealedCount, setRevealedCount] = useState(Number.POSITIVE_INFINITY);
    useEffect(() => {
        if (compactMode) setRevealedCount(0);
    }, [compactMode]);
    useEffect(() => {
        if (compactMode || revealedCount >= nodes.length) return;
        const frame = requestAnimationFrame(() => {
            setRevealedCount((count) => Math.min(count + 2, nodes.length));
        });
        return () => cancelAnimationFrame(frame);
    }, [compactMode, revealedCount, nodes.length]);

    return (
        <>
            {nodes.map((node, index) => {
                // Preserve full editing/connection affordances for the active target, but keep
                // all other nodes as cheap DOM hit rectangles in overview mode.
                const stagedCompact = compactMode || index >= revealedCount;
                // Hover-only promotion is suspended during wheel input. An otherwise pinned
                // heavy media/editor node can stall zoom; selection and playing media still win.
                const hoveredForPromotion = shouldPromoteHoveredNode(scale, node.width, node.height, wheelZoomActive) ? activeNodeId : null;
                const showFull = shouldRenderFullNode(node.id, stagedCompact, selectedNodeIds, hoveredForPromotion, connectionTargetNodeId, panelNodeId, playingNodeIds.has(node.id));
                return <CanvasNodeHandoff
                    key={node.id}
                    shared={shared}
                    data={node}
                    showFull={showFull}
                    showImagePreview={shouldShowCompactImage(scale, node.width, node.height)}
                    isSelected={selectedNodeIds.has(node.id)}
                    isRelated={relatedNodeIds.has(node.id)}
                    isFocusRelated={hoveredForPromotion === node.id}
                    isConnectionTarget={connectionTargetNodeId === node.id}
                    isConnecting={isConnecting}
                    showPanel={!isNodeResizing && panelNodeId === node.id && !isMarqueeActive}
                    groupChildCount={groupChildCountById.get(node.id) || 0}
                    isGroupDropTarget={dropTargetGroupId === node.id}
                    batchExpanded={expandedImageNodeIds.has(node.id)}
                    showImageInfo={showImageInfo}
                    onMediaPlaybackChange={onMediaPlaybackChange}
                />;
            })}
        </>
    );
});
