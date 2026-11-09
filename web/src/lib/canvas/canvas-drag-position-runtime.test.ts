import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    applyCanvasDragDelta,
    canvasDragDeltaFromPointer,
    clearCanvasDragPositionOverrides,
    getCanvasDragPositionOverrides,
    registerCanvasDragPositionElement,
    resolveCanvasDragFinishDelta,
    setCanvasDragPositionOverrides,
    subscribeCanvasDragPositionOverrides,
} from "./canvas-drag-position-runtime";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id: "node-1",
    type: CanvasNodeType.Image,
    title: "Image",
    position: { x: 10, y: 20 },
    width: 200,
    height: 150,
    metadata,
});

describe("canvas drag position runtime", () => {
    beforeEach(() => clearCanvasDragPositionOverrides());

    it("composes the final pointer coordinates into world-space delta", () => {
        expect(canvasDragDeltaFromPointer({ x: 100, y: 50 }, { x: 245, y: 110 }, 1.5)).toEqual({ x: 96.66666666666667, y: 40 });
    });

    it("commits the latest queued pointermove when blur or pointercancel has no coordinates", () => {
        const latestMove = { x: 48, y: -16 };
        const finishDelta = resolveCanvasDragFinishDelta({ x: 100, y: 50 }, null, latestMove, 2);
        expect(finishDelta).toBe(latestMove);
        expect(applyCanvasDragDelta([node()], new Map([["node-1", { x: 10, y: 20 }]]), finishDelta)[0].position).toEqual({ x: 58, y: 4 });
        expect(resolveCanvasDragFinishDelta({ x: 100, y: 50 }, { x: 160, y: 70 }, latestMove, 2)).toEqual({ x: 30, y: 10 });
    });

    it("keeps transient position overrides outside node data and preserves concurrent metadata at commit", () => {
        const initial = new Map([["node-1", { x: 10, y: 20 }]]);
        const latest = [{ ...node({ content: "new generated result", status: "success" }), position: { x: 12, y: 23 } }];
        const moved = applyCanvasDragDelta(latest, initial, { x: 7, y: -4 });
        expect(moved[0].position).toEqual({ x: 17, y: 16 });
        expect(moved[0].metadata).toEqual({ content: "new generated result", status: "success" });

        setCanvasDragPositionOverrides(new Map([["node-1", { x: 7, y: -4 }]]));
        expect(getCanvasDragPositionOverrides().get("node-1")).toEqual({ x: 7, y: -4 });
        expect(latest[0].position).toEqual({ x: 12, y: 23 });
        expect(latest[0].metadata?.content).toBe("new generated result");
    });

    it("applies to both registered LOD roots, notifies the edge subscriber, and clears on cancellation", () => {
        const makeElement = () => {
            const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
            return { style } as unknown as HTMLElement & { style: typeof style };
        };
        const full = makeElement();
        const compact = makeElement();
        const unsubscribeFull = registerCanvasDragPositionElement("node-1", full);
        const unsubscribeCompact = registerCanvasDragPositionElement("node-1", compact);
        const subscriber = vi.fn();
        const unsubscribe = subscribeCanvasDragPositionOverrides(subscriber);

        setCanvasDragPositionOverrides(new Map([["node-1", { x: 12, y: 8 }]]));
        expect(full.style.setProperty).toHaveBeenCalledWith("translate", "12px 8px");
        expect(compact.style.setProperty).toHaveBeenCalledWith("translate", "12px 8px");
        expect(subscriber).toHaveBeenCalledTimes(1);

        clearCanvasDragPositionOverrides();
        expect(full.style.removeProperty).toHaveBeenCalledWith("translate");
        expect(compact.style.removeProperty).toHaveBeenCalledWith("translate");
        expect(subscriber).toHaveBeenCalledTimes(2);
        unsubscribe();
        unsubscribeFull();
        unsubscribeCompact();
    });
});
