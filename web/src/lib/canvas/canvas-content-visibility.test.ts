import { describe, expect, it } from "vitest";
import { CanvasNodeType } from "@/types/canvas";
import { CANVAS_CONTENT_VISIBILITY_STYLE, shouldContainCanvasContent } from "./canvas-content-visibility";

describe("canvas heavy-content visibility containment", () => {
    it("isolates only bounded media and text, keeping custom panels and group layouts unchanged", () => {
        for (const type of [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text]) {
            expect(shouldContainCanvasContent(type, false, false)).toBe(true);
        }
        expect(shouldContainCanvasContent(CanvasNodeType.Image, true, false)).toBe(false);
        expect(shouldContainCanvasContent(CanvasNodeType.Text, false, true)).toBe(false);
        expect(shouldContainCanvasContent(CanvasNodeType.Group, false, false)).toBe(false);
        expect(shouldContainCanvasContent(CanvasNodeType.Config, false, false)).toBe(false);
        expect(shouldContainCanvasContent("plugin:unknown", false, false)).toBe(false);
    });
    it("provides a stable nonzero intrinsic size for skipped offscreen content", () => {
        expect(CANVAS_CONTENT_VISIBILITY_STYLE).toEqual({
            contentVisibility: "auto",
            containIntrinsicSize: "auto 160px 120px",
        });
    });
});
