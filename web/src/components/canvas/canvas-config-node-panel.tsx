import type { CSSProperties } from "react";
import { Image as ImageIcon, LoaderCircle, MessageSquare, Music2, Play, Settings2, Square, Video } from "lucide-react";
import { Button, Segmented, Select } from "antd";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, resolveModelChannel, resolveModelForCapability, resolveModelScript, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { resolveSeedanceInputAssignments } from "@/lib/canvas/seedance-input-assignments";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata, CanvasVideoReference } from "@/types/canvas";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number };
    videoInputs: NodeGenerationInput[];
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string) => void;
    onStop: (nodeId: string) => void;
    onComposerToggle: () => void;
};

export function CanvasConfigNodePanel({ node, isRunning, inputSummary, videoInputs, onConfigChange, onGenerate, onStop, onComposerToggle }: CanvasConfigNodePanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = node.metadata?.generationMode || "image";
    const config = buildNodeConfig(globalConfig, node, mode);
    const chipStyle = { background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text };
    const hasAnyInput = Boolean(inputSummary.textCount || inputSummary.imageCount || inputSummary.videoCount || inputSummary.audioCount);
    const hasComposerContent = Boolean((node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim());
    const canGenerate = hasComposerContent || (mode === "audio" ? inputSummary.textCount > 0 : hasAnyInput);
    const arkVideo = mode === "video" && resolveModelChannel(config, config.model)?.apiFormat === "volcengine_ark" && !resolveModelScript(config, config.model);
    const mediaInputs = videoInputs.filter((input) => input.type === "image" || input.type === "video" || input.type === "audio");
    const mediaReferences = mediaInputs.map((input) => ({ id: input.nodeId, kind: input.type as CanvasVideoReference["kind"] }));
    const orderedAssignments = resolveSeedanceInputAssignments(config.videoMode || "text_to_video", mediaReferences, node.metadata?.videoReferences);
    const assignedById = new Map(orderedAssignments.map((item) => [item.id, item]));
    const setRole = (id: string, role: CanvasVideoReference["role"] | undefined) => {
        onConfigChange(node.id, { videoReferences: orderedAssignments.map((item) => item.id === id ? { ...item, role } : item) });
    };
    const moveRole = (id: string, delta: number) => {
        const current = [...orderedAssignments];
        const index = current.findIndex((item) => item.id === id);
        const nextIndex = Math.max(0, Math.min(current.length - 1, index + delta));
        if (index < 0 || index === nextIndex) return;
        const [item] = current.splice(index, 1);
        current.splice(nextIndex, 0, item);
        onConfigChange(node.id, { videoReferences: current });
    };

    return (
        <div className="flex h-full min-h-0 w-full cursor-move flex-col overflow-y-auto overscroll-contain px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="shrink-0 text-sm font-semibold">{t("canvas.configNode.title")}</div>
                <div className="cursor-default" onMouseDown={(event) => event.stopPropagation()}>
                    <Segmented
                        size="small"
                        className="canvas-config-mode !rounded-md !p-0.5"
                        value={mode}
                        onChange={(value) => onConfigChange(node.id, { generationMode: value as CanvasGenerationMode })}
                        options={[
                            {
                                value: "image",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <ImageIcon className="size-3.5" />
                                        {t("canvas.configNode.image")}
                                    </span>
                                ),
                            },
                            {
                                value: "text",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <MessageSquare className="size-3.5" />
                                        {t("canvas.configNode.text")}
                                    </span>
                                ),
                            },
                            {
                                value: "video",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Video className="size-3.5" />
                                        {t("canvas.configNode.video")}
                                    </span>
                                ),
                            },
                            {
                                value: "audio",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Music2 className="size-3.5" />
                                        {t("canvas.configNode.audio")}
                                    </span>
                                ),
                            },
                        ]}
                    />
                </div>
            </div>

            <div className="mb-2 flex flex-wrap gap-1.5">
                <InputChip label={t("canvas.configNode.prompt")} value={t("canvas.configNode.items", { count: inputSummary.textCount })} style={chipStyle} />
                <InputChip label={t("canvas.configNode.references")} value={t("canvas.configNode.images", { count: inputSummary.imageCount })} style={chipStyle} />
                <InputChip label={t("canvas.configNode.videoReferences")} value={t("canvas.configNode.items", { count: inputSummary.videoCount })} style={chipStyle} />
                <InputChip label={t("canvas.configNode.audioReferences")} value={t("canvas.configNode.items", { count: inputSummary.audioCount })} style={chipStyle} />
                <button type="button" className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px]" style={chipStyle} onMouseDown={(event) => event.stopPropagation()} onClick={onComposerToggle}>
                    <Settings2 className="size-3.5" />
                    {t("canvas.configNode.compose")}
                </button>
            </div>

            <div className="mb-2 grid min-w-0 cursor-default grid-cols-[minmax(0,1fr)_148px] items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
                <ModelPicker className="canvas-compact-control h-10" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability={mode} onMissingConfig={() => openConfigDialog(true)} fullWidth />
                {mode === "video" ? (
                    <CanvasVideoSettingsPopover config={config} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                ) : mode === "image" ? (
                    <CanvasImageSettingsPopover config={config} placement="topRight" autoAdjustOverflow={false} buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })} />
                ) : mode === "audio" ? (
                    <CanvasAudioSettingsPopover config={config} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                ) : (
                    <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                )}
            </div>

            {arkVideo ? (
                <div className="mb-2 space-y-2 rounded-lg border p-2" style={{ borderColor: theme.node.stroke }} onMouseDown={(event) => event.stopPropagation()}>
                    <div className="text-[11px] font-medium opacity-75">{t("canvas.configNode.seedanceInputs")}</div>
                    {!mediaInputs.length ? <div className="text-[11px] opacity-60">{t("canvas.configNode.seedanceInputsEmpty")}</div> : orderedAssignments.map((item, index) => {
                        const input = mediaInputs.find((entry) => entry.nodeId === item.id);
                        if (!input) return null;
                        const selection = assignedById.get(item.id);
                        const kind = input.type as CanvasVideoReference["kind"];
                        const roleOptions = config.videoMode === "text_to_video" ? [] : config.videoMode === "first_frame"
                            ? kind === "image" ? [{ value: "first_frame", label: t("canvas.configNode.firstFrame") }] : []
                            : config.videoMode === "first_last_frame"
                              ? kind === "image" ? [{ value: "first_frame", label: t("canvas.configNode.firstFrame") }, { value: "last_frame", label: t("canvas.configNode.lastFrame") }] : []
                              : [{ value: kind === "image" ? "reference_image" : kind === "video" ? "reference_video" : "reference_audio", label: t("canvas.configNode.omniReference") }];
                        return <div key={input.nodeId} className="flex items-center gap-1.5">
                            <span className="min-w-0 flex-1 truncate text-[11px]" title={input.title}>{input.title}</span>
                            <Select size="small" className="w-32" value={selection?.role || "exclude"} options={[{ value: "exclude", label: t("canvas.configNode.excludeInput") }, ...roleOptions]} onChange={(role) => setRole(input.nodeId, role === "exclude" ? undefined : role as CanvasVideoReference["role"])} />
                            <button type="button" aria-label={t("canvas.configNode.moveUp")} disabled={index === 0} className="px-1 disabled:opacity-30" onClick={() => moveRole(input.nodeId, -1)}>↑</button>
                            <button type="button" aria-label={t("canvas.configNode.moveDown")} disabled={index === orderedAssignments.length - 1} className="px-1 disabled:opacity-30" onClick={() => moveRole(input.nodeId, 1)}>↓</button>
                        </div>;
                    })}
                    {config.videoMode === "text_to_video" && mediaInputs.some((input) => !node.metadata?.videoReferences?.some((entry) => entry.id === input.nodeId && !entry.role)) ? <div className="text-[11px] text-amber-600 dark:text-amber-400">{t("canvas.configNode.seedanceTextModeWarning")}</div> : null}
                    <div className="text-[10px] opacity-55">{t("canvas.configNode.seedanceInputsHint")}</div>
                </div>
            ) : null}

            <Button
                type="primary"
                className="sticky bottom-0 mt-auto !h-9 !w-full !shrink-0 !cursor-pointer !rounded-lg"
                danger={isRunning}
                disabled={!isRunning && !canGenerate}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => (isRunning ? onStop(node.id) : onGenerate(node.id))}
            >
                <span className="inline-flex items-center gap-1.5">
                    {isRunning ? (
                        <>
                            <LoaderCircle className="size-4 animate-spin" />
                            <Square className="size-3.5 fill-current" />
                            <span>{t("canvas.configNode.stop")}</span>
                        </>
                    ) : (
                        <>
                            <Play className="size-4" />
                            <span>{t("canvas.configNode.generate")}</span>
                        </>
                    )}
                </span>
            </Button>
        </div>
    );
}

function InputChip({ label, value, style }: { label: string; value: string; style: CSSProperties }) {
    return (
        <div className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]" style={style}>
            <span>{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? globalConfig.background ?? defaultConfig.background,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        videoMode: node.metadata?.videoMode || globalConfig.videoMode || defaultConfig.videoMode,
        videoRatio: node.metadata?.videoRatio || globalConfig.videoRatio || defaultConfig.videoRatio,
        videoReturnLastFrame: node.metadata?.returnLastFrame || globalConfig.videoReturnLastFrame || defaultConfig.videoReturnLastFrame,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoReturnLastFrame") return { returnLastFrame: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}
