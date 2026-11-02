import { afterEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
    getCanvasBlob: vi.fn(),
    canvasCasUrl: vi.fn((key: string) => /^cas:[a-f0-9]{64}$/.test(key) ? "/api/v1/blobs/" + key.slice(4) : null),
    isCanvasCasKey: vi.fn((key: string) => /^cas:[a-f0-9]{64}$/.test(key)),
    uploadCanvasMedia: vi.fn(),
}));
vi.mock("@/features/backend-sync/canvas-media", () => ({ uploadCanvasMedia: backend.uploadCanvasMedia }));
vi.mock("@/features/backend-sync/canvas-cas", () => backend);
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("localforage", () => { throw new Error("Canvas media must not load localforage"); });

import { getImageBlob, imageToDataUrl, resolveImageUrl } from "./image-storage";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile } from "./file-storage";

afterEach(() => vi.clearAllMocks());

describe("Canvas media CAS-only storage", () => {
    it("returns no browser blob or legacy key URL for retired keys", async () => {
        expect(await getImageBlob("image:legacy")).toBeNull();
        expect(await getMediaBlob("video:legacy")).toBeNull();
        expect(await resolveImageUrl("image:legacy", "image:legacy")).toBe("");
        expect(await resolveMediaUrl("video:legacy", "video:legacy")).toBe("");
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        expect(await imageToDataUrl({ storageKey: "image:legacy", url: "image:legacy" })).toBe("");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(backend.getCanvasBlob).not.toHaveBeenCalled();
    });

    it("fails closed on attempts to upload a retired media key as if it were a URL", async () => {
        await expect(uploadMediaFile("video:legacy", "video")).rejects.toThrow("legacy_canvas_media_unavailable");
        expect(backend.uploadCanvasMedia).not.toHaveBeenCalled();
    });
});
