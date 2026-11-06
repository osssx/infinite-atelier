import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Maximize2, Square } from "lucide-react";
import { Button, Modal, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, modelMatchesCapability, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import { useNodeMentionReferences } from "./canvas-graph-context";
import { useCanvasTextExecution } from "@/features/backend-sync/canvas-text-execution-visual";
import {useComfyMediaPresetControl} from "@/features/comfy-workflow/comfy-media-preset-control";
import type {CanvasConnection} from "@/types/canvas";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    projectId?: string;
    onConnectReference?: (sourceId: string, targetId: string) => void;
    onDisconnectReference?: (sourceId: string, targetId: string) => void;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
    nodes?:readonly CanvasNodeData[];
    connections?:readonly CanvasConnection[];
};

export function CanvasNodePromptPanel({ node, projectId, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, onImageSettingsOpenChange, modeOverride,nodes=[],connections=[],onConnectReference,onDisconnectReference }: CanvasNodePromptPanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    // Computed here rather than passed in: this panel only mounts for the node whose panel is open,
    // so the references are built for one node instead of for every node on the canvas.
    const mentionReferences = useNodeMentionReferences(node.id);
    const execution = useCanvasTextExecution(node.id);
    const active = isRunning || Boolean(execution);
    const mode = modeOverride ?? defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const [prompt, setPrompt] = useState(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
    const [expanded, setExpanded] = useState(false);
    const [comfyOptions,setComfyOptions]=useState<{value:string;label:string;disabled?:boolean}[]>([]);
    const [comfyValue,setComfyValue]=useState<string>();
    const selectComfyPresetRef=useRef<(value:string)=>void>(()=>{});
    const onComfyPickerOptionsChange=useCallback((options:{value:string;label:string;disabled?:boolean}[],select:(value:string)=>void,activeValue?:string)=>{
        setComfyOptions(current=>current.length===options.length&&current.every((item,index)=>item.value===options[index]?.value&&item.label===options[index]?.label)?current:options);
        selectComfyPresetRef.current=select;
        setComfyValue(current=>current===activeValue?current:activeValue);
    },[]);
    const onModelChange=(model:string)=>{onConfigChange(node.id,{model,comfyMediaPreset:undefined});setComfyValue(undefined);};
    const handleComfyConfigChange=useCallback((patch:Partial<CanvasNodeData["metadata"]>)=>onConfigChange(node.id,{...patch,...(patch?.comfyMediaPreset?{model:undefined}:{})}),[node.id,onConfigChange]);
    const explicitChannelModel=Boolean(node.metadata?.model&&modelMatchesCapability(globalConfig,node.metadata.model,mode));
    const inheritedWorkflow=mode!=="text"&&!explicitChannelModel?globalConfig.comfyWorkflowDefaults?.[mode]:undefined;
    const hasComfyWorkflow=Boolean(node.metadata?.comfyMediaPreset??inheritedWorkflow);
    const comfyMediaControls=useComfyMediaPresetControl({node,nodes,connections,config,theme,
        defaultPreset:inheritedWorkflow,onChange:handleComfyConfigChange,capability:mode,onPickerOptionsChange:onComfyPickerOptionsChange});

    // Restore on node switches and external prompt updates (e.g. BBox apply).
    // Local edits are also committed to metadata, so this agrees with the draft;
    // generation result fields do not participate and cannot reset typed input.
    useEffect(() => {
        setPrompt(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id, node.metadata?.composerContent, node.metadata?.prompt]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (isEditingExistingContent) onConfigChange(node.id, { composerContent: value });
        else onPromptChange(node.id, value);
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || active) return;
        onGenerate(node.id, mode, text);
    };

    const openExpandedEditor = () => {
        setExpanded(true);
    };

    const activeReferences = mentionReferences.filter((reference) => reference.active);

    return (
        <div
            data-canvas-no-zoom
            className="rounded-2xl border p-3 backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <CanvasNodeReferenceBar nodeId={node.id} references={activeReferences} nodes={nodes} onConnect={onConnectReference} onDisconnect={onDisconnectReference} />
            {mode === "text" ? <div className="mb-1 text-[11px] opacity-60">{t("canvas.skillPicker.slashHint")}</div> : null}
            <CanvasPromptChipInput
                value={prompt}
                enableSkills={mode === "text"}
                projectId={projectId}
                references={mentionReferences}
                onChange={updatePrompt}
                onSubmit={submit}
                className="thin-scrollbar h-40 w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
            />

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <Tooltip title={t("canvas.promptPanel.expandEditor")}>
                        <Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<Maximize2 className="size-3.5" />} onClick={openExpandedEditor} aria-label={t("canvas.promptPanel.expandEditor")} />
                    </Tooltip>
                    <CanvasPromptLibrary onSelect={updatePrompt} />
                    {mode === "image" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={onModelChange} capability="image" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" externalOptions={comfyOptions} externalValue={comfyValue} onExternalSelect={value=>selectComfyPresetRef.current(value)}/>
                            {!hasComfyWorkflow?<CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-8 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />:comfyMediaControls.settings}
                        </>
                    ) : mode === "video" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={onModelChange} capability="video" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" externalOptions={comfyOptions} externalValue={comfyValue} onExternalSelect={value=>selectComfyPresetRef.current(value)}/>
                            {!hasComfyWorkflow?<CanvasVideoSettingsPopover config={config} buttonClassName="!h-8 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />:comfyMediaControls.settings}
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={onModelChange} capability="audio" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" externalOptions={comfyOptions} externalValue={comfyValue} onExternalSelect={value=>selectComfyPresetRef.current(value)}/>
                            {!hasComfyWorkflow?<CanvasAudioSettingsPopover config={config} buttonClassName="!h-8 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />:comfyMediaControls.settings}
                        </>
                    ) : (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="text" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasTextSettingsPopover buttonClassName="!h-8 !max-w-[170px] !justify-start !rounded-full !px-3" config={config} count={node.metadata?.textCount || 1} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                        </>
                    )}
                </div>
                <Button
                    type="primary"
                    className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                    danger={active}
                    disabled={Boolean(execution?.stopping) || (!active && !prompt.trim())}
                    onClick={() => (active ? onStop(node.id) : submit())}
                    aria-label={t(active ? "canvas.promptPanel.stopGeneration" : "canvas.promptPanel.generate")}
                >
                    <span className="flex items-center gap-1.5">
                        {active ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                                <span className="text-xs font-medium">{t("canvas.promptPanel.stop")}</span>
                            </>
                        ) : (
                            <ArrowUp className="size-4" />
                        )}
                    </span>
                </Button>
            </div>
            {comfyMediaControls.slots}
            {comfyMediaControls.error?<div role="alert" className="mt-1 max-w-[460px] text-[11px] leading-4 text-amber-700 dark:text-amber-300">{comfyMediaControls.error}</div>:null}
            <Modal title={t("canvas.promptPanel.editorTitle")} open={expanded} centered width={760} footer={null} onCancel={() => setExpanded(false)} destroyOnHidden>
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasNodeReferenceBar nodeId={node.id} references={activeReferences} nodes={nodes} onConnect={onConnectReference} onDisconnect={onDisconnectReference} />
                    <CanvasPromptChipInput
                        value={prompt}
                        enableSkills={mode === "text"}
                        projectId={projectId}
                        references={mentionReferences}
                        onChange={updatePrompt}
                        className="thin-scrollbar h-[52dvh] min-h-80 w-full cursor-text overflow-y-auto rounded-xl border p-4 text-[15px] leading-6 outline-none"
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
                    />
                </div>
            </Modal>
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
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
