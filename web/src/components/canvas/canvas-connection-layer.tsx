import { memo, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildOverviewConnectionPaths, findOverviewConnectionAtPoint, partitionConnectionsForMovingNodes, refreshStationaryNodeMap, type OverviewPaths } from "@/lib/canvas/canvas-overview-connections";
import { useThemeStore } from "@/stores/use-theme-store";
import { getCanvasDragPositionOverrides, getCanvasDragPositionVersion, subscribeCanvasDragPositionOverrides } from "@/lib/canvas/canvas-drag-position-runtime";

import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position, ViewportTransform } from "@/types/canvas";
import { ActiveConnectionPath, ConnectionPath } from "./canvas-connections";
import type { RefObject } from "react";

// The world layer is a fixed 10000x10000 box and `overflow-visible` lets Bézier curves escape it.
// There is deliberately no `translateZ(0)`: forcing this element onto its own compositing layer made
// every `scale` change re-rasterise the whole layer, which measured as ~31% of the cost of zooming.
// (The 10000x10000 box itself was measured too and costs nothing — see CANVAS_BASELINE.md §6.1.)
const WORLD_SVG_CLASS = "absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible";
const WORLD_SVG_STYLE: CSSProperties = { pointerEvents: "none", zIndex: 0 };

type ConnectionLayerProps = {
    /** Already culled to the viewport by the controller. */
    connections: CanvasConnection[];
    nodeById: ReadonlyMap<string, CanvasNodeData>;
    wheelZoomActive: boolean;
    panActive: boolean;
    containerRef: RefObject<HTMLDivElement | null>;
    viewportRef: RefObject<ViewportTransform>;
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    devicePixelRatio: number;
    movingNodeIds: ReadonlySet<string>;
    selectedConnectionId: string | null;
    relatedConnectionIds: ReadonlySet<string>;
    onSelect: (connectionId: string) => void;
    onContextMenu: (event: ReactMouseEvent<SVGPathElement>, connectionId: string) => void;
    onDelete: (connectionId: string) => void;
};

/**
 * Ordinary and related edges share two Canvas2D strokes. The selected edge remains SVG for its
 * delete affordance, and edge hit-testing uses the same cubic geometry only on pointer events.
 */
const EDGE_OVERSCAN_CSS = 280;
const EDGE_REFRESH_DISTANCE_CSS = 160;

function sameSharedEdgeGeometry(previous: OverviewPaths, next: OverviewPaths) {
    const previousById = new Map(previous.curves.map((curve) => [curve.id, curve]));
    for (const curve of next.curves) {
        const old = previousById.get(curve.id);
        if (!old) continue;
        if (old.highlighted !== curve.highlighted || old.x0 !== curve.x0 || old.y0 !== curve.y0 || old.x1 !== curve.x1 || old.y1 !== curve.y1 || old.x2 !== curve.x2 || old.y2 !== curve.y2 || old.x3 !== curve.x3 || old.y3 !== curve.y3) return false;
    }
    return true;
}

function sameExactEdgeGeometry(previous: OverviewPaths, next: OverviewPaths) {
    if (previous.curves.length !== next.curves.length) return false;
    const previousById = new Map(previous.curves.map((curve) => [curve.id, curve]));
    for (const curve of next.curves) {
        const old = previousById.get(curve.id);
        if (!old || old.highlighted !== curve.highlighted || old.x0 !== curve.x0 || old.y0 !== curve.y0 || old.x1 !== curve.x1 || old.y1 !== curve.y1 || old.x2 !== curve.x2 || old.y2 !== curve.y2 || old.x3 !== curve.x3 || old.y3 !== curve.y3) return false;
    }
    return true;
}

