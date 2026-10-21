import { memo, useMemo, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildOverviewConnectionPaths, findOverviewConnectionAtPoint } from "@/lib/canvas/canvas-overview-connections";
import { useThemeStore } from "@/stores/use-theme-store";

import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";
import { ActiveConnectionPath, ConnectionPath } from "./canvas-connections";

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
    scale: number;
    selectedConnectionId: string | null;
    relatedConnectionIds: ReadonlySet<string>;
    onSelect: (connectionId: string) => void;
    onContextMenu: (event: ReactMouseEvent<SVGPathElement>, connectionId: string) => void;
    onDelete: (connectionId: string) => void;
};

/**
 * Memoized so panning, marqueeing, opening dialogs and moving the draft connection do not walk the
 * edge list. Each edge is memoized too, so a node drag re-renders only the edges touching it.
 */
export const ConnectionLayer = memo(function ConnectionLayer({ connections, nodeById, scale, selectedConnectionId, relatedConnectionIds, onSelect, onContextMenu, onDelete }: ConnectionLayerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const wasOverview = useRef(false);
    if (scale <= 0.16) wasOverview.current = true;
    else if (scale >= 0.22) wasOverview.current = false;
    const overview = wasOverview.current;
    const paths = useMemo(
        () => overview ? buildOverviewConnectionPaths(connections, nodeById, selectedConnectionId, relatedConnectionIds) : null,
        [overview, connections, nodeById, selectedConnectionId, relatedConnectionIds],
    );
    const resolveHit = (event: ReactMouseEvent<SVGPathElement>) => {
        if (!paths) return null;
        const matrix = event.currentTarget.ownerSVGElement?.getScreenCTM();
        if (!matrix) return null;
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        return findOverviewConnectionAtPoint(paths.curves, point.x, point.y);
    };
    if (overview && paths) {
        const selected = connections.find((connection) => connection.id === selectedConnectionId);
        const from = selected ? nodeById.get(selected.fromNodeId) : undefined;
        const to = selected ? nodeById.get(selected.toNodeId) : undefined;
        return (
            <svg className={WORLD_SVG_CLASS} style={WORLD_SVG_STYLE} data-canvas-overview-edges=""
                data-canvas-overview-edge-count={paths.curves.length + (selected && from && to ? 1 : 0)}>
                {paths.ordinary ? <path d={paths.ordinary} stroke={theme.node.muted} strokeWidth="2" strokeOpacity=".82" fill="none" pointerEvents="none" /> : null}
                {paths.highlighted ? <path d={paths.highlighted} stroke={theme.node.activeStroke} strokeWidth="3" fill="none" pointerEvents="none" /> : null}
                {paths.hit ? <path data-canvas-overview-hit="" d={paths.hit} stroke="transparent" strokeWidth="16" fill="none"
                    style={{ cursor: "pointer", pointerEvents: "stroke" }}
                    onClick={(event) => {
                        event.stopPropagation();
                        const id = resolveHit(event);
                        if (id) onSelect(id);
                    }}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const id = resolveHit(event);
                        if (id) onContextMenu(event, id);
                    }}
                /> : null}
                {selected && from && to ? <ConnectionPath
                    key={selected.id} connection={selected} from={from} to={to}
                    active selected onSelect={onSelect} onContextMenu={onContextMenu} onDelete={onDelete}
                /> : null}
            </svg>
        );
    }
    return (
        <svg className={WORLD_SVG_CLASS} style={WORLD_SVG_STYLE}>
            {connections.map((connection) => {
                const from = nodeById.get(connection.fromNodeId);
                const to = nodeById.get(connection.toNodeId);
                if (!from || !to) return null;

                return (
                    <ConnectionPath
                        key={connection.id}
                        connection={connection}
                        from={from}
                        to={to}
                        active={selectedConnectionId === connection.id || relatedConnectionIds.has(connection.id)}
                        selected={selectedConnectionId === connection.id}
                        onSelect={onSelect}
                        onContextMenu={onContextMenu}
                        onDelete={onDelete}
                    />
                );
            })}
        </svg>
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
