import { memo, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";

import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";
import { ActiveConnectionPath, ConnectionPath } from "./canvas-connections";

// The world layer is a fixed 10000x10000 box; `overflow-visible` lets Bézier curves escape it and
// `translateZ(0)` keeps the whole layer on one compositing layer.
const WORLD_SVG_CLASS = "absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible";
const WORLD_SVG_STYLE: CSSProperties = { pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 };

type ConnectionLayerProps = {
    /** Already culled to the viewport by the controller. */
    connections: CanvasConnection[];
    nodeById: ReadonlyMap<string, CanvasNodeData>;
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
export const ConnectionLayer = memo(function ConnectionLayer({ connections, nodeById, selectedConnectionId, relatedConnectionIds, onSelect, onContextMenu, onDelete }: ConnectionLayerProps) {
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
