import { useEffect, useId, useMemo, useState } from "react";
import { Cpu, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { modelOptionLabel, modelOptionName, resolveModelChannel, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import {modelChannelProvider} from "@/features/backend-sync/model-channel-autoroute";
import {resolveMediaCapabilities,supportedMediaModes,supportedMediaParameters,type MediaModeId,type MediaKind} from "@/services/media-capabilities";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    mediaMode?:MediaModeId;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
    externalOptions?:{value:string;label:string;disabled?:boolean;tags?:string[]}[];
    externalValue?:string;
    onExternalSelect?:(value:string)=>void;
};
const EXTERNAL_MODEL_PREFIX="__atelier_external:";
export function modelSupportsConfiguredMediaMode(config:AiConfig,value:string,mode:MediaModeId,kind:MediaKind):boolean{
    const channel=resolveModelChannel(config,value),model=channel?.models.find(item=>item.name===modelOptionName(value));
    if(!model?.mediaCapabilities)return true;
    const executor={provider:modelChannelProvider(channel,kind)??channel?.apiFormat??"openai",kind,customScript:Boolean(model.script)};
    const resolved=resolveMediaCapabilities(model,{kind,supportedModes:supportedMediaModes(executor),supportedParameters:supportedMediaParameters(executor)});
    return resolved.modes.some(item=>item.id===mode);
}
export function modelPickerSelectValue(channelValue:string,externalValue:string|undefined,externalOptions:{value:string;label:string;disabled?:boolean}[]){
    return externalValue&&externalOptions.some(option=>option.value===externalValue)
        ?EXTERNAL_MODEL_PREFIX+externalValue:channelValue;
}
export function modelPickerSelection(selected:string,externalOptions:{value:string;label:string;disabled?:boolean}[]){
    const external=externalOptions.find(option=>EXTERNAL_MODEL_PREFIX+option.value===selected);
    return external?{kind:"external" as const,value:external.value}:{kind:"channel" as const,value:selected};
}

export function ModelPicker({ config, value, onChange, capability, mediaMode, className, fullWidth = false, placeholder, onMissingConfig,externalOptions=[],externalValue,onExternalSelect }: ModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const options = useMemo(() => Array.from(new Set([...(config.channelMode === "local" && !capability ? [value] : []), ...selectableModelsByCapability(config, capability)].filter((model): model is string => Boolean(model)))), [capability, config, value]);
    const current = value || "";
    const selectedExternal=externalValue?externalOptions.find(option=>option.value===externalValue):undefined;
    const selectedValue=modelPickerSelectValue(current,externalValue,externalOptions);
    const pickerPlaceholder = placeholder || t("settingsPanels.model.select");
    const handleValueChange=(selected:string)=>{
        const selection=modelPickerSelection(selected,externalOptions);
        if(selection.kind==="external")onExternalSelect?.(selection.value);
        else onChange(selection.value);
    };

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    return (
        <Select
            open={open}
            value={selectedValue}
            onOpenChange={(nextOpen) => {
                if (nextOpen && !options.length && config.channelMode === "local") onMissingConfig?.();
                if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(nextOpen);
            }}
            onValueChange={handleValueChange}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={selectedExternal?.label??(current ? modelOptionLabel(config, current) : pickerPlaceholder)}
            >
                {selectedExternal?<Workflow className="size-4 shrink-0 opacity-70" aria-hidden="true"/>:<ModelIcon model={current}/>}
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{selectedExternal?.label??(current ? modelOptionLabel(config, current) : pickerPlaceholder)}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {options.length ? (
                    <SelectGroup>
                    <SelectLabel>渠道模型</SelectLabel>
                    {options.map((model) => (
                        <SelectItem key={model} value={model} disabled={Boolean(mediaMode&&capability&&(capability==="image"||capability==="video"||capability==="audio")&&!modelSupportsConfiguredMediaMode(config,model,mediaMode,capability))} textValue={modelOptionLabel(config, model)}>
                            <ModelLabel config={config} model={model} />{mediaMode&&capability&&(capability==="image"||capability==="video"||capability==="audio")&&!modelSupportsConfiguredMediaMode(config,model,mediaMode,capability)?<span className="ml-2 text-xs text-muted-foreground">· 不支持此模式</span>:null}
                        </SelectItem>
                    ))}
                    </SelectGroup>
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {emptyModelLabel(config, capability)}
                    </SelectItem>
                )}
                {externalOptions.length?<SelectGroup><SelectLabel>ComfyUI 工作流预设</SelectLabel>
                    {externalOptions.map(option=><SelectItem key={option.value} value={EXTERNAL_MODEL_PREFIX+option.value} textValue={option.label} disabled={option.disabled}>
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                            <Workflow className="size-4 shrink-0 opacity-70" aria-hidden="true"/>
                            <span className="truncate">{option.label}</span>
                            {option.tags?.length ? <span className="flex flex-wrap gap-1" aria-label="工作流能力">{option.tags.map(tag => (
                                <span key={tag} className="rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">{tag}</span>
                            ))}</span> : null}
                        </span>
                    </SelectItem>)}
                </SelectGroup>:null}
            </SelectContent>
        </Select>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability ? i18n.t(`settingsPanels.model.capabilities.${capability}`) : "";
    if (capability && config.models.length) return i18n.t("settingsPanels.model.assign", { capability: label });
    return config.models.length ? i18n.t("settingsPanels.model.noMatch", { capability: label }) : i18n.t("settingsPanels.model.addFirst");
}

function ModelLabel({ config, model }: { config: AiConfig; model: string }) {
    const channel = resolveModelChannel(config, model);
    const entry = channel?.models.find(item => item.name === modelOptionName(model));
    const kind = entry?.capability;
    const labels: Record<MediaModeId, string> = {
        text_to_image: "文生图", reference_edit: "参考编辑", inpaint: "局部重绘",
        text_to_video: "文生视频", first_frame: "首帧", last_frame: "尾帧", first_last_frame: "首尾帧", omni_reference: "全能参考",
        text_to_speech: "语音合成", voice_clone: "参考音色", text_to_music: "音乐", text_to_sound: "音效",
    };
    const executor = { provider: modelChannelProvider(channel, kind) ?? channel?.apiFormat ?? "", kind: (kind === "text" || !kind ? "image" : kind), customScript: Boolean(entry?.script) };
    const resolved = kind && kind !== "text" ? resolveMediaCapabilities(entry, {
        kind, supportedModes: supportedMediaModes(executor), supportedParameters: supportedMediaParameters(executor),
    }) : undefined;
    const tags = resolved?.explicit
        ? [...resolved.modes.map(mode => labels[mode.id as MediaModeId]), ...(entry?.mediaCapabilities?.modes.some(mode => mode.layout && resolved.modes.some(active => active.id === mode.id)) ? ["Layout"] : [])]
        : [];
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex min-w-0 items-center gap-2"><ModelIcon model={model} />
                <span className="truncate">{modelOptionLabel(config, model)}</span></span>
            {resolved?.explicit ? <span className="flex flex-wrap gap-1" aria-label="模型能力">
                {(tags.length ? tags : ["暂无可用能力"]).map(tag => (
                    <span key={tag} className="rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">{tag}</span>
                ))}
            </span> : null}
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}
