import { describe, expect, it } from "vitest";
import { buildSeedanceContent, validateSeedanceRequest } from "./seedance-content";
import { seedancePresets } from "./model-capabilities";
import type { VideoGenerationRequest } from "./types";

function request(overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest {
    return {
        modelOption: `ark::${seedancePresets[0].name}`,
        mode: "text_to_video",
        prompt: "A cinematic sunrise",
        references: [],
        durationSeconds: 6,
        resolution: "720p",
        ratio: "adaptive",
        generateAudio: true,
        watermark: false,
        ...overrides,
    };
}

describe("Seedance 2.0 request validation and content mapping", () => {
    it("maps text and typed omni references to Ark content roles", () => {
        const content = buildSeedanceContent("A scene", [
            { id: "i", kind: "image", role: "reference_image", url: "data:image/png;base64,AA==" },
            { id: "v", kind: "video", role: "reference_video", url: "https://media.example/video.mp4" },
            { id: "a", kind: "audio", role: "reference_audio", url: "data:audio/mpeg;base64,AA==" },
        ]);
        expect(content).toEqual([
            { type: "text", text: "A scene" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" }, role: "reference_image" },
            { type: "video_url", video_url: { url: "https://media.example/video.mp4" }, role: "reference_video" },
            { type: "audio_url", audio_url: { url: "data:audio/mpeg;base64,AA==" }, role: "reference_audio" },
        ]);
    });

    it("rejects mixed first/last frame and omni references", () => {
        expect(() => validateSeedanceRequest(request({
            mode: "first_frame",
            references: [{ id: "1", kind: "image", role: "first_frame", width: 640, height: 480 }, { id: "2", kind: "image", role: "reference_image", width: 640, height: 480 }],
        }), seedancePresets[0].videoCapabilities)).toThrow(/exactly one first-frame image/i);
        expect(() => validateSeedanceRequest(request({
            mode: "omni_reference",
            references: [{ id: "1", kind: "image", role: "reference_audio", width: 640, height: 480 }],
        }), seedancePresets[0].videoCapabilities)).toThrow(/matching reference/i);
    });

    it("enforces standard and fast resolution limits and 4–15 second duration", () => {
        expect(() => validateSeedanceRequest(request({ resolution: "4k" }), seedancePresets[1].videoCapabilities)).toThrow(/not supported/i);
        expect(() => validateSeedanceRequest(request({ durationSeconds: 3 }), seedancePresets[0].videoCapabilities)).toThrow(/duration/i);
        expect(() => validateSeedanceRequest(request({ durationSeconds: -1 }), seedancePresets[0].videoCapabilities)).not.toThrow();
    });

    it("checks reference file sizes, dimensions, duration, and audio dependency", () => {
        expect(() => validateSeedanceRequest(request({ mode: "omni_reference", references: [{ id: "i", kind: "image", role: "reference_image", bytes: 31 * 1024 * 1024, width: 1024, height: 1024 }] }), seedancePresets[0].videoCapabilities)).toThrow(/file size/i);
        expect(() => validateSeedanceRequest(request({ mode: "omni_reference", references: [{ id: "v", kind: "video", role: "reference_video", mimeType: "video/mp4", durationMs: 16_000, width: 1280, height: 720 }] }), seedancePresets[0].videoCapabilities)).toThrow(/duration/i);
        expect(() => validateSeedanceRequest(request({ mode: "omni_reference", references: [{ id: "a", kind: "audio", role: "reference_audio", durationMs: 2_000, mimeType: "audio/mpeg" }] }), seedancePresets[0].videoCapabilities)).toThrow(/require at least one image or video/i);
    });
});
