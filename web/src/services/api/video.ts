import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { getImageBlob, imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { proxyApiUrl } from "@/lib/api-proxy";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { resolveModelChannel } from "@/stores/use-config-store";
import { capabilitiesForModel } from "./video/model-capabilities";
import { buildSeedanceContent, validateLocalRouterRequest, validateSeedanceRequest } from "./video/seedance-content";
import type { VideoGenerationRequest, VideoInputMedia, VideoTaskStatus } from "./video/types";
export type { VideoGenerationRequest, VideoInputMedia } from "./video/types";

type VideoResponse = { id: string; status?: string; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal; request?: VideoGenerationRequest; onTaskCreated?: (task: VideoGenerationTask) => void; onTaskStatus?: (status: VideoTaskStatus) => void };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string; lastFrameUrl?: string; lastFrameBlob?: Blob; requirePersistence?: boolean };
export type VideoGenerationTask = { id: string; provider: "openai" | "plugin" | "volcengine_ark" | "router_local"; model: string; channelId?: string; startedAt?: number; status?: VideoTaskStatus };
export type VideoGenerationTaskState = { status: "pending"; providerStatus?: VideoTaskStatus } | { status: "completed"; result: VideoGenerationResult; providerStatus?: VideoTaskStatus; lastFrameUrl?: string; lastFrameBlob?: Blob } | { status: "failed"; error: string; providerStatus?: VideoTaskStatus };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return proxyApiUrl(buildApiUrl(config.baseUrl, path));
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, options);
    options?.onTaskCreated?.(task);
    let backoff = 2_000;
    for (let attempt = 0; attempt < 160; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        let state: VideoGenerationTaskState;
        try {
            state = await pollVideoGenerationTask(config, task, options);
            backoff = 2_000;
        } catch (error) {
            if (options?.signal?.aborted || attempt === 159 || !isRetryableQueryError(error)) throw error;
            await delay(backoff, options?.signal);
            backoff = Math.min(30_000, Math.round(backoff * 1.7));
            continue;
        }
        if (state.providerStatus) options?.onTaskStatus?.(state.providerStatus);
        if (state.status === "completed") return { ...state.result, lastFrameUrl: state.lastFrameUrl };
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === 159) throw new Error("The remote video task is still running. Its task ID was saved and can be resumed; no replacement task was created.");
        await delay(backoff, options?.signal);
        backoff = Math.min(30_000, Math.round(backoff * 1.25));
    }
    throw new Error(apiText("videoTimeout", { provider: "" }));
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (requestConfig.apiFormat === "volcengine_ark") return createSeedanceTask(config, requestConfig, selectedModel, options?.request || legacySeedanceRequest(config, selectedModel, prompt, references), options);
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("pluginVideoExpired") };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "volcengine_ark" || task.provider === "router_local") return pollSeedanceTask(requestConfig, task, options, task.provider === "router_local");
    return pollOpenAIVideoTask(requestConfig, task, options);
}

export async function cancelVideoGenerationTask(config: AiConfig, task: VideoGenerationTask) {
    if (task.provider !== "volcengine_ark" && task.provider !== "router_local") return false;
    const requestConfig = resolveModelRequestConfig(config, task.model);
    const local = task.provider === "router_local";
    const response = local
        ? (await axios.get<SeedanceResponse>(routerLocalUrl(`/contents/generations/tasks/${encodeURIComponent(task.id)}`), { headers: routerLocalHeaders(requestConfig), timeout: 30_000 })).data
        : (await axios.get<SeedanceResponse>(arkUrl(requestConfig, `/contents/generations/tasks/${encodeURIComponent(task.id)}`), { headers: arkHeaders(requestConfig) })).data;
    const remote = local ? response : unwrapSeedanceResponse(response);
    if (remote.status !== "queued") return false;
    if (local) {
        await axios.delete(routerLocalUrl(`/contents/generations/tasks/${encodeURIComponent(task.id)}`), { headers: routerLocalHeaders(requestConfig), timeout: 30_000 });
    } else await axios.delete(arkUrl(requestConfig, `/contents/generations/tasks/${encodeURIComponent(task.id)}`), { headers: arkHeaders(requestConfig) });
    return true;
}

