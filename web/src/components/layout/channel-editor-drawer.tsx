import { App, Button, Drawer, Input, Segmented, Select, Space } from "antd";
import { ListPlus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { seedancePresets } from "@/services/api/video/model-capabilities";
import { defaultBaseUrlForApiFormat, guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";
import {saveSqliteModelChannelFromEditor,modelChannelProvider, type VaultChannelView} from "@/features/backend-sync/model-channel-autoroute";
import {canvasApi, CanvasApiError} from "@/features/backend-sync/canvas-api";

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
