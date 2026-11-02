import { afterEach, describe, expect, it, vi } from "vitest";

const cas = vi.hoisted(() => ({
    uploadCanvasMedia: vi.fn(async (blob: Blob, kind: "video" | "audio") => ({
        url: "/api/v1/blobs/" + "a".repeat(64), storageKey: "cas:" + "a".repeat(64),
        bytes: blob.size, mimeType: blob.type, ...(kind === "video" ? { width: 1920, height: 1080 } : {}),
    })),
}));
vi.mock("@/features/backend-sync/canvas-media", () => cas);
vi.mock("localforage", () => { throw new Error("Canvas media must not load localforage"); });

import { uploadMediaFile } from "@/services/file-storage";

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("Canvas API media storage acceptance", () => {
    it("sends video and audio uploads to backend CAS", async () => {
        const video = new Blob(["video"], { type: "video/mp4" });
        const audio = new Blob(["audio"], { type: "audio/mpeg" });
        const savedVideo = await uploadMediaFile(video, "video");
        const savedAudio = await uploadMediaFile(audio, "audio");
        expect(savedVideo.storageKey).toBe("cas:" + "a".repeat(64));
        expect(savedAudio.url).toBe("/api/v1/blobs/" + "a".repeat(64));
        expect(cas.uploadCanvasMedia).toHaveBeenNthCalledWith(1, video, "video");
        expect(cas.uploadCanvasMedia).toHaveBeenNthCalledWith(2, audio, "audio");
    });

    it("rejects failed remote downloads and retired browser keys", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
        await expect(uploadMediaFile("https://media.example/source.mp4", "video")).rejects.toThrow("canvas_media_download_failed");
        await expect(uploadMediaFile("video:legacy", "video")).rejects.toThrow("legacy_canvas_media_unavailable");
        expect(cas.uploadCanvasMedia).not.toHaveBeenCalled();
    });
});
