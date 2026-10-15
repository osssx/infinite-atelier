import { describe, expect, it } from "vitest";
import { canvasPopupPosition } from "./canvas-popup-position";

describe("unscaled canvas creation menus", () => {
    const anchor = { x: 100, y: 200 };
    const rect = { left: 80, top: 48 };
    const popup = { width: 300, height: 420 };
    const screen = { width: 1200, height: 900 };

    it("maps world positions through canvas translation and zoom but never scales menu dimensions", () => {
        expect(canvasPopupPosition(anchor, { x: 20, y: 30, k: 0.5 }, rect, popup, screen)).toEqual({ x: 150, y: 178 });
        expect(canvasPopupPosition(anchor, { x: 20, y: 30, k: 2 }, rect, popup, { width: 1200, height: 1200 })).toEqual({ x: 300, y: 478 });
    });

    it("clamps menus within the screen at high zoom and near edges", () => {
        expect(canvasPopupPosition({ x: 2000, y: 2000 }, { x: 0, y: 0, k: 3 }, rect, popup, screen)).toEqual({ x: 888, y: 468 });
        expect(canvasPopupPosition({ x: -2000, y: -2000 }, { x: 0, y: 0, k: 0.1 }, rect, popup, screen)).toEqual({ x: 12, y: 12 });
    });

    it("keeps a stable anchor when pan and zoom compensate each other", () => {
        const first = canvasPopupPosition(anchor, { x: 0, y: 0, k: 1 }, rect, popup, screen);
        const second = canvasPopupPosition(anchor, { x: -100, y: -200, k: 2 }, rect, popup, screen);
        expect(second).toEqual(first);
    });

    it("keeps menus accessible on unusually small viewports", () => {
        expect(canvasPopupPosition(anchor, { x: 0, y: 0, k: 1 }, { left: 0, top: 0 }, popup, { width: 220, height: 250 })).toEqual({ x: 12, y: 12 });
    });
});
