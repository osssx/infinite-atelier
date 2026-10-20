import { describe, expect, it } from "vitest";
import { CANVAS_SIDEBAR_ROW_STRIDE, canvasSidebarWindow } from "./canvas-side-panel-window";

describe("canvas sidebar virtual rows", () => {
    it("mounts only a bounded range for 200 items", () => {
        const first = canvasSidebarWindow(200, 0, 400);
        expect(first.start).toBe(0);
        expect(first.end).toBeLessThan(20);
        expect(first.totalHeight).toBe(200 * CANVAS_SIDEBAR_ROW_STRIDE - 6);
        const middle = canvasSidebarWindow(200, 100 * CANVAS_SIDEBAR_ROW_STRIDE, 400);
        expect(middle.start).toBeLessThanOrEqual(100);
        expect(middle.end).toBeGreaterThan(100);
        expect(middle.end - middle.start).toBeLessThan(25);
    });
    it("clamps negative and stale scroll offsets after filtering", () => {
        expect(canvasSidebarWindow(0, 100000, 400)).toEqual({ start: 0, end: 0, totalHeight: 0 });
        expect(canvasSidebarWindow(2, 100000, 400)).toEqual({ start: 0, end: 2, totalHeight: 118 });
        expect(canvasSidebarWindow(10, -500, 124).start).toBe(0);
    });
});