export async function retrySeedanceDownload(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions) {
    if (task.provider !== "volcengine_ark" && task.provider !== "router_local") throw new Error("This is not a Seedance video task.");
    const state = await pollVideoGenerationTask(config, task, options);
    if (state.status !== "completed") throw new Error(state.status === "failed" ? state.error : "Video generation is still running.");
    return { video: await storeGeneratedVideo(state.result), lastFrameBlob: state.lastFrameBlob, lastFrameUrl: state.lastFrameUrl };
}

function legacySeedanceRequest(config: AiConfig, modelOption: string, prompt: string, references: ReferenceImage[]): VideoGenerationRequest {
    const resolution = normalizeVideoResolution(config.vquality);
    const validResolution = (["480p", "720p", "1080p", "4k"].includes(resolution) ? resolution : "720p") as VideoGenerationRequest["resolution"];
    const mode = references.length ? (config.videoMode === "first_frame" || config.videoMode === "first_last_frame" || config.videoMode === "omni_reference" ? config.videoMode : "omni_reference") : "text_to_video";
    return {
        modelOption,
        mode,
        prompt,
        references: references.map((image) => ({ id: image.id, kind: "image", role: mode === "first_frame" ? "first_frame" : mode === "first_last_frame" ? (references[0] === image ? "first_frame" : "last_frame") : "reference_image", dataUrl: image.dataUrl, storageKey: image.storageKey, mimeType: image.type })),
        durationSeconds: Number(config.videoSeconds) === -1 ? -1 : Number(config.videoSeconds) || 6,
        resolution: validResolution,
        ratio: (config.videoRatio || "adaptive") as VideoGenerationRequest["ratio"],
        generateAudio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
        returnLastFrame: boolConfig(config.videoReturnLastFrame, false),
    };
}

type SeedanceResponse = { id?: string; status?: VideoTaskStatus; content?: { video_url?: string; last_frame_url?: string }; error?: { message?: string }; message?: string; code?: string | number };
function arkUrl(config: AiConfig, path: string) { return `/api/ark${path}`; }
function arkHeaders(config: AiConfig, contentType?: string) {
    return { ...aiHeaders(config, contentType), "x-gateway-token": import.meta.env.VITE_MEDIA_GATEWAY_TOKEN || "", "x-ark-base-url": config.baseUrl };
}

export function buildRouterLocalApiPath(path: string) { return `/api/router-local/api/v3${path.startsWith("/") ? path : `/${path}`}`; }

function routerOrigin(config: AiConfig) {
    const url = new URL(config.baseUrl);
    const hostname = url.hostname.toLowerCase();
    if (!(hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") || !url.port || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname.replace(/\/+$/, "") !== "/api/v3")) {
        throw new Error("Local Router adapter requires an explicit localhost or loopback origin with an explicit port and optional /api/v3 path.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Local Router adapter only supports HTTP or HTTPS on loopback.");
    return url.origin;
}

function routerLocalHeaders(config: AiConfig) {
    return { Authorization: `Bearer ${config.apiKey}`, "x-router-origin": routerOrigin(config) };
}

function routerLocalUrl(path: string) { return buildRouterLocalApiPath(path); }

class RouterLocalHttpError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

async function localRouterJson<T>(path: string, config: AiConfig, options?: { method?: string; body?: BodyInit; signal?: AbortSignal; contentType?: string }): Promise<T> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options?.signal?.reason);
    const timeout = setTimeout(() => controller.abort(new DOMException("Local Router request timed out", "TimeoutError")), 120_000);
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (options?.signal?.aborted) onAbort();
    let response: Response;
    try {
        response = await fetch(buildRouterLocalApiPath(path), {
            method: options?.method || "GET",
            headers: { ...routerLocalHeaders(config), ...(options?.contentType ? { "Content-Type": options.contentType } : {}) },
            ...(options?.body ? { body: options.body } : {}),
            signal: controller.signal,
            cache: "no-store",
        });
    } finally {
        clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", onAbort);
    }
    const payload = await response.json().catch(() => ({})) as T & { error?: string | { message?: string; code?: string }; message?: string };
    if (!response.ok) throw new RouterLocalHttpError(response.status, routerPayloadMessage(payload, response.status));
    return payload;
}

