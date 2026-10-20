import { memo } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getCompactImageSource } from "@/lib/canvas/canvas-lod-preview";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasActions } from "./canvas-actions";

/** Same-sized visual shell and semantic content as the full node, without editing DOM or media decoders. */
export const CompactCanvasNode = memo(function CompactCanvasNode({
    data, isSelected, isRelated, isGroupDropTarget, showImagePreview = false, groupChildCount = 0,
}: {
    data: CanvasNodeData;
    isSelected: boolean;
    isRelated: boolean;
    isGroupDropTarget: boolean;
    showImagePreview?: boolean;
    groupChildCount?: number;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { onMouseDown, onSelectCapture, onHoverStart, onHoverEnd, onContextMenu, onViewImage } = useCanvasActions();
    const definition = getNodeDefinition(data.type);
    const isGroup = data.type === CanvasNodeType.Group;
    const isImage = data.type === CanvasNodeType.Image;
    const isVideo = data.type === CanvasNodeType.Video;
    const isAudio = data.type === CanvasNodeType.Audio;
    const imageSource = getCompactImageSource(data);
    const hasImage = Boolean(imageSource);
    const active = isSelected || isGroupDropTarget;
    const accent = definition?.minimapColor || theme.node.muted;
    const transparent = Boolean(definition?.transparentBackground);
    const borderColor = active ? "#2f80ff" : isGroup ? theme.node.stroke : hasImage ? "transparent" : isRelated ? theme.node.muted : transparent ? "transparent" : theme.node.stroke;
    const background = isGroup ? `${theme.toolbar.panel}66` : hasImage || (isVideo && data.metadata?.content) || transparent ? "transparent" : theme.node.fill;

    return (
        <div data-node-id={data.id} data-canvas-compact-node title={data.title}
            className={`node-element absolute select-none ${isGroup ? "z-[5]" : isSelected ? "z-50" : "z-10"}`}
            style={{ transform: `translate(${data.position.x}px, ${data.position.y}px)`, width: data.width, height: data.height, contain: "layout style" }}
            onMouseEnter={() => onHoverStart(data.id)}
            onMouseLeave={() => onHoverEnd(data.id)}
            onMouseDownCapture={(event) => onSelectCapture(event, data.id)}
            onContextMenu={(event) => onContextMenu(event, data.id)}
        >
            <div data-canvas-compact-body className="relative h-full w-full overflow-hidden rounded-3xl border-2"
                style={{ borderStyle: isGroup ? "dashed" : "solid", borderColor, background, boxSizing: "border-box", boxShadow: active ? "0 0 0 1px #2f80ff55" : undefined }}
                onMouseDown={(event) => onMouseDown(event, data.id)}
                onDoubleClick={(event) => {
                    if (isImage && imageSource) {
                        event.stopPropagation();
                        onViewImage(data);
                    }
                }}
            >
                {isImage && imageSource && showImagePreview ? (
                    <img key={imageSource} data-canvas-compact-image src={imageSource} alt="" draggable={false} loading="lazy" decoding="async"
                        className={`pointer-events-none block h-full w-full select-none ${data.metadata?.freeResize ? "object-fill" : "object-contain"}`}
                        style={{ opacity: 0, transition: "opacity 160ms ease-out" }}
                        onLoad={(event) => { event.currentTarget.style.opacity = "1"; }}
                    />
                ) : null}
                {isImage && imageSource && !showImagePreview ? (
                    <div className="pointer-events-none absolute inset-0 opacity-50" style={{ background: accent + "26" }} />
                ) : null}
                {isImage && !imageSource ? <div className="pointer-events-none grid h-full w-full place-items-center" style={{ color: theme.node.placeholder }}><span className="text-2xl opacity-40">▧</span></div> : null}
                {isVideo ? (
                    <div className="pointer-events-none flex h-full w-full items-center justify-center" style={{ background: data.metadata?.content ? "#000" : theme.node.fill }}>
                        <span className="grid size-12 place-items-center rounded-full border border-white/30 bg-white/15 text-white/85">
                            <span className="ml-1 h-0 w-0 border-y-[8px] border-y-transparent border-l-[12px] border-l-current" />
                        </span>
                    </div>
                ) : null}
                {isAudio ? (
                    <div className="pointer-events-none flex h-full w-full flex-col justify-center gap-3 px-4" style={{ color: theme.node.text }}>
                        <span className="truncate text-sm opacity-70">{data.title}</span>
                        <div className="h-2 w-full rounded-full" style={{ background: theme.node.muted + "44" }} />
                    </div>
                ) : null}
                {data.type === CanvasNodeType.Text ? (
                    <div className="pointer-events-none h-full w-full overflow-hidden whitespace-pre-wrap break-words pl-4 pr-14 pt-8 pb-4 font-mono"
                        style={{ color: theme.node.text, fontSize: data.metadata?.fontSize || 14, lineHeight: 1.65 }}>
                        {(data.metadata?.content || data.title).slice(0,900)}
                    </div>
                ) : null}
                {isGroup ? (
                    <div className="pointer-events-none flex h-full w-full flex-col p-4" style={{ color: theme.node.text }}>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <span className="grid size-8 shrink-0 place-items-center rounded-xl" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }}>
                                <span className="size-3 rounded-sm border" style={{ borderColor: accent }} />
                            </span>
                            <span className="truncate">{data.title}</span>
                            <span className="ml-auto rounded-full px-2 py-1 text-[11px]" style={{ background: theme.node.fill, color: theme.node.muted }}>{groupChildCount}</span>
                        </div>
                        <div className="mt-3 flex-1 rounded-2xl border border-dashed" style={{ borderColor: theme.node.stroke, background: `${theme.node.fill}55` }} />
                    </div>
                ) : null}
                {(data.type === CanvasNodeType.Config || data.type === CanvasNodeType.Director ||
                    (!isGroup && !isImage && !isVideo && !isAudio && data.type !== CanvasNodeType.Text)) ? (
                    <div className="pointer-events-none flex h-full w-full items-start gap-2 px-4 pt-4" style={{ color: theme.node.text }}>
                        <span className="size-3 shrink-0 rounded-full opacity-75" style={{ background: accent }} />
                        <span className="truncate text-sm font-semibold opacity-80">{data.title}</span>
                    </div>
                ) : null}
            </div>
        </div>
    );
});
