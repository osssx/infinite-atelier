import { memo, useCallback, useEffect, useState } from "react";

import type { CanvasNodeData } from "@/types/canvas";
import { shouldRenderFullNode } from "@/lib/canvas/canvas-lod";
import { shouldShowCompactImage } from "@/lib/canvas/canvas-lod-preview";
import { CanvasNode, type CanvasNodeProps } from "./canvas-node";
import { CompactCanvasNode } from "./canvas-node-compact";

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
    /** Density-aware simplified render, without media and editor descendants. */
    compactMode: boolean;
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
    compactMode,
    selectedNodeIds,    scale,

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
                const showFull = shouldRenderFullNode(node.id, stagedCompact, selectedNodeIds, activeNodeId, connectionTargetNodeId, panelNodeId, playingNodeIds.has(node.id));
                if (!showFull) return (
                    <CompactCanvasNode
                        key={node.id}
                        data={node}
                        isSelected={selectedNodeIds.has(node.id)}
                        showImagePreview={shouldShowCompactImage(scale, node.width, node.height)}
                        groupChildCount={groupChildCountById.get(node.id) || 0}
                        isRelated={relatedNodeIds.has(node.id)}
                        isGroupDropTarget={dropTargetGroupId === node.id}
                    />
                );
                return <CanvasNode
                    {...shared}
                    key={node.id}
                    onMediaPlaybackChange={onMediaPlaybackChange}
                    data={node}
                    isSelected={selectedNodeIds.has(node.id)}
                    isRelated={relatedNodeIds.has(node.id)}
                    isFocusRelated={activeNodeId === node.id}
                    isConnectionTarget={connectionTargetNodeId === node.id}
                    isConnecting={isConnecting}
                    showPanel={!isNodeResizing && panelNodeId === node.id && !isMarqueeActive}
                    groupChildCount={groupChildCountById.get(node.id) || 0}
                    isGroupDropTarget={dropTargetGroupId === node.id}
                    batchExpanded={expandedImageNodeIds.has(node.id)}
                    showImageInfo={showImageInfo}
                />;
            })}
        </>
    );
});
