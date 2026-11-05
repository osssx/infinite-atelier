import { IMAGE_SIZE_PRESETS } from "./image-size-presets";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type BBoxKind = "object" | "character" | "text";
export type BBoxItem = { id: string; kind: BBoxKind; caption: string; text?: string; tags?: string[]; palette?: string[]; x1: number; y1: number; x2: number; y2: number; locked?: boolean; hidden?: boolean };
export type BBoxSummary = { caption: string; meta?: string[]; canvas?: "single" | "multi_panel" | "collage"; palette?: string[] };
export type BBoxLayout = { version: 1; width: number; height: number; summary: BBoxSummary; items: BBoxItem[] };

export function validBboxSize(width: number, height: number) {
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width % 16 === 0 && height % 16 === 0;
}
export function resizeBboxLayout(layout: BBoxLayout, width: number, height: number): BBoxLayout {
    const sx = width / layout.width,
        sy = height / layout.height;
    return { ...layout, width, height, items: layout.items.map((item) => ({ ...item, x1: item.x1 * sx, x2: item.x2 * sx, y1: item.y1 * sy, y2: item.y2 * sy })) };
}

export function clampBboxItem(item: BBoxItem, width: number, height: number): BBoxItem {
    const boxWidth = Math.max(1, Math.min(width, item.x2 - item.x1));
    const boxHeight = Math.max(1, Math.min(height, item.y2 - item.y1));
    const x1 = Math.max(0, Math.min(width - boxWidth, item.x1));
    const y1 = Math.max(0, Math.min(height - boxHeight, item.y1));
    return { ...item, x1, y1, x2: x1 + boxWidth, y2: y1 + boxHeight };
}

export function updateBboxItem(item: BBoxItem, patch: Partial<BBoxItem>, width: number, height: number): BBoxItem {
    const updated = { ...item, ...patch };
    const changesGeometry = (Object.keys(patch) as Array<keyof BBoxItem>).some((key) => key === "x1" || key === "y1" || key === "x2" || key === "y2");
    return changesGeometry ? clampBboxItem(updated, width, height) : updated;
}

export function moveBboxSelection(layout: BBoxLayout, selectedIds: readonly string[], dx: number, dy: number): BBoxLayout {
    const movable = layout.items.filter((item) => selectedIds.includes(item.id) && !item.locked && !item.hidden).map((item) => clampBboxItem(item, layout.width, layout.height));
    if (!movable.length) return layout;
    const deltaX = Math.max(-Math.min(...movable.map((item) => item.x1)), Math.min(layout.width - Math.max(...movable.map((item) => item.x2)), dx));
    const deltaY = Math.max(-Math.min(...movable.map((item) => item.y1)), Math.min(layout.height - Math.max(...movable.map((item) => item.y2)), dy));
    const movedById = new Map(movable.map((item) => [item.id, { ...item, x1: item.x1 + deltaX, x2: item.x2 + deltaX, y1: item.y1 + deltaY, y2: item.y2 + deltaY }]));
    return { ...layout, items: layout.items.map((item) => movedById.get(item.id) ?? item) };
}

export function resizeBboxItem(item: BBoxItem, handle: string, dx: number, dy: number, width: number, height: number): BBoxItem {
    item = clampBboxItem(item, width, height);
    let { x1, y1, x2, y2 } = item;
    if (handle.includes("w")) x1 = Math.max(0, Math.min(x2 - 1, item.x1 + dx));
    if (handle.includes("e")) x2 = Math.min(width, Math.max(x1 + 1, item.x2 + dx));
    if (handle.includes("n")) y1 = Math.max(0, Math.min(y2 - 1, item.y1 + dy));
    if (handle.includes("s")) y2 = Math.min(height, Math.max(y1 + 1, item.y2 + dy));
    return { ...item, x1, y1, x2, y2 };
}

