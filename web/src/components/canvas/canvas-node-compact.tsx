import { memo, useEffect, useState } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getCompactImageSource } from "@/lib/canvas/canvas-lod-preview";
import { compactCanvasMarkdown } from "@/lib/canvas/canvas-markdown-utils";
import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import { resolveMediaPreview } from "@/services/media-preview-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasActions } from "./canvas-actions";

/** Same-sized visual shell and semantic content as the full node, without editing DOM or media decoders. */
export const CompactCanvasNode = memo(function CompactCanvasNode({
    data, isSelected, isRelated, isGroupDropTarget, showImagePreview = false, groupChildCount = 0, hitActive = true,
}: {
    data: CanvasNodeData;
    isSelected: boolean;
    isRelated: boolean;
    isGroupDropTarget: boolean;
    showImagePreview?: boolean;
    groupChildCount?: number;
    /** Handoff: do not duplicate hit targets once the full node becomes interactive. */
    hitActive?: boolean;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { onMouseDown, onSelectCapture, onHoverStart, onHoverEnd, onContextMenu, onViewImage } = useCanvasActions();
    const definition = getNodeDefinition(data.type);
    const isGroup = data.type === CanvasNodeType.Group;
    const isImage = data.type === CanvasNodeType.Image;
    const isVideo = data.type === CanvasNodeType.Video;
    const isAudio = data.type === CanvasNodeType.Audio;
    const imageSource = getCompactImageSource(data);
    const primary = data.metadata?.images?.find((item) => item.id === (data.metadata?.primaryImageId || data.metadata?.images?.[0]?.id));
    const storageKey = isImage ? (primary?.storageKey || data.metadata?.storageKey) : isVideo ? data.metadata?.storageKey : undefined;
    const kind = isVideo ? "video" as const : "image" as const;
    const [preview, setPreview] = useState<{ key: string; url: string } | null>(null);
    // A persisted 256px preview is looked up by source storage key. The full original
    // is NOT passed to an <img> in the overview. Legacy blobs backfill only while idle.
    useEffect(() => {
        if (!showImagePreview || !storageKey || (!isImage && !isVideo)) return;
        let active = true;
        const load = kind === "image" ? () => getImageBlob(storageKey) : () => getMediaBlob(storageKey);
        void resolveMediaPreview(kind, storageKey, load, isImage && data.metadata?.naturalWidth && data.metadata.naturalHeight
            ? { width: data.metadata.naturalWidth, height: data.metadata.naturalHeight } : undefined)
            .then((url) => { if (active && url) setPreview({ key: storageKey, url }); });
        return () => { active = false; };
    }, [showImagePreview, storageKey, kind, isImage, isVideo, data.metadata?.naturalWidth, data.metadata?.naturalHeight]);
    const previewUrl = storageKey ? (preview?.key === storageKey ? preview.url : null) : imageSource;

    const hasImage = Boolean(imageSource);
    const active = isSelected || isGroupDropTarget;
    const accent = definition?.minimapColor || theme.node.muted;
    const transparent = Boolean(definition?.transparentBackground);
    const borderColor = active ? "#2f80ff" : isGroup ? theme.node.stroke : hasImage ? "transparent" : isRelated ? theme.node.muted : transparent ? "transparent" : theme.node.stroke;
    const background = isGroup ? `${theme.toolbar.panel}66` : hasImage || (isVideo && data.metadata?.content) || transparent ? "transparent" : theme.node.fill;

    return (
        <div data-node-id={hitActive ? data.id : undefined} data-canvas-compact-node={hitActive ? "" : undefined} data-canvas-lod-node={data.id} title={data.title}
            className={`node-element absolute select-none ${isGroup ? "z-[5]" : isSelected ? "z-50" : "z-10"}`}
            style={{ transform: `translate(${data.position.x}px, ${data.position.y}px)`, width: data.width, height: data.height, contain: "layout style", pointerEvents: hitActive ? undefined : "none" }}
            onMouseEnter={() => onHoverStart(data.id)}
            onMouseLeave={(event) => {
                const nextNode = event.relatedTarget instanceof Element ? event.relatedTarget.closest("[data-canvas-lod-node]") : null;
                if (nextNode?.getAttribute("data-canvas-lod-node") !== data.id) onHoverEnd(data.id);
            }}
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
                {isImage && previewUrl && showImagePreview ? (
                    <img key={previewUrl} data-canvas-compact-image src={previewUrl} alt="" draggable={false} loading="lazy" decoding="async"
                        className={`pointer-events-none block h-full w-full select-none ${data.metadata?.freeResize ? "object-fill" : "object-contain"}`}
                        style={{ opacity: 0, transition: "opacity 160ms ease-out" }}
                        onLoad={(event) => { event.currentTarget.style.opacity = "1"; }}
                    />
                ) : null}
                {isImage && imageSource && (!showImagePreview || !previewUrl) ? (
                    <div className="pointer-events-none absolute inset-0 opacity-50" style={{ background: accent + "26" }} />
                ) : null}
                {isImage && !imageSource ? <div className="pointer-events-none grid h-full w-full place-items-center" style={{ color: theme.node.placeholder }}><span className="text-2xl opacity-40">▧</span></div> : null}
                {isVideo ? (
                    <div className="pointer-events-none flex h-full w-full items-center justify-center" style={{ background: data.metadata?.content ? "#000" : theme.node.fill }}>
                        {showImagePreview && previewUrl && isVideo ? (
                            <img src={previewUrl} alt="" draggable={false} decoding="async"
                                data-canvas-compact-poster
                                className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
                        ) : null}
                        <span className="relative z-[1] grid size-12 place-items-center rounded-full border border-white/30 bg-white/15 text-white/85">
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
                    <div className="pointer-events-none h-full w-full overflow-hidden whitespace-pre-wrap break-words px-4 pt-12 pb-4 font-mono"
                        style={{ color: theme.node.text, fontSize: data.metadata?.fontSize || 14, lineHeight: 1.65 }}>
                        {compactCanvasMarkdown(data.metadata?.content || data.title)}
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
