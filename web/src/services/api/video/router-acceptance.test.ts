import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/api-proxy", () => ({ proxyApiUrl: (url: string) => url }));
vi.mock("@/lib/image-utils", () => ({ dataUrlToFile: vi.fn() }));
vi.mock("@/services/file-storage", () => ({ getMediaBlob: vi.fn(), uploadMediaFile: vi.fn() }));
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: vi.fn(), getImageBlob: vi.fn() }));
vi.mock("../model-plugin", () => ({ runModelPlugin: vi.fn() }));
vi.mock("axios", () => ({ default: { post: vi.fn(), get: vi.fn(), delete: vi.fn(), isCancel: () => false, isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError) } }));

import axios from "axios";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { defaultConfig, createModelChannel, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { createVideoGenerationTask, pollVideoGenerationTask, cancelVideoGenerationTask } from "../video";
import { SEEDANCE_STANDARD } from "./model-capabilities";
import type { VideoGenerationRequest } from "./types";

function localConfig(): AiConfig {
    const channel = { id: "local", name: "Seedance2", apiFormat: "volcengine_ark", baseUrl: "http://127.0.01:8189/api/v3/", apiKey: "local-test-key", seedanceAdapter: "router_local", models: [{ name: SEEDANCE_STANDARD, capability: "video" }] } as ModelChannel;
    return { ...defaultConfig, model: `local::${SEEDANCE_STANDARD}`, videoModel: `local::${SEEDANCE_STANDARD}`, channels: [channel] };
}
function request(config: AiConfig): VideoGenerationRequest {
    return { modelOption: config.model, prompt: "Local acceptance prompt", mode: "text_to_video", references: [], durationSeconds: 5, ratio: "16:9", resolution: "480p", generateAudio: true, watermark: false, returnLastFrame: false };
}
function task(config: AiConfig) {
    return { id: "cgt-existing-local-task", provider: "router_local" as const, model: config.model, channelId: "local", status: "queued" as const, startedAt: 1 };
}

const requestFetch = vi.fn<typeof fetch>();
beforeEach(() => { vi.clearAllMocks(); requestFetch.mockReset(); vi.stubGlobal("fetch", requestFetch); });
afterEach(() => vi.unstubAllGlobals());

describe("independent custom Router acceptance", () => {
    it("preserves an explicit local adapter when saving the channel", () => {
        expect(createModelChannel(localConfig().channels[0])).toHaveProperty("seedanceAdapter", "router_local");
    });

    it("uses the selected local address and omits even false return_last_frame", async () => {
        const config = localConfig();
        requestFetch.mockResolvedValueOnce(Response.json({ id: "cgt-new-local-task" }));
        await createVideoGenerationTask(config, "ignored", [], { request: request(config) });
        const [url, options] = requestFetch.mock.calls[0];
        const body = JSON.parse(String(options?.body));
        expect(String(url)).toBe("/api/router-local/api/v3/contents/generations/tasks");
        expect(body).not.toHaveProperty("return_last_frame");
        expect(body).toMatchObject({ model: SEEDANCE_STANDARD, duration: 5, resolution: "480p" });
        expect(options?.headers).toMatchObject({ Authorization: "Bearer local-test-key", "x-router-origin": "http://127.0.0.1:8189" });
        expect(axios.post).not.toHaveBeenCalled();
    });

    it.each([
        { durationSeconds: -1 },
        { returnLastFrame: true },
        { watermark: true },
        { resolution: "4k" as const },
    ])("rejects unsupported local parameters without posting: %j", async (overrides) => {
        const config = localConfig();
        await expect(createVideoGenerationTask(config, "prompt", [], { request: { ...request(config), ...overrides } })).rejects.toThrow();
        expect(axios.post).not.toHaveBeenCalled();
        expect(requestFetch).not.toHaveBeenCalled();
    });

    it("queries a saved local task through its own channel without creating another", async () => {
        const config = localConfig();
        requestFetch.mockResolvedValueOnce(Response.json({ id: "cgt-existing-local-task", status: "running" }));
        expect(await pollVideoGenerationTask(config, task(config))).toMatchObject({ status: "pending", providerStatus: "running" });
        expect(requestFetch.mock.calls[0][0]).toBe("/api/router-local/api/v3/contents/generations/tasks/cgt-existing-local-task");
        expect(requestFetch.mock.calls[0][1]?.headers).toMatchObject({ "x-router-origin": "http://127.0.0.1:8189" });
        expect(axios.post).not.toHaveBeenCalled();
    });

    it("retains the local service's readable nested authentication error", async () => {
        const config = localConfig();
        requestFetch.mockResolvedValueOnce(Response.json({ error: { code: "unauthorized", message: "Router API key rejected" } }, { status: 401 }));
        await expect(pollVideoGenerationTask(config, task(config))).rejects.toThrow("Router API key rejected");
        expect(axios.post).not.toHaveBeenCalled();
    });

    it("marks a missing saved local task as expired", async () => {
        const config = localConfig();
        requestFetch.mockResolvedValueOnce(Response.json({ error: { code: "not_found", message: "Task not found" } }, { status: 404 }));
        expect(await pollVideoGenerationTask(config, task(config))).toMatchObject({ status: "failed", providerStatus: "expired" });
        expect(axios.post).not.toHaveBeenCalled();
    });

    it("cancels a queued local task on the configured channel", async () => {
        const config = localConfig();
        vi.mocked(axios.get).mockResolvedValueOnce({ data: { id: "cgt-existing-local-task", status: "queued" } });
        vi.mocked(axios.delete).mockResolvedValueOnce({ data: { status: "cancelled" } });
        expect(await cancelVideoGenerationTask(config, task(config))).toBe(true);
        expect(vi.mocked(axios.delete).mock.calls[0][0]).toBe("/api/router-local/api/v3/contents/generations/tasks/cgt-existing-local-task");
        expect(vi.mocked(axios.delete).mock.calls[0][1]?.headers).toMatchObject({ "x-router-origin": "http://127.0.0.1:8189" });
        expect(axios.post).not.toHaveBeenCalled();
    });

    it("carries a custom HTTPS Ark base address through to the production gateway", async () => {
        const config = localConfig();
        config.channels[0] = { ...config.channels[0], baseUrl: "https://ark-relay.example/team/api/v3", seedanceAdapter: "ark_official" } as ModelChannel;
        vi.mocked(axios.post).mockResolvedValueOnce({ data: { id: "custom-https-task" } });
        await createVideoGenerationTask(config, "ignored", [], { request: request(config) });
        expect(vi.mocked(axios.post).mock.calls[0][2]?.headers).toMatchObject({ "x-ark-base-url": "https://ark-relay.example/team/api/v3" });
    });

    it("uploads all three local media types with usable extensions and submits their tokens", async () => {
        const config = localConfig();
        vi.mocked(getImageBlob).mockResolvedValue(new Blob([new Uint8Array(64)], { type: "image/png" }));
        vi.mocked(getMediaBlob).mockImplementation(async (key) => new Blob([new Uint8Array(64)], { type: key === "video:ref" ? "video/mp4" : "audio/mpeg" }));
        const uploadNames: string[] = [];
        let submitted: Record<string, unknown> | undefined;
        vi.mocked(axios.post).mockImplementation(async (_url, form) => {
            const file = (form as FormData).get("file") as File;
            uploadNames.push(file.name);
            const ext = file.name.split(".").pop();
            return { data: { url: `router-upload:00000000-0000-0000-0000-000000000000.${ext}`, bytes: 64, duration_sec: ext === "png" ? undefined : 5 } };
        });
        requestFetch.mockImplementation(async (_url, options) => {
            submitted = JSON.parse(String(options?.body));
            return Response.json({ id: "cgt-media-task" });
        });
        await createVideoGenerationTask(config, "prompt", [], { request: { ...request(config), mode: "omni_reference", references: [
            { id: "image", kind: "image", role: "reference_image", storageKey: "image:ref", mimeType: "image/png", width: 128, height: 128 },
            { id: "video", kind: "video", role: "reference_video", storageKey: "video:ref", mimeType: "video/mp4", durationMs: 5000, width: 1280, height: 720 },
            { id: "audio", kind: "audio", role: "reference_audio", storageKey: "audio:ref", mimeType: "audio/mpeg", durationMs: 5000 },
        ] } });
        expect(uploadNames.sort()).toEqual(["audio.mp3", "image.png", "video.mp4"]);
        expect(JSON.stringify(submitted)).not.toContain("blob:");
        expect(JSON.stringify(submitted)).toContain("router-upload:");
        expect(vi.mocked(axios.post).mock.calls.filter(([, body]) => body instanceof FormData)).toHaveLength(3);
    });

    it("downloads a signed HTTP video from the same local Router without calling the official gateway", async () => {
        const config = localConfig();
        const url = `http://127.0.0.1:8189/media/cgt-existing-local-task?exp=2147483647&sig=${"a".repeat(64)}`;
        requestFetch.mockResolvedValueOnce(Response.json({ id: "cgt-existing-local-task", status: "succeeded", content: { video_url: url } }));
        vi.mocked(axios.get).mockResolvedValueOnce({ data: new Blob(["local video"], { type: "video/mp4" }) });
        const state = await pollVideoGenerationTask(config, task(config));
        expect(state).toMatchObject({ status: "completed", result: { requirePersistence: true } });
        expect(decodeURIComponent(String(vi.mocked(axios.get).mock.calls[0][0]))).toBe(`/api/router-local/download?url=${url}`);
    });

    it("rejects a result URL on another local service before requesting its bytes", async () => {
        const config = localConfig();
        const foreign = `http://127.0.0.1:9999/media/cgt-existing-local-task?exp=2147483647&sig=${"a".repeat(64)}`;
        requestFetch.mockResolvedValueOnce(Response.json({ id: "cgt-existing-local-task", status: "succeeded", content: { video_url: foreign } }));
        await expect(pollVideoGenerationTask(config, task(config))).rejects.toThrow();
        expect(axios.get).not.toHaveBeenCalled();
    });
});