export function drawBboxItem(item: BBoxItem, startX: number, startY: number, x: number, y: number, width: number, height: number): BBoxItem {
    const start = { x: Math.max(0, Math.min(width, startX)), y: Math.max(0, Math.min(height, startY)) };
    const end = { x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y)) };
    let x1 = Math.min(start.x, end.x),
        x2 = Math.max(start.x, end.x);
    let y1 = Math.min(start.y, end.y),
        y2 = Math.max(start.y, end.y);
    if (x2 - x1 < 1) {
        x1 = Math.min(x1, width - 1);
        x2 = x1 + 1;
    }
    if (y2 - y1 < 1) {
        y1 = Math.min(y1, height - 1);
        y2 = y1 + 1;
    }
    return { ...item, x1, y1, x2, y2 };
}

export function snapMoveBboxSelection(layout: BBoxLayout, selectedIds: readonly string[], dx: number, dy: number, threshold: number): { layout: BBoxLayout; dx: number; dy: number } {
    const movable = layout.items.filter((item) => selectedIds.includes(item.id) && !item.hidden && !item.locked);
    if (!movable.length) return { layout, dx: 0, dy: 0 };
    const others = layout.items.filter((item) => !selectedIds.includes(item.id) && !item.hidden);
    const xTargets = [0, layout.width / 2, layout.width, ...others.flatMap((item) => [item.x1, (item.x1 + item.x2) / 2, item.x2])];
    const yTargets = [0, layout.height / 2, layout.height, ...others.flatMap((item) => [item.y1, (item.y1 + item.y2) / 2, item.y2])];
    const dxCandidates = movable.flatMap((item) => [item.x1, (item.x1 + item.x2) / 2, item.x2].flatMap((point) => xTargets.map((target) => target - (point + dx)))).filter((delta) => Math.abs(delta) <= threshold);
    const dyCandidates = movable.flatMap((item) => [item.y1, (item.y1 + item.y2) / 2, item.y2].flatMap((point) => yTargets.map((target) => target - (point + dy)))).filter((delta) => Math.abs(delta) <= threshold);
    const snapDelta = (candidates: number[]) => candidates.sort((a, b) => Math.abs(a) - Math.abs(b))[0] ?? 0;
    const nextDx = dx + snapDelta(dxCandidates),
        nextDy = dy + snapDelta(dyCandidates);
    const result = moveBboxSelection(layout, selectedIds, nextDx, nextDy);
    const actual = result.items.find((item) => movable.some((candidate) => candidate.id === item.id))!;
    const first = movable[0];
    return { layout: result, dx: actual.x1 - first.x1, dy: actual.y1 - first.y1 };
}

export function duplicateBboxSelection(layout: BBoxLayout, selectedIds: readonly string[], offset = 16): { layout: BBoxLayout; selectedIds: string[] } {
    const source = layout.items.filter((item) => selectedIds.includes(item.id) && !item.hidden);
    if (!source.length) return { layout, selectedIds: [] };
    const dx = Math.max(-Math.min(...source.map((item) => item.x1)), Math.min(layout.width - Math.max(...source.map((item) => item.x2)), offset));
    const dy = Math.max(-Math.min(...source.map((item) => item.y1)), Math.min(layout.height - Math.max(...source.map((item) => item.y2)), offset));
    const copies = source.map((item) => clampBboxItem({ ...item, id: crypto.randomUUID(), x1: item.x1 + dx, x2: item.x2 + dx, y1: item.y1 + dy, y2: item.y2 + dy }, layout.width, layout.height));
    return { layout: { ...layout, items: [...layout.items, ...copies] }, selectedIds: copies.map((item) => item.id) };
}

export type BBoxAlignment = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";
export function alignBboxItems(layout: BBoxLayout, selectedIds: readonly string[], alignment: BBoxAlignment): BBoxLayout {
    const items = layout.items.filter((item) => selectedIds.includes(item.id) && !item.hidden && !item.locked);
    if (items.length < 2) return layout;
    const edge =
        alignment === "left"
            ? Math.min(...items.map((item) => item.x1))
            : alignment === "right"
              ? Math.max(...items.map((item) => item.x2))
              : alignment === "top"
                ? Math.min(...items.map((item) => item.y1))
                : alignment === "bottom"
                  ? Math.max(...items.map((item) => item.y2))
                  : alignment === "centerX"
                    ? items.reduce((sum, item) => sum + (item.x1 + item.x2) / 2, 0) / items.length
                    : items.reduce((sum, item) => sum + (item.y1 + item.y2) / 2, 0) / items.length;
    return {
        ...layout,
        items: layout.items.map((item) => {
            if (!selectedIds.includes(item.id) || item.hidden || item.locked) return item;
            const width = item.x2 - item.x1,
                height = item.y2 - item.y1;
            if (alignment === "left") return clampBboxItem({ ...item, x1: edge, x2: edge + width }, layout.width, layout.height);
            if (alignment === "right") return clampBboxItem({ ...item, x1: edge - width, x2: edge }, layout.width, layout.height);
            if (alignment === "centerX") return clampBboxItem({ ...item, x1: edge - width / 2, x2: edge + width / 2 }, layout.width, layout.height);
            if (alignment === "top") return clampBboxItem({ ...item, y1: edge, y2: edge + height }, layout.width, layout.height);
            if (alignment === "bottom") return clampBboxItem({ ...item, y1: edge - height, y2: edge }, layout.width, layout.height);
            return clampBboxItem({ ...item, y1: edge - height / 2, y2: edge + height / 2 }, layout.width, layout.height);
        }),
    };
}

export function distributeBboxItems(layout: BBoxLayout, selectedIds: readonly string[], axis: "x" | "y"): BBoxLayout {
    const items = layout.items.filter((item) => selectedIds.includes(item.id) && !item.hidden && !item.locked).sort((a, b) => (axis === "x" ? a.x1 - b.x1 : a.y1 - b.y1));
    if (items.length < 3) return layout;
    const first = axis === "x" ? items[0].x1 : items[0].y1,
        last = axis === "x" ? items.at(-1)!.x2 : items.at(-1)!.y2;
    const total = items.reduce((sum, item) => sum + (axis === "x" ? item.x2 - item.x1 : item.y2 - item.y1), 0),
        gap = (last - first - total) / (items.length - 1);
    let position = first;
    const positions = new Map<string, number>();
    for (const item of items) {
        positions.set(item.id, position);
        position += (axis === "x" ? item.x2 - item.x1 : item.y2 - item.y1) + gap;
    }
    return {
        ...layout,
        items: layout.items.map((item) => {
            const next = positions.get(item.id);
            if (next === undefined) return item;
            return clampBboxItem(axis === "x" ? { ...item, x2: next + item.x2 - item.x1, x1: next } : { ...item, y2: next + item.y2 - item.y1, y1: next }, layout.width, layout.height);
        }),
    };
}

export function matchBboxSize(layout: BBoxLayout, selectedIds: readonly string[], axis: "width" | "height"): BBoxLayout {
    const items = layout.items.filter((item) => selectedIds.includes(item.id) && !item.hidden && !item.locked);
    if (items.length < 2) return layout;
    const size = axis === "width" ? items[0].x2 - items[0].x1 : items[0].y2 - items[0].y1;
    return {
        ...layout,
        items: layout.items.map((item) => (selectedIds.includes(item.id) && !item.hidden && !item.locked ? clampBboxItem(axis === "width" ? { ...item, x2: item.x1 + size } : { ...item, y2: item.y1 + size }, layout.width, layout.height) : item)),
    };
}
export function emptyBboxLayout(width: number, height: number): BBoxLayout {
    return { version: 1, width, height, summary: { caption: "" }, items: [] };
}
export function validateBboxLayout(layout: BBoxLayout): string | null {
    if (!validBboxSize(layout.width, layout.height)) return "Canvas dimensions must be positive multiples of 16.";
    if (!layout.summary.caption.trim()) return "Global caption is required.";
    const visible = layout.items.filter((item) => !item.hidden);
    if (!visible.length) return "Add at least one visible item.";
    for (const item of visible) {
        if (!item.caption.trim() || (item.kind === "text" && !item.text?.trim())) return `Complete the caption and text for ${item.kind}.`;
        if (![item.x1, item.y1, item.x2, item.y2].every(Number.isFinite) || item.x1 < 0 || item.y1 < 0 || item.x2 > layout.width || item.y2 > layout.height || item.x2 <= item.x1 || item.y2 <= item.y1) return `Fix the bounds for ${item.kind}.`;
    }
    return null;
}

export function bboxLayoutToModelJson(layout: BBoxLayout): string {
    const items = layout.items
        .filter((item) => !item.hidden)
        .map((item) => {
            const left = Math.floor(item.x1),
                top = Math.floor(item.y1),
                right = Math.ceil(item.x2),
                bottom = Math.ceil(item.y2);
            return {
                label: item.kind,
                caption: item.caption.trim(),
                ...(item.kind === "text" ? { text: item.text ?? "" } : {}),
                ...(item.tags?.length ? { tags: item.tags } : {}),
                ...(item.palette?.length ? { palette: item.palette } : {}),
                bbox: [top - layout.height / 2, left - layout.width / 2, bottom - layout.height / 2, right - layout.width / 2],
            };
        });
    return JSON.stringify({ summary: layout.summary, items, bbox_coord_space: "abs_centralized", bbox_format: "yxyx" }, null, 2);
}

export function parseBboxImport(value: unknown, width: number, height: number): BBoxLayout {
    const data = typeof value === "string" ? JSON.parse(value) : value;
    if (!data || typeof data !== "object") throw new Error("Expected a JSON object.");
    const root = data as Record<string, unknown>,
        rows = root.items;
    if (!Array.isArray(rows)) throw new Error("JSON must contain an items array.");
    const centralized = root.bbox_coord_space === "abs_centralized" && root.bbox_format === "yxyx";
    if (!centralized && root.bbox_coord_space && root.bbox_coord_space !== "abs") throw new Error("Unsupported bbox_coord_space.");
    if (root.bbox_format && root.bbox_format !== (centralized ? "yxyx" : "xyxy")) throw new Error("Unsupported bbox_format.");
    const summaryRaw = root.summary && typeof root.summary === "object" ? (root.summary as Record<string, unknown>) : { caption: root.summary ?? root.caption };
    const importedWidth = typeof root.width === "number" && Number.isInteger(root.width) ? root.width : width;
    const importedHeight = typeof root.height === "number" && Number.isInteger(root.height) ? root.height : height;
    if (!validBboxSize(importedWidth, importedHeight)) throw new Error("Imported canvas dimensions must be positive multiples of 16.");
    if (root.version !== undefined && root.version !== 1) throw new Error("Unsupported BBox draft version.");
    if (root.summary && typeof root.summary !== "object" && typeof root.summary !== "string") throw new Error("summary must be an object.");
    const items: BBoxItem[] = rows.map((raw, index) => {
        if (!raw || typeof raw !== "object") throw new Error(`Item ${index + 1} is invalid.`);
        const row = raw as Record<string, unknown>,
            kind = row.label ?? row.kind ?? row.type;
        if ("children" in row || "parent" in row) throw new Error(`Item ${index + 1} uses unsupported nested coordinates.`);
        if (kind !== "object" && kind !== "character" && kind !== "text") throw new Error(`Item ${index + 1} has an unsupported type.`);
        let x1: number, y1: number, x2: number, y2: number;
        if (Array.isArray(row.bbox) && row.bbox.length === 4 && row.bbox.every((x) => typeof x === "number" && Number.isFinite(x))) {
            if (centralized) {
                [y1, x1, y2, x2] = row.bbox as number[];
                x1 += importedWidth / 2;
                x2 += importedWidth / 2;
                y1 += importedHeight / 2;
                y2 += importedHeight / 2;
            } else [x1, y1, x2, y2] = row.bbox as number[];
        } else if ([row.x1, row.y1, row.x2, row.y2].every((n) => typeof n === "number" && Number.isFinite(n))) {
            ({ x1, y1, x2, y2 } = row as unknown as Pick<BBoxItem, "x1" | "y1" | "x2" | "y2">);
        } else if ([row.x, row.y, row.width, row.height].every((n) => typeof n === "number" && Number.isFinite(n))) {
            x1 = row.x as number;
            y1 = row.y as number;
            x2 = x1 + (row.width as number);
            y2 = y1 + (row.height as number);
        } else throw new Error(`Item ${index + 1} needs bbox or x/y/width/height.`);
        return {
            id: typeof row.id === "string" ? row.id : crypto.randomUUID(),
            kind,
            caption: String(row.caption ?? ""),
            ...(kind === "text" ? { text: String(row.text ?? "") } : {}),
            ...(Array.isArray(row.tags) ? { tags: row.tags.filter((v): v is string => typeof v === "string") } : {}),
            ...(Array.isArray(row.palette) ? { palette: row.palette.filter((v): v is string => typeof v === "string") } : {}),
            ...(row.locked === true ? { locked: true } : {}),
            ...(row.hidden === true ? { hidden: true } : {}),
            x1,
            y1,
            x2,
            y2,
        };
    });
    return {
        version: 1,
        width: importedWidth,
        height: importedHeight,
        summary: {
            caption: String(summaryRaw.caption ?? ""),
            ...(Array.isArray(summaryRaw.meta) ? { meta: summaryRaw.meta.filter((v): v is string => typeof v === "string") } : {}),
            ...(summaryRaw.canvas === "single" || summaryRaw.canvas === "multi_panel" || summaryRaw.canvas === "collage" ? { canvas: summaryRaw.canvas } : {}),
            ...(Array.isArray(summaryRaw.palette) ? { palette: summaryRaw.palette.filter((v): v is string => typeof v === "string") } : {}),
        },
        items,
    };
}

