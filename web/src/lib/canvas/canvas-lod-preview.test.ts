import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { getCompactImageSource, shouldShowCompactImage } from "./canvas-lod-preview";

const node = (type: CanvasNodeType, content?: string): CanvasNodeData => ({
    id: "1", title: "Test", type, position: { x: 0, y: 0 },
    width: 320, height: 180, metadata: { content },
});

describe("visually continuous compact LOD previews", () => {
    it("uses the same primary content as the full image renderer", () => {
        const image = node(CanvasNodeType.Image, "fallback.png");
        image.metadata!.images = [
            { id: "a", content: "image-a.png", status: "success", storageKey: "", bytes: 10, mimeType: "image/png", naturalWidth: 64, naturalHeight: 64 },
            { id: "b", content: "image-b.png", status: "success", storageKey: "", bytes: 10, mimeType: "image/png", naturalWidth: 64, naturalHeight: 64 },
        ];
        image.metadata!.primaryImageId = "b";
        expect(getCompactImageSource(image)).toBe("image-b.png");
        image.metadata!.primaryImageId = "not-found";
        expect(getCompactImageSource(image)).toBe("fallback.png");
        image.metadata!.images = [];
        expect(getCompactImageSource(image)).toBe("fallback.png");
    });

    it("never decodes video/audio URLs as image previews", () => {
        expect(getCompactImageSource(node(CanvasNodeType.Video, "clip.mp4"))).toBeNull();
        expect(getCompactImageSource(node(CanvasNodeType.Audio, "clip.mp3"))).toBeNull();
        expect(getCompactImageSource(node(CanvasNodeType.Image))).toBeNull();
    });

    it("only activates expensive image previews when their projected size is visible", () => {
        expect(shouldShowCompactImage(0.05, 320, 180)).toBe(false);
        expect(shouldShowCompactImage(0.2, 320, 180)).toBe(true);
        expect(shouldShowCompactImage(0.35, 160, 120)).toBe(true);
        expect(shouldShowCompactImage(0.35, 80, 80)).toBe(false);
        expect(shouldShowCompactImage(NaN, 320, 180)).toBe(false);
    });
});
