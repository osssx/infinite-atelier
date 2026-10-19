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

// ---------------------------------------------------------------------------
// Pipeline attribution
// ---------------------------------------------------------------------------

/**
 * Where a frame's main-thread time goes, accumulated across a measurement round.
 *
 * Exists to answer a question the frame-time numbers cannot: at 3000 nodes panning measured 970ms a
 * frame while every observable scale metric — mounted nodes, edges, DOM, paths — was within 1.2-1.7x
 * of the 1000-node case that runs at 16.3ms. Something costs 59x and none of the obvious size
 * measures show it, so measuring the candidates directly is the only way to find out which one it is
 * (or to establish that none of them is, and stop looking here).
 */
export type PipelineTimings = {
    /**
     * React render + commit, measured from the bridge's own render body to its layout effect. The
     * bridge is the first child of the page's root element, so the whole canvas subtree renders after
     * it and is included. Approximate for anything rendered before it — noted, not hidden.
     */
    renderMs: number;
    /** Renders counted. More than one per frame would itself be a finding. */
    renders: number;
    graphIndexMs: number;
    graphIndexNodes: number;
    visibleNodesMs: number;
    visibleNodesCount: number;
    visibleConnectionsMs: number;
    visibleConnectionsCount: number;
    sidePanelMs: number;
    sidePanelCount: number;
    /** State updates the page issued, to catch a setState loop. */
    setStateCalls: number;
};

const emptyTimings = (): PipelineTimings => ({
    renderMs: 0,
    renders: 0,
    graphIndexMs: 0,
    graphIndexNodes: 0,
    visibleNodesMs: 0,
    visibleNodesCount: 0,
    visibleConnectionsMs: 0,
    visibleConnectionsCount: 0,
    sidePanelMs: 0,
    sidePanelCount: 0,
    setStateCalls: 0,
});

let pipelineTimings = emptyTimings();

/** A handle onto the live accumulator, for callers that cannot import the sink directly. */
export const pipelineSink = {
    addMs(key: "renderMs" | "graphIndexMs" | "visibleNodesMs" | "visibleConnectionsMs" | "sidePanelMs", ms: number) {
        pipelineTimings[key] += ms;
    },
    count(key: "renders" | "graphIndexNodes" | "visibleNodesCount" | "visibleConnectionsCount" | "sidePanelCount" | "setStateCalls", n = 1) {
        pipelineTimings[key] += n;
    },
};

/** Snapshots and clears, so each measurement round reports only its own work. */
export function drainPipelineTimings(): PipelineTimings {
    const snapshot = pipelineTimings;
    pipelineTimings = emptyTimings();
    return snapshot;
}