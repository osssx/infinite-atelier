import { IMAGE_SIZE_PRESETS } from "./image-size-presets";
import { isSupportedBboxGenerationSize } from "./bbox-layout";
import { describe, expect, it } from "vitest";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import {
    alignBboxItems,
    applyBboxLayoutToGraph,
    bboxLayoutToModelJson,
    clampBboxItem,
    distributeBboxItems,
    drawBboxItem,
    duplicateBboxSelection,
    initialBboxSize,
    bboxSizeForNode,
    syncBboxLayoutAspect,
    matchBboxSize,
    moveBboxSelection,
    parseBboxImport,
    resizeBboxItem,
    resizeBboxLayout,
    snapMoveBboxSelection,
    updateBboxItem,
    validateBboxLayout,
    type BBoxItem,
    type BBoxLayout,
} from "./bbox-layout";

const layout = (): BBoxLayout => ({
    version: 1,
    width: 1536,
    height: 1024,
    summary: { caption: "A complete layout", meta: ["campaign"], canvas: "single", palette: ["warm white"] },
    items: [
        { id: "hidden", kind: "object", caption: "ignored", x1: 0, y1: 0, x2: 8, y2: 8, hidden: true, locked: true },
        { id: "text", kind: "text", caption: "Visible Chinese title", text: "第一行\n第二行", x1: 224.2, y1: 176.8, x2: 800.1, y2: 480.2, tags: ["title"], palette: ["green"] },
    ],
});
const imageNode = (metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({ id: "image", type: CanvasNodeType.Image, title: "Image", position: { x: 0, y: 0 }, width: 400, height: 300, metadata });

describe("BBox layout model and geometry", () => {
    const bounded = (item: BBoxItem, width: number, height: number) => {
        expect(item.x1).toBeGreaterThanOrEqual(0);
        expect(item.y1).toBeGreaterThanOrEqual(0);
        expect(item.x2).toBeLessThanOrEqual(width);
        expect(item.y2).toBeLessThanOrEqual(height);
        expect(item.x2).toBeGreaterThan(item.x1);
        expect(item.y2).toBeGreaterThan(item.y1);
    };

    it("compiles non-square dimensions, floors/ceils edges and excludes hidden/internal fields", () => {
        const result = JSON.parse(bboxLayoutToModelJson(layout()));
        expect(result).toEqual({
            summary: { caption: "A complete layout", meta: ["campaign"], canvas: "single", palette: ["warm white"] },
            items: [{ label: "text", caption: "Visible Chinese title", text: "第一行\n第二行", tags: ["title"], palette: ["green"], bbox: [-336, -544, -31, 33] }],
            bbox_coord_space: "abs_centralized",
            bbox_format: "yxyx",
        });
        expect(JSON.stringify(result)).not.toContain("hidden");
        expect(JSON.stringify(result)).not.toContain('"id"');
    });

    it("preserves official draft fields and internal state through JSON import", () => {
        const official = {
            width: 1536,
            height: 1024,
            bbox_coord_space: "abs",
            bbox_format: "xyxy",
            summary: { caption: "studio", meta: ["photo"], canvas: "single", palette: ["ivory"] },
            items: [{ label: "text", caption: "Exact lettering", text: "Title\nTagline", bbox: [100, 200, 500, 300], tags: ["headline"], palette: ["green"] }],
        };
        const parsed = parseBboxImport(official, 1024, 1024);
        expect(parsed.summary).toEqual(official.summary);
        expect(parsed.items[0]).toMatchObject({ kind: "text", caption: "Exact lettering", text: "Title\nTagline", x1: 100, y1: 200, x2: 500, y2: 300, tags: ["headline"], palette: ["green"] });
        const draft = { ...layout(), items: layout().items.map((item) => ({ ...item })) };
        expect(parseBboxImport(JSON.stringify(draft), 1024, 1024).items[0]).toEqual(draft.items[0]);
    });

    it("imports centralized model coordinates using declared canvas size and preserves text whitespace", () => {
        const compiled = bboxLayoutToModelJson(layout());
        const imported = parseBboxImport(compiled, 1536, 1024);
        expect(imported.width).toBe(1536);
        expect(imported.items[0]).toMatchObject({ x1: 224, y1: 176, x2: 801, y2: 481, text: "第一行\n第二行" });
        const spaced = layout();
        spaced.items[1].text = "  line one\nline two  ";
        expect(JSON.parse(bboxLayoutToModelJson(spaced)).items[0].text).toBe("  line one\nline two  ");
    });

    it("rescales boxes when dimensions change and maps default generation sizes", () => {
        const resized = resizeBboxLayout(layout(), 1024, 1536);
        expect(resized.items[1].x1).toBeCloseTo((224.2 * 2) / 3);
        expect(resized.items[1].y1).toBeCloseTo(265.2);
        expect(resized.items[1].x2).toBeCloseTo((800.1 * 2) / 3);
        expect(resized.items[1].y2).toBeCloseTo(720.3);
        expect(initialBboxSize("16:9")).toEqual([1536, 864]);
        expect(initialBboxSize("auto")).toEqual([1024, 1024]);
    });

    it("preserves all prompt-panel ratios and accepts aligned custom dimensions", () => {
        for (const preset of IMAGE_SIZE_PRESETS) {
            expect(initialBboxSize(preset.ratio)).toEqual([preset.width, preset.height]);
            const [w, h] = preset.ratio.split(":").map(Number);
            expect(preset.width / preset.height).toBeCloseTo(w / h, 8);
            expect(isSupportedBboxGenerationSize(preset.width, preset.height)).toBe(true);
        }
        expect(initialBboxSize("2048x1152")).toEqual([2048, 1152]);
        expect(isSupportedBboxGenerationSize(2048, 1152)).toBe(true);
        expect(isSupportedBboxGenerationSize(1025, 1024)).toBe(false);
        expect(isSupportedBboxGenerationSize(0, 1024)).toBe(false);
    });

    it("rejects invalid bounds, empty visible layouts, blank exact text, nested imports, and bad dimensions", () => {
        expect(validateBboxLayout({ ...layout(), summary: { caption: "" } })).toContain("Global caption");
        expect(validateBboxLayout({ ...layout(), items: layout().items.map((item) => ({ ...item, hidden: true })) })).toContain("visible item");
        expect(validateBboxLayout({ ...layout(), items: [{ ...layout().items[1], text: "  " }] })).toContain("caption and text");
        expect(validateBboxLayout({ ...layout(), items: [{ ...layout().items[1], x2: 1600 }] })).toContain("bounds");
        expect(() => parseBboxImport({ ...layout(), width: 100, height: 101 }, 1024, 1024)).toThrow("multiples of 16");
        expect(() => parseBboxImport({ width: 1024, height: 1024, items: [{ label: "object", caption: "bad", bbox: [0, 0, 1, 1], children: [] }] }, 1024, 1024)).toThrow("nested coordinates");
    });

    it("matches the published non-square example and reverses xyxy to abs_centralized/yxyx", () => {
        const sample: BBoxLayout = { version: 1, width: 1536, height: 1024, summary: { caption: "Campaign" }, items: [{ id: "cup", kind: "object", caption: "Ivory ceramic cup", x1: 176, y1: 224, x2: 800, y2: 864 }] };
        const compiled = JSON.parse(bboxLayoutToModelJson(sample));
        expect(compiled.items[0].bbox).toEqual([-288, -592, 352, 32]);
        expect(compiled.bbox_coord_space).toBe("abs_centralized");
        expect(compiled.bbox_format).toBe("yxyx");
        const imported = parseBboxImport({ width: 1536, height: 1024, bbox_coord_space: "abs", bbox_format: "xyxy", summary: { caption: "Campaign" }, items: [{ label: "object", caption: "Ivory ceramic cup", bbox: [176, 224, 800, 864] }] }, 1024, 1024);
        expect(imported.items[0]).toMatchObject({ x1: 176, y1: 224, x2: 800, y2: 864 });
        const reverse = parseBboxImport(compiled, 1536, 1024);
        expect(reverse.items[0]).toMatchObject({ x1: 176, y1: 224, x2: 800, y2: 864 });
    });

    it("aligns, distributes and matches selected unlocked items while preserving locked and hidden boxes", () => {
        const source: BBoxLayout = {
            version: 1,
            width: 1024,
            height: 1024,
            summary: { caption: "test" },
            items: [
                { id: "a", kind: "object", caption: "a", x1: 10, y1: 10, x2: 30, y2: 30 },
                { id: "b", kind: "object", caption: "b", x1: 100, y1: 80, x2: 140, y2: 120 },
                { id: "c", kind: "object", caption: "c", x1: 200, y1: 200, x2: 250, y2: 260 },
                { id: "locked", kind: "object", caption: "locked", x1: 300, y1: 300, x2: 330, y2: 330, locked: true },
                { id: "hidden", kind: "object", caption: "hidden", x1: 400, y1: 400, x2: 430, y2: 430, hidden: true },
            ],
        };
        const aligned = alignBboxItems(source, ["a", "b", "c", "locked", "hidden"], "left");
        expect(aligned.items[0].x1).toBe(10);
        expect(aligned.items[1].x1).toBe(10);
        expect(aligned.items[2].x1).toBe(10);
        expect(aligned.items[3]).toEqual(source.items[3]);
        expect(aligned.items[4]).toEqual(source.items[4]);
        const distributed = distributeBboxItems(source, ["a", "b", "c"], "x");
        expect(distributed.items[1].x1).toBeCloseTo(95);
        const matched = matchBboxSize(source, ["a", "b", "c"], "height");
        expect(matched.items.slice(0, 3).map((item) => item.y2 - item.y1)).toEqual([20, 20, 20]);
    });

    it("clamps corner and outside drag drawing, including subpixel canvas-edge clicks", () => {
        const seed: BBoxItem = { id: "draw", kind: "object", caption: "", x1: 0, y1: 0, x2: 1, y2: 1 };
        for (const box of [
            drawBboxItem(seed, 100, 80, -100, -20, 320, 240),
            drawBboxItem(seed, 400, 300, 2000, 2000, 320, 240),
            drawBboxItem(seed, 320, 240, 320, 240, 320, 240),
            drawBboxItem(seed, 319.9, 239.9, 319.9, 239.9, 320, 240),
            drawBboxItem(seed, 320.1, 240.1, 320.1, 240.1, 320, 240),
            drawBboxItem(seed, -10, -10, -20, -20, 320, 240),
        ])
            bounded(box, 320, 240);
        expect(drawBboxItem(seed, 320, 240, 320, 240, 320, 240)).toMatchObject({ x1: 319, y1: 239, x2: 320, y2: 240 });
        expect(drawBboxItem(seed, 319.9, 239.9, 319.9, 239.9, 320, 240)).toMatchObject({ x1: 319, y1: 239, x2: 320, y2: 240 });
    });

    it("bounds numeric coordinate edits but does not silently rewrite imported invalid coordinates for text edits", () => {
        const badImport: BBoxItem = { id: "bad", kind: "object", caption: "original", x1: -20, y1: 10, x2: 80, y2: 260 };
        expect(updateBboxItem(badImport, { caption: "edited" }, 320, 240)).toMatchObject({ x1: -20, y1: 10, x2: 80, y2: 260, caption: "edited" });
        bounded(updateBboxItem(badImport, { x1: -500 }, 320, 240), 320, 240);
        bounded(updateBboxItem(badImport, { x2: 5000, y2: -10 }, 320, 240), 320, 240);
    });

    it("clamps a shared multi-item delta at all four edges without changing relative spacing", () => {
        const source: BBoxLayout = {
            version: 1,
            width: 320,
            height: 240,
            summary: { caption: "bounds" },
            items: [
                { id: "a", kind: "object", caption: "a", x1: 20, y1: 30, x2: 60, y2: 70 },
                { id: "b", kind: "text", caption: "b", text: "b", x1: 100, y1: 90, x2: 180, y2: 160 },
            ],
        };
        for (const [dx, dy] of [
            [-1000, -1000],
            [1000, 1000],
            [-1000, 1000],
            [1000, -1000],
        ]) {
            const moved = moveBboxSelection(source, ["a", "b"], dx, dy);
            moved.items.forEach((item) => bounded(item, source.width, source.height));
            expect(moved.items[1].x1 - moved.items[0].x1).toBe(source.items[1].x1 - source.items[0].x1);
            expect(moved.items[1].y1 - moved.items[0].y1).toBe(source.items[1].y1 - source.items[0].y1);
        }
    });

    it("keeps every resize handle inside the image with at least one-pixel area", () => {
        const item: BBoxItem = { id: "box", kind: "object", caption: "x", x1: 5, y1: 6, x2: 15, y2: 16 };
        for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
            bounded(resizeBboxItem(item, handle, 10000, 10000, 320, 240), 320, 240);
            bounded(resizeBboxItem(item, handle, -10000, -10000, 320, 240), 320, 240);
        }
        const invalidImported: BBoxItem = { ...item, x1: -40, y1: 260, x2: 400, y2: 500 };
        bounded(resizeBboxItem(invalidImported, "nw", -50, 50, 320, 240), 320, 240);
    });

    it("snaps to a nearby edge, then clamps at canvas edges, and keeps duplicate groups together", () => {
        const source: BBoxLayout = {
            version: 1,
            width: 320,
            height: 240,
            summary: { caption: "snap" },
            items: [
                { id: "moving", kind: "object", caption: "a", x1: 10, y1: 10, x2: 30, y2: 30 },
                { id: "target", kind: "object", caption: "b", x1: 65, y1: 12, x2: 95, y2: 32 },
                { id: "edge", kind: "object", caption: "c", x1: 250, y1: 200, x2: 320, y2: 240 },
            ],
        };
        const snapped = snapMoveBboxSelection(source, ["moving"], 31, 0, 6);
        expect(snapped.layout.items[0].x2).toBe(65);
        const atEdge = snapMoveBboxSelection(source, ["edge"], 500, 500, 6).layout.items[2];
        bounded(atEdge, 320, 240);
        const copies = duplicateBboxSelection(source, ["edge"]);
        expect(copies.layout.items[3]).toMatchObject({ x1: 250, y1: 200, x2: 320, y2: 240 });
        bounded(copies.layout.items[3], 320, 240);
    });

    it("keeps seeded deterministic geometry sequences bounded across move, snap, resize, copy and batch layout paths", () => {
        let state = 0x73a5;
        const random = (max: number) => {
            state = (state * 48271) % 0x7fffffff;
            return state % max;
        };
        const width = 320,
            height = 240;
        for (let i = 0; i < 100; i += 1) {
            const x = random(width - 2),
                y = random(height - 2),
                w = 1 + random(width - x),
                h = 1 + random(height - y);
            const first: BBoxItem = { id: "a", kind: "object", caption: "a", x1: x, y1: y, x2: x + w, y2: y + h };
            const second = drawBboxItem({ ...first, id: "b" }, x, y, random(width * 2) - width / 2, random(height * 2) - height / 2, width, height);
            let next: BBoxLayout = { version: 1, width, height, summary: { caption: "sequence" }, items: [first, second] };
            next = moveBboxSelection(next, ["a", "b"], random(width * 8) - width * 4, random(height * 8) - height * 4);
            next = snapMoveBboxSelection(next, ["a", "b"], random(width * 4) - width * 2, random(height * 4) - height * 2, 6).layout;
            next = { ...next, items: next.items.map((item) => resizeBboxItem(item, ["nw", "n", "ne", "e", "se", "s", "sw", "w"][random(8)], random(width * 4) - width * 2, random(height * 4) - height * 2, width, height)) };
            next = duplicateBboxSelection(next, ["a", "b"]).layout;
            next = alignBboxItems(
                next,
                next.items.map((item) => item.id),
                "right",
            );
            next = distributeBboxItems(
                next,
                next.items.map((item) => item.id),
                "y",
            );
            next = matchBboxSize(
                next,
                next.items.map((item) => item.id),
                "width",
            );
            next.items.forEach((item) => bounded(item, width, height));
        }
    });
});

describe("BBox graph apply", () => {
    const makeText = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Text, title: "Text", position: { x: 0, y: 0 }, width: 420, height: 280, metadata: { content: "compiled" } });
    it("writes size and both prompt fields without adding text when the effective prompt is empty", () => {
        const graph = applyBboxLayoutToGraph({ nodes: [imageNode()], connections: [], nodeId: "image", layout: layout(), promptJson: "compiled", makeTextNode: () => makeText("new"), makeConnectionId: () => "edge" });
        expect(graph?.selectedNodeId).toBeNull();
        expect(graph?.nodes).toHaveLength(1);
        expect(graph?.nodes[0].metadata).toMatchObject({ bboxLayout: layout(), size: "1536x1024", prompt: "compiled", composerContent: "compiled" });
        expect(graph?.connections).toEqual([]);
    });
    it("adds a new text node and text-to-image edge on each apply when a prompt exists", () => {
        const source = imageNode({ composerContent: "existing prompt" });
        const first = applyBboxLayoutToGraph({ nodes: [source], connections: [], nodeId: "image", layout: layout(), promptJson: "compiled", makeTextNode: () => makeText("first"), makeConnectionId: () => "edge-1" })!;
        expect(first.nodes.find((node) => node.id === "image")?.metadata?.composerContent).toBe("existing prompt");
        expect(first.connections).toEqual([{ id: "edge-1", fromNodeId: "first", toNodeId: "image" }]);
        const second = applyBboxLayoutToGraph({ nodes: first.nodes, connections: first.connections, nodeId: "image", layout: layout(), promptJson: "compiled", makeTextNode: () => makeText("second"), makeConnectionId: () => "edge-2" })!;
        expect(second.nodes.filter((node) => node.type === CanvasNodeType.Text)).toHaveLength(2);
        expect(second.connections).toHaveLength(2);
        expect(second.selectedNodeId).toBe("second");
    });
    it("rejects a removed or image-filled target", () => {
        const args = { nodes: [imageNode({ content: "ready image" })], connections: [], nodeId: "image", layout: layout(), promptJson: "compiled", makeTextNode: () => makeText("new"), makeConnectionId: () => "edge" };
        expect(applyBboxLayoutToGraph(args)).toBeNull();
        expect(applyBboxLayoutToGraph({ ...args, nodes: [] })).toBeNull();
    });
});

describe("BBox opening follows node aspect",()=>{
 it("uses workflow preview geometry instead of stale channel size",()=>{
  const node={width:191.25,height:340} as CanvasNodeData;
  expect(initialBboxSize(bboxSizeForNode(node,"1:1"))).toEqual([864,1536]);
  expect(bboxSizeForNode({width:340,height:191.25} as CanvasNodeData,"2048x1152")).toBe("2048x1152");
 });
 it("supports custom ratios with valid aligned canvas dimensions",()=>{
  const [w,h]=initialBboxSize("2.5:1");
  expect(w%16).toBe(0);expect(h%16).toBe(0);expect(w/h).toBeCloseTo(2.5,1);
  expect(initialBboxSize("562500:1000000")).toEqual([864,1536]);
  expect(bboxSizeForNode({width:0,height:0} as CanvasNodeData,"4:3")).toBe("4:3");
 });
 it("rescales saved boxes while preserving captions and same-aspect canvas dimensions",()=>{
  const layout={version:1 as const,width:1024,height:1024,summary:{caption:"scene"},items:[
   {id:"a",kind:"object" as const,caption:"subject",x1:256,y1:256,x2:768,y2:768}]};
  const resized=syncBboxLayoutAspect(layout,"9:16");
  expect(resized).toMatchObject({width:864,height:1536,summary:{caption:"scene"},items:[{caption:"subject",x1:216,y1:384,x2:648,y2:1152}]});
  expect(syncBboxLayoutAspect(resized,"9:16")).toBe(resized);
  expect(layout.width).toBe(1024);
 });
});
