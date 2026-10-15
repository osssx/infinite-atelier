import type { VideoCapabilities } from "@/stores/use-config-store";
import type { VideoGenerationRequest, VideoInputMedia } from "./types";

export type ArkContentItem =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string }; role: string }
    | { type: "video_url"; video_url: { url: string }; role: string }
    | { type: "audio_url"; audio_url: { url: string }; role: string };

export function validateSeedanceRequest(request: VideoGenerationRequest, capabilities: VideoCapabilities) {
    if (!request.prompt.trim()) throw new Error("A prompt is required.");
    if (!("text_to_video" === request.mode || request.mode === "first_frame" || request.mode === "first_last_frame" || request.mode === "omni_reference")) throw new Error("Unsupported Seedance generation mode.");
    if (!capabilities.resolutions?.includes(request.resolution)) throw new Error(`Resolution ${request.resolution} is not supported by this model.`);
    if (!capabilities.ratios?.includes(request.ratio)) throw new Error(`Ratio ${request.ratio} is not supported by this model.`);
    const allowedDurations = capabilities.durations || [-1, ...Array.from({ length: 12 }, (_, index) => index + 4)];
    if (!allowedDurations.includes(request.durationSeconds)) throw new Error(`Duration ${request.durationSeconds} seconds is not supported by this model.`);
    if (request.durationSeconds !== -1 && (!Number.isInteger(request.durationSeconds) || request.durationSeconds < 4 || request.durationSeconds > 15)) throw new Error("Seedance 2.0 duration must be 4–15 seconds, or smart duration (-1).");
    if (request.generateAudio && capabilities.generateAudio === false) throw new Error("Audio generation is not supported by this model.");
    if (request.watermark && capabilities.watermark === false) throw new Error("Watermark settings are not supported by this model.");
    if (request.returnLastFrame && capabilities.returnLastFrame === false) throw new Error("Returning the last frame is not supported by this model.");
    const images = request.references.filter((media) => media.kind === "image");
    const videos = request.references.filter((media) => media.kind === "video");
    const audios = request.references.filter((media) => media.kind === "audio");
    if (request.mode === "text_to_video" && request.references.length) throw new Error("Text-to-video does not accept references. Choose omni-reference mode to use media.");
    if (request.mode === "first_frame" && (images.length !== 1 || images[0].role !== "first_frame" || videos.length + audios.length > 0)) throw new Error("First-frame mode requires exactly one first-frame image.");
    if (request.mode === "first_last_frame" && (images.length !== 2 || !images.some((image) => image.role === "first_frame") || !images.some((image) => image.role === "last_frame") || videos.length + audios.length > 0)) throw new Error("First/last-frame mode requires exactly one first-frame and one last-frame image, with no other references.");
    const expectedRole = { image: "reference_image", video: "reference_video", audio: "reference_audio" } as const;
    if (request.mode === "omni_reference" && request.references.some((media) => media.role !== expectedRole[media.kind])) throw new Error("Omni-reference inputs must use the matching reference image, video, or audio role.");
    if (request.mode === "omni_reference" && !request.references.length) throw new Error("Omni-reference mode requires at least one reference file.");
    if (request.mode !== "omni_reference" && request.mode !== "text_to_video" && request.references.some((media) => media.role !== "first_frame" && media.role !== "last_frame")) throw new Error("Frame modes cannot be mixed with omni-reference media.");
    if (images.length > 9) throw new Error("Seedance 2.0 supports up to 9 reference images.");
    if (videos.length > 3) throw new Error("Seedance 2.0 supports up to 3 reference videos.");
    if (audios.length > 3) throw new Error("Seedance 2.0 supports up to 3 reference audio files.");
    if (audios.length && !images.length && !videos.length) throw new Error("Seedance 2.0 audio references require at least one image or video.");
    for (const media of [...videos, ...audios]) {
        if (!media.durationMs || media.durationMs < 2_000 || media.durationMs > 15_000) throw new Error(`${media.kind} reference duration must be between 2 and 15 seconds.`);
    }
    if (sumDuration(videos) > 15_000) throw new Error("Reference videos may total no more than 15 seconds.");
    if (sumDuration(audios) > 15_000) throw new Error("Reference audio may total no more than 15 seconds.");
    for (const image of images) { assertMedia(image, 30 * 1024 * 1024 - 1, ["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff", "image/gif", "image/heic", "image/heif"]); assertDimensions(image, "image"); }
    for (const video of videos) { assertMedia(video, 200 * 1024 * 1024, ["video/mp4", "video/quicktime"]); assertDimensions(video, "video"); }
    for (const audio of audios) assertMedia(audio, 15 * 1024 * 1024, ["audio/mpeg", "audio/wav", "audio/x-wav"]);
}

export function buildSeedanceContent(prompt: string, references: Array<VideoInputMedia & { url: string }>): ArkContentItem[] {
    return [{ type: "text", text: prompt }, ...references.map((media) => {
        if (media.kind === "image") return { type: "image_url" as const, image_url: { url: media.url }, role: media.role || "reference_image" };
        if (media.kind === "video") return { type: "video_url" as const, video_url: { url: media.url }, role: media.role || "reference_video" };
        return { type: "audio_url" as const, audio_url: { url: media.url }, role: media.role || "reference_audio" };
    })];
}

function assertMedia(media: VideoInputMedia, limit: number, types: string[]) {
    if (media.bytes !== undefined && media.bytes > limit) throw new Error(`${media.kind} reference exceeds the supported file size.`);
    if (media.mimeType && !types.includes(media.mimeType.toLowerCase())) throw new Error(`Unsupported ${media.kind} format: ${media.mimeType}.`);
}

function sumDuration(items: VideoInputMedia[]) {
    return items.reduce((sum, media) => sum + (media.durationMs || 0), 0);
}

function assertDimensions(media: VideoInputMedia, kind: "image" | "video") {
    if (media.url?.startsWith("asset://")) return;
    if (!media.width || !media.height) throw new Error(`${kind} reference dimensions could not be verified. Reimport the file and try again.`);
    if (media.width < 300 || media.width > 6000 || media.height < 300 || media.height > 6000) throw new Error(`${kind} reference width and height must each be between 300 and 6000 pixels.`);
    const ratio = media.width / media.height;
    if (ratio < 0.4 || ratio > 2.5) throw new Error(`${kind} reference aspect ratio must be between 0.4 and 2.5.`);
    if (kind === "video") {
        const pixels = media.width * media.height;
        if (pixels < 407_696 || pixels > 8_295_044) throw new Error("Video reference resolution is outside the Seedance 2.0 supported pixel range.");
    }
}
