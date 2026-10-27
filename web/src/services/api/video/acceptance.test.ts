import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/api-proxy", () => ({ proxyApiUrl: (url: string) => url }));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:vi.fn()}));
vi.mock("@/lib/image-utils", () => ({ dataUrlToFile: vi.fn() }));
vi.mock("@/services/file-storage", () => ({ getMediaBlob: vi.fn(), uploadMediaFile: vi.fn() }));
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: vi.fn() }));
vi.mock("@/lib/canvas/canvas-node-factory", () => ({ imageMetadata: vi.fn(), referenceUrl: vi.fn() }));
vi.mock("../model-plugin", () => ({ runModelPlugin: vi.fn() }));
vi.mock("axios", () => ({ default: { post: vi.fn(), get: vi.fn(), delete: vi.fn(), isCancel: () => false, isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError) } }));

import axios from "axios";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import { defaultConfig, buildArkApiUrl, normalizeChannelModels, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "../model-plugin";
import { uploadMediaFile } from "@/services/file-storage";
import { createVideoGenerationTask, pollVideoGenerationTask, requestVideoGeneration, cancelVideoGenerationTask, retrySeedanceDownload, storeGeneratedVideo, type VideoGenerationTask } from "../video";
import { SEEDANCE_STANDARD, SEEDANCE_FAST } from "./model-capabilities";
import type { VideoGenerationRequest } from "./types";
import { buildGenerationConfig, resetInterruptedGeneration } from "@/lib/canvas/canvas-generation-helpers";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const configFor = (format: "openai" | "volcengine_ark" = "volcengine_ark", name = SEEDANCE_STANDARD): AiConfig => ({
    ...defaultConfig, model: `acceptance::${name}`, videoModel: `acceptance::${name}`,
    channels: [{ id: "acceptance", name: "acceptance", apiFormat: format, baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "test-only", models: [{ name, capability: "video" }] }],
});
const requestFor = (config: AiConfig): VideoGenerationRequest => ({ modelOption: config.model, mode: "text_to_video", prompt: "A slow camera move", references: [], durationSeconds: 6, resolution: "720p", ratio: "16:9", generateAudio: true, watermark: false });
const taskFor = (config: AiConfig): VideoGenerationTask => ({ id: "existing-task", provider: "volcengine_ark", model: config.model, channelId: "acceptance", startedAt: 1, status: "queued" });

beforeEach(() => vi.clearAllMocks());
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("independent Seedance acceptance", () => {
    it("retains a locally saved successful video across refresh", () => {
        const config = configFor();
        const node: CanvasNodeData = { id: "saved", type: CanvasNodeType.Video, title: "saved", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { status: "success", storageKey: "video:saved", content: "blob:old-session", videoTask: { provider: "volcengine_ark", channelId: "acceptance", model: config.model, taskId: "completed-task", startedAt: 1, status: "succeeded" } } };
        expect(resetInterruptedGeneration([node])[0].metadata?.status).toBe("success");
    });

    it("restores unsaved Ark work while marking legacy interrupted work as failed", () => {
        const base: CanvasNodeData = { id: "pending", type: CanvasNodeType.Video, title: "pending", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { status: "loading" } };
        const ark = { ...base, metadata: { ...base.metadata, videoTask: { provider: "volcengine_ark" as const, model: configFor().model, taskId: "existing-task", startedAt: 1, status: "running" as const } } };
        expect(resetInterruptedGeneration([ark, base]).map((node) => node.metadata?.status)).toEqual(["loading", "error"]);
    });

    it("projects node video settings independently of image size", () => {
        const config = configFor();
        const node: CanvasNodeData = { id: "node", type: CanvasNodeType.Video, title: "video", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { model: config.model, size: "1024x1024", videoMode: "first_last_frame", videoRatio: "21:9", returnLastFrame: "true" } };
        expect(buildGenerationConfig(config, node, "video")).toMatchObject({ videoMode: "first_last_frame", videoRatio: "21:9", videoReturnLastFrame: "true", size: "1024x1024" });
    });

    it("builds Ark v3 paths without introducing v1", () => {
        expect(buildArkApiUrl("https://ark.cn-beijing.volces.com/api/v3/", "/contents/generations/tasks")).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
    });

    it("preserves capability metadata through channel normalization", () => {
        const model = { name: "ep-custom", capability: "video" as const, videoPreset: "seedance-2.0-fast" as const, videoCapabilities: { resolutions: ["480p", "720p"] } };
        expect(normalizeChannelModels([model])[0]).toMatchObject(model);
    });

    it("submits only Ark JSON parameters through the task gateway", async () => {
        const config = configFor();
        vi.mocked(axios.post).mockResolvedValueOnce({ data: { id: "new-task" } });
        const task = await createVideoGenerationTask(config, "ignored", [], { request: requestFor(config) });
        const [url, body] = vi.mocked(axios.post).mock.calls[0];
        expect(url).toBe("/api/ark/contents/generations/tasks");
        expect(body).toMatchObject({ model: SEEDANCE_STANDARD, duration: 6, resolution: "720p", ratio: "16:9", generate_audio: true, watermark: false, content: [{ type: "text", text: "A slow camera move" }] });
        for (const key of ["seconds", "size", "resolution_name", "seed", "camera_fixed", "frames"]) expect(body).not.toHaveProperty(key);
        expect(task).toMatchObject({ id: "new-task", provider: "volcengine_ark", channelId: "acceptance" });
    });

    it("routes the same Seedance name on an OpenAI channel through OpenAI", async () => {
        const config = configFor("openai");
        vi.mocked(axios.post).mockResolvedValueOnce({ data: { id: "openai-task" } });
        const task = await createVideoGenerationTask(config, "prompt");
        expect(task.provider).toBe("openai");
        expect(vi.mocked(axios.post).mock.calls[0][1]).toBeInstanceOf(FormData);
    });

    it("executes an explicit script before Ark protocol dispatch", async () => {
        const config = configFor();
        config.channels[0].models[0].script = "return 'https://example.com/video.mp4'";
        vi.mocked(runModelPlugin).mockResolvedValueOnce("https://example.com/video.mp4");
        const task = await createVideoGenerationTask(config, "prompt");
        expect(task.provider).toBe("plugin");
        expect(runModelPlugin).toHaveBeenCalledOnce();
        expect(axios.post).not.toHaveBeenCalled();
    });

    it("supports server-managed Ark credentials without exposing a gateway token to the browser", async () => {
        vi.stubEnv("VITE_ARK_SERVER_AUTH", "true");
        vi.stubEnv("VITE_MEDIA_GATEWAY_TOKEN", "");
        const config = configFor();
        config.channels[0].apiKey = "";
        expect(useConfigStore.getState().isAiConfigReady(config, config.model)).toBe(true);
        vi.mocked(axios.post).mockResolvedValueOnce({ data: { id: "server-auth-task" } });
        await expect(createVideoGenerationTask(config, "prompt", [], { request: requestFor(config) })).resolves.toMatchObject({ id: "server-auth-task", provider: "volcengine_ark" });
    });

    it("rejects unsupported Fast resolution before creating a billable task", async () => {
        const config = configFor("volcengine_ark", SEEDANCE_FAST);
        await expect(createVideoGenerationTask(config, "prompt", [], { request: { ...requestFor(config), resolution: "4k" } })).rejects.toThrow(/resolution/i);
        expect(axios.post).not.toHaveBeenCalled();
    });

    it("accepts a large remote reference without counting the downloaded file as JSON body", async () => {
        const config = configFor();
        vi.mocked(axios.post).mockResolvedValueOnce({ data: { id: "remote-task" } });
        await expect(createVideoGenerationTask(config, "prompt", [], { request: { ...requestFor(config), mode: "omni_reference", references: [{ id: "remote", kind: "video", role: "reference_video", url: "https://example.com/reference.mp4", bytes: 150 * 1024 * 1024, width: 1280, height: 720, durationMs: 5000, mimeType: "video/mp4" }] } })).resolves.toMatchObject({ id: "remote-task" });
    });

    it("preserves a valid Ark image asset identifier", async () => {
        const config = configFor();
        vi.mocked(axios.post).mockResolvedValueOnce({ data: { id: "asset-task" } });
        await createVideoGenerationTask(config, "prompt", [], { request: { ...requestFor(config), mode: "first_frame", references: [{ id: "asset", kind: "image", role: "first_frame", url: "asset://asset-123", width: 1280, height: 720, mimeType: "image/png" }] } });
        expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ content: [{ type: "text", text: "A slow camera move" }, { type: "image_url", image_url: { url: "asset://asset-123" }, role: "first_frame" }] });
    });

    it("does not treat failed Ark local persistence as permanent success", async () => {
        vi.mocked(uploadMediaFile).mockRejectedValueOnce(new Error("quota exceeded"));
        await expect(storeGeneratedVideo({ blob: new Blob(["video"], { type: "video/mp4" }), requirePersistence: true })).rejects.toThrow(/quota exceeded/);
    });

    it("maps an expired saved task without ever creating a replacement", async () => {
        const config = configFor();
        vi.mocked(axios.get).mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } });
        expect(await pollVideoGenerationTask(config, taskFor(config))).toMatchObject({ status: "failed", providerStatus: "expired" });
        expect(axios.post).not.toHaveBeenCalled();
    });

    it("does not send DELETE when the remote task is already running", async () => {
        const config = configFor();
        vi.mocked(axios.get).mockResolvedValueOnce({ data: { id: "existing-task", status: "running" } });
        expect(await cancelVideoGenerationTask(config, taskFor(config))).toBe(false);
        expect(axios.delete).not.toHaveBeenCalled();
    });

    it("cancels a queued Ark task after confirming its current status", async () => {
        const config = configFor();
        vi.mocked(axios.get).mockResolvedValueOnce({ data: { id: "existing-task", status: "queued" } });
        vi.mocked(axios.delete).mockResolvedValueOnce({ data: {} });
        await expect(cancelVideoGenerationTask(config, taskFor(config))).resolves.toBe(true);
        expect(axios.get).toHaveBeenCalledOnce();
        expect(axios.delete).toHaveBeenCalledOnce();
        expect(vi.mocked(axios.delete).mock.calls[0][0]).toContain("/contents/generations/tasks/existing-task");
    });

    it("retries a completed task download without creating a replacement", async () => {
        const config = configFor();
        const task = taskFor(config);
        vi.mocked(axios.get).mockResolvedValueOnce({ data: { id: task.id, status: "succeeded", content: { video_url: "https://ark.cn-beijing.volces.com/result.mp4" } } });
        vi.mocked(canvasApi).mockResolvedValueOnce({blobId:"a".repeat(64),mimeType:"video/mp4",byteSize:5});
        const mediaFetch=vi.fn().mockResolvedValue(new Response(new Blob(["video"],{type:"video/mp4"}),{
            headers:{"content-type":"video/mp4"}
        }));
        vi.stubGlobal("fetch",mediaFetch);
        vi.mocked(uploadMediaFile).mockResolvedValueOnce({ url: "blob:stored", storageKey: "video:stored", bytes: 5, mimeType: "video/mp4" });
        await expect(retrySeedanceDownload(config, task)).resolves.toMatchObject({ video: { storageKey: "video:stored" } });
        expect(canvasApi).toHaveBeenCalledWith("/api/v1/media/download","POST",{url:"https://ark.cn-beijing.volces.com/result.mp4"});
        expect(mediaFetch).toHaveBeenCalledWith("/api/v1/blobs/"+"a".repeat(64),expect.objectContaining({credentials:"same-origin"}));
        expect(axios.get).toHaveBeenCalledOnce();
        expect(axios.post).not.toHaveBeenCalled();
        expect(uploadMediaFile).toHaveBeenCalledOnce();
    });
    it("rejects an incorrect stored CAS result without creating a replacement paid task",async()=>{
        const config=configFor();
        vi.mocked(axios.get).mockResolvedValueOnce({data:{id:"existing-task",status:"succeeded",
            content:{video_url:"https://ark.cn-beijing.volces.com/result.mp4"}}});
        vi.mocked(canvasApi).mockResolvedValueOnce({blobId:"a".repeat(64),mimeType:"video/mp4",byteSize:99});
        const fetchMock=vi.fn().mockResolvedValue(new Response(new Blob(["bad"],{type:"video/mp4"}),{
            headers:{"content-type":"video/mp4"}
        }));
        vi.stubGlobal("fetch",fetchMock);
        await expect(retrySeedanceDownload(config,taskFor(config)))
            .rejects.toThrow(/CAS download did not match/);
        expect(axios.post).not.toHaveBeenCalled();
        expect(uploadMediaFile).not.toHaveBeenCalled();
    });

    it("retries a transient query failure without repeating create", async () => {
        vi.useFakeTimers();
        const config = configFor();
        vi.mocked(axios.post).mockResolvedValueOnce({ data: { id: "new-task" } });
        vi.mocked(axios.get).mockRejectedValueOnce({ isAxiosError: true, response: { status: 429 }, message: "rate limit" });
        vi.mocked(axios.get).mockResolvedValueOnce({ data: { id: "new-task", status: "failed", error: { message: "terminal test failure" } } });
        const result = requestVideoGeneration(config, "prompt", [], { request: requestFor(config) });
        const assertion = expect(result).rejects.toThrow("terminal test failure");
        await vi.runAllTimersAsync();
        await assertion;
        expect(axios.post).toHaveBeenCalledOnce();
        expect(axios.get).toHaveBeenCalledTimes(2);
    });
});
