import type { ChannelModel, ModelChannel, VideoCapabilities } from "@/stores/use-config-store";

export const SEEDANCE_STANDARD = "doubao-seedance-2-0-260128";
export const SEEDANCE_FAST = "doubao-seedance-2-0-fast-260128";
export const SEEDANCE_MINI = "doubao-seedance-2-0-mini-260615";
export const SEEDANCE_RATIOS = ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] as const;

const standard: VideoCapabilities = { resolutions: ["480p", "720p", "1080p", "4k"], durations: [-1, ...Array.from({ length: 12 }, (_, index) => index + 4)], ratios: [...SEEDANCE_RATIOS], generateAudio: true, watermark: true, returnLastFrame: true };
const fast: VideoCapabilities = { ...standard, resolutions: ["480p", "720p"] };
const mini: VideoCapabilities = { ...standard, resolutions: ["480p", "720p"] };

export const seedancePresets: Array<{ name: string; videoPreset: NonNullable<ChannelModel["videoPreset"]>; videoCapabilities: VideoCapabilities }> = [
    { name: SEEDANCE_STANDARD, videoPreset: "seedance-2.0", videoCapabilities: standard },
    { name: SEEDANCE_FAST, videoPreset: "seedance-2.0-fast", videoCapabilities: fast },
    { name: SEEDANCE_MINI, videoPreset: "seedance-2.0-mini", videoCapabilities: mini },
];

export function capabilitiesForModel(channel: ModelChannel, model: ChannelModel): VideoCapabilities | null {
    if (channel.apiFormat !== "volcengine_ark") return null;
    if (model.videoCapabilities) return model.videoCapabilities;
    return seedancePresets.find((preset) => preset.name === model.name)?.videoCapabilities || null;
}

export function isSeedanceModel(channel: ModelChannel, model: ChannelModel) {
    return channel.apiFormat === "volcengine_ark" && Boolean(capabilitiesForModel(channel, model));
}
