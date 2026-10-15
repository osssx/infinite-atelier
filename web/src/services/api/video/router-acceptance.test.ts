import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/api-proxy", () => ({ proxyApiUrl: (url: string) => url }));
vi.mock("@/lib/image-utils", () => ({ dataUrlToFile: vi.fn() }));
vi.mock("@/services/file-storage", () => ({ getMediaBlob: vi.fn(), uploadMediaFile: vi.fn() }));
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: vi.fn(), getImageBlob: vi.fn() }));
vi.mock("../model-plugin", () => ({ runModelPlugin: vi.fn() }));
vi.mock("axios", () => ({ default: { post: vi.fn(), get: vi.fn(), delete: vi.fn(), isCancel: () => false, isAxiosError: () => false } }));

import axios from "axios";
import { getMediaBlob } from "@/services/file-storage";
import { createModelChannel, defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { createVideoGenerationTask, pollVideoGenerationTask, type VideoGenerationTask } from "../video";
import { SEEDANCE_STANDARD } from "./model-capabilities";
import type { VideoGenerationRequest } from "./types";

const config: AiConfig = {
    ...defaultConfig, model: `legacy::${SEEDANCE_STANDARD}`, videoModel: `legacy::${SEEDANCE_STANDARD}`,
    channels: [{ id: "legacy", name: "Seedance", apiFormat: "volcengine_ark", baseUrl: "http://127.0.0.1:8189/api/v3", apiKey: "channel-key", models: [{ name: SEEDANCE_STANDARD, capability: "video" }] }],
};

describe("legacy Seedance Router migration", () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.unstubAllGlobals());

    it("normalizes the old provider to official Ark while retaining channel identity and settings", () => {
        const channel = createModelChannel({ id: "old-id", name: "Old", apiFormat: "volcengine_ark", baseUrl: "http://127.0.0.1:8189/api/v3", apiKey: "kept", seedanceAdapter: "router_local" } as never);
        expect(channel).toMatchObject({ id: "old-id", baseUrl: "http://127.0.0.1:8189/api/v3", apiKey: "kept" });
        expect(channel).not.toHaveProperty("seedanceAdapter");
    });

    it("sends the same official Ark request body for a public channel and a configured loopback base", async () => {
        const request: VideoGenerationRequest = { modelOption: config.model, mode: "text_to_video", prompt: "Official wire prompt", references: [], durationSeconds: 6, resolution: "720p", ratio: "16:9", generateAudio: true, watermark: false, returnLastFrame: false };
        vi.mocked(axios.post).mockResolvedValue({ data: { id: "created", status: "queued" } } as never);
        const local = await createVideoGenerationTask(config, request.prompt, [], { request });
        const publicConfig: AiConfig = { ...config, channels: [{ ...config.channels[0], baseUrl: "https://relay.example.test/custom/api/v3" }] };
        const publicTask = await createVideoGenerationTask(publicConfig, request.prompt, [], { request });
        expect(local.provider).toBe("volcengine_ark");
        expect(publicTask.provider).toBe("volcengine_ark");
        expect(vi.mocked(axios.post).mock.calls[0][0]).toBe("/api/ark/contents/generations/tasks");
        expect(vi.mocked(axios.post).mock.calls[1][0]).toBe("/api/ark/contents/generations/tasks");
        expect(vi.mocked(axios.post).mock.calls[0][1]).toEqual(vi.mocked(axios.post).mock.calls[1][1]);
    });

    it("uploads local reference media through the generic signed URL service and sends the channel key", async () => {
        const localBlob = new Blob([new Uint8Array(32)], { type: "video/mp4" });
        vi.mocked(getMediaBlob).mockResolvedValueOnce(localBlob);
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ url: "http://127.0.0.1:8189/uploads/00000000-0000-0000-0000-000000000000.mp4?exp=2000000000&sig=signature" }), { status: 200, headers: { "content-type": "application/json" } }));
        vi.stubGlobal("fetch", fetchMock);
        vi.mocked(axios.post).mockResolvedValueOnce({ data: { id: "created", status: "queued" } } as never);
        const request: VideoGenerationRequest = { modelOption: config.model, mode: "omni_reference", prompt: "Use the reference", references: [{ id: "ref-video", kind: "video", role: "reference_video", storageKey: "video:local", mimeType: "video/mp4", bytes: 32, durationMs: 3000, width: 1280, height: 720 }], durationSeconds: 6, resolution: "720p", ratio: "16:9", generateAudio: true, watermark: false };
        await createVideoGenerationTask(config, request.prompt, [], { request });
        expect(fetchMock).toHaveBeenCalledWith("/api/media/uploads", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer channel-key" }) }));
        expect(JSON.stringify(vi.mocked(axios.post).mock.calls[0][1])).toContain("http://127.0.0.1:8189/uploads/");
    });

    it("polls an existing legacy task ID through the official API path without creating a replacement", async () => {
        vi.mocked(axios.get).mockResolvedValueOnce({ data: { id: "cgt-existing", status: "running" } } as never);
        const task = { id: "cgt-existing", provider: "router_local", model: config.model, channelId: "legacy", status: "running", startedAt: 1 } as unknown as VideoGenerationTask;
        const state = await pollVideoGenerationTask(config, task);
        expect(state.status).toBe("pending");
        expect(vi.mocked(axios.get)).toHaveBeenCalledWith("/api/ark/contents/generations/tasks/cgt-existing", expect.objectContaining({ headers: expect.objectContaining({ "x-ark-base-url": config.channels[0].baseUrl }) }));
        expect(vi.mocked(axios.post)).not.toHaveBeenCalled();
    });
});
