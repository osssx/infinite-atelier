import { describe, expect, it } from "vitest";

import { buildCanvasFixture } from "./canvas-fixtures";
import { CanvasNodeType } from "@/types/canvas";

const urls = {
    staticMediaUrl: "/perf-media/sample-photo.jpg",
    staticVideoUrl: "/perf-media/sample-video.mp4",
    staticAudioUrl: "/perf-media/sample-audio.mp3",
};

describe("decoded media fixture", () => {
    it("gives all image, video and audio nodes real same-origin asset URLs", () => {
        const fixture = buildCanvasFixture({ nodeCount: 200, seed: 7, mediaMode: "decoded", ...urls });
        const types = [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio];
        for (const type of types) {
            const items = fixture.nodes.filter((node) => node.type === type);
            expect(items.length).toBeGreaterThan(0);
            expect(items.every((node) => node.metadata?.content?.startsWith("/perf-media/"))).toBe(true);
        }
        expect(fixture.nodes.length).toBe(200);
        expect(fixture.connections.length).toBe(300);
    });

    it("rejects an incomplete decoded fixture instead of issuing broken network requests", () => {
        expect(() => buildCanvasFixture({ nodeCount: 200, mediaMode: "decoded", staticMediaUrl: urls.staticMediaUrl })).toThrow(/all three/);
    });

    it("preserves the deterministic node graph when switching fixture media modes", () => {
        const decoded = buildCanvasFixture({ nodeCount: 200, seed: 7, mediaMode: "decoded", ...urls });
        const staticOnly = buildCanvasFixture({ nodeCount: 200, seed: 7, mediaMode: "static", staticMediaUrl: "/perf-media/sample-photo.jpg" });
        expect(decoded.connections).toEqual(staticOnly.connections);
        expect(decoded.nodes.map(({ id, type, position, width, height }) => ({ id, type, position, width, height }))).toEqual(
            staticOnly.nodes.map(({ id, type, position, width, height }) => ({ id, type, position, width, height })),
        );
    });
});
