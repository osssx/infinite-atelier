import type { SeedanceVideoMode } from "@/stores/use-config-store";

export type VideoMode = SeedanceVideoMode;
export type VideoInputMedia = {
    id: string;
    kind: "image" | "video" | "audio";
    role?: "first_frame" | "last_frame" | "reference_image" | "reference_video" | "reference_audio";
    storageKey?: string;
    url?: string;
    dataUrl?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    width?: number;
    height?: number;
};
export type VideoGenerationRequest = {
    modelOption: string;
    mode: VideoMode;
    prompt: string;
    references: VideoInputMedia[];
    durationSeconds: number | -1;
    resolution: "480p" | "720p" | "1080p" | "4k";
    ratio: "adaptive" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9";
    generateAudio: boolean;
    watermark: boolean;
    returnLastFrame?: boolean;
};
export type VideoTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
