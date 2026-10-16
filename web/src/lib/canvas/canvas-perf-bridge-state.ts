import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

/**
 * Live snapshot of the canvas page's state, written by `CanvasPerfBridge` and read by the perf harness.
 *
 * A plain mutable object in an import-free module on purpose. The bridge is statically imported by
 * `project.tsx`, so it must not drag the harness into the normal bundle; and the harness needs the
 * canvas's own `viewport` / selection, which live in component state and have no DOM equivalent.
 * Sharing them through a module is what lets the instrumentation stay a byte-identical one-liner in
 * every measured tree, instead of depending on each tree's (very different) component internals.
 */
export type CanvasPerfBridgeState = {
    viewport: ViewportTransform;
    selectedNodeIds: ReadonlySet<string>;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    /** The canvas's scroll/transform container, for DOM queries and synthetic event targets. */
    container: HTMLElement | null;
    setViewport: ((viewport: ViewportTransform) => void) | null;
    /**
     * Incremented every time the canvas page finishes loading. Each measurement round waits for this
     * to advance past the value it saw before navigating, so a late signal from a previous round can
     * never be mistaken for the current one.
     */
    readyToken: number;
};

export const canvasPerfBridgeState: CanvasPerfBridgeState = {
    viewport: { x: 0, y: 0, k: 1 },
    selectedNodeIds: new Set<string>(),
    nodes: [],
    connections: [],
    container: null,
    setViewport: null,
    readyToken: 0,
};
