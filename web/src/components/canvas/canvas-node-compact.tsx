import { memo } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasActions } from "./canvas-actions";

/**
 * Lightweight node for dense overviews. No media decoders, editors, resize handles, config
 * panels, or per-node icon trees. The real canvas geometry and gesture handlers are preserved.
 * A single selected/focused node is promoted to the full CanvasNode by NodeLayer.
 */
export const CompactCanvasNode = memo(function CompactCanvasNode({
    data,
    isSelected,
    isRelated,
    isGroupDropTarget,
}: {
    data: CanvasNodeData;
    isSelected: boolean;
    isRelated: boolean;
    isGroupDropTarget: boolean;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { onMouseDown, onSelectCapture, onHoverStart, onHoverEnd, onContextMenu, onViewImage } = useCanvasActions();
    const isGroup = data.type === CanvasNodeType.Group;
    const accent = getNodeDefinition(data.type)?.minimapColor || theme.node.muted;
    const borderColor = isSelected || isGroupDropTarget ? theme.node.activeStroke : isRelated ? theme.node.muted : accent;

    return (
        <div
            data-node-id={data.id}
            data-canvas-compact-node
            title={data.title}
            className={`node-element absolute select-none ${isGroup ? "z-[5]" : isSelected ? "z-50" : "z-10"}`}
            style={{
                transform: `translate(${data.position.x}px, ${data.position.y}px)`,
                width: data.width,
                height: data.height,
                contain: "layout style",
            }}
            onMouseEnter={() => onHoverStart(data.id)}
            onMouseLeave={() => onHoverEnd(data.id)}
            onMouseDownCapture={(event) => onSelectCapture(event, data.id)}
            onContextMenu={(event) => onContextMenu(event, data.id)}
        >
            <div
                data-canvas-compact-body
                className="h-full w-full"
                style={{
                    border: `3px ${isGroup ? "dashed" : "solid"} ${borderColor}`,
                    borderRadius: 18,
                    background: isGroup ? "transparent" : theme.node.fill,
                    boxSizing: "border-box",
                }}
                onMouseDown={(event) => onMouseDown(event, data.id)}
                onDoubleClick={(event) => {
                    if (data.type === CanvasNodeType.Image && data.metadata?.content) {
                        event.stopPropagation();
                        onViewImage(data);
                    }
                }}
            />
        </div>
    );
});
