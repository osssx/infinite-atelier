import { App, Button, Checkbox, Drawer, Input, InputNumber, Segmented, Select, Space } from "antd";
import { ListPlus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { seedancePresets } from "@/services/api/video/model-capabilities";
import { defaultBaseUrlForApiFormat, guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";
import {saveSqliteModelChannelFromEditor,modelChannelProvider, type VaultChannelView} from "@/features/backend-sync/model-channel-autoroute";
import {canvasApi, CanvasApiError} from "@/features/backend-sync/canvas-api";
import {MEDIA_MODES,supportedMediaModes,supportedMediaParameters,type MediaCapabilities,type MediaInputRule,type MediaKind,type MediaModeId,type MediaParameterSpec} from "@/services/media-capabilities";

type ScriptTarget = { name: string; capability: ModelCapability; value: string };
type VaultKeyStatus =
    | { state: "checking"; channelId: string; expectedProvider: string | null; protocol: ApiCallFormat }
    | { state: "saved"; channelId: string; expectedProvider: string | null; protocol: ApiCallFormat; actualProvider: string }
    | { state: "unconfigured"; channelId: string; expectedProvider: string | null; protocol: ApiCallFormat }
    | { state: "mismatch"; channelId: string; expectedProvider: string | null; protocol: ApiCallFormat; actualProvider: string }
    | { state: "failed"; channelId: string; expectedProvider: string | null; protocol: ApiCallFormat };

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const [checkingArk, setCheckingArk] = useState(false);
    const [savingChannel,setSavingChannel]=useState(false);
    const [vaultKeyStatus, setVaultKeyStatus] = useState<VaultKeyStatus | null>(null);
    const [vaultCheckAttempt, setVaultCheckAttempt] = useState(0);
    const apiKeyWasEdited = useRef(false);
    const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
        { label: "OpenAI", value: "openai" },
        { label: "Gemini", value: "gemini" },
        { label: "Volcengine Ark", value: "volcengine_ark" },
    ];
    const capabilityOptions: Array<{ label: string; value: ModelCapability }> = ["image", "video", "text", "audio"].map((value) => ({ label: t(`config.channelEditor.capabilities.${value}`), value: value as ModelCapability }));
    const mediaModeLabels:Record<MediaModeId,string>={text_to_image:"文生图",reference_edit:"参考编辑",inpaint:"局部重绘",text_to_video:"文生视频",first_frame:"首帧生成",last_frame:"尾帧生成",first_last_frame:"首尾帧生成",omni_reference:"全能参考",text_to_speech:"语音合成",voice_clone:"参考音色合成",text_to_music:"音乐生成",text_to_sound:"音效生成"};

    useEffect(() => {
        if (open && channel) {
            apiKeyWasEdited.current = false;
            setDraft(channel);
        }
    }, [open, channel]);

    const draftProvider = modelChannelProvider(draft);
    useEffect(() => {
        if (!open || !draft) return;
        const channelId = draft.id;
        const expectedProvider = modelChannelProvider(draft);
        const protocol = draft.apiFormat;
        let active = true;
        setVaultKeyStatus({ state: "checking", channelId, expectedProvider, protocol });
        canvasApi<VaultChannelView>("/api/v1/channels/" + encodeURIComponent(channelId))
            .then((record) => {
                if (!active) return;
                if (record.id !== channelId || !expectedProvider || record.provider !== expectedProvider) {
                    setVaultKeyStatus({ state: "mismatch", channelId, expectedProvider, protocol, actualProvider: record.provider });
                } else if (record.hasKey && record.keyVersion) {
                    setVaultKeyStatus({ state: "saved", channelId, expectedProvider, protocol, actualProvider: record.provider });
                    if (!apiKeyWasEdited.current) {
                        setDraft((current) => current?.id === channelId ? { ...current, apiKey: "" } : current);
                    }
                } else {
                    setVaultKeyStatus({ state: "unconfigured", channelId, expectedProvider, protocol });
                }
            })
            .catch((error: unknown) => {
                if (!active) return;
                if (error instanceof CanvasApiError && error.status === 404) {
                    setVaultKeyStatus({ state: "unconfigured", channelId, expectedProvider, protocol });
                } else {
                    setVaultKeyStatus({ state: "failed", channelId, expectedProvider, protocol });
                }
            });
        return () => { active = false; };
    }, [open, draft?.id, draft?.apiFormat, draftProvider, vaultCheckAttempt]);

    const currentVaultStatus = vaultKeyStatus && vaultKeyStatus.channelId === draft?.id &&
        vaultKeyStatus.expectedProvider === draftProvider && vaultKeyStatus.protocol === draft?.apiFormat ? vaultKeyStatus : null;

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl = !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl;
        patch({ apiFormat, baseUrl });
    };

    const applySelection = (names: string[]) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        setModels(names.map((name) => map.get(name) || (draft.apiFormat === "volcengine_ark" ? createArkPresetModel(name) : undefined) || { name, capability: guessCapability(name) }));
    };

    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => (model.name === name ? { ...model, capability } : model)));
    const setVideoPreset = (name: string, preset: string | undefined) => setModels(draft.models.map((model) => {
        if (model.name !== name) return model;
        const selectedPreset = seedancePresets.find((item) => item.videoPreset === preset);
        return { ...model, videoPreset: selectedPreset?.videoPreset, videoCapabilities: selectedPreset?.videoCapabilities };
    }));
    const toggleMediaMode=(model:ChannelModel,modeId:MediaModeId,enabled:boolean)=>{
        const kind=model.capability as MediaKind;
        const existing=model.mediaCapabilities?.kind===kind?model.mediaCapabilities:undefined;
        const defaultInputs:Partial<Record<MediaModeId,Array<{role:"reference_image"|"source_image"|"mask"|"first_frame"|"last_frame"|"reference_video"|"reference_audio"|"voice_reference";kind:"image"|"video"|"audio"|"mask";minItems:number;maxItems:number}>>>={
            reference_edit:[{role:"reference_image",kind:"image",minItems:1,maxItems:4}],inpaint:[{role:"source_image",kind:"image",minItems:1,maxItems:1},{role:"mask",kind:"mask",minItems:1,maxItems:1}],
            first_frame:[{role:"first_frame",kind:"image",minItems:1,maxItems:1}],last_frame:[{role:"last_frame",kind:"image",minItems:1,maxItems:1}],
            first_last_frame:[{role:"first_frame",kind:"image",minItems:1,maxItems:1},{role:"last_frame",kind:"image",minItems:1,maxItems:1}],
            omni_reference:[{role:"reference_image",kind:"image",minItems:0,maxItems:9},{role:"reference_video",kind:"video",minItems:0,maxItems:3},{role:"reference_audio",kind:"audio",minItems:0,maxItems:3}],
            voice_clone:[{role:"voice_reference",kind:"audio",minItems:1,maxItems:1}]};
        const modes=existing?.modes??MEDIA_MODES[kind].map(id=>({id,enabled:false,inputs:defaultInputs[id]??[],parameters:[]}));
        const nextModes=modes.map(mode=>mode.id===modeId?{...mode,enabled}:mode);
        const nextDefault=existing?.defaultMode&&nextModes.some(mode=>mode.id===existing.defaultMode&&mode.enabled)?existing.defaultMode:enabled?modeId:nextModes.find(mode=>mode.enabled)?.id;
        const next:MediaCapabilities={schemaVersion:1,kind,modes:nextModes,...(nextDefault?{defaultMode:nextDefault}:{})};
        setModels(draft.models.map(item=>item.name===model.name?{...item,mediaCapabilities:next}:item));
    };
    const updateMediaMode=(model:ChannelModel,modeId:MediaModeId,update:(mode:MediaCapabilities["modes"][number])=>MediaCapabilities["modes"][number])=>setModels(draft.models.map(item=>{
        if(item.name!==model.name||!item.mediaCapabilities)return item;
        return {...item,mediaCapabilities:{...item.mediaCapabilities,modes:item.mediaCapabilities.modes.map(mode=>mode.id===modeId?update(mode):mode)}};
    }));
    const parameterChoices=(model:ChannelModel)=>supportedMediaParameters({provider:draft.apiFormat,kind:model.capability as MediaKind,customScript:Boolean(model.script)});
    const addMediaParameter=(model:ChannelModel,modeId:MediaModeId,id:string)=>{
        const type:MediaParameterSpec["type"]=id==="generate_audio"||id==="watermark"||id==="return_last_frame"||id==="transparent_background"?"boolean":
            ["aspect_ratio","resolution","voice","output_format"].includes(id)?"enum":
            ["negative_prompt","instructions"].includes(id)?"string":"number";
        const values:MediaParameterSpec["values"]=type==="enum"?(id==="resolution"?["480p","720p","1080p"]:id==="aspect_ratio"?["16:9","9:16","1:1","4:3","3:4","21:9"]:id==="voice"?["alloy","echo","fable","onyx","nova","shimmer"]:["mp3","wav","flac"]):undefined;
        const numericDefault=id==="duration_seconds"?6:id==="speed"?1:id==="count"?1:id==="width"||id==="height"?1024:0;
        const spec:MediaParameterSpec={id,mode:"adjustable",type,...(type==="number"?{defaultValue:numericDefault}:type==="boolean"?{defaultValue:false}:values?{values,defaultValue:values[0]}:{defaultValue:""})};
        updateMediaMode(model,modeId,mode=>({...mode,parameters:[...mode.parameters.filter(item=>item.id!==id),spec]}));
    };
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = async () => {
        if(savingChannel)return;
        setSavingChannel(true);
        try {
            let updated={...draft,name:draft.name.trim()||t("config.channels.unnamed"),
                models:normalizeChannelModels(draft.models)};
            const provider=modelChannelProvider(updated);
            // Vault-backed channels are saved to the encrypted backend Vault.
            if(provider&&updated.apiKey.trim()){
                updated=await saveSqliteModelChannelFromEditor(updated,channel,provider);
            } else if (provider && currentVaultStatus?.state === "saved") {
                // An empty key leaves the existing vault version intact.
                updated=await saveSqliteModelChannelFromEditor(updated,channel,provider);
            }
            setDraft(updated);
            onSave(updated);
            onClose();
        }catch(error){message.error(error instanceof Error?error.message:String(error))}
        finally{setSavingChannel(false)}
    };

    const checkArkConnection = async () => {
        setCheckingArk(true);
        try {
            if(modelChannelProvider(draft)!=="volcengine_ark") {
                message.warning(t("config.channelEditor.arkConnectionUnsupported"));
                return;
            }
            if(!channel || channel.id!==draft.id || draft.apiKey.trim() || channel.baseUrl!==draft.baseUrl || currentVaultStatus?.state !== "saved") {
                message.warning(t("config.channelEditor.arkSaveBeforeTest"));
                return;
            }
            const result=await canvasApi<{reachable:boolean;authenticated:boolean;reason?:string}>(
                "/api/v1/channels/"+encodeURIComponent(draft.id)+"/health"
            );
            if(result.reachable&&result.authenticated)
                message.success(t("config.channelEditor.arkConnectionPassed"));
            else if(result.reason==="ark_auth_failed")
                message.error(t("config.channelEditor.arkConnectionAuthFailed"));
            else message.error(t("config.channelEditor.arkConnectionFailed", {detail:result.reason||"unavailable"}));
        } catch (error) {
            message.error(t("config.channelEditor.arkConnectionFailed", { detail: error instanceof Error ? error.message : String(error) }));
        } finally {
            setCheckingArk(false);
        }
    };

    return (
        <Drawer
            open={open}
            size={640}
            title={t("config.channelEditor.title")}
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" loading={savingChannel} onClick={() => void save()}>
                        {t("common.save")}
                    </Button>
                </Space>
            }
        >
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.name")}</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.protocol")}</span>
                    <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.baseUrl")}</span>
                    <Input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com" />
                    {draft.apiFormat === "volcengine_ark" ? <span className="mt-1 block text-xs text-stone-500">{t("config.channelEditor.arkProtocolHint")}</span> : null}
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => { apiKeyWasEdited.current = true; patch({ apiKey: event.target.value }); }} placeholder={currentVaultStatus?.state === "saved" ? "" : t("config.channelEditor.apiKeyPlaceholder")} />
                    <div className={`mt-2 text-xs ${currentVaultStatus?.state === "saved" ? "text-emerald-700 dark:text-emerald-400" : currentVaultStatus?.state === "mismatch" ? "text-amber-700 dark:text-amber-400" : "text-stone-500"}`}>
                        {draft.apiKey.trim()
                            ? t(currentVaultStatus?.state === "saved" ? "config.channelEditor.apiKeyPendingReplace" : "config.channelEditor.apiKeyPendingSave")
                            : currentVaultStatus?.state === "checking" ? t("config.channelEditor.apiKeyChecking")
                            : currentVaultStatus?.state === "saved" ? t("config.channelEditor.apiKeySaved")
                            : currentVaultStatus?.state === "mismatch" ? t("config.channelEditor.apiKeyProviderMismatch", { provider: t(`config.channelEditor.vaultProviderNames.${currentVaultStatus.actualProvider}`, { defaultValue: t("config.channelEditor.vaultProviderNames.unknown") }) })
                            : currentVaultStatus?.state === "failed" ? <span className="inline-flex items-center gap-2">{t("config.channelEditor.apiKeyCheckFailed")}<Button size="small" type="link" className="h-auto p-0" icon={<RotateCw className="size-3" />} onClick={() => setVaultCheckAttempt((value) => value + 1)}>{t("config.channelEditor.retryKeyCheck")}</Button></span>
                            : t("config.channelEditor.apiKeyUnconfigured")}
                    </div>
                    {draft.apiKey.trim() && currentVaultStatus?.state === "mismatch" ? <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t("config.channelEditor.apiKeyProviderMismatch", { provider: t(`config.channelEditor.vaultProviderNames.${currentVaultStatus.actualProvider}`, { defaultValue: t("config.channelEditor.vaultProviderNames.unknown") }) })}</div> : null}
                    {draft.apiKey.trim() && currentVaultStatus?.state === "failed" ? <div className="mt-1 inline-flex items-center gap-2 text-xs text-stone-500">{t("config.channelEditor.apiKeyCheckFailed")}<Button size="small" type="link" className="h-auto p-0" icon={<RotateCw className="size-3" />} onClick={() => setVaultCheckAttempt((value) => value + 1)}>{t("config.channelEditor.retryKeyCheck")}</Button></div> : null}
                    {draft.apiFormat === "volcengine_ark" ? <div className="mt-2 flex flex-wrap items-center gap-2"><Button size="small" loading={checkingArk} onClick={() => void checkArkConnection()}>{t("config.channelEditor.testArkConnection")}</Button><span className="text-xs text-stone-500">{t("config.channelEditor.arkConnectionHint")}</span></div> : null}
                </label>
            </div>

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">{t("config.channelEditor.models")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t("config.channelEditor.modelDescription", { count: draft.models.length })}</div>
                </div>
                <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                    {t("config.channelEditor.selectModels")}
                </Button>
            </div>

            <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((model) => (
                        <div key={model.name} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900/40">
                            <span className="min-w-0 flex-1 truncate text-sm" title={model.name}>
                                {model.name}
                            </span>
                            <div className="flex shrink-0 items-center gap-2">
                                <Segmented size="small" value={model.capability} options={capabilityOptions} onChange={(value) => setCapability(model.name, value as ModelCapability)} />
                                {draft.apiFormat === "volcengine_ark" && model.capability === "video" ? <Select size="small" className="w-36" value={model.videoPreset} placeholder={t("config.channelEditor.seedancePreset")} options={seedancePresets.map((preset) => ({ value: preset.videoPreset, label: t(`config.channelEditor.presets.${preset.videoPreset}`) }))} onChange={(value) => setVideoPreset(model.name, value)} allowClear /> : null}
                                <Button size="small" type={model.script ? "primary" : "default"} ghost={Boolean(model.script)} onClick={() => setScriptTarget({ name: model.name, capability: model.capability, value: model.script || "" })}>
                                    {t(model.script ? "config.channelEditor.scriptReady" : "config.channelEditor.script")}
                                </Button>
                                <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                            </div>
                            {model.capability!=="text"?<div className="basis-full border-t border-stone-100 pt-2 dark:border-stone-800">
                                <div className="mb-1 text-[11px] font-medium text-stone-500">媒体能力（显式配置；旧模型维持兼容行为）</div>
                                <div className="flex flex-wrap gap-x-3 gap-y-1">{MEDIA_MODES[model.capability as MediaKind].map(mode=>{
                                    const isConfigured=model.mediaCapabilities?.kind===model.capability;
                                    const enabled=isConfigured?!!model.mediaCapabilities?.modes.find(item=>item.id===mode)?.enabled:false;
                                    const supported=supportedMediaModes({provider:draft.apiFormat,kind:model.capability as MediaKind,customScript:Boolean(model.script)}).includes(mode);
                                    const whyUnsupported=!supported?(draft.apiFormat==="volcengine_ark"&&model.capability==="video"?"Ark 执行器仅支持文生视频、首帧、首尾帧和多模态参考，时长 4–15 秒，分辨率最高 1080p。":"当前执行器没有此模式的请求映射。"):undefined;
                                    return <span key={mode} title={whyUnsupported}><Checkbox disabled={!supported} checked={enabled} onChange={event=>toggleMediaMode(model,mode,event.target.checked)}><span className="text-xs">{mediaModeLabels[mode]}{!supported?"（不可用）":""}</span></Checkbox></span>;
                                })}</div>
                                {model.mediaCapabilities?.kind===model.capability?<>
                                 <label className="mt-2 flex items-center gap-2 text-[11px] text-stone-500">默认模式<Select size="small" className="w-40" allowClear value={model.mediaCapabilities.defaultMode}
                                  options={model.mediaCapabilities.modes.filter(item=>item.enabled).map(item=>({value:item.id,label:mediaModeLabels[item.id]}))}
                                  onChange={(value:MediaModeId|undefined)=>setModels(draft.models.map(item=>item.name===model.name?{...item,mediaCapabilities:{...model.mediaCapabilities!,...(value?{defaultMode:value}: {defaultMode:undefined})}}:item))}/></label>
                                 {model.mediaCapabilities.modes.filter(item=>item.enabled).map(mediaMode=><div key={mediaMode.id} className="mt-2 rounded border border-stone-200 p-2 dark:border-stone-700">
                                  <div className="mb-1 text-[11px] font-medium">{mediaModeLabels[mediaMode.id]} · 输入数量</div>
                                  {model.capability==="image"&&(mediaMode.id==="text_to_image"||mediaMode.id==="reference_edit")?<Checkbox checked={Boolean(mediaMode.layout)} onChange={event=>updateMediaMode(model,mediaMode.id,current=>{
                                   if(event.target.checked)return {...current,layout:{format:"atelier_bbox_json_v1",delivery:"prompt_json"}};
                                   const {layout:_layout,...withoutLayout}=current;return withoutLayout;
                                  })}><span className="text-[10px]">支持显式 BBox Layout（作为完整结构化提示词）</span></Checkbox>:null}
                                  {mediaMode.inputs.map((rule:MediaInputRule)=><div key={rule.role} className="flex flex-wrap items-center gap-2 py-1 text-[10px]">
                                   <span className="min-w-28">{rule.role}（{rule.kind}）</span><span>最少</span><InputNumber size="small" min={0} max={16} value={rule.minItems} className="w-16"
                                    onChange={value=>updateMediaMode(model,mediaMode.id,current=>({...current,inputs:current.inputs.map(input=>input.role===rule.role?{...input,minItems:Number(value??0),maxItems:Math.max(Number(value??0),input.maxItems)}:input)}))}/>
                                   <span>最多</span><InputNumber size="small" min={rule.minItems} max={16} value={rule.maxItems} className="w-16"
                                    onChange={value=>updateMediaMode(model,mediaMode.id,current=>({...current,inputs:current.inputs.map(input=>input.role===rule.role?{...input,maxItems:Number(value??input.minItems)}:input)}))}/>
                                  </div>)}
                                  <div className="mt-1 flex items-center gap-2"><span className="text-[10px]">参数</span><Select size="small" className="w-48" placeholder="添加可配置参数" value={undefined}
                                   options={parameterChoices(model).filter(id=>!mediaMode.parameters.some(parameter=>parameter.id===id)).map(id=>({value:id,label:id}))}
                                   onChange={(id:string)=>addMediaParameter(model,mediaMode.id,id)}/></div>
                                  {mediaMode.parameters.map(parameter=><div key={parameter.id} className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
                                   <span className="w-28">{parameter.id}</span><Select size="small" className="w-24" value={parameter.mode} options={[{value:"adjustable",label:"可调"},{value:"fixed",label:"固定"}]}
                                   onChange={(value:"adjustable"|"fixed")=>updateMediaMode(model,mediaMode.id,current=>({...current,parameters:current.parameters.map(item=>{if(item.id!==parameter.id)return item;const {fixedValue,...rest}=item;return value==="fixed"?{...rest,mode:value,fixedValue:item.defaultValue??(item.type==="number"?0:item.type==="boolean"?false:item.values?.[0]??"")}:rest.mode==="fixed"?{...rest,mode:value}: {...rest,mode:value};})}))}/>
                                   {parameter.type==="number"?<><InputNumber size="small" placeholder="默认" value={typeof parameter.defaultValue==="number"?parameter.defaultValue:undefined} className="w-20" onChange={value=>updateMediaMode(model,mediaMode.id,current=>({...current,parameters:current.parameters.map(item=>item.id===parameter.id?{...item,defaultValue:value??undefined,...(item.mode==="fixed"?{fixedValue:value??undefined}:{})}:item)}))}/><InputNumber size="small" placeholder="最小" value={parameter.min} className="w-20" onChange={value=>updateMediaMode(model,mediaMode.id,current=>({...current,parameters:current.parameters.map(item=>item.id===parameter.id?{...item,min:value??undefined}:item)}))}/><InputNumber size="small" placeholder="最大" value={parameter.max} className="w-20" onChange={value=>updateMediaMode(model,mediaMode.id,current=>({...current,parameters:current.parameters.map(item=>item.id===parameter.id?{...item,max:value??undefined}:item)}))}/><InputNumber size="small" placeholder="步长" value={parameter.step} className="w-20" onChange={value=>updateMediaMode(model,mediaMode.id,current=>({...current,parameters:current.parameters.map(item=>item.id===parameter.id?{...item,step:value??undefined}:item)}))}/></>:
                                    parameter.type==="boolean"?<Checkbox checked={Boolean(parameter.defaultValue)} onChange={event=>updateMediaMode(model,mediaMode.id,current=>({...current,parameters:current.parameters.map(item=>item.id===parameter.id?{...item,defaultValue:event.target.checked,...(item.mode==="fixed"?{fixedValue:event.target.checked}:{})}:item)}))}>默认值</Checkbox>:
                                    parameter.type==="enum"?<Input size="small" className="w-44" value={(parameter.values??[]).join(",")} placeholder="允许值，以逗号分隔" onChange={event=>updateMediaMode(model,mediaMode.id,current=>({...current,parameters:current.parameters.map(item=>{if(item.id!==parameter.id)return item;const values=event.target.value.split(",").map(value=>value.trim()).filter(Boolean);const nextValue=values.includes(String(item.defaultValue))?item.defaultValue:values[0];return {...item,values,defaultValue:nextValue,...(item.mode==="fixed"?{fixedValue:nextValue}:{})};})}))}/>:
                                    <Input size="small" className="w-36" value={typeof parameter.defaultValue==="string"?parameter.defaultValue:""} placeholder="默认值" onChange={event=>updateMediaMode(model,mediaMode.id,current=>({...current,parameters:current.parameters.map(item=>item.id===parameter.id?{...item,defaultValue:event.target.value,...(item.mode==="fixed"?{fixedValue:event.target.value}:{})}:item)}))}/>}
                                   <Button size="small" type="link" danger className="h-auto p-0 text-[10px]" onClick={()=>updateMediaMode(model,mediaMode.id,current=>({...current,parameters:current.parameters.filter(item=>item.id!==parameter.id)}))}>删除</Button>
                                  </div>)}
                                 </div>)}
                                 <div className="mt-1 text-[10px] text-stone-400">schema v1 · {model.mediaCapabilities.modes.filter(mode=>mode.enabled).length} 个已启用模式</div>
                                 <Button size="small" type="link" className="h-auto p-0 text-[10px]" onClick={()=>setModels(draft.models.map(item=>item.name===model.name?{...item,mediaCapabilities:undefined}:item))}>恢复兼容配置</Button>
                                </>:null}
                            </div>:null}
                        </div>
                    ))
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-stone-500">{t("config.channelEditor.empty")}</div>
                )}
            </div>

            <ModelSelectModal open={selectOpen} channel={draft} selectedNames={draft.models.map((model) => model.name)} onConfirm={applySelection} onClose={() => setSelectOpen(false)} />

            <ModelScriptEditor
                open={Boolean(scriptTarget)}
                capability={scriptTarget?.capability || "text"}
                apiFormat={draft.apiFormat}
                modelName={scriptTarget?.name || ""}
                value={scriptTarget?.value || ""}
                onSave={(script) => scriptTarget && setScript(scriptTarget.name, script)}
                onClose={() => setScriptTarget(null)}
            />
        </Drawer>
    );
}

function createArkPresetModel(name: string): ChannelModel | undefined {
    const preset = seedancePresets.find((item) => item.name === name);
    return preset ? { name, capability: "video", videoPreset: preset.videoPreset, videoCapabilities: preset.videoCapabilities } : undefined;
}
