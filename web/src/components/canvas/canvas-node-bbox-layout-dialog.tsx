import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { App, Button, Input, Modal, Select, Switch, Tooltip } from "antd";
import { AlignCenterHorizontal, AlignCenterVertical, ArrowDown, ArrowUp, Copy, Eye, EyeOff, Lock, LockOpen, Redo2, Trash2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { IMAGE_SIZE_PRESETS } from "@/lib/canvas/image-size-presets";
import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";
import {
    alignBboxItems,
    bboxLayoutToModelJson,
    clampBboxItem,
    drawBboxItem,
    duplicateBboxSelection,
    distributeBboxItems,
    emptyBboxLayout,
    initialBboxSize,
    isSupportedBboxGenerationSize,
    matchBboxSize,
    moveBboxSelection,
    parseBboxImport,
    resizeBboxItem,
    resizeBboxLayout,
    snapMoveBboxSelection,
    updateBboxItem,
    validateBboxLayout,
    type BBoxAlignment,
    type BBoxItem,
    type BBoxKind,
    type BBoxLayout,
} from "@/lib/canvas/bbox-layout";

type Gesture = { pointerId: number; startX: number; startY: number; original: BBoxLayout; itemId?: string; handle?: string; selection: string[]; newItem?: BBoxItem };
type Point = { x: number; y: number };
const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const presets = IMAGE_SIZE_PRESETS;

export function CanvasNodeBBoxLayoutDialog({
    open,
    initialLayout,
    initialPrompt,
    initialSize,
    onClose,
    onApply,
}: {
    open: boolean;
    initialLayout?: BBoxLayout;
    initialPrompt?: string;
    initialSize: string;
    onClose: () => void;
    onApply: (layout: BBoxLayout, promptJson: string, width: number, height: number) => void;
}) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const getInitialLayout = () => {
        if (initialLayout) return initialLayout;
        if (initialPrompt) {
            try {
                return parseBboxImport(initialPrompt, ...initialBboxSize(initialSize));
            } catch {
                /* Start with a clean layout when the prompt is not a BBox document. */
            }
        }
        return emptyBboxLayout(...initialBboxSize(initialSize));
    };
    const [layout, setLayout] = useState<BBoxLayout>(getInitialLayout);
    const [selected, setSelected] = useState<string[]>([]);
    const [error, setError] = useState("");
    const [snap, setSnap] = useState(true);
    const [grid, setGrid] = useState(false);
    const [preview, setPreview] = useState(false);
    const [drawKind, setDrawKind] = useState<BBoxKind | null>(null);
    const [marquee, setMarquee] = useState<{ start: Point; end: Point } | null>(null);
    const [pasteJson, setPasteJson] = useState("");
    const [history, setHistory] = useState<BBoxLayout[]>([]);
    const [future, setFuture] = useState<BBoxLayout[]>([]);
    const copiedItems = useRef<BBoxItem[]>([]);
    const gesture = useRef<Gesture | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const draggedLayer = useRef<string | null>(null);
    const [editingItemId, setEditingItemId] = useState<string | null>(null);
    const [editingDraft, setEditingDraft] = useState<{ caption: string; text: string }>({ caption: "", text: "" });
    const [editingPosition, setEditingPosition] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
    const viewport = useImageEditorViewport({ width: layout.width, height: layout.height }, open);
    const selectedItem = layout.items.find((item) => item.id === selected.at(-1));
    const json = useMemo(() => bboxLayoutToModelJson(layout), [layout]);
    const canApplySize = isSupportedBboxGenerationSize(layout.width, layout.height);
    const localizedError = (issue: string) =>
        issue.startsWith("Global caption")
            ? t("canvas.bboxEditor.captionRequired")
            : issue.startsWith("Add at least")
              ? t("canvas.bboxEditor.visibleRequired")
              : issue.startsWith("Complete the caption")
                ? t("canvas.bboxEditor.captionTextRequired", { kind: issue.split("for ").at(-1)?.replace(/\.$/, "") })
                : issue.startsWith("Fix the bounds")
                  ? t("canvas.bboxEditor.boundsInvalid", { kind: issue.split("for ").at(-1)?.replace(/\.$/, "") })
                  : issue;

    useEffect(() => {
        if (!open) return;
        setLayout(getInitialLayout());
        setSelected([]);
        setError("");
        setHistory([]);
        setFuture([]);
        setPreview(false);
        setDrawKind(null);
    }, [open, initialLayout, initialPrompt, initialSize]);

    const commit = (next: BBoxLayout) => {
        setHistory((past) => [...past.slice(-49), layout]);
        setFuture([]);
        setLayout(next);
        setError("");
    };
    const undo = () => {
        if (!history.length) return;
        setFuture((redo) => [layout, ...redo]);
        setLayout(history.at(-1)!);
        setHistory(history.slice(0, -1));
    };
    const redo = () => {
        if (!future.length) return;
        setHistory((past) => [...past, layout]);
        setLayout(future[0]);
        setFuture(future.slice(1));
    };
    const updateItem = (id: string, patch: Partial<BBoxItem>) => commit({ ...layout, items: layout.items.map((item) => (item.id === id ? updateBboxItem(item, patch, layout.width, layout.height) : item)) });
    const addItem = (kind: BBoxKind, box?: { x1: number; y1: number; x2: number; y2: number }) => {
        const item: BBoxItem = {
            id: crypto.randomUUID(),
            kind,
            caption: "",
            ...(kind === "text" ? { text: "" } : {}),
            x1: box?.x1 ?? layout.width * 0.3,
            y1: box?.y1 ?? layout.height * 0.3,
            x2: box?.x2 ?? layout.width * 0.7,
            y2: box?.y2 ?? layout.height * 0.7,
        };
        commit({ ...layout, items: [...layout.items, item] });
        setSelected([item.id]);
        setDrawKind(null);
        return item;
    };
    const duplicate = (item: BBoxItem) => {
        const result = duplicateBboxSelection(layout, [item.id]);
        commit(result.layout);
        setSelected(result.selectedIds);
    };

    const openInlineEditor = (event: ReactMouseEvent<SVGSVGElement>, item: BBoxItem) => {
        if (preview) return;
        event.preventDefault();
        event.stopPropagation();
        if (item.locked) {
            message.warning(t("canvas.bboxEditor.lockedEdit"));
            return;
        }
        setSelected([item.id]);
        setEditingItemId(item.id);
        setEditingDraft({ caption: item.caption, text: item.text ?? "" });
        const rect = [...event.currentTarget.querySelectorAll<SVGGElement>("g[data-bbox-canvas-id]")].find((group) => group.dataset.bboxCanvasId === item.id)?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
        const left = Math.max(12, Math.min(rect.left, window.innerWidth - 352));
        const top = rect.bottom + 8 + 280 < window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - 288);
        setEditingPosition({ left, top });
    };
    const closeInlineEditor = () => {
        setEditingItemId(null);
        requestAnimationFrame(() => viewport.stageRef.current?.querySelector<SVGSVGElement>("svg")?.focus());
    };
    const saveInlineEditor = () => {
        const item = layout.items.find((candidate) => candidate.id === editingItemId);
        if (!item || item.locked) {
            closeInlineEditor();
            return;
        }
        updateItem(item.id, { caption: editingDraft.caption, ...(item.kind === "text" ? { text: editingDraft.text } : {}) });
        closeInlineEditor();
    };

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (preview) return;
            if (event.target instanceof Element && event.target.closest("input,textarea,[contenteditable='true']")) return;
            const mod = event.metaKey || event.ctrlKey;
            if (mod && event.key.toLowerCase() === "z") {
                event.preventDefault();
                event.shiftKey ? redo() : undo();
                return;
            }
            if (mod && event.key.toLowerCase() === "y") {
                event.preventDefault();
                redo();
                return;
            }
            if (mod && event.key.toLowerCase() === "a") {
                event.preventDefault();
                setSelected(layout.items.filter((item) => !item.hidden).map((item) => item.id));
                return;
            }
            if ((event.key === "Delete" || event.key === "Backspace") && selected.length) {
                event.preventDefault();
                commit({ ...layout, items: layout.items.filter((item) => !selected.includes(item.id)) });
                setSelected([]);
                return;
            }
            if (mod && event.key.toLowerCase() === "c" && selected.length) {
                copiedItems.current = layout.items.filter((item) => selected.includes(item.id)).map((item) => ({ ...item }));
                return;
            }
            if (mod && event.key.toLowerCase() === "v" && copiedItems.current.length) {
                event.preventDefault();
                const copies = duplicateBboxSelection(
                    { ...layout, items: copiedItems.current },
                    copiedItems.current.map((item) => item.id),
                );
                commit({ ...layout, items: [...layout.items, ...copies.layout.items] });
                setSelected(copies.selectedIds);
                return;
            }
            if (mod && event.key.toLowerCase() === "d" && selected.length) {
                event.preventDefault();
                const copies = duplicateBboxSelection(layout, selected);
                commit(copies.layout);
                setSelected(copies.selectedIds);
                return;
            }
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && selected.length) {
                event.preventDefault();
                const step = event.shiftKey ? 10 : 1;
                const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
                const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
                commit(moveBboxSelection(layout, selected, dx, dy));
            }
        };
        const onPaste = (event: ClipboardEvent) => {
            if (preview) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("input,textarea,[contenteditable='true']")) return;
            const text = event.clipboardData?.getData("text/plain");
            if (text?.trim().startsWith("{")) {
                event.preventDefault();
                void importText(text);
            }
        };
        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("paste", onPaste, true);
        return () => {
            window.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("paste", onPaste, true);
        };
    });

    const pointFor = (event: ReactPointerEvent<SVGElement>) => {
        const svg = event.currentTarget instanceof SVGSVGElement ? event.currentTarget : event.currentTarget.ownerSVGElement;
        return pointFromClient(event.clientX, event.clientY, svg);
    };
    const pointFromClient = (clientX: number, clientY: number, svg?: SVGSVGElement | null) => {
        const rect = svg?.getBoundingClientRect();
        return { x: (clientX - (rect?.left ?? 0)) / Math.max(viewport.imageScale, 0.001), y: (clientY - (rect?.top ?? 0)) / Math.max(viewport.imageScale, 0.001) };
    };
    const begin = (event: ReactPointerEvent<SVGElement>, itemId?: string, handle?: string) => {
        if (event.button !== 0 || preview) return;
        event.preventDefault();
        event.stopPropagation();
        const point = pointFor(event);
        let selection = selected;
        if (itemId && (event.shiftKey || event.ctrlKey || event.metaKey)) {
            selection = selected.includes(itemId) ? selected.filter((id) => id !== itemId) : [...selected, itemId];
            setSelected(selection);
        } else if (itemId && !selected.includes(itemId)) {
            selection = [itemId];
            setSelected(selection);
        }
        if (!itemId && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            selection = [];
            setSelected([]);
        }
        const newItem = !itemId && drawKind ? ({ id: crypto.randomUUID(), kind: drawKind, caption: "", ...(drawKind === "text" ? { text: "" } : {}), x1: point.x, y1: point.y, x2: point.x, y2: point.y } as BBoxItem) : undefined;
        gesture.current = { pointerId: event.pointerId, startX: point.x, startY: point.y, original: layout, itemId, handle, selection, newItem };
        const svg = event.currentTarget instanceof SVGSVGElement ? event.currentTarget : event.currentTarget.ownerSVGElement;
        svg?.focus();
        svg?.setPointerCapture(event.pointerId);
    };
    const move = (event: ReactPointerEvent<SVGSVGElement>) => {
        const g = gesture.current;
        if (!g || event.pointerId !== g.pointerId) return;
        const point = pointFor(event);
        let dx = point.x - g.startX,
            dy = point.y - g.startY;
        if (grid && !g.newItem) {
            dx = Math.round(dx / 16) * 16;
            dy = Math.round(dy / 16) * 16;
        }
        if (g.newItem) {
            const snap = (value: number, limit: number) => (grid ? Math.min(limit, Math.max(0, Math.round(value / 16) * 16)) : value);
            const item = drawBboxItem(g.newItem, snap(g.startX, layout.width), snap(g.startY, layout.height), snap(point.x, layout.width), snap(point.y, layout.height), layout.width, layout.height);
            setLayout({ ...g.original, items: [...g.original.items, item] });
            setSelected([item.id]);
            return;
        }
        if (!g.itemId) {
            setMarquee({ start: { x: g.startX, y: g.startY }, end: point });
            return;
        }
        if (g.handle && g.itemId) {
            let items = g.original.items.map((item) => (item.id === g.itemId && !item.locked && !item.hidden ? resizeBboxItem(item, g.handle!, dx, dy, layout.width, layout.height) : item));
            if (snap) items = snapResizeItem(items, g, layout, viewport.imageScale);
            setLayout({ ...g.original, items: items.map((item) => (item.id === g.itemId ? clampBboxItem(item, layout.width, layout.height) : item)) });
            return;
        }
        const moved = snap ? snapMoveBboxSelection(g.original, g.selection, dx, dy, 6 / Math.max(viewport.imageScale, 0.001)).layout : moveBboxSelection(g.original, g.selection, dx, dy);
        setLayout(moved);
    };
    const finish = (event: ReactPointerEvent<SVGSVGElement>) => {
        const g = gesture.current;
        if (!g || event.pointerId !== g.pointerId) return;
        gesture.current = null;
        if (!g.itemId && !g.newItem && marquee) {
            const box = { x1: Math.min(marquee.start.x, marquee.end.x), y1: Math.min(marquee.start.y, marquee.end.y), x2: Math.max(marquee.start.x, marquee.end.x), y2: Math.max(marquee.start.y, marquee.end.y) };
            const found = layout.items.filter((item) => !item.hidden && item.x2 >= box.x1 && item.x1 <= box.x2 && item.y2 >= box.y1 && item.y1 <= box.y2).map((item) => item.id);
            setSelected(g.selection.length ? [...new Set([...g.selection, ...found])] : found);
            setMarquee(null);
        }
        const changed = JSON.stringify(g.original.items) !== JSON.stringify(layout.items);
        if (changed) {
            setHistory((past) => [...past.slice(-49), g.original]);
            setFuture([]);
        }
        if (g.newItem) setDrawKind(null);
    };

    function changeSize(width: number, height: number) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width % 16 || height % 16) {
            setError("Dimensions must be positive multiples of 16.");
            return;
        }
        commit(resizeBboxLayout(layout, width, height));
    }
    async function importText(text: string) {
        try {
            const imported = parseBboxImport(text, layout.width, layout.height);
            const report = [
                `Canvas: ${imported.width} × ${imported.height}`,
                `Caption: ${imported.summary.caption || "(empty)"}`,
                ...imported.items.map((item) => `${item.kind}: [${Math.floor(item.x1)}, ${Math.floor(item.y1)}, ${Math.ceil(item.x2)}, ${Math.ceil(item.y2)}]`),
            ].join("\n");
            modal.confirm({
                title: t("canvas.bboxEditor.importConfirm"),
                content: <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{report}</pre>,
                onOk: () => {
                    commit(imported);
                    setSelected(imported.items[0] ? [imported.items[0].id] : []);
                    setPasteJson("");
                },
            });
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : "Invalid JSON");
        }
    }
    const apply = () => {
        const issue = validateBboxLayout(layout);
        if (issue) {
            setError(localizedError(issue));
            const item = layout.items.find(
                (candidate) =>
                    !candidate.hidden &&
                    (!candidate.caption.trim() ||
                        (candidate.kind === "text" && !candidate.text?.trim()) ||
                        candidate.x1 < 0 ||
                        candidate.y1 < 0 ||
                        candidate.x2 > layout.width ||
                        candidate.y2 > layout.height ||
                        candidate.x2 <= candidate.x1 ||
                        candidate.y2 <= candidate.y1),
            );
            if (item) {
                setSelected([item.id]);
                requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-bbox-id="${item.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
            } else document.querySelector<HTMLElement>("[data-bbox-global-caption]")?.focus();
            return;
        }
        if (!canApplySize) {
            setError(t("canvas.bboxEditor.supportedSizeError"));
            return;
        }
        onApply(layout, json, layout.width, layout.height);
    };

    return (
        <Modal open={open} title={t("canvas.bboxEditor.title")} onCancel={onClose} footer={null} width="min(1400px, 94vw)" centered destroyOnHidden styles={{ body: { maxHeight: "calc(100dvh - 140px)", overflowY: "auto" } }}>
            <div className="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)_260px] xl:grid-cols-[320px_minmax(0,1fr)_260px]" data-canvas-no-zoom>
                <section className="flex h-[min(60dvh,560px)] min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/10 bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.02] lg:h-[calc(100dvh-180px)]">
                    <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-auto overscroll-contain pr-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <strong>{t("canvas.bboxEditor.canvasItems")}</strong>
                            <div className="flex gap-1">
                                {(["object", "character", "text"] as const).map((kind) => (
                                    <Button key={kind} size="small" onClick={() => addItem(kind)}>
                                        + {kind}
                                    </Button>
                                ))}
                            </div>
                        </div>
                        <div className="space-y-2">
                            {layout.items.map((item, index) => (
                                <div
                                    key={item.id}
                                    data-bbox-id={item.id}
                                    draggable
                                    onDragStart={() => {
                                        draggedLayer.current = item.id;
                                    }}
                                    onDragOver={(event) => event.preventDefault()}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        const source = layout.items.findIndex((candidate) => candidate.id === draggedLayer.current),
                                            target = layout.items.findIndex((candidate) => candidate.id === item.id);
                                        if (source < 0 || target < 0 || source === target) return;
                                        const items = [...layout.items];
                                        const [moving] = items.splice(source, 1);
                                        items.splice(target, 0, moving);
                                        commit({ ...layout, items });
                                        draggedLayer.current = null;
                                    }}
                                    onDragEnd={() => {
                                        draggedLayer.current = null;
                                    }}
                                    className={`rounded-lg border p-2 ${selected.includes(item.id) ? "border-sky-500" : "border-black/10 dark:border-white/10"}`}
                                    onClick={() => setSelected([item.id])}
                                >
                                    <div className="mb-2 flex flex-wrap items-center gap-1">
                                        <span className="inline-flex h-6 min-w-7 shrink-0 items-center justify-center rounded bg-slate-200 px-1 text-xs font-bold text-slate-800 dark:bg-slate-700 dark:text-white" aria-label={`Layer ${index + 1}`}>
                                            #{index + 1}
                                        </span>
                                        <Select
                                            size="small"
                                            className="min-w-0 flex-1"
                                            value={item.kind}
                                            options={(["object", "character", "text"] as const).map((value) => ({ value, label: value }))}
                                            onChange={(kind) => updateItem(item.id, { kind: kind as BBoxKind, text: kind === "text" ? item.text || "" : undefined })}
                                        />
                                        <Tooltip title={item.locked ? "Unlock" : "Lock"}>
                                            <Button
                                                size="small"
                                                title={t(item.locked ? "canvas.bboxEditor.unlock" : "canvas.bboxEditor.lock")}
                                                aria-label={t(item.locked ? "canvas.bboxEditor.unlock" : "canvas.bboxEditor.lock")}
                                                icon={item.locked ? <Lock size={14} /> : <LockOpen size={14} />}
                                                onClick={() => updateItem(item.id, { locked: !item.locked })}
                                            />
                                        </Tooltip>
                                        <Button
                                            size="small"
                                            title={t(item.hidden ? "canvas.bboxEditor.show" : "canvas.bboxEditor.hide")}
                                            aria-label={t(item.hidden ? "canvas.bboxEditor.show" : "canvas.bboxEditor.hide")}
                                            icon={item.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                                            onClick={() => updateItem(item.id, { hidden: !item.hidden })}
                                        />
                                        <Button
                                            size="small"
                                            title={t("canvas.bboxEditor.moveUp")}
                                            aria-label={t("canvas.bboxEditor.moveUp")}
                                            icon={<ArrowUp size={14} />}
                                            disabled={index === layout.items.length - 1}
                                            onClick={() => {
                                                const items = [...layout.items];
                                                [items[index], items[index + 1]] = [items[index + 1], items[index]];
                                                commit({ ...layout, items });
                                            }}
                                        />
                                        <Button
                                            size="small"
                                            title={t("canvas.bboxEditor.moveDown")}
                                            aria-label={t("canvas.bboxEditor.moveDown")}
                                            icon={<ArrowDown size={14} />}
                                            disabled={index === 0}
                                            onClick={() => {
                                                const items = [...layout.items];
                                                [items[index], items[index - 1]] = [items[index - 1], items[index]];
                                                commit({ ...layout, items });
                                            }}
                                        />
                                        <Button size="small" title={t("canvas.bboxEditor.duplicate")} aria-label={t("canvas.bboxEditor.duplicate")} icon={<Copy size={14} />} onClick={() => duplicate(item)} />
                                        <Button
                                            danger
                                            size="small"
                                            title={t("canvas.bboxEditor.delete")}
                                            aria-label={t("canvas.bboxEditor.delete")}
                                            icon={<Trash2 size={14} />}
                                            onClick={() => {
                                                commit({ ...layout, items: layout.items.filter((candidate) => candidate.id !== item.id) });
                                                setSelected([]);
                                            }}
                                        />
                                    </div>
                                    <div className="grid grid-cols-4 gap-1">
                                        {(["x1", "y1", "x2", "y2"] as const).map((key) => (
                                            <label className="text-[10px] opacity-70" key={key}>
                                                {key}
                                                <Input
                                                    size="small"
                                                    type="number"
                                                    min={key === "x1" || key === "y1" ? 0 : undefined}
                                                    max={key === "x1" ? item.x2 - 1 : key === "y1" ? item.y2 - 1 : key === "x2" ? layout.width : layout.height}
                                                    value={Math.round(item[key])}
                                                    onChange={(event) => updateItem(item.id, { [key]: Number(event.target.value) })}
                                                />
                                            </label>
                                        ))}
                                    </div>
                                    <Input.TextArea className="mt-2" size="small" rows={2} placeholder={t("canvas.bboxEditor.itemCaption")} value={item.caption} onChange={(event) => updateItem(item.id, { caption: event.target.value })} />
                                    {item.kind === "text" ? (
                                        <Input.TextArea className="mt-2" size="small" rows={2} placeholder={t("canvas.bboxEditor.exactText")} value={item.text} onChange={(event) => updateItem(item.id, { text: event.target.value })} />
                                    ) : null}
                                    <div className="mt-1 grid grid-cols-2 gap-1">
                                        <Input
                                            size="small"
                                            placeholder={t("canvas.bboxEditor.tags")}
                                            value={item.tags?.join(", ") || ""}
                                            onChange={(event) =>
                                                updateItem(item.id, {
                                                    tags: event.target.value
                                                        .split(",")
                                                        .map((value) => value.trim())
                                                        .filter(Boolean),
                                                })
                                            }
                                        />
                                        <Input
                                            size="small"
                                            placeholder={t("canvas.bboxEditor.palette")}
                                            value={item.palette?.join(", ") || ""}
                                            onChange={(event) =>
                                                updateItem(item.id, {
                                                    palette: event.target.value
                                                        .split(",")
                                                        .map((value) => value.trim())
                                                        .filter(Boolean),
                                                })
                                            }
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                        {selected.length > 1 ? <MultiSelectionTools layout={layout} selected={selected} onCommit={commit} /> : null}
                    </div>
                </section>

                <section className="flex min-h-0 min-w-0 flex-col lg:sticky lg:top-0 lg:h-[calc(100dvh-180px)]">
                    <div role="toolbar" className="thin-scrollbar mb-2 flex shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap rounded-lg border border-black/10 p-2 text-xs dark:border-white/10 [&>*]:shrink-0" title={t("canvas.bboxEditor.panHint")}>
                        <Button size="small" title={t("canvas.bboxEditor.undo")} aria-label={t("canvas.bboxEditor.undo")} icon={<Undo2 size={15} />} disabled={!history.length} onClick={undo} />
                        <Button size="small" title={t("canvas.bboxEditor.redo")} aria-label={t("canvas.bboxEditor.redo")} icon={<Redo2 size={15} />} disabled={!future.length} onClick={redo} />
                        <Button size="small" title={t("canvas.bboxEditor.zoomOut")} aria-label={t("canvas.bboxEditor.zoomOut")} icon={<ZoomOut size={15} />} onClick={viewport.zoomOut} disabled={!viewport.canZoomOut} />
                        <span className="text-xs tabular-nums">{Math.round(viewport.zoom * 100)}%</span>
                        <Button size="small" title={t("canvas.bboxEditor.zoomIn")} aria-label={t("canvas.bboxEditor.zoomIn")} icon={<ZoomIn size={15} />} onClick={viewport.zoomIn} disabled={!viewport.canZoomIn} />
                        <Select
                            size="small"
                            disabled={preview}
                            value={drawKind ?? "select"}
                            onChange={(value) => setDrawKind(value === "select" ? null : (value as BBoxKind))}
                            options={[
                                { value: "select", label: t("canvas.bboxEditor.selectTool") },
                                { value: "object", label: t("canvas.bboxEditor.drawObject") },
                                { value: "character", label: t("canvas.bboxEditor.drawCharacter") },
                                { value: "text", label: t("canvas.bboxEditor.drawText") },
                            ]}
                        />
                        <span aria-hidden="true" className="h-4 border-l border-black/15 dark:border-white/15" />
                        <span>
                            {layout.width} × {layout.height}px
                        </span>
                        <label className="flex items-center gap-2">
                            {t("canvas.bboxEditor.snap")} <Switch size="small" disabled={preview} checked={snap} onChange={setSnap} />
                        </label>
                        <label className="flex items-center gap-2">
                            {t("canvas.bboxEditor.grid16")} <Switch size="small" disabled={preview} checked={grid} onChange={setGrid} />
                        </label>
                        <Button size="small" type={preview ? "primary" : "default"} aria-pressed={preview} title={t("canvas.bboxEditor.previewHint")} icon={<Eye size={14} />} onClick={() => {
                            setEditingItemId(null);
                            setDrawKind(null);
                            setMarquee(null);
                            setPreview((value) => !value);
                        }}>
                            {preview ? t("canvas.bboxEditor.edit") : t("canvas.bboxEditor.preview")}
                        </Button>
                    </div>
                    <div
                        ref={viewport.viewportRef}
                        {...viewport.panHandlers}
                        className={`relative h-[clamp(240px,55dvh,600px)] min-h-0 lg:h-auto lg:flex-1 rounded-lg border border-black/15 bg-neutral-100 dark:border-white/15 dark:bg-neutral-900 ${viewport.scrollClassName} ${viewport.spacePressed ? "cursor-grab" : ""}`}
                    >
                        <div className="relative" style={viewport.contentStyle}>
                            <div ref={viewport.stageRef} className="absolute overflow-visible rounded bg-white shadow-sm" style={viewport.stageStyle}>
                                <svg
                                    tabIndex={0}
                                    aria-label={t("canvas.bboxEditor.canvasItems")}
                                    width={layout.width}
                                    height={layout.height}
                                    viewBox={`0 0 ${layout.width} ${layout.height}`}
                                    className="absolute left-0 top-0 h-full w-full touch-none select-none focus:outline-none"
                                    style={{ ...viewport.mediaStyle, overflow: "visible" }}
                                    onPointerDown={(event) => begin(event)}
                                    onPointerMove={move}
                                    onPointerUp={finish}
                                    onPointerCancel={finish}
                                    onDoubleClick={(event) => {
                                        const point = pointFromClient(event.clientX, event.clientY, event.currentTarget);
                                        const item = [...layout.items].reverse().find((candidate) => !candidate.hidden && point.x >= candidate.x1 && point.x <= candidate.x2 && point.y >= candidate.y1 && point.y <= candidate.y2);
                                        if (item) openInlineEditor(event, item);
                                    }}
                                >
                                    <defs>
                                        {layout.items.map((item) => (
                                            <clipPath key={item.id} id={`bbox-clip-${item.id.replace(/[^\w-]/g, "-")}`}>
                                                <rect x={item.x1} y={item.y1} width={Math.max(1, item.x2 - item.x1)} height={Math.max(1, item.y2 - item.y1)} />
                                            </clipPath>
                                        ))}
                                    </defs>
                                    {grid && !preview ? (
                                        <defs>
                                            <pattern id="bbox-grid" width="16" height="16" patternUnits="userSpaceOnUse">
                                                <path d="M 16 0 L 0 0 0 16" fill="none" stroke="#94a3b8" strokeOpacity=".25" />
                                            </pattern>
                                        </defs>
                                    ) : null}
                                    {grid && !preview ? <rect width="100%" height="100%" fill="url(#bbox-grid)" pointerEvents="none" /> : null}
                                    {layout.items.map((item, index) => {
                                        if (item.hidden) return null;
                                        const boxWidth = Math.max(1, item.x2 - item.x1);
                                        const boxHeight = Math.max(1, item.y2 - item.y1);
                                        const scale = Math.max(viewport.imageScale, 0.001);
                                        const clipId = `bbox-clip-${item.id.replace(/[^\w-]/g, "-")}`;
                                        return (
                                            <g key={item.id} data-bbox-canvas-id={item.id} onPointerDown={(event) => begin(event, item.id)} className={item.locked || preview ? "" : "cursor-move"}>
                                                <title>{`#${index + 1} ${item.kind}${item.locked ? " · locked" : ""}\n${item.caption}${item.kind === "text" ? `\n${item.text ?? ""}` : ""}`}</title>
                                                <rect
                                                    x={item.x1}
                                                    y={item.y1}
                                                    width={boxWidth}
                                                    height={boxHeight}
                                                    fill={item.kind === "text" ? "rgba(234,88,12,.12)" : item.kind === "character" ? "rgba(147,51,234,.12)" : "rgba(37,99,235,.12)"}
                                                    stroke={selected.includes(item.id) && !preview ? "#0ea5e9" : item.kind === "text" ? "#ea580c" : item.kind === "character" ? "#9333ea" : "#2563eb"}
                                                    strokeWidth={2}
                                                    vectorEffect="non-scaling-stroke"
                                                />
                                                <foreignObject x={item.x1} y={item.y1} width={boxWidth} height={boxHeight} clipPath={`url(#${clipId})`} pointerEvents="none">
                                                    <div
                                                        style={{
                                                            boxSizing: "border-box",
                                                            display: "flex",
                                                            flexDirection: "column",
                                                            gap: `${2 / scale}px`,
                                                            width: "100%",
                                                            height: "100%",
                                                            overflow: "hidden",
                                                            padding: `${3 / scale}px`,
                                                            color: "#111827",
                                                            fontFamily: "Arial, sans-serif",
                                                        }}
                                                    >
                                                        <div
                                                            style={{
                                                                flex: `0 0 ${14 / scale}px`,
                                                                overflow: "hidden",
                                                                whiteSpace: "nowrap",
                                                                textOverflow: "ellipsis",
                                                                fontSize: `${12 / scale}px`,
                                                                fontWeight: 700,
                                                                lineHeight: `${14 / scale}px`,
                                                                color: item.kind === "text" ? "#c2410c" : item.kind === "character" ? "#7e22ce" : "#1d4ed8",
                                                            }}
                                                        >
                                                            #{index + 1} · {item.kind}
                                                            {item.locked ? " · 🔒" : ""}
                                                        </div>
                                                        {item.kind === "text" ? (
                                                            <div style={{ minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", gap: `${2 / scale}px` }}>
                                                                <div
                                                                    style={{
                                                                        flex: `0 0 ${Math.min(2, Math.max(1, Math.floor((boxHeight * scale) / 46)))}em`,
                                                                        overflow: "hidden",
                                                                        fontSize: `${11 / scale}px`,
                                                                        lineHeight: 1.15,
                                                                        color: "#475569",
                                                                        whiteSpace: "pre-wrap",
                                                                        overflowWrap: "anywhere",
                                                                    }}
                                                                >
                                                                    {item.caption}
                                                                </div>
                                                                <div style={{ minHeight: 0, flex: 1, overflow: "hidden", fontSize: `${14 / scale}px`, lineHeight: 1.2, fontWeight: 600, color: "#111827", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                                                                    {item.text}
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div style={{ minHeight: 0, flex: 1, overflow: "hidden", fontSize: `${14 / scale}px`, lineHeight: 1.2, color: "#334155", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.caption}</div>
                                                        )}
                                                    </div>
                                                </foreignObject>
                                                {selected.includes(item.id) && !item.locked && !preview
                                                    ? handles.map((handle) => {
                                                          const x = handle.includes("w") ? item.x1 : handle.includes("e") ? item.x2 : (item.x1 + item.x2) / 2;
                                                          const y = handle.includes("n") ? item.y1 : handle.includes("s") ? item.y2 : (item.y1 + item.y2) / 2;
                                                          return (
                                                              <circle
                                                                  key={handle}
                                                                  cx={x}
                                                                  cy={y}
                                                                  r={5 / scale}
                                                                  fill="white"
                                                                  stroke="#0284c7"
                                                                  strokeWidth={2}
                                                                  vectorEffect="non-scaling-stroke"
                                                                  style={{ cursor: `${handle}-resize` }}
                                                                  onPointerDown={(event) => begin(event, item.id, handle)}
                                                              />
                                                          );
                                                      })
                                                    : null}
                                            </g>
                                        );
                                    })}
                                    {gesture.current?.newItem
                                        ? (() => {
                                              const item = layout.items.at(-1);
                                              return item ? (
                                                  <rect x={item.x1} y={item.y1} width={Math.max(1, item.x2 - item.x1)} height={Math.max(1, item.y2 - item.y1)} fill="rgba(14,165,233,.08)" stroke="#0ea5e9" strokeDasharray="8 4" pointerEvents="none" />
                                              ) : null;
                                          })()
                                        : null}
                                    {marquee ? (
                                        <rect
                                            x={Math.min(marquee.start.x, marquee.end.x)}
                                            y={Math.min(marquee.start.y, marquee.end.y)}
                                            width={Math.abs(marquee.end.x - marquee.start.x)}
                                            height={Math.abs(marquee.end.y - marquee.start.y)}
                                            fill="rgba(14,165,233,.1)"
                                            stroke="#0ea5e9"
                                            strokeDasharray="6 4"
                                            pointerEvents="none"
                                        />
                                    ) : null}
                                </svg>
                            </div>
                        </div>
                    </div>
                </section>

                <section className="flex h-[min(60dvh,560px)] min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/10 bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.02] lg:h-[calc(100dvh-180px)]">
                    <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-auto overscroll-contain pr-1">
                        <label className="block text-xs">
                            {t("canvas.bboxEditor.generationSize")}{" "}
                            <Select
                                className="w-full"
                                value={presets.some((size) => size.width === layout.width && size.height === layout.height) ? `${layout.width}x${layout.height}` : "custom"}
                                options={[
                                    ...presets.map((size) => ({ value: `${size.width}x${size.height}`, label: `${size.ratio} · ${size.width} × ${size.height}` })),
                                    { value: "custom", label: t("canvas.bboxEditor.customDraft", { width: layout.width, height: layout.height }) },
                                ]}
                                onChange={(value) => {
                                    if (value === "custom") return;
                                    const [width, height] = value.split("x").map(Number);
                                    changeSize(width, height);
                                }}
                            />
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            <label className="text-xs">
                                {t("canvas.bboxEditor.width")}
                                <Input type="number" min={16} step={16} value={layout.width} onChange={(event) => changeSize(Number(event.target.value), layout.height)} />
                            </label>
                            <label className="text-xs">
                                {t("canvas.bboxEditor.height")}
                                <Input type="number" min={16} step={16} value={layout.height} onChange={(event) => changeSize(layout.width, Number(event.target.value))} />
                            </label>
                        </div>
                        <p className="text-xs opacity-65">{t("canvas.bboxEditor.sizeLimit")}</p>
                        <label className="block text-xs">
                            {t("canvas.bboxEditor.globalCaption")}
                            <Input.TextArea data-bbox-global-caption rows={2} value={layout.summary.caption} onChange={(event) => commit({ ...layout, summary: { ...layout.summary, caption: event.target.value } })} />
                        </label>
                        <details className="rounded-lg border border-black/10 p-3 dark:border-white/10">
                            <summary className="cursor-pointer text-xs font-medium">{t("canvas.bboxEditor.jsonTools")}</summary>
                            <div className="mt-3 space-y-3">
                                <div className="flex flex-wrap gap-2">
                                    <Button onClick={() => fileRef.current?.click()}>{t("canvas.bboxEditor.importJson")}</Button>
                                    <Button
                                        onClick={() => {
                                            const blob = new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" });
                                            const url = URL.createObjectURL(blob);
                                            const anchor = document.createElement("a");
                                            anchor.href = url;
                                            anchor.download = "bbox-layout.json";
                                            anchor.click();
                                            URL.revokeObjectURL(url);
                                        }}
                                    >
                                        {t("canvas.bboxEditor.exportDraft")}
                                    </Button>
                                    <Button onClick={() => void navigator.clipboard.writeText(json).then(() => message.success(t("canvas.bboxEditor.copied")))}>{t("canvas.bboxEditor.copyModelJson")}</Button>
                                </div>
                                <textarea className="w-full rounded border border-black/15 bg-transparent p-2 font-mono text-xs" rows={5} readOnly value={json} />
                                <Input.TextArea rows={3} placeholder={t("canvas.bboxEditor.pasteJson")} value={pasteJson} onChange={(event) => setPasteJson(event.target.value)} />
                                <Button disabled={!pasteJson.trim()} onClick={() => void importText(pasteJson)}>
                                    {t("canvas.bboxEditor.importPasted")}
                                </Button>
                                <input
                                    ref={fileRef}
                                    type="file"
                                    accept="application/json,.json"
                                    hidden
                                    onChange={(event) => {
                                        const file = event.target.files?.[0];
                                        if (file) void file.text().then(importText);
                                        event.target.value = "";
                                    }}
                                />
                            </div>
                        </details>
                    </div>
                    {error ? <div className="text-sm text-red-500">{error}</div> : null}
                    <div className="mt-3 flex shrink-0 justify-end gap-2 border-t pt-3">
                        <Button onClick={onClose}>{t("common.cancel")}</Button>
                        <Button type="primary" disabled={!canApplySize} onClick={apply}>
                            {t("canvas.bboxEditor.apply")}
                        </Button>
                    </div>
                </section>
            </div>
            {editingItemId && typeof document !== "undefined"
                ? createPortal(
                      <div
                          data-canvas-no-zoom
                          data-canvas-shortcuts-ignore
                          className="fixed z-[1200] w-[min(340px,calc(100vw-24px))] rounded-xl border border-black/15 bg-white p-3 text-slate-900 shadow-2xl dark:border-white/15 dark:bg-slate-900 dark:text-slate-100"
                          style={{ left: editingPosition.left, top: editingPosition.top }}
                          onPointerDownCapture={(event) => {
                              event.stopPropagation();
                          }}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Escape") {
                                  event.preventDefault();
                                  closeInlineEditor();
                              }
                              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                                  event.preventDefault();
                                  saveInlineEditor();
                              }
                          }}
                      >
                          <div className="mb-2 text-sm font-semibold">{t("canvas.bboxEditor.inlineEdit")}</div>
                          <label className="mb-1 block text-xs font-medium opacity-75">{t("canvas.bboxEditor.descriptionLabel")}</label>
                          <Input.TextArea autoFocus rows={3} value={editingDraft.caption} onChange={(event) => setEditingDraft((draft) => ({ ...draft, caption: event.target.value }))} placeholder={t("canvas.bboxEditor.itemCaption")} />
                          {layout.items.find((item) => item.id === editingItemId)?.kind === "text" ? (
                              <>
                                  <label className="mb-1 mt-2 block text-xs font-medium opacity-75">{t("canvas.bboxEditor.exactVisibleTextLabel")}</label>
                                  <Input.TextArea rows={4} value={editingDraft.text} onChange={(event) => setEditingDraft((draft) => ({ ...draft, text: event.target.value }))} placeholder={t("canvas.bboxEditor.exactText")} />
                              </>
                          ) : null}
                          <div className="mt-3 flex justify-end gap-2">
                              <Button onClick={closeInlineEditor}>{t("canvas.bboxEditor.cancelEdit")}</Button>
                              <Button type="primary" onClick={saveInlineEditor}>
                                  {t("canvas.bboxEditor.save")}
                              </Button>
                          </div>
                          <div className="mt-2 text-[11px] opacity-55">{t("canvas.bboxEditor.labelPreviewHint")}</div>
                      </div>,
                      document.body,
                  )
                : null}
        </Modal>
    );
}

function MultiSelectionTools({ layout, selected, onCommit }: { layout: BBoxLayout; selected: string[]; onCommit: (layout: BBoxLayout) => void }) {
    const { t } = useTranslation();
    const chosen = layout.items.filter((item) => selected.includes(item.id) && !item.locked && !item.hidden);
    if (chosen.length < 2) return null;
    const alignments: Array<{ label: string; alignment: BBoxAlignment }> = [
        { label: "canvas.bboxEditor.alignLeft", alignment: "left" },
        { label: "canvas.bboxEditor.alignCenterX", alignment: "centerX" },
        { label: "canvas.bboxEditor.alignRight", alignment: "right" },
        { label: "canvas.bboxEditor.alignTop", alignment: "top" },
        { label: "canvas.bboxEditor.alignMiddle", alignment: "centerY" },
        { label: "canvas.bboxEditor.alignBottom", alignment: "bottom" },
    ];
    return (
        <div className="flex flex-wrap gap-1">
            {alignments.map(({ label, alignment }) => (
                <Button
                    key={label}
                    size="small"
                    icon={alignment.endsWith("X") ? <AlignCenterHorizontal size={13} /> : alignment === "centerY" ? <AlignCenterVertical size={13} /> : undefined}
                    onClick={() => onCommit(alignBboxItems(layout, selected, alignment))}
                >
                    {t(label)}
                </Button>
            ))}
            <Button size="small" onClick={() => onCommit(distributeBboxItems(layout, selected, "x"))}>
                {t("canvas.bboxEditor.distributeX")}
            </Button>
            <Button size="small" onClick={() => onCommit(distributeBboxItems(layout, selected, "y"))}>
                {t("canvas.bboxEditor.distributeY")}
            </Button>
            <Button size="small" onClick={() => onCommit(matchBboxSize(layout, selected, "width"))}>
                {t("canvas.bboxEditor.matchWidth")}
            </Button>
            <Button size="small" onClick={() => onCommit(matchBboxSize(layout, selected, "height"))}>
                {t("canvas.bboxEditor.matchHeight")}
            </Button>
        </div>
    );
}

function snapItems(items: BBoxItem[], gesture: Gesture, layout: BBoxLayout, scale: number) {
    const moved = items.find((item) => item.id === gesture.itemId);
    if (!moved) return items;
    const others = gesture.original.items.filter((item) => !gesture.selection.includes(item.id) && !item.hidden);
    const threshold = 6 / Math.max(scale, 0.001);
    const candidatesX = [0, layout.width / 2, layout.width, ...others.flatMap((item) => [item.x1, (item.x1 + item.x2) / 2, item.x2])];
    const candidatesY = [0, layout.height / 2, layout.height, ...others.flatMap((item) => [item.y1, (item.y1 + item.y2) / 2, item.y2])];
    const pointsX = [moved.x1, (moved.x1 + moved.x2) / 2, moved.x2],
        pointsY = [moved.y1, (moved.y1 + moved.y2) / 2, moved.y2];
    const nearest = (points: number[], candidates: number[]) => {
        let best: { delta: number; distance: number } | null = null;
        for (const point of points)
            for (const candidate of candidates) {
                const delta = candidate - point,
                    distance = Math.abs(delta);
                if (distance <= threshold && (!best || distance < best.distance)) best = { delta, distance };
            }
        return best?.delta ?? 0;
    };
    const dx = nearest(pointsX, candidatesX),
        dy = nearest(pointsY, candidatesY);
    return items.map((item) => (gesture.selection.includes(item.id) && !item.locked ? { ...item, x1: item.x1 + dx, x2: item.x2 + dx, y1: item.y1 + dy, y2: item.y2 + dy } : item));
}

function snapResizeItem(items: BBoxItem[], gesture: Gesture, layout: BBoxLayout, scale: number) {
    const item = items.find((candidate) => candidate.id === gesture.itemId);
    if (!item || !gesture.handle) return items;
    const others = gesture.original.items.filter((candidate) => !gesture.selection.includes(candidate.id) && !candidate.hidden);
    const threshold = 6 / Math.max(scale, 0.001);
    const candidatesX = [0, layout.width / 2, layout.width, ...others.flatMap((candidate) => [candidate.x1, (candidate.x1 + candidate.x2) / 2, candidate.x2])];
    const candidatesY = [0, layout.height / 2, layout.height, ...others.flatMap((candidate) => [candidate.y1, (candidate.y1 + candidate.y2) / 2, candidate.y2])];
    const nearest = (value: number, candidates: number[]) =>
        candidates
            .map((candidate) => candidate - value)
            .filter((delta) => Math.abs(delta) <= threshold)
            .sort((a, b) => Math.abs(a) - Math.abs(b))[0] ?? 0;
    const x1 = gesture.handle.includes("w") ? item.x1 + nearest(item.x1, candidatesX) : item.x1;
    const x2 = gesture.handle.includes("e") ? item.x2 + nearest(item.x2, candidatesX) : item.x2;
    const y1 = gesture.handle.includes("n") ? item.y1 + nearest(item.y1, candidatesY) : item.y1;
    const y2 = gesture.handle.includes("s") ? item.y2 + nearest(item.y2, candidatesY) : item.y2;
    return items.map((candidate) => (candidate.id === item.id ? { ...candidate, x1: Math.min(x1, x2 - 1), y1: Math.min(y1, y2 - 1), x2: Math.max(x2, x1 + 1), y2: Math.max(y2, y1 + 1) } : candidate));
}