function routerPayloadMessage(payload: { error?: string | { message?: string; code?: string }; message?: string }, status: number) {
    return payload.message || (typeof payload.error === "string" ? payload.error : payload.error?.message) || `Local Router request failed (${status}).`;
}

async function createLocalRouterTask(rootConfig: AiConfig, config: AiConfig, channel: ReturnType<typeof resolveModelChannel> & {}, modelOption: string, capabilities: NonNullable<ReturnType<typeof capabilitiesForModel>>, request: VideoGenerationRequest, options?: RequestOptions): Promise<VideoGenerationTask> {
    routerOrigin(config);
    if (!channel || channel.seedanceAdapter !== "router_local") throw new Error("Select the local Router adapter on this channel.");
    if (!config.apiKey.trim()) throw new Error("A local Router API key is required for media upload and task requests.");
    if (modelOptionName(modelOption) !== "doubao-seedance-2-0-260128") throw new Error("The local Router only supports the standard Seedance 2.0 model alias.");
    const staged = await Promise.all(request.references.map((reference) => stageRouterLocalMedia(reference)));
    const stagedRequest = { ...request, references: staged.map((item) => item.reference) };
    validateLocalRouterRequest(stagedRequest, capabilities);
    const uploaded = await Promise.all(staged.map(async (item) => item.blob ? uploadRouterLocalMedia(config, item.reference, item.blob, item.fileName!, options?.signal) : item.reference));
    const body = {
        model: modelOptionName(modelOption),
        content: buildSeedanceContent(stagedRequest.prompt, uploaded as Array<VideoInputMedia & { url: string }>),
        ratio: stagedRequest.ratio,
        resolution: stagedRequest.resolution,
        duration: stagedRequest.durationSeconds,
        generate_audio: stagedRequest.generateAudio,
        ...(stagedRequest.watermark ? { watermark: true } : {}),
    };
    const created = await localRouterJson<SeedanceResponse>("/contents/generations/tasks", config, { method: "POST", body: JSON.stringify(body), contentType: "application/json", signal: options?.signal });
    if (!created.id) throw new Error("Local Router did not return a task ID.");
    return { id: created.id, provider: "router_local", model: modelOption, channelId: channel.id, startedAt: Date.now(), status: created.status || "queued" };
}

async function stageRouterLocalMedia(media: VideoInputMedia): Promise<{ reference: VideoInputMedia; blob?: Blob; fileName?: string }> {
    if (media.url?.startsWith("router-upload:")) return { reference: media };
    let blob: Blob | null = null;
    if (media.kind === "image" && media.storageKey) blob = await getImageBlob(media.storageKey);
    else if (media.kind !== "image" && media.storageKey) blob = await getMediaBlob(media.storageKey);
    if (!blob && media.kind === "image") {
        const data = media.dataUrl || (media.url?.startsWith("data:image/") ? media.url : "");
        if (data) blob = await (await fetch(data)).blob();
    }
    if (!blob) throw new Error(`Local ${media.kind} reference is missing from browser storage; remote URLs and expired blob URLs are not accepted by the local Router.`);
    const mimeType = blob.type || media.mimeType || "application/octet-stream";
    const fileName = `${media.id || "reference"}.${extensionFor(mimeType)}`;
    return { reference: { ...media, url: undefined, dataUrl: undefined, mimeType, bytes: blob.size }, blob, fileName };
}

async function uploadRouterLocalMedia(config: AiConfig, media: VideoInputMedia, blob: Blob, fileName: string, signal?: AbortSignal): Promise<VideoInputMedia & { url: string }> {
    const form = new FormData();
    form.append("file", blob, fileName);
    let response;
    try {
        response = await axios.post<{ url?: string; type?: string; bytes?: number; duration_sec?: number }>(routerLocalUrl("/media/uploads"), form, { headers: routerLocalHeaders(config), signal, timeout: 120_000 });
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const payload = error.response?.data as { error?: string | { message?: string; code?: string }; message?: string } | undefined;
            throw new RouterLocalHttpError(error.response?.status || 0, payload ? routerPayloadMessage(payload, error.response?.status || 0) : error.message || "Local Router media upload failed.");
        }
        throw error;
    }
    const payload = response.data;
    if (!payload.url || !/^router-upload:[a-f0-9-]{36}\.(png|jpg|webp|mp4|mov|webm|wav|mp3|flac|m4a)$/i.test(payload.url)) throw new Error("Local Router returned an invalid router-upload token.");
    return { ...media, url: payload.url, bytes: payload.bytes ?? blob.size, mimeType: media.mimeType || blob.type, durationMs: payload.duration_sec ? Math.round(payload.duration_sec * 1000) : media.durationMs };
}

