import { memo, type MouseEvent as ReactMouseEvent } from "react";
import { Unlink2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { getCanvasPortAnchor, pickCanvasDropHandle } from "@/lib/canvas/canvas-ports";
import { connectionControlPoints } from "@/lib/canvas/canvas-connection-culling";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";

// Memoized, and the handlers take the connection id instead of being bound per edge: the caller can
// then pass stable callbacks, which is what lets memo actually bail out when another edge changes.
export const ConnectionPath = memo(function ConnectionPath({
    connection,
    from,
    to,
    active,
    selected,
    onSelect,
    onContextMenu,
    onDelete,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    active: boolean;
    selected: boolean;
    onSelect: (connectionId: string) => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>, connectionId: string) => void;
    onDelete: (connectionId: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const { startX, startY, endX, endY, control1X, control2X } = connectionControlPoints(from, to, connection);
    const pathD = `M ${startX} ${startY} C ${control1X} ${startY}, ${control2X} ${endY}, ${endX} ${endY}`;
    const midpointX = (startX + endX) / 2;
    const midpointY = (startY + endY) / 2;

    return (
        <g>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect(connection.id);
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event, connection.id);
                }}
            />
            <path
                d={pathD}
                stroke={active ? theme.node.activeStroke : theme.node.muted}
                strokeWidth={active ? 3 : 2}
                strokeOpacity={active ? 1 : 0.82}
                fill="none"
                style={{ filter: active ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none" }}
            />
            {selected ? (
                <foreignObject x={midpointX - 16} y={midpointY - 16} width="32" height="32" style={{ overflow: "visible", pointerEvents: "all" }}>
                    <button
                        type="button"
                        data-canvas-no-zoom
                        className="grid size-8 place-items-center rounded-full border shadow-lg transition hover:scale-105"
                        style={{ background: theme.toolbar.panel, borderColor: theme.node.activeStroke, color: theme.node.activeStroke }}
                        title={t("canvas.controls.disconnect")}
                        aria-label={t("canvas.controls.disconnect")}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            onDelete(connection.id);
                        }}
                    >
                        <Unlink2 className="size-4" />
                    </button>
                </foreignObject>
            ) : null}
        </g>
    );
});

export function ActiveConnectionPath({ node, handle, mouseWorld, target }: { node?: CanvasNodeData; handle: ConnectionHandle; mouseWorld: Position; target?: CanvasNodeData }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!node) return null;

    const origin = getCanvasPortAnchor(node, handle.handleType, handle.portId);
    const hoveredPort = target ? pickCanvasDropHandle(target, handle, mouseWorld.y) : null;
    const snapped = target && hoveredPort ? getCanvasPortAnchor(target, hoveredPort.handleType, hoveredPort.portId) : null;
    const snappedStartX = handle.handleType === "source" ? origin.x : snapped?.x ?? mouseWorld.x;
    const snappedStartY = handle.handleType === "source" ? origin.y : snapped?.y ?? mouseWorld.y;
    const snappedEndX = handle.handleType === "target" ? origin.x : snapped?.x ?? mouseWorld.x;
    const snappedEndY = handle.handleType === "target" ? origin.y : snapped?.y ?? mouseWorld.y;
    const distance = Math.abs(snappedEndX - snappedStartX);
    const pathD = `M ${snappedStartX} ${snappedStartY} C ${snappedStartX + distance * 0.5} ${snappedStartY}, ${snappedEndX - distance * 0.5} ${snappedEndY}, ${snappedEndX} ${snappedEndY}`;

    return <path d={pathD} stroke={theme.node.activeStroke} strokeWidth="2" fill="none" strokeDasharray="5,5" />;
}
