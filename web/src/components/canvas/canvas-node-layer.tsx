import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { CanvasNodeData } from "@/types/canvas";
import { shouldPromoteHoveredNode, shouldRenderFullNode, shouldUseCompactNodeLayer } from "@/lib/canvas/canvas-lod";
import { shouldShowCompactImage } from "@/lib/canvas/canvas-lod-preview";
import { choosePromotionBatch, orderNodePromotions } from "@/lib/canvas/canvas-node-promotion";
import { PERF_MODE } from "@/lib/perf-mode";
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
    /** World-space viewport center for gradual promotion of nearby editors first. */
    centerX: number;
    centerY: number;
    /** Avoid mounting media/editors in the middle of pan, drag, resize or marquee. */
    pausePromotions: boolean;
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
    centerX,
    centerY,
    pausePromotions,
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

    // Pause new hydration during a gesture, but retain editors already mounted:
    // unmounting an active text editor or a multi-selected drag source is destructive.
    const [promotedIds, setPromotedIds] = useState<ReadonlySet<string>>(() => new Set());
    const previousFrameRef = useRef<number | null>(null);
    const lastCommitMsRef = useRef(0);
    const renderStartRef = useRef(performance.now());
    renderStartRef.current = performance.now();
    useLayoutEffect(() => {
        lastCommitMsRef.current = performance.now() - renderStartRef.current;
    });

    useEffect(() => {
        if (!compactMode) return;
        previousFrameRef.current = null;
        setPromotedIds((previous) => previous.size ? new Set() : previous);
    }, [compactMode]);

    const priorityIds = useMemo(() => {
        const ids = new Set(playingNodeIds);
        if (selectedNodeIds.size === 1) for (const id of selectedNodeIds) ids.add(id);
        if (activeNodeId) ids.add(activeNodeId);
        if (connectionTargetNodeId) ids.add(connectionTargetNodeId);
        if (panelNodeId) ids.add(panelNodeId);
        return ids;
    }, [playingNodeIds, selectedNodeIds, activeNodeId, connectionTargetNodeId, panelNodeId]);

    // Directly pinned editors have already paid the mount cost. Record them so a
    // hover/selection release cannot immediately tear them down during recovery.
    useEffect(() => {
        if (compactMode || nodes.length < 24 || !priorityIds.size) return;
        const visible = new Set(nodes.map(({ id }) => id));
        setPromotedIds((previous) => {
            const missing = [...priorityIds].filter((id) => visible.has(id) && !previous.has(id));
            if (!missing.length) return previous;
            const next = new Set(previous);
            for (const id of missing) next.add(id);
            return next;
        });
    }, [compactMode, nodes, priorityIds]);

    // Do not sort the node list on every pan/zoom frame when editors are
    // intentionally compact or admission is paused.
    const candidates = useMemo(
        () => compactMode || pausePromotions || nodes.length < 24
            ? []
            : orderNodePromotions(nodes, centerX, centerY, priorityIds),
        [compactMode, pausePromotions, nodes, centerX, centerY, priorityIds],
    );

    // Keep a single pending rAF. React commits report a rough render+commit cost;
    // together with frame spacing this bounds promotion to 1-4 weighted units.
    useEffect(() => {
        if (compactMode || pausePromotions || nodes.length < 24) return;
        if (candidates.every((candidate) => promotedIds.has(candidate.id))) return;
        const frame = requestAnimationFrame((now) => {
            const interval = previousFrameRef.current == null ? 16.7 : Math.min(100, now - previousFrameRef.current);
            previousFrameRef.current = now;
            const batch = choosePromotionBatch(candidates, promotedIds, interval, lastCommitMsRef.current);
            if (!batch.length) return;
            setPromotedIds((previous) => {
                if (batch.every((id) => previous.has(id))) return previous;
                const next = new Set(previous);
                for (const id of batch) next.add(id);
                return next;
            });
        });
        return () => cancelAnimationFrame(frame);
    }, [compactMode, pausePromotions, candidates, promotedIds, nodes.length]);
    // data-node-id stays constant through promotion; expose a perf-only settling marker.
    const isRecovering = PERF_MODE && !compactMode && nodes.length >= 24 &&
        (pausePromotions || candidates.some(({ id }) => !promotedIds.has(id)));

    return (
        <>
            {PERF_MODE && isRecovering ? <span hidden data-canvas-lod-recovering="" /> : null}
            {nodes.map((node) => {
                // Preserve full editing/connection affordances for the active target, but keep
                // all other nodes as cheap DOM hit rectangles in overview mode.
                const stagedCompact = compactMode || (nodes.length >= 24 && !promotedIds.has(node.id));
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