export function initialBboxSize(value?: string): [number, number] {
    const match = value?.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (match) {
        const w = Number(match[1]),
            h = Number(match[2]);
        if (validBboxSize(w, h)) return [w, h];
    }
    const preset = IMAGE_SIZE_PRESETS.find((size) => size.ratio === value);
    if (preset) return [preset.width, preset.height];
    return [1024, 1024];
}

export type BBoxMetadata = CanvasNodeMetadata & { bboxLayout?: BBoxLayout };

export function isSupportedBboxGenerationSize(width: number, height: number) {
    return validBboxSize(width, height);
}

export function applyBboxLayoutToGraph(args: {
    nodes: readonly CanvasNodeData[];
    connections: readonly CanvasConnection[];
    nodeId: string;
    layout: BBoxLayout;
    promptJson: string;
    makeTextNode: () => CanvasNodeData;
    makeConnectionId: () => string;
}): { nodes: CanvasNodeData[]; connections: CanvasConnection[]; selectedNodeId: string | null } | null {
    const target = args.nodes.find((node) => node.id === args.nodeId);
    if (!target || target.type !== CanvasNodeType.Image || target.metadata?.content) return null;
    const effectivePrompt = (target.metadata?.composerContent ?? target.metadata?.prompt ?? "").trim();
    const nodes = args.nodes.map((node) =>
        node.id === args.nodeId
            ? {
                  ...node,
                  metadata: { ...node.metadata, bboxLayout: args.layout, size: `${args.layout.width}x${args.layout.height}`, ...(effectivePrompt ? {} : { composerContent: args.promptJson, prompt: args.promptJson }) },
              }
            : node,
    );
    if (!effectivePrompt) return { nodes, connections: [...args.connections], selectedNodeId: null };
    const textNode = args.makeTextNode();
    let centerX = target.position.x + target.width + textNode.width / 2 + 72;
    let centerY = target.position.y + textNode.height / 2;
    const overlaps = () =>
        nodes.some(
            (node) =>
                centerX - textNode.width / 2 < node.position.x + node.width + 24 &&
                centerX + textNode.width / 2 + 24 > node.position.x &&
                centerY - textNode.height / 2 < node.position.y + node.height + 24 &&
                centerY + textNode.height / 2 + 24 > node.position.y,
        );
    for (let attempt = 0; attempt < 240 && overlaps(); attempt += 1) {
        centerY += textNode.height + 48;
        if (attempt % 12 === 11) {
            centerX += textNode.width + 64;
            centerY = target.position.y + textNode.height / 2;
        }
    }
    textNode.position = { x: centerX - textNode.width / 2, y: centerY - textNode.height / 2 };
    return { nodes: [...nodes, textNode], connections: [...args.connections, { id: args.makeConnectionId(), fromNodeId: textNode.id, toNodeId: args.nodeId }], selectedNodeId: textNode.id };
}
