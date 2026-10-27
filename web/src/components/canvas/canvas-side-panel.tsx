import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { App, Button, Empty, Input, Popconfirm, Select, Spin, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Check, ChevronRight, Clapperboard, Download, Eye, FileText, History as HistoryIcon, Image as ImageIcon, ListChecks, Music2, Plus, Search, Settings2, Square, Trash2, Type, Video } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { exportCanvasNodes } from "@/lib/canvas/canvas-export";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { cn } from "@/lib/utils";
import { uploadCanvasImage,uploadCanvasMedia } from "@/features/backend-sync/canvas-media";
import { resolveImageUrl } from "@/services/image-storage";
import { getImageBlob } from "@/services/image-storage";
import { resolveMediaPreview } from "@/services/media-preview-storage";
import { CANVAS_SIDEBAR_ROW_HEIGHT, CANVAS_SIDEBAR_ROW_STRIDE, canvasSidebarWindow } from "@/lib/canvas/canvas-side-panel-window";
import { useAssetStore, type Asset, type AssetKind } from "@/stores/use-asset-store";
import { awaitAssetStorePersistence } from "@/stores/use-asset-store";
import { useGenerationHistoryStore, type GenerationHistoryRecord } from "@/stores/canvas/use-generation-history-store";
import { CANVAS_SIDE_PANEL_MAX_WIDTH, CANVAS_SIDE_PANEL_MIN_WIDTH, CANVAS_SIDE_PANEL_MOTION_MS, useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { pipelineSink } from "@/lib/canvas/canvas-perf-bridge-state";

import type { InsertAssetPayload } from "./asset-picker-modal";

const PANEL_MOTION_SECONDS = CANVAS_SIDE_PANEL_MOTION_MS / 1000;
const PANEL_EASE = [0.22, 1, 0.36, 1] as const;
// Inline so Vite inlines it before Rollup runs; the timing probe must not exist in a normal build.
const CANVAS_PERF_MODE = import.meta.env.MODE === "perf";

type PanelTab = "canvas" | "assets" | "history";

type Props = {
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    onFocusNode: (nodeId: string) => void;
    onPreviewNode: (nodeId: string) => void;
    onInsertAsset: (payload: InsertAssetPayload) => void;
};

const NODE_TYPE_ICON: Record<string, typeof Square> = {
    [CanvasNodeType.Image]: ImageIcon,
    [CanvasNodeType.Video]: Video,
    [CanvasNodeType.Audio]: Music2,
    [CanvasNodeType.Text]: Type,
    [CanvasNodeType.Config]: Settings2,
    [CanvasNodeType.Group]: Square,
    [CanvasNodeType.Director]: Clapperboard,
};

const STATUS_COLOR: Record<string, string> = {
    success: "#22c55e",
    loading: "#f59e0b",
    error: "#ef4444",
    idle: "transparent",
};

export function CanvasSidePanel({ nodes, selectedNodeIds, onFocusNode, onPreviewNode, onInsertAsset }: Props) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [tab, setTab] = useState<PanelTab>("canvas");
    const width = useCanvasSidePanelStore((state) => state.width);
    const panelOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const panelMounted = useCanvasSidePanelStore((state) => state.panelMounted);
    const panelClosing = useCanvasSidePanelStore((state) => state.panelClosing);
    const setWidth = useCanvasSidePanelStore((state) => state.setWidth);
    const [resizing, setResizing] = useState(false);

    const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            nextWidth = Math.min(CANVAS_SIDE_PANEL_MAX_WIDTH, Math.max(CANVAS_SIDE_PANEL_MIN_WIDTH, startWidth + moveEvent.clientX - startX));
            setWidth(nextWidth);
        };
        const onUp = () => {
            localStorage.setItem("canvas-side-panel-width", String(nextWidth));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    if (!panelMounted) return null;

    return (
        <motion.div
            className="relative z-[60] flex h-full shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: panelOpen ? width + 1 : 0, opacity: panelOpen ? 1 : 0 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: PANEL_EASE }}
            style={{ overflow: "clip", pointerEvents: panelClosing ? "none" : undefined }}
        >
            <motion.aside
                className="relative flex h-full shrink-0 flex-col overflow-hidden border-r"
                initial={{ x: -48 }}
                animate={{ x: panelClosing ? -28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: PANEL_EASE }}
                style={{ width, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                data-canvas-no-zoom
            >
                <div className="flex items-center gap-5 px-4 pt-3.5">
                    <TabButton label={t("canvas.sidePanel.canvas")} active={tab === "canvas"} theme={theme} onClick={() => setTab("canvas")} />
                    <TabButton label={t("canvas.sidePanel.assets")} active={tab === "assets"} theme={theme} onClick={() => setTab("assets")} />
                    <TabButton label={t("canvas.sidePanel.history")} active={tab === "history"} theme={theme} onClick={() => setTab("history")} />
                </div>
                <div className="mt-2 min-h-0 flex-1 overflow-hidden">
                    {tab === "canvas" ? (
                        <CanvasNodesTab nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={onFocusNode} onPreviewNode={onPreviewNode} theme={theme} />
                    ) : tab === "assets" ? (
                        <CanvasAssetsTab onInsert={onInsertAsset} theme={theme} />
                    ) : (
                        <CanvasHistoryTab theme={theme} />
                    )}
                </div>
                <button type="button" className="absolute inset-y-0 right-0 z-40 w-4 translate-x-1/2 cursor-col-resize" onPointerDown={startResize} aria-label={t("canvas.sidePanel.resize")} />
            </motion.aside>
        </motion.div>
    );
}

function TabButton({ label, active, theme, onClick }: { label: string; active: boolean; theme: CanvasTheme; onClick: () => void }) {
    return (
        <button type="button" onClick={onClick} className="relative pb-1.5 text-sm font-semibold transition-opacity" style={{ color: theme.node.text, opacity: active ? 1 : 0.45 }}>
            {label}
            {active ? <motion.span layoutId="sidePanelTabIndicator" className="absolute inset-x-0 -bottom-px h-0.5 rounded-full" style={{ background: theme.toolbar.activeText }} transition={{ type: "spring", stiffness: 500, damping: 34 }} /> : null}
        </button>
    );
}

// ---------------------------------------------------------------------------
// Canvas tab: list nodes and center, zoom, and select the clicked node.
// ---------------------------------------------------------------------------

const NODE_FILTER_VALUES = ["all", CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Text, CanvasNodeType.Audio, CanvasNodeType.Config, CanvasNodeType.Group];

function nodePreviewText(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return getNodeDefinition(node.type)?.title || node.type;
}

function CanvasNodesTab({ nodes, selectedNodeIds, onFocusNode, onPreviewNode, theme }: { nodes: CanvasNodeData[]; selectedNodeIds: Set<string>; onFocusNode: (nodeId: string) => void; onPreviewNode: (nodeId: string) => void; theme: CanvasTheme }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [keyword, setKeyword] = useState("");
    const [typeFilter, setTypeFilter] = useState<string>("all");
    const [selectMode, setSelectMode] = useState(false);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [exporting, setExporting] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const [listHeight, setListHeight] = useState(450);
    const [scrollTop, setScrollTop] = useState(0);
    useEffect(() => {
        const container = listRef.current;
        if (!container) return;
        const measure = () => setListHeight((previous) => previous === container.clientHeight ? previous : container.clientHeight);
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        if (listRef.current) listRef.current.scrollTop = 0;
        setScrollTop(0);
    }, [keyword, typeFilter]);

    const filtered = useMemo(() => {
        const started = CANVAS_PERF_MODE ? performance.now() : 0;
        const query = keyword.trim().toLowerCase();
        const list = nodes.filter((node) => (typeFilter === "all" || node.type === typeFilter) && (!query || [node.title, node.metadata?.content, node.metadata?.prompt].filter(Boolean).join(" ").toLowerCase().includes(query)));
        if (CANVAS_PERF_MODE) {
            pipelineSink.addMs("sidePanelMs", performance.now() - started);
            pipelineSink.count("sidePanelCount", list.length);
        }
        return list;
    }, [nodes, keyword, typeFilter]);
    const listWindow = canvasSidebarWindow(filtered.length, scrollTop, listHeight);
    const windowedNodes = filtered.slice(listWindow.start, listWindow.end);

    const exitSelect = () => {
        setSelectMode(false);
        setChecked(new Set());
    };
    // Stable so memoized rows are not invalidated on every parent render.
    const toggleChecked = useCallback(
        (id: string) =>
            setChecked((prev) => {
                const next = new Set(prev);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
            }),
        [],
    );
    const allChecked = filtered.length > 0 && filtered.every((node) => checked.has(node.id));
    const toggleAll = () => setChecked(allChecked ? new Set() : new Set(filtered.map((node) => node.id)));

    const handleExport = async () => {
        const targets = nodes.filter((node) => checked.has(node.id));
        if (!targets.length) return;
        setExporting(true);
        const hide = message.loading(t("canvas.sidePanel.exporting"), 0);
        try {
            await exportCanvasNodes(targets, t("canvas.sidePanel.exportName", { count: targets.length }));
            message.success(t("canvas.sidePanel.exported", { count: targets.length }));
            exitSelect();
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
            setExporting(false);
        }
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
                <span className="text-xs font-medium opacity-60">{t("canvas.sidePanel.elements")}</span>
                {filtered.length ? <span className="text-xs opacity-35">{filtered.length}</span> : null}
                <button
                    type="button"
                    onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
                    className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                    style={selectMode ? { color: theme.toolbar.activeText, opacity: 1 } : undefined}
                >
                    <ListChecks className="size-3.5" />
                    {selectMode ? t("common.cancel") : t("canvas.sidePanel.select")}
                </button>
                {selectMode ? null : <Select size="small" variant="borderless" className="w-20" value={typeFilter} onChange={setTypeFilter} options={NODE_FILTER_VALUES.map((value) => ({ value, label: value === "all" ? t("common.all") : t(`canvas.sidePanel.filter.${value}`) }))} />}
            </div>
            <div className="px-3 pb-2.5">
                <Input size="small" allowClear prefix={<Search className="size-3.5 text-stone-400" />} placeholder={t("canvas.sidePanel.searchNodes")} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            </div>
            <div ref={listRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {filtered.length ? (
                    <div className="relative" style={{ height: listWindow.totalHeight }} data-canvas-sidebar-total={filtered.length}>
                        {windowedNodes.map((node, index) => (
                            <div key={node.id} className="absolute inset-x-0" style={{ top: (listWindow.start + index) * CANVAS_SIDEBAR_ROW_STRIDE, height: CANVAS_SIDEBAR_ROW_HEIGHT }}>
                                <NodeRow
                                    node={node}
                                    active={selectMode ? checked.has(node.id) : selectedNodeIds.has(node.id)}
                                    checked={checked.has(node.id)}
                                    selectMode={selectMode}
                                    theme={theme}
                                    onFocus={onFocusNode}
                                    onPreview={onPreviewNode}
                                    onToggleChecked={toggleChecked}
                                />
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="pt-16 text-center text-sm opacity-40">{t("canvas.sidePanel.noNodes")}</div>
                )}
            </div>
            {selectMode ? (
                <div className="flex items-center gap-2 border-t px-3 py-2.5" style={{ borderColor: theme.toolbar.border }}>
                    <button type="button" onClick={toggleAll} className="rounded-md px-2 py-1 text-xs font-medium opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10">
                        {allChecked ? t("canvas.sidePanel.clearAll") : t("workbench.selectAll")}
                    </button>
                    <span className="text-xs opacity-45">{t("canvas.sidePanel.selected", { count: checked.size })}</span>
                    <button
                        type="button"
                        onClick={() => void handleExport()}
                        disabled={!checked.size || exporting}
                        className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                    >
                        <Download className="size-3.5" />
                        {t("canvas.exportSelected")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

// One row per node. Memoized because a node drag replaces the `nodes` array on every frame, while a
// row's rendered output only depends on fields a move does not touch (type, title, content, status).
// Unmoved nodes keep their object identity, so their rows bail out instead of re-rendering — with a
// few hundred nodes this was the whole list re-rendering on every drag frame.
const NodeRow = memo(function NodeRow({
    node,
    active,
    checked,
    selectMode,
    theme,
    onFocus,
    onPreview,
    onToggleChecked,
}: {
    node: CanvasNodeData;
    active: boolean;
    checked: boolean;
    selectMode: boolean;
    theme: CanvasTheme;
    onFocus: (nodeId: string) => void;
    onPreview: (nodeId: string) => void;
    onToggleChecked: (nodeId: string) => void;
}) {
    const { t } = useTranslation();
    const Icon = NODE_TYPE_ICON[node.type] || FileText;
    const primary = node.metadata?.images?.find((image) => image.id === (node.metadata?.primaryImageId || node.metadata?.images?.[0]?.id));
    const imageSource = primary?.content || node.metadata?.content;
    const imageStorageKey = primary?.storageKey || node.metadata?.storageKey;
    const isImage = node.type === CanvasNodeType.Image && Boolean(imageSource || imageStorageKey);

    return (
        <div className={cn("group flex h-full w-full items-center rounded-lg transition", active ? "" : "hover:bg-black/5 dark:hover:bg-white/5")} style={active ? { background: theme.toolbar.activeBg } : undefined}>
            <button type="button" onClick={() => (selectMode ? onToggleChecked(node.id) : onFocus(node.id))} className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left" title={selectMode ? undefined : t("canvas.sidePanel.focusNode")}>
                {selectMode ? <CheckMark checked={checked} theme={theme} /> : null}
                <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md">
                    {isImage ? <CanvasSidebarThumbnail storageKey={imageStorageKey} source={imageSource} title={node.title} /> : <Icon className="size-5 opacity-60" />}
                </span>
                <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block truncate text-sm font-medium leading-snug">{node.title || getNodeDefinition(node.type)?.title || t("canvas.node.untitled")}</span>
                    <span className="block truncate text-xs leading-snug opacity-50">{nodePreviewText(node)}</span>
                </span>
                {node.metadata?.status && node.metadata.status !== "idle" ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[node.metadata.status] || "transparent" }} /> : null}
            </button>
            {selectMode || !isImage ? null : (
                <div className="flex shrink-0 flex-col items-center gap-0.5 pr-1.5">
                    <button type="button" onClick={() => onPreview(node.id)} className="grid size-7 place-items-center rounded-md opacity-55 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10" aria-label={t("canvas.sidePanel.preview")} title={t("canvas.sidePanel.preview")}>
                        <Eye className="size-3.5" />
                    </button>
                </div>
            )}
        </div>
    );
});

/** Only mounted (visible) sidebar rows request 256px previews. Stored assets never decode originals here. */
const CanvasSidebarThumbnail = memo(function CanvasSidebarThumbnail({ storageKey, source, title }: { storageKey?: string; source?: string; title: string }) {
    const [preview, setPreview] = useState<{ key: string; url: string } | null>(null);
    useEffect(() => {
        if (!storageKey) return;
        let active = true;
        void resolveMediaPreview("image", storageKey, () => getImageBlob(storageKey))
            .then((url) => { if (active && url) setPreview({ key: storageKey, url }); });
        return () => { active = false; };
    }, [storageKey]);
    // Preserve legacy/external image thumbnails where no storageKey exists; virtualization limits concurrent decodes.
    const url = storageKey ? (preview?.key === storageKey ? preview.url : null) : source;
    return url
        ? <img data-canvas-sidebar-preview src={url} alt={title} loading="lazy" decoding="async" className="size-full object-cover" />
        : <ImageIcon className="size-5 opacity-40" />;
});

function CheckMark({ checked, theme }: { checked: boolean; theme: CanvasTheme }) {
    return (
        <span className="grid size-4 shrink-0 place-items-center rounded border transition" style={{ borderColor: checked ? theme.toolbar.activeText : theme.node.stroke, background: checked ? theme.toolbar.activeText : "transparent" }}>
            {checked ? <Check className="size-3 text-white" /> : null}
        </span>
    );
}

// ---------------------------------------------------------------------------
// Assets tab: collapsible type groups, tag filtering, and click-to-insert.
// ---------------------------------------------------------------------------

const ASSET_GROUPS: { kind: AssetKind; icon: typeof Square }[] = [
    { kind: "image", icon: ImageIcon },
    { kind: "video", icon: Video },
    { kind: "text", icon: FileText },
];

function buildInsertPayload(asset: Asset): InsertAssetPayload {
    if (asset.kind === "text") return { kind: "text", content: asset.data.content, title: asset.title };
    if (asset.kind === "video") return { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height };
    return { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title };
}

const CanvasAssetsTab = memo(function CanvasAssetsTab({ onInsert, theme }: { onInsert: (payload: InsertAssetPayload) => void; theme: CanvasTheme }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const [keyword, setKeyword] = useState("");
    const [tagFilter, setTagFilter] = useState<string>("all");
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const allTags = useMemo(() => Array.from(new Set(assets.flatMap((asset) => asset.tags || []))).slice(0, 20), [assets]);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets.filter((asset) => (tagFilter === "all" || (asset.tags || []).includes(tagFilter)) && (!query || [asset.title, ...(asset.tags || [])].join(" ").toLowerCase().includes(query)));
    }, [assets, keyword, tagFilter]);

    const groups = useMemo(() => ASSET_GROUPS.map((group) => ({ ...group, items: filtered.filter((asset) => asset.kind === group.kind) })).filter((group) => group.items.length > 0), [filtered]);

    const handleFiles = async (fileList: FileList | null) => {
        const files = Array.from(fileList || []);
        if (!files.length) return;
        setUploading(true);
        const hide = message.loading(t("canvas.sidePanel.addingAssets"), 0);
        let added = 0;
        try {
            for (const file of files) {
                if (file.type.startsWith("image/")) {
                    const image = await uploadCanvasImage(file);
                    addAsset({ kind: "image", title: file.name || t("assets.kinds.image"), coverUrl: image.url, tags: [], data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType } });
                    added += 1;
                } else if (file.type.startsWith("video/")) {
                    const media = await uploadCanvasMedia(file, "video");
                    addAsset({ kind: "video", title: file.name || t("assets.kinds.video"), coverUrl: "", tags: [], data: { url: media.url, storageKey: media.storageKey, width: media.width || 0, height: media.height || 0, bytes: media.bytes, mimeType: media.mimeType } });
                    added += 1;
                }
            }
            if (added) await awaitAssetStorePersistence();
            if (added) message.success(t("canvas.sidePanel.addedAssets", { count: added }));
            else message.warning(t("canvas.sidePanel.mediaOnly"));
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.addFailed"));
        } finally {
            hide();
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 px-3 pb-2 pt-1">
                <Input size="small" allowClear prefix={<Search className="size-3.5 text-stone-400" />} placeholder={t("canvas.sidePanel.searchAssets")} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
                <button
                    type="button"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10"
                    style={{ color: theme.node.text }}
                >
                    <Plus className="size-3.5" />
                    {t("canvas.sidePanel.add")}
                </button>
                <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={(e) => void handleFiles(e.target.files)} />
            </div>
            {allTags.length ? (
                <div className="flex flex-wrap gap-1.5 px-3 pb-2">
                    <Tag.CheckableTag checked={tagFilter === "all"} className={cn("prompt-filter-tag", tagFilter === "all" && "is-active")} onChange={() => setTagFilter("all")}>
                        {t("common.all")}
                    </Tag.CheckableTag>
                    {allTags.map((tag) => (
                        <Tag.CheckableTag key={tag} checked={tagFilter === tag} className={cn("prompt-filter-tag", tagFilter === tag && "is-active")} onChange={() => setTagFilter((prev) => (prev === tag ? "all" : tag))}>
                            {tag}
                        </Tag.CheckableTag>
                    ))}
                </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {groups.length ? (
                    <div className="space-y-1">
                        {groups.map((group) => {
                            const isCollapsed = collapsed[group.kind];
                            return (
                                <div key={group.kind}>
                                    <button
                                        type="button"
                                        onClick={() => setCollapsed((prev) => ({ ...prev, [group.kind]: !prev[group.kind] }))}
                                        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs font-semibold opacity-75 transition hover:opacity-100"
                                    >
                                        <ChevronRight className={cn("size-3.5 transition-transform", !isCollapsed && "rotate-90")} />
                                        <group.icon className="size-3.5" />
                                        <span>{t(`assets.kinds.${group.kind}`)}</span>
                                        <span className="opacity-50">{group.items.length}</span>
                                    </button>
                                    {isCollapsed ? null : (
                                        <div className="grid grid-cols-2 gap-2 px-1 pb-2 pt-1">
                                            {group.items.map((asset) => (
                                                <AssetCard key={asset.id} asset={asset} theme={theme} onInsert={() => onInsert(buildInsertPayload(asset))} onRemove={() => (removeAsset(asset.id), message.success(t("canvas.sidePanel.assetRemoved")))} />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.sidePanel.noAssets")} className="pt-16" />
                )}
            </div>
        </div>
    );
});

function AssetCard({ asset, theme, onInsert, onRemove }: { asset: Asset; theme: CanvasTheme; onInsert: () => void; onRemove: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="group relative aspect-square overflow-hidden rounded-xl border transition duration-200 hover:-translate-y-0.5 hover:shadow-lg" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
            <AssetCover asset={asset} />
            <div className="absolute inset-0 flex items-center justify-center gap-2.5 opacity-0 transition duration-200 group-hover:opacity-100">
                <button
                    type="button"
                    onClick={onInsert}
                    className="grid size-8 place-items-center rounded-full bg-white/90 text-stone-700 shadow-sm backdrop-blur transition hover:bg-white hover:text-stone-900 dark:bg-black/60 dark:text-stone-100 dark:hover:bg-black/80"
                    aria-label={t("canvas.sidePanel.inserted")}
                >
                    <Plus className="size-4" />
                </button>
                <Popconfirm title={t("canvas.sidePanel.removeAssetTitle")} okText={t("canvas.sidePanel.remove")} cancelText={t("common.cancel")} okButtonProps={{ danger: true }} onConfirm={onRemove}>
                    <button
                        type="button"
                        className="grid size-8 place-items-center rounded-full bg-white/90 text-stone-700 shadow-sm backdrop-blur transition hover:bg-white hover:text-red-500 dark:bg-black/60 dark:text-stone-100 dark:hover:bg-black/80 dark:hover:text-red-400"
                        aria-label={t("canvas.sidePanel.removeAsset")}
                    >
                        <Trash2 className="size-4" />
                    </button>
                </Popconfirm>
            </div>
        </div>
    );
}

function AssetCover({ asset }: { asset: Asset }) {
    if (asset.kind === "text") return <div className="size-full overflow-hidden whitespace-pre-wrap break-words p-2.5 text-[11px] leading-snug opacity-80">{asset.data.content}</div>;
    if (asset.kind === "video") {
        if (asset.coverUrl) return <img src={asset.coverUrl} alt="" className="size-full object-cover transition duration-300 group-hover:scale-[1.04]" />;
        return <video src={`${asset.data.url}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover transition duration-300 group-hover:scale-[1.04]" />;
    }
    return <img src={asset.coverUrl || asset.data.dataUrl} alt="" className="size-full object-cover transition duration-300 group-hover:scale-[1.04]" />;
}

// ---------------------------------------------------------------------------
// Generation history tab: recently generated canvas images with one-click save to assets.
// ---------------------------------------------------------------------------

const CanvasHistoryTab = memo(function CanvasHistoryTab({ theme }: { theme: CanvasTheme }) {
    const { i18n, t } = useTranslation();
    const message = App.useApp().message;
    const records = useGenerationHistoryStore((state) => state.records);
    const removeRecord = useGenerationHistoryStore((state) => state.removeRecord);
    const clearRecords = useGenerationHistoryStore((state) => state.clearRecords);
    const addAsset = useAssetStore((state) => state.addAsset);

    const saveToAssets = async (record: GenerationHistoryRecord) => {
        const first = record.images[0];
        if (!first) return;
        const url = await resolveImageUrl(first.storageKey);
        if (!url) {
            message.error(t("canvas.sidePanel.addFailed"));
            return;
        }
        addAsset({
            kind: "image",
            title: record.prompt.slice(0, 24) || t("canvas.sidePanel.generatedImage"),
            coverUrl: url,
            tags: [],
            source: "canvas-history",
            data: { dataUrl: url, storageKey: first.storageKey, width: first.width, height: first.height, bytes: first.bytes, mimeType: first.mimeType },
        });
        try { await awaitAssetStorePersistence();message.success(t("common.addedToAssets")); }
        catch(error){message.error(String(error))}
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex min-h-8 items-center justify-between px-3 pt-1">
                <span className="text-xs opacity-60">{t("canvas.sidePanel.history")}</span>
                {records.length ? (
                    <Button type="text" size="small" className="!px-2 !text-xs" onClick={clearRecords}>
                        {t("canvas.sidePanel.clearHistory")}
                    </Button>
                ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {records.length ? (
                    <div className="space-y-2">
                        {records.map((record) => (
                            <div key={record.id} className="rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                                <div className="grid grid-cols-3 gap-1.5">
                                    {record.images.slice(0, 6).map((image) => (
                                        <HistoryThumb key={image.storageKey} storageKey={image.storageKey} theme={theme} />
                                    ))}
                                </div>
                                <p className="mt-2 line-clamp-2 text-xs leading-5 opacity-75">{record.prompt}</p>
                                <div className="mt-2 flex items-center justify-between gap-2">
                                    <span className="truncate text-[11px] opacity-45">
                                        {new Date(record.createdAt).toLocaleString(i18n.resolvedLanguage, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                                        {record.successCount > 1 ? ` · ${record.successCount}张` : ""}
                                    </span>
                                    <div className="flex shrink-0 items-center gap-1">
                                        <Button type="text" size="small" className="!px-2 !text-xs" style={{ color: theme.toolbar.activeText }} onClick={() => void saveToAssets(record)}>
                                            {t("canvas.sidePanel.saveToAssets")}
                                        </Button>
                                        <Button type="text" size="small" className="!px-1.5 !text-xs" icon={<Trash2 className="size-3.5" />} onClick={() => removeRecord(record.id)} aria-label={t("common.delete")} />
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.sidePanel.historyEmpty")} className="pt-12" />
                )}
            </div>
        </div>
    );
});

function HistoryThumb({ storageKey, theme }: { storageKey: string; theme: CanvasTheme }) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        let alive = true;
        void resolveImageUrl(storageKey).then((resolved) => {
            if (alive && resolved) setUrl(resolved);
        });
        return () => {
            alive = false;
        };
    }, [storageKey]);
    if (!url) return <div className="aspect-square rounded-lg" style={{ background: theme.toolbar.itemHover }} />;
    return <img src={url} alt="" className="aspect-square w-full rounded-lg object-cover" loading="lazy" />;
}