async function createSeedanceTask(rootConfig: AiConfig, config: AiConfig, modelOption: string, request: VideoGenerationRequest, options?: RequestOptions): Promise<VideoGenerationTask> {
    const channel = resolveModelChannel(rootConfig, modelOption);
    const model = channel?.models.find((item) => item.name === modelOptionName(modelOption));
    const capabilities = channel && model ? capabilitiesForModel(channel, model) : null;
    if (!channel || !model || !capabilities) throw new Error("Select a Seedance model configured on an Ark channel.");
    if (channel.seedanceAdapter === "router_local") return createLocalRouterTask(rootConfig, config, channel, modelOption, capabilities, request, options);
    const media = await Promise.all(request.references.map((item) => resolveSeedanceMedia(item, options?.signal)));
    const resolvedRequest = { ...request, references: media };
    validateSeedanceRequest(resolvedRequest, capabilities);
    const body = {
        model: modelOptionName(modelOption),
        content: buildSeedanceContent(resolvedRequest.prompt, media),
        ratio: resolvedRequest.ratio,
        resolution: resolvedRequest.resolution,
        duration: resolvedRequest.durationSeconds,
        generate_audio: resolvedRequest.generateAudio,
        watermark: resolvedRequest.watermark,
        return_last_frame: Boolean(resolvedRequest.returnLastFrame),
    };
    if (new Blob([JSON.stringify(body)]).size > 64 * 1024 * 1024) throw new Error("Seedance 2.0 request JSON exceeds the 64 MB limit.");
    try {
        const response = await axios.post<SeedanceResponse>(arkUrl(config, "/contents/generations/tasks"), body, { headers: arkHeaders(config, "application/json"), signal: options?.signal, timeout: 60_000 });
        const created = unwrapSeedanceResponse(response.data);
        if (!created.id) throw new Error("Ark did not return a task ID.");
        return { id: created.id, provider: "volcengine_ark", model: modelOption, channelId: channel.id, startedAt: Date.now(), status: "queued" };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance task creation failed."));
    }
}

