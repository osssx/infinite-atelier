import { describe, expect, it } from "vitest";
import { PREVIEW_EDGE, previewSize } from "./media-preview-storage";

describe("persistent media preview sizing", () => {
    it("bounds high-resolution images by 256 pixels without stretching", () => {
        expect(PREVIEW_EDGE).toBe(256);
        expect(previewSize(8192, 4096)).toEqual({ width: 256, height: 128 });
        expect(previewSize(4096, 8192)).toEqual({ width: 128, height: 256 });
        expect(previewSize(1920, 1080)).toEqual({ width: 256, height: 144 });
    });
    it("never upscales tiny uploads, and tolerates absent dimensions", () => {
        expect(previewSize(80, 40)).toEqual({ width: 80, height: 40 });
        expect(previewSize(0, 0)).toEqual({ width: 256, height: 256 });
        expect(previewSize(100000, 1)).toEqual({ width: 256, height: 1 });
    });
});
