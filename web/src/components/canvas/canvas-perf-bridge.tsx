import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type RefObject } from "react";

import { canvasPerfBridgeState, pipelineSink } from "@/lib/canvas/canvas-perf-bridge-state";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

// Spelled out inline rather than imported from `perf-mode.ts`: Vite replaces this with `false` before
// Rollup runs, which makes every guarded branch provably dead — including the dynamic import below,
// so a normal build emits no chunk for the perf code at all. Constant propagation across a module
// boundary is a weaker guarantee than a literal, and this is the one place where it matters.
const PERF_MODE = import.meta.env.MODE === "perf";

type CanvasPerfBridgeProps = {
    containerRef: RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    setViewport: (viewport: ViewportTransform) => void;
    selectedNodeIds: ReadonlySet<string>;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

/**
 * Bridge between the canvas page and the measurement harness.
 *
 * Ships inert in every build. All of its work sits behind `PERF_MODE`, a compile-time constant, and
 * its one potentially heavy import — the panel — is a dynamic import inside that branch, so a normal
 * build emits no chunk for any of the perf code.
 *
 * It exists so the A/B comparison stays honest: the only edit this needs in the canvas page is one
 * import plus one JSX line, identical in both measured trees, instead of reaching into each tree's
 * (very different) component internals.
 *
 * Placement requirement: render it after the page's `!projectLoaded` early return, as a child of the
 * root `<main>`. Its own mount is then exactly the "project loaded and canvas mounted" signal, and
 * because it renders only a fixed-position panel (or null) it takes part in no layout.
 */
export function CanvasPerfBridge({ containerRef, viewport, setViewport, selectedNodeIds, nodes, connections }: CanvasPerfBridgeProps) {
    // Start of this render pass. This component is the first child of the page's root element, so
    // everything the canvas subtree renders afterwards is covered by the delta to the layout effect
    // below. Not exact — anything rendered before this point is excluded — but it is what answers
    // "is React itself the cost", which the frame timings alone cannot.
    const renderStartRef = useRef(0);
    if (PERF_MODE) renderStartRef.current = performance.now();

    // Republished after every render rather than subscribed to: the harness reads this on demand —
    // between frames, after paint — and the canvas's own state stays the single source of truth.
    // No dependency array on purpose; the values change constantly and are cheap to copy.
    useLayoutEffect(() => {
        if (!PERF_MODE) return;
        pipelineSink.addMs("renderMs", performance.now() - renderStartRef.current);
        pipelineSink.count("renders");
        canvasPerfBridgeState.viewport = viewport;
        canvasPerfBridgeState.selectedNodeIds = selectedNodeIds;
        canvasPerfBridgeState.nodes = nodes;
        canvasPerfBridgeState.connections = connections;
        canvasPerfBridgeState.container = containerRef.current;
        canvasPerfBridgeState.setViewport = setViewport;
    });

    // The layout effect above runs first, so the state is already published when the token advances.
    // The cleanup is what lets the harness confirm this round's canvas is gone before remounting it —
    // without it, a stale element would look like a mounted canvas forever and the reset protocol
    // would hang until its timeout.
    useEffect(() => {
        if (!PERF_MODE) return;
        canvasPerfBridgeState.readyToken += 1;
        return () => {
            canvasPerfBridgeState.container = null;
            canvasPerfBridgeState.setViewport = null;
        };
    }, []);

    const [Panel, setPanel] = useState<ComponentType | null>(null);
    useEffect(() => {
        if (!PERF_MODE) return;
        let cancelled = false;
        void import("@/components/canvas/canvas-perf-panel").then((module) => {
            if (!cancelled) setPanel(() => module.default);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    return Panel ? <Panel /> : null;
}