async function resolveSeedanceMedia(media: VideoInputMedia, signal?: AbortSignal): Promise<VideoInputMedia & { url: string }> {
    if (media.kind === "image") {
        let dataUrl = media.storageKey ? await imageToDataUrl({ storageKey: media.storageKey, url: media.url }) : media.dataUrl || media.url;
        if (dataUrl?.startsWith("data:image/")) {
            const dimensions = media.width && media.height ? {} : await readImageDimensions(dataUrl);
            return { ...media, ...dimensions, url: dataUrl, mimeType: media.mimeType || dataUrl.slice(5, dataUrl.indexOf(";")), bytes: media.bytes || estimateDataUrlBytes(dataUrl) };
        }
        if (media.url && (/^https:\/\//i.test(media.url) || /^asset:\/\/[A-Za-z0-9_-]+$/i.test(media.url))) return { ...media, url: media.url };
        throw new Error("Image reference is unavailable or cannot be read as a data URL.");
    }
    if (media.kind === "audio" && media.dataUrl?.startsWith("data:audio/")) return { ...media, url: media.dataUrl };
    const remote = media.url || "";
    if (/^asset:\/\//i.test(remote) || /^https:\/\//i.test(remote)) return { ...media, url: remote };
    if (!media.storageKey) throw new Error(`${media.kind} references require an Ark asset ID or an HTTPS URL reachable by Volcano Engine.`);
    const blob = await getMediaBlob(media.storageKey);
    if (!blob) throw new Error(`Local ${media.kind} reference is missing from browser storage.`);
    if (media.kind === "audio" && blob.size <= 15 * 1024 * 1024) return { ...media, url: await blobToDataUrl(blob), bytes: blob.size, mimeType: blob.type || media.mimeType };
    const form = new FormData();
    form.append("file", blob, media.id || `reference.${extensionFor(blob.type)}`);
    let response: Response;
    try {
        response = await fetch("/media/ark", { method: "POST", body: form, signal, headers: { "x-gateway-token": import.meta.env.VITE_MEDIA_GATEWAY_TOKEN || "" } });
    } catch (error) {
        throw new Error(`The Ark media gateway is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`Ark media upload failed (${response.status}). Configure the secure media gateway before using local ${media.kind} references.`);
    const payload = (await response.json()) as { url?: string };
    if (!payload.url || !/^https:\/\//i.test(payload.url)) throw new Error("The media gateway returned no public HTTPS URL.");
    return { ...media, url: payload.url, bytes: blob.size, mimeType: blob.type || media.mimeType };
}

async function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Unable to read reference media.")); reader.onerror = () => reject(reader.error || new Error("Unable to read reference media.")); reader.readAsDataURL(blob);
    });
}
async function readImageDimensions(dataUrl: string) {
    return new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error("Seedance image dimensions could not be verified."));
        image.src = dataUrl;
    });
}
function extensionFor(type: string) {
    const mime = type.toLowerCase().split(";")[0].trim();
    const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/quicktime": "mov", "video/mp4": "mp4", "video/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/flac": "flac", "audio/x-flac": "flac", "audio/mp4": "m4a", "audio/x-m4a": "m4a" };
    return extensions[mime] || "bin";
}
function estimateDataUrlBytes(value: string) { const base64 = value.slice(value.indexOf(",") + 1); return Math.floor((base64.length * 3) / 4); }

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions, local = false): Promise<VideoGenerationTaskState> {
    try {
        const path = `/contents/generations/tasks/${encodeURIComponent(task.id)}`;
        const remote = local
            ? await localRouterJson<SeedanceResponse>(path, config, { signal: options?.signal })
            : unwrapSeedanceResponse((await axios.get<SeedanceResponse>(arkUrl(config, path), { headers: arkHeaders(config), signal: options?.signal, timeout: 30_000 })).data);
        if (remote.status) options?.onTaskStatus?.(remote.status);
        if (remote.status === "failed" || remote.status === "cancelled") return { status: "failed", error: remote.error?.message || remote.message || `Seedance task ${remote.status}.`, providerStatus: remote.status };
        if (remote.status === "succeeded") {
            if (!remote.content?.video_url) return { status: "failed", error: "Seedance task succeeded but returned no video URL.", providerStatus: "succeeded" };
            try {
                const blob = await downloadResult(remote.content.video_url, options?.signal, local ? config : undefined);
                const lastFrameBlob = remote.content.last_frame_url && (options?.request?.returnLastFrame || boolConfig(config.videoReturnLastFrame, false)) ? await downloadResult(remote.content.last_frame_url, options?.signal) : undefined;
                return { status: "completed", result: { blob, mimeType: blob.type || "video/mp4", lastFrameUrl: remote.content.last_frame_url, lastFrameBlob, requirePersistence: true }, providerStatus: "succeeded", lastFrameUrl: remote.content.last_frame_url, lastFrameBlob };
            } catch (error) {
                throw new Error(`Video generation succeeded, but saving its temporary result failed. Retry download before the link expires: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return { status: "pending", providerStatus: remote.status || "running" };
    } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : error instanceof RouterLocalHttpError ? error.status : undefined;
        if ([404, 410].includes(status || 0)) return { status: "failed", error: "This Seedance task has expired or is no longer available. Create a new task only if you want to generate another video.", providerStatus: "expired" };
        if (isRetryableQueryError(error)) throw Object.assign(new Error(readAxiosError(error, "Seedance task query failed.")), { retryable: true, cause: error });
        throw new Error(readAxiosError(error, "Seedance task query failed."));
    }
}

function isRetryableQueryError(error: unknown) {
    if (error && typeof error === "object" && "retryable" in error && (error as { retryable?: unknown }).retryable === true) return true;
    if (error instanceof RouterLocalHttpError) return error.status === 0 || error.status === 429 || error.status >= 500;
    if (error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError")) return true;
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    return !error.response || status === 429 || (status !== undefined && status >= 500);
}

function unwrapSeedanceResponse(response: SeedanceResponse): SeedanceResponse {
    if (response.code !== undefined && response.code !== 0 && response.code !== "0") throw new Error(response.message || `Ark API error ${response.code}`);
    return response;
}

async function downloadResult(url: string, signal?: AbortSignal, localConfig?: AiConfig) {
    if (localConfig) {
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new Error("Local Router returned an invalid media URL."); }
        if (parsed.origin !== routerOrigin(localConfig) || !/^\/media\/[A-Za-z0-9_-]+$/.test(parsed.pathname) || !parsed.searchParams.get("exp") || !parsed.searchParams.get("sig") || parsed.username || parsed.password || parsed.hash) {
            throw new Error("Local Router returned an untrusted signed media URL.");
        }
        let response;
        try {
            response = await axios.get<Blob>(`/api/router-local/download?url=${encodeURIComponent(parsed.toString())}`, { headers: routerLocalHeaders(localConfig), responseType: "blob", signal, timeout: 120_000 });
        } catch (error) {
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            if ([404, 410].includes(status || 0)) throw new Error("Video generation succeeded, but the local Router's signed video URL has expired. Retry download if the Router still has the file.");
            if (status === 429 || (status !== undefined && status >= 500) || (axios.isAxiosError(error) && !error.response)) throw Object.assign(new Error(`Local Router result download failed: ${error instanceof Error ? error.message : String(error)}`), { retryable: true, cause: error });
            throw error;
        }
        if (!response.data.size || response.data.type.includes("json")) throw new Error("The local Router result URL did not return a video file.");
        return response.data;
    }
    if (!/^https:\/\//i.test(url)) throw new Error("Ark returned a non-HTTPS result URL.");
    let response;
    try { response = await axios.get<Blob>(`/api/ark/download?url=${encodeURIComponent(url)}`, { headers: { "x-gateway-token": import.meta.env.VITE_MEDIA_GATEWAY_TOKEN || "" }, responseType: "blob", signal, timeout: 120_000 }); }
    catch (error) {
        if (axios.isAxiosError(error) && [404, 410].includes(error.response?.status || 0)) throw new Error("Ark's temporary video URL has expired. This task cannot be downloaded again; create a new generation if you still need the video.");
        throw error;
    }
    if (!response.data.size || response.data.type.includes("json")) throw new Error("The result URL did not return a video file.");
    return response.data;
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: config.size,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error(apiText("scriptNoVideo"));
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) {
        try { return await uploadMediaFile(result.blob, "video"); }
        catch (error) { if (result.requirePersistence) throw new Error(`Generated video could not be saved to local storage: ${error instanceof Error ? error.message : String(error)}`); throw error; }
    }
    if (result.url) {
        try { return await uploadMediaFile(result.url, "video"); }
        catch (error) { if (result.requirePersistence) throw error; return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" }; }
    }
    throw new Error(apiText("noPlayableVideo"));
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readApiErrorMessage(video.error?.message) || apiText("videoGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url, mimeType: "video/mp4" };
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim() && !(config.apiFormat === "volcengine_ark" && (import.meta.env.VITE_MEDIA_GATEWAY_TOKEN || import.meta.env.VITE_ARK_SERVER_AUTH === "true"))) throw new Error(apiText("apiKeyRequired"));
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiVideoUnsupported"));
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    if (resolution === "768") return "768P";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        if (!error.response) {
            const url = typeof error.config?.url === "string" ? error.config.url : "";
            const hint = url ? `\n${url}` : "";
            return error.code === "ERR_NETWORK" ? `${apiText("corsRequired")}${hint}` : `${apiText("networkFailed")}${hint}`;
        }
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || readNetworkMessage(error.message) || error.message : fallback;
}

function readNetworkMessage(message: string) {
    return /failed to fetch|network error|load failed|net::err_/i.test(message) ? apiText("networkFailed") : null;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || apiText("videoDownloadFailed"));
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}
