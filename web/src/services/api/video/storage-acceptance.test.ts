import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("localforage", () => ({ default: { createInstance: () => ({ setItem: vi.fn().mockResolvedValue(undefined) }) } }));

import { uploadMediaFile } from "@/services/file-storage";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fakeVideo() {
    const video = Object.assign(new EventTarget(), { videoWidth: 0, videoHeight: 0, duration: NaN, src: "", preload: "", pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn() });
    vi.stubGlobal("document", { createElement: () => video });
    return video;
}

describe("independent local media acceptance", () => {
    it("saves an unplayable video without inventing natural dimensions", async () => {
        const video = fakeVideo();
        const saved = uploadMediaFile(new Blob(["HEVC test payload"], { type: "video/mp4" }), "video");
        await Promise.resolve();
        await Promise.resolve();
        video.dispatchEvent(new Event("error"));
        const result = await saved;
        expect(result.storageKey).toMatch(/^video:/);
        expect(result.width).toBeUndefined();
        expect(result.height).toBeUndefined();
        expect(video.removeAttribute).toHaveBeenCalledWith("src");
        URL.revokeObjectURL(result.url);
    });

    it("finishes persistence when the media loader never responds", async () => {
        vi.useFakeTimers();
        fakeVideo();
        const saved = uploadMediaFile(new Blob(["silent loader"], { type: "video/mp4" }), "video");
        await vi.advanceTimersByTimeAsync(10_001);
        const result = await saved;
        expect(result.width).toBeUndefined();
        expect(result.durationMs).toBeUndefined();
        URL.revokeObjectURL(result.url);
    });

    it("uses the dimensions and duration reported by the actual media loader", async () => {
        const video = fakeVideo();
        video.videoWidth = 3840;
        video.videoHeight = 2160;
        video.duration = 6.125;
        const saved = uploadMediaFile(new Blob(["metadata test"], { type: "video/mp4" }), "video");
        await Promise.resolve();
        await Promise.resolve();
        video.dispatchEvent(new Event("loadedmetadata"));
        const result = await saved;
        expect(result).toMatchObject({ width: 3840, height: 2160, durationMs: 6125 });
        URL.revokeObjectURL(result.url);
    });
});
