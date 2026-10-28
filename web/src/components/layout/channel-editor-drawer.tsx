import { App, Button, Drawer, Input, Segmented, Select, Space } from "antd";
import { ListPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { seedancePresets } from "@/services/api/video/model-capabilities";
import { defaultBaseUrlForApiFormat, guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";
import {saveSqliteModelChannelFromEditor,modelChannelProvider} from "@/features/backend-sync/model-channel-autoroute";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {isVaultOnlyChannel,redactConfirmedVaultKey} from "@/features/backend-sync/model-config-persistence";

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const [checkingArk, setCheckingArk] = useState(false);
    const [savingChannel,setSavingChannel]=useState(false);
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
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = async () => {
        if(savingChannel)return;
        setSavingChannel(true);
        try {
            let updated={...draft,name:draft.name.trim()||t("config.channels.unnamed"),
                models:normalizeChannelModels(draft.models)};
            const provider=modelChannelProvider(updated);
            // A successful Vault save must precede any local key redaction.
            // Mixed browser-script/video channels retain the browser credential.
            if(provider&&updated.apiKey.trim()){
                const key=updated.apiKey;
                const vaulted=await saveSqliteModelChannelFromEditor(updated,channel,provider);
                if(isVaultOnlyChannel(updated)){
                    redactConfirmedVaultKey(updated);
                    updated=vaulted;
                }else updated={...vaulted,apiKey:key};
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
                message.warning("当前连通性检查仅支持官方方舟 API 地址");
                return;
            }
            if(!channel || channel.apiKey!==draft.apiKey || channel.baseUrl!==draft.baseUrl) {
                message.warning("请先保存渠道及 API Key，再测试连接");
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
            width={640}
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
                {draft.apiFormat === "volcengine_ark" ? <label className="block md:col-span-2">

                </label> : null}
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                    {draft.apiFormat === "volcengine_ark" ? <div className="mt-2 flex flex-wrap items-center gap-2"><Button size="small" loading={checkingArk} onClick={() => void checkArkConnection()}>{t("config.channelEditor.testArkConnection")}</Button><span className="text-xs text-stone-500">{t("config.channelEditor.arkConnectionHint")}</span></div> : null}
                    {modelChannelProvider(draft) ? <div className="mt-2 text-xs text-stone-500">
                        {modelChannelProvider(draft)==="openai_compatible"
                            ? "自定义 OpenAI 兼容渠道直接使用填写的 HTTP(S) API 地址，无需配置白名单。生成在本地后端执行，密钥保存在加密 Vault；远程 HTTP 明文连接请注意风险。"
                            : "本地模型执行默认启用。保存时自动将填写的密钥写入本机加密 Vault。"}
                        {isVaultOnlyChannel(draft)
                            ? "此渠道的模型执行与模型列表读取均使用后端 Vault；保存成功后自动清除浏览器中相同渠道的明文密钥。"
                            : "此渠道可能包含旧视频或自定义脚本等浏览器直连功能，因此暂时保留其浏览器密钥。"}
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