export const ConnectionLayer = memo(function ConnectionLayer({ connections, nodeById, wheelZoomActive, panActive, containerRef, viewportRef, viewport, viewportSize, devicePixelRatio, movingNodeIds, selectedConnectionId, relatedConnectionIds, onSelect, onContextMenu, onDelete }: ConnectionLayerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const dragVersion = useSyncExternalStore(subscribeCanvasDragPositionOverrides, getCanvasDragPositionVersion, getCanvasDragPositionVersion);
    const dragOverrides = getCanvasDragPositionOverrides();
    const staticCanvasRef = useRef<HTMLCanvasElement>(null);
    const movingCanvasRef = useRef<HTMLCanvasElement>(null);
    const staticPathCacheRef = useRef<{ ordinary: string; ordinaryPath: Path2D | null; highlighted: string; highlightedPath: Path2D | null }>({ ordinary: "", ordinaryPath: null, highlighted: "", highlightedPath: null });
    const movingPathCacheRef = useRef<{ ordinary: string; ordinaryPath: Path2D | null; highlighted: string; highlightedPath: Path2D | null }>({ ordinary: "", ordinaryPath: null, highlighted: "", highlightedPath: null });
    const staticSnapshotRef = useRef<{ paths: OverviewPaths; movementKey: string; viewport: ViewportTransform; muted: string; active: string; width: number; height: number; dpr: number } | null>(null);
    const movingSnapshotRef = useRef<{ paths: OverviewPaths; movementKey: string } | null>(null);
    const stationaryNodeByIdRef = useRef(nodeById);
    const stationaryNodeById = refreshStationaryNodeMap(stationaryNodeByIdRef.current, nodeById, movingNodeIds);
    if (stationaryNodeById !== stationaryNodeByIdRef.current) stationaryNodeByIdRef.current = stationaryNodeById;
    const partition = useMemo(() => partitionConnectionsForMovingNodes(connections, movingNodeIds), [connections, movingNodeIds]);
    const staticPaths = useMemo(
        () => buildOverviewConnectionPaths(partition.stationary, stationaryNodeById, selectedConnectionId, relatedConnectionIds),
        [partition.stationary, stationaryNodeById, selectedConnectionId, relatedConnectionIds],
    );
    const movingPaths = useMemo(
        () => buildOverviewConnectionPaths(partition.moving, nodeById, selectedConnectionId, relatedConnectionIds, dragOverrides),
        [partition.moving, nodeById, selectedConnectionId, relatedConnectionIds, dragVersion],
    );
    const hitCurves = useMemo(() => [...staticPaths.curves, ...movingPaths.curves], [staticPaths.curves, movingPaths.curves]);
    const movementKey = movingNodeIds.size ? [...movingNodeIds].sort().join("\u001f") : "";
    const selected = connections.find((connection) => connection.id === selectedConnectionId);
    const selectedFromBase = selected ? nodeById.get(selected.fromNodeId) : undefined;
    const selectedToBase = selected ? nodeById.get(selected.toNodeId) : undefined;
    const selectedFromDelta = selected ? dragOverrides.get(selected.fromNodeId) : undefined;
    const selectedToDelta = selected ? dragOverrides.get(selected.toNodeId) : undefined;
    const selectedFrom = selectedFromBase && selectedFromDelta ? { ...selectedFromBase, position: { x: selectedFromBase.position.x + selectedFromDelta.x, y: selectedFromBase.position.y + selectedFromDelta.y } } : selectedFromBase;
    const selectedTo = selectedToBase && selectedToDelta ? { ...selectedToBase, position: { x: selectedToBase.position.x + selectedToDelta.x, y: selectedToBase.position.y + selectedToDelta.y } } : selectedToBase;

    const drawLayer = (canvas: HTMLCanvasElement | null, paths: OverviewPaths, cache: typeof staticPathCacheRef.current) => {
        if (!canvas || viewportSize.width <= 0 || viewportSize.height <= 0) return;
        const dpr = Math.min(2, Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1));
        const bitmapWidth = Math.max(1, Math.ceil((viewportSize.width + EDGE_OVERSCAN_CSS * 2) * dpr));
        const bitmapHeight = Math.max(1, Math.ceil((viewportSize.height + EDGE_OVERSCAN_CSS * 2) * dpr));
        // Only resize on an actual redraw. Resizing on every wheel/pan frame clears the bitmap and flashes.
        if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
        if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
        const currentViewport = panActive ? viewportRef.current : viewport;
        const k = Math.max(0.05, currentViewport.k);
        const worldLeft = -currentViewport.x / k - EDGE_OVERSCAN_CSS / k;
        const worldTop = -currentViewport.y / k - EDGE_OVERSCAN_CSS / k;
        const worldWidth = (viewportSize.width + EDGE_OVERSCAN_CSS * 2) / k;
        const worldHeight = (viewportSize.height + EDGE_OVERSCAN_CSS * 2) / k;
        canvas.style.left = `${worldLeft}px`;
        canvas.style.top = `${worldTop}px`;
        canvas.style.width = `${worldWidth}px`;
        canvas.style.height = `${worldHeight}px`;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.setTransform(k * dpr, 0, 0, k * dpr, -worldLeft * k * dpr, -worldTop * k * dpr);
        context.clearRect(worldLeft, worldTop, worldWidth, worldHeight);
        if (typeof Path2D !== "undefined") {
            if (cache.ordinary !== paths.ordinary) {
                cache.ordinary = paths.ordinary;
                cache.ordinaryPath = paths.ordinary ? new Path2D(paths.ordinary) : null;
            }
            if (cache.highlighted !== paths.highlighted) {
                cache.highlighted = paths.highlighted;
                cache.highlightedPath = paths.highlighted ? new Path2D(paths.highlighted) : null;
            }
        }
        if (cache.ordinaryPath) {
            context.strokeStyle = theme.node.muted;
            context.globalAlpha = 0.82;
            context.lineWidth = 2;
            context.stroke(cache.ordinaryPath);
        }
        if (cache.highlightedPath) {
            context.strokeStyle = theme.node.activeStroke;
            context.globalAlpha = 1;
            context.lineWidth = 3;
            context.stroke(cache.highlightedPath);
        }
        context.globalAlpha = 1;
        return { viewport: { ...currentViewport }, dpr };
    };

    useLayoutEffect(() => {
        const staticSnapshot = staticSnapshotRef.current;
        const movingSnapshot = movingSnapshotRef.current;
        const expectedDpr = Math.min(2, Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1));
        const current = viewportRef.current;
        const k = Math.max(0.05, current.k);
        const currentLeft = -current.x / k;
        const currentTop = -current.y / k;
        const currentRight = currentLeft + viewportSize.width / k;
        const currentBottom = currentTop + viewportSize.height / k;
        const drawn = staticSnapshot?.viewport;
        const drawnK = Math.max(0.05, drawn?.k ?? current.k);
        const drawnLeft = -(drawn?.x ?? current.x) / drawnK - EDGE_OVERSCAN_CSS / drawnK;
        const drawnTop = -(drawn?.y ?? current.y) / drawnK - EDGE_OVERSCAN_CSS / drawnK;
        const drawnRight = drawnLeft + (viewportSize.width + EDGE_OVERSCAN_CSS * 2) / drawnK;
        const drawnBottom = drawnTop + (viewportSize.height + EDGE_OVERSCAN_CSS * 2) / drawnK;
        const bitmapCoversViewport = currentLeft >= drawnLeft && currentTop >= drawnTop && currentRight <= drawnRight && currentBottom <= drawnBottom;
        const viewportNeedsRefresh = !staticSnapshot || !bitmapCoversViewport || (!wheelZoomActive && !panActive && (current.x !== drawn?.x || current.y !== drawn?.y || current.k !== drawn?.k)) ||
            (panActive && Math.hypot(current.x - (drawn?.x ?? current.x), current.y - (drawn?.y ?? current.y)) >= EDGE_REFRESH_DISTANCE_CSS);
        const staticInputsChanged = !staticSnapshot || staticSnapshot.movementKey !== movementKey || staticSnapshot.muted !== theme.node.muted || staticSnapshot.active !== theme.node.activeStroke || staticSnapshot.width !== viewportSize.width || staticSnapshot.height !== viewportSize.height || staticSnapshot.dpr !== expectedDpr;
        const edgeGestureActive = movingNodeIds.size > 0;
        const staticGeometryChanged = !staticSnapshot || staticSnapshot.paths !== staticPaths && (
            !sameSharedEdgeGeometry(staticSnapshot.paths, staticPaths) ||
            (!wheelZoomActive && !panActive && !edgeGestureActive && !sameExactEdgeGeometry(staticSnapshot.paths, staticPaths))
        );
        const shouldDrawStatic = staticInputsChanged || staticGeometryChanged || ((!wheelZoomActive || !bitmapCoversViewport) && (!panActive || !bitmapCoversViewport) && viewportNeedsRefresh);
        if (shouldDrawStatic) {
            const result = drawLayer(staticCanvasRef.current, staticPaths, staticPathCacheRef.current);
            if (result) staticSnapshotRef.current = { paths: staticPaths, movementKey, viewport: result.viewport, muted: theme.node.muted, active: theme.node.activeStroke, width: viewportSize.width, height: viewportSize.height, dpr: result.dpr };
        }

        const movingGeometryChanged = !movingSnapshot || movingSnapshot.paths !== movingPaths && !sameExactEdgeGeometry(movingSnapshot.paths, movingPaths);
        if (shouldDrawStatic || movingGeometryChanged || movingSnapshot?.movementKey !== movementKey) {
            drawLayer(movingCanvasRef.current, movingPaths, movingPathCacheRef.current);
            movingSnapshotRef.current = { paths: movingPaths, movementKey };
        }
    // The current theme/colors and geometry need crisp redraws after the gesture settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [staticPaths, movingPaths, viewport, viewportSize.width, viewportSize.height, devicePixelRatio, theme, wheelZoomActive, panActive, movementKey]);

    const resolveHit = (event: ReactMouseEvent<HTMLCanvasElement> | ReactPointerEvent<HTMLCanvasElement>) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return null;
        const latest = viewportRef.current;
        const x = (event.clientX - rect.left - latest.x) / latest.k;
        const y = (event.clientY - rect.top - latest.y) / latest.k;
        return findOverviewConnectionAtPoint(hitCurves, x, y);
    };
    return (
        <>
            <canvas ref={staticCanvasRef} className="absolute pointer-events-auto" data-canvas-edge-layer=""
                data-canvas-edge-count={hitCurves.length + (selected && selectedFrom && selectedTo ? 1 : 0)}
                data-canvas-overview-edges="" data-canvas-overview-edge-count={hitCurves.length + (selected && selectedFrom && selectedTo ? 1 : 0)}
                onPointerDown={(event) => {
                    if (event.button === 1) return;
                    if (resolveHit(event)) event.stopPropagation();
                }}
                onMouseDown={(event) => {
                    if (event.button === 0 && resolveHit(event)) event.stopPropagation();
                }}
                onClick={(event) => {
                    const id = resolveHit(event);
                    if (id) { event.stopPropagation(); onSelect(id); }
                }}
                onContextMenu={(event) => {
                    const id = resolveHit(event);
                    if (!id) return;
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu(event as unknown as ReactMouseEvent<SVGPathElement>, id);
                }}
            />
            <canvas ref={movingCanvasRef} className="absolute pointer-events-none" aria-hidden="true" data-canvas-moving-edge-layer="" />
            {selected && selectedFrom && selectedTo ? <svg className={WORLD_SVG_CLASS} style={WORLD_SVG_STYLE} data-canvas-selected-edge="">
                <ConnectionPath key={selected.id} connection={selected} from={selectedFrom} to={selectedTo}
                    active selected onSelect={onSelect} onContextMenu={onContextMenu} onDelete={onDelete} />
            </svg> : null}
        </>
    );
});

type ActiveConnectionOverlayProps = {
    connectingParams: ConnectionHandle | null;
    mouseWorld: Position;
    connectionTargetNodeId: string | null;
    nodeById: ReadonlyMap<string, CanvasNodeData>;
};

/**
 * The dashed line following the pointer while connecting. Kept in its own memoized layer because it
 * is the one thing that changes on every pointermove — otherwise it would drag the whole edge list
 * through a re-render each frame.
 */
export const ActiveConnectionOverlay = memo(function ActiveConnectionOverlay({ connectingParams, mouseWorld, connectionTargetNodeId, nodeById }: ActiveConnectionOverlayProps) {
    if (!connectingParams) return null;

    return (
        <svg className={WORLD_SVG_CLASS} style={WORLD_SVG_STYLE}>
            <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined} />
        </svg>
    );
});
