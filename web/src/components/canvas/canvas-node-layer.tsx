import { memo } from "react";

import type { CanvasNodeData } from "@/types/canvas";
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
    return (
        <>
            {nodes.map((node) => {
                // Preserve full editing/connection affordances for the active target, but keep
                // all other nodes as cheap DOM hit rectangles in overview mode.
                const showFull = !compactMode || panelNodeId === node.id || connectionTargetNodeId === node.id || activeNodeId === node.id || (selectedNodeIds.size === 1 && selectedNodeIds.has(node.id));
                if (!showFull) return (
                    <CompactCanvasNode
                        key={node.id}
                        data={node}
                        isSelected={selectedNodeIds.has(node.id)}
                        isRelated={relatedNodeIds.has(node.id)}
                        isGroupDropTarget={dropTargetGroupId === node.id}
                    />
                );
                return <CanvasNode
                    {...shared}
                    key={node.id}
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
