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

    it("builds the exact, spatially mixed 300-node acceptance profile with static photo and video cover", () => {
        const fixture = buildCanvasFixture({
            nodeCount: 300, seed: 7, mediaMode: "static", profile: "performance-300",
            staticMediaUrl: urls.staticMediaUrl, staticVideoUrl: urls.staticVideoUrl,
            staticVideoPosterUrl: "/perf-media/sample-video-poster.jpg",
        });
        const counts = Object.fromEntries(Object.values(CanvasNodeType).map((type) => [type, fixture.nodes.filter((node) => node.type === type).length]));
        expect(counts).toMatchObject({ image: 150, video: 60, text: 60, audio: 10, config: 10, group: 10 });
        expect(fixture.connections).toHaveLength(450);
        expect(fixture.nodes.filter((node) => node.type === CanvasNodeType.Image).every((node) => node.metadata?.content === urls.staticMediaUrl)).toBe(true);
        const videos = fixture.nodes.filter((node) => node.type === CanvasNodeType.Video);
        expect(videos.every((node) => node.metadata?.content === urls.staticVideoUrl && node.metadata?.perfStaticPosterUrl === "/perf-media/sample-video-poster.jpg")).toBe(true);
        expect(fixture.nodes.filter((node) => node.type === CanvasNodeType.Text).map((node) => node.metadata?.content?.length ?? 0).sort((a, b) => a - b)[0]).toBeLessThan(100);
        expect(new Set(fixture.nodes.slice(10, 50).map((node) => node.type)).size).toBeGreaterThan(3);
    });
});
