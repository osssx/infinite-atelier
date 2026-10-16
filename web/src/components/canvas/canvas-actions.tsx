import { createContext, useContext, useMemo, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import type { CanvasNodeData, Position } from "@/types/canvas";

/**
 * Every node-level callback, in one place.
 *
 * A context rather than ~19 props on every node: the consumers sit four levels below the layer
 * (CanvasNode -> NodeContent -> ImageContent -> ExpandedImageCard), so threading them through would be
 * mostly noise. It is also the only way to keep memoization honest — see the provider below.
 */
export type CanvasActions = {
    onMouseDown: (event: ReactMouseEvent, nodeId: string) => void;
    onSelectCapture: (event: ReactMouseEvent, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => void;
    onResizeStart: (nodeId: string) => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onResizeEnd: (nodeId: string) => void;
    onContentChange: (nodeId: string, content: string) => void;
    onTitleChange: (nodeId: string, title: string) => void;
    onContextMenu: (event: ReactMouseEvent, nodeId: string) => void;
    onToggleBatch: (nodeId: string) => void;
    onSetBatchPrimary: (nodeId: string, imageId: string) => void;
    onDuplicateBatchImage: (node: CanvasNodeData, imageId: string) => void;
    onRetryBatchImage: (node: CanvasNodeData, imageId: string) => void;
    onDeleteBatchImage: (nodeId: string, imageId: string) => void;
    onRetry: (node: CanvasNodeData) => void;
    onGenerateImage: (node: CanvasNodeData) => void;
    onViewImage: (node: CanvasNodeData, imageId?: string) => void;
};

const CanvasActionsContext = createContext<CanvasActions | null>(null);

/**
 * Hands consumers a permanently stable `CanvasActions` whose members read the newest implementations
 * through a ref.
 *
 * Without this, the context value would change whenever any single callback's identity does. Most
 * callbacks are already `useCallback([])`, but `onRetry`, `onGenerateImage` and the batch handlers
 * depend on `effectiveConfig` / `t` / `message`, so a settings or locale change would re-render every
 * visible node. The facade makes that class of bug impossible here rather than merely unlikely.
 */
export function CanvasActionsProvider({ actions, children }: { actions: CanvasActions; children: ReactNode }) {
    const latest = useRef(actions);
    latest.current = actions;

    const stable = useMemo<CanvasActions>(
        () => ({
            onMouseDown: (event, nodeId) => latest.current.onMouseDown(event, nodeId),
            onSelectCapture: (event, nodeId) => latest.current.onSelectCapture(event, nodeId),
            onHoverStart: (nodeId) => latest.current.onHoverStart(nodeId),
            onHoverEnd: (nodeId) => latest.current.onHoverEnd(nodeId),
            onConnectStart: (event, nodeId, handleType) => latest.current.onConnectStart(event, nodeId, handleType),
            onResizeStart: (nodeId) => latest.current.onResizeStart(nodeId),
            onResize: (nodeId, width, height, position) => latest.current.onResize(nodeId, width, height, position),
            onResizeEnd: (nodeId) => latest.current.onResizeEnd(nodeId),
            onContentChange: (nodeId, content) => latest.current.onContentChange(nodeId, content),
            onTitleChange: (nodeId, title) => latest.current.onTitleChange(nodeId, title),
            onContextMenu: (event, nodeId) => latest.current.onContextMenu(event, nodeId),
            onToggleBatch: (nodeId) => latest.current.onToggleBatch(nodeId),
            onSetBatchPrimary: (nodeId, imageId) => latest.current.onSetBatchPrimary(nodeId, imageId),
            onDuplicateBatchImage: (node, imageId) => latest.current.onDuplicateBatchImage(node, imageId),
            onRetryBatchImage: (node, imageId) => latest.current.onRetryBatchImage(node, imageId),
            onDeleteBatchImage: (nodeId, imageId) => latest.current.onDeleteBatchImage(nodeId, imageId),
            onRetry: (node) => latest.current.onRetry(node),
            onGenerateImage: (node) => latest.current.onGenerateImage(node),
            onViewImage: (node, imageId) => latest.current.onViewImage(node, imageId),
        }),
        [],
    );

    return <CanvasActionsContext.Provider value={stable}>{children}</CanvasActionsContext.Provider>;
}

export function useCanvasActions() {
    const actions = useContext(CanvasActionsContext);
    if (!actions) throw new Error("useCanvasActions must be used within CanvasActionsProvider");
    return actions;
}
