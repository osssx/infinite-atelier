import { App, Button, Drawer, Input, Segmented, Select, Space } from "antd";
import { ListPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { seedancePresets } from "@/services/api/video/model-capabilities";
import { defaultBaseUrlForApiFormat, guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";
import {canvasApi,CanvasApiError} from "@/features/backend-sync/canvas-api";

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const [checkingArk, setCheckingArk] = useState(false);
    const [registeringBackend,setRegisteringBackend]=useState(false);
    const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
        { label: "OpenAI", value: "openai" },
        { label: "Gemini", value: "gemini" },
        { label: "Volcengine Ark", value: "volcengine_ark" },
    ];
    const capabilityOptions: Array<{ label: string; value: ModelCapability }> = ["image", "video", "text", "audio"].map((value) => ({ label: t(`config.channelEditor.capabilities.${value}`), value: value as ModelCapability }));

    useEffect(() => {
        if (open && channel) setDraft(channel);
    }, [open, channel]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl = !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl;
        patch({ apiFormat, baseUrl, backendExecution:false });
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
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        if(draft.backendExecution&&draft.apiKey.trim()){
            message.warning("请点击「更新 SQLite 后端密钥」，不要将新密钥保存回浏览器配置");
            return;
        }
        onSave({ ...draft, name: draft.name.trim() || t("config.channels.unnamed"), models: normalizeChannelModels(draft.models) });
        onClose();
    };

    const checkArkConnection = async () => {
        setCheckingArk(true);
        try {
            const response = await fetch("/api/ark/health", {
                headers: {
                    "x-gateway-token": import.meta.env.VITE_MEDIA_GATEWAY_TOKEN || "",
                    "x-ark-base-url": draft.baseUrl,
                    ...(draft.apiKey.trim() ? { Authorization: `Bearer ${draft.apiKey.trim()}` } : {}),
                },
                cache: "no-store",
            });
            const result = (await response.json().catch(() => ({}))) as { error?: string; reachable?: boolean; apiKeySource?: string };
            if (response.ok && result.reachable) {
                message.success(t("config.channelEditor.arkConnectionPassed"));
            } else if (result.error === "ark_auth_failed" || result.error === "ark_key_missing") {
                message.error(t("config.channelEditor.arkConnectionAuthFailed"));
            } else if (response.status === 401 && result.error === "unauthorized") {
                message.error(t("config.channelEditor.arkGatewayAuthFailed"));
            } else {
                message.error(t("config.channelEditor.arkConnectionFailed", { detail: result.error || response.status }));
            }
        } catch (error) {
            message.error(t("config.channelEditor.arkConnectionFailed", { detail: error instanceof Error ? error.message : String(error) }));
        } finally {
            setCheckingArk(false);
        }
    };

    const registerBackendChannel=async()=>{
        if(draft.apiFormat!=="openai"||
          !/^https:\/\/api\.openai\.com(?:\/v1)?\/?$/.test(draft.baseUrl.trim())){
            message.error("SQLite 模型执行仅支持官方 https://api.openai.com 渠道");return;
        }
        if(!draft.apiKey.trim()){message.error("请先填写此渠道的 API Key");return}
        setRegisteringBackend(true);
        try{
            const capabilities=await canvasApi<{autoDispatch:boolean;modelKinds?:string[]}>(
              "/api/v1/execution/capabilities");
            if(!capabilities.autoDispatch||!capabilities.modelKinds?.includes("image"))
              throw Error("请在启动后端前设置 ATELIER_OPENAI_MODELS=1");
            type ChannelView={id:string;provider:string;keyVersion:string|null};
            let existing:ChannelView|null=null;
            try{existing=await canvasApi<ChannelView>("/api/v1/channels/"+encodeURIComponent(draft.id))}
            catch(error){if(!(error instanceof CanvasApiError&&error.status===404))throw error}
            if(existing&&existing.provider!=="openai")throw Error("同名后端渠道不是 OpenAI，请另建渠道");
            if(existing){
                await canvasApi("/api/v1/channels/"+encodeURIComponent(draft.id)+"/credential","PATCH",{
                  apiKey:draft.apiKey,expectedKeyVersion:existing.keyVersion
                });
            }else{
                await canvasApi("/api/v1/channels","POST",{id:draft.id,provider:"openai",
                  displayName:draft.name,apiKey:draft.apiKey});
            }
            // Once vaulted, scrub this channel key from Zustand persistence.
            const enabled={...draft,backendExecution:true,apiKey:""};
            setDraft(enabled);onSave(enabled);
            message.success("已将渠道密钥写入本地后端加密 Vault，并启用 SQLite 模型任务");
        }catch(error){message.error(error instanceof Error?error.message:String(error))}
        finally{setRegisteringBackend(false)}
    };

    return (
        <Drawer
            open={open}
            width={640}
            title={t("config.channelEditor.title")}
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={save}>
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
                {draft.apiFormat === "volcengine_ark" ? <label className="block md:col-span-2">

                </label> : null}
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                    {draft.apiFormat === "volcengine_ark" ? <div className="mt-2 flex flex-wrap items-center gap-2"><Button size="small" loading={checkingArk} onClick={() => void checkArkConnection()}>{t("config.channelEditor.testArkConnection")}</Button><span className="text-xs text-stone-500">{t("config.channelEditor.arkConnectionHint")}</span></div> : null}
                    {draft.apiFormat === "openai" ? <div className="mt-2 space-y-1">
                        <div className="flex flex-wrap gap-2">
                            <Button size="small" loading={registeringBackend}
                                onClick={()=>void registerBackendChannel()}>
                                {draft.backendExecution?"更新 SQLite 后端密钥":"启用 SQLite 后端模型生成"}
                            </Button>
                            {draft.backendExecution?<Button size="small" onClick={()=>{
                                const disabled={...draft,backendExecution:false};
                                setDraft(disabled);onSave(disabled);
                            }}>停用后端生成</Button>:null}
                        </div>
                        <div className="text-xs text-stone-500">
                            仅限官方 OpenAI API；明确点击后将密钥写入本机 DPAPI Vault。
                            注册成功后将清空此渠道的浏览器配置密钥；历史备份与其他渠道仍需单独清理。
                        </div>
                    </div> : null}
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
