import { App, Button, Drawer, Input, Segmented, Select, Space } from "antd";
import { ListPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { localRouterCapabilities, seedancePresets } from "@/services/api/video/model-capabilities";
import { defaultBaseUrlForApiFormat, guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const [checkingArk, setCheckingArk] = useState(false);
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
        setModels(names.map((name) => map.get(name) || (draft.apiFormat === "volcengine_ark" ? createArkPresetModel(name, draft.seedanceAdapter === "router_local") : undefined) || { name, capability: guessCapability(name) }));
    };

    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => (model.name === name ? { ...model, capability } : model)));
    const setVideoPreset = (name: string, preset: string | undefined) => setModels(draft.models.map((model) => {
        if (model.name !== name) return model;
        const selectedPreset = seedancePresets.find((item) => item.videoPreset === preset && (draft.seedanceAdapter !== "router_local" || item.videoPreset === "seedance-2.0"));
        return { ...model, videoPreset: selectedPreset?.videoPreset, videoCapabilities: draft.seedanceAdapter === "router_local" ? (selectedPreset ? localRouterCapabilities : undefined) : selectedPreset?.videoCapabilities };
    }));
    const changeSeedanceAdapter = (seedanceAdapter: "ark_official" | "router_local") => {
        patch({
            seedanceAdapter,
            models: draft.models.map((model) => {
                if (seedanceAdapter === "router_local") {
                    if (model.videoPreset === "seedance-2.0-fast" || model.videoPreset === "seedance-2.0-mini") return { ...model, videoPreset: undefined, videoCapabilities: undefined };
                    if (model.videoPreset === "seedance-2.0") return { ...model, videoCapabilities: localRouterCapabilities };
                    return model;
                }
                const preset = seedancePresets.find((item) => item.videoPreset === model.videoPreset);
                return preset ? { ...model, videoCapabilities: preset.videoCapabilities } : model;
            }),
        });
    };
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        onSave({ ...draft, seedanceAdapter: draft.apiFormat === "volcengine_ark" ? draft.seedanceAdapter || inferSeedanceAdapter(draft.baseUrl) : draft.seedanceAdapter, name: draft.name.trim() || t("config.channels.unnamed"), models: normalizeChannelModels(draft.models) });
        onClose();
    };

    const checkArkConnection = async () => {
        setCheckingArk(true);
        try {
            const adapter = draft.seedanceAdapter || inferSeedanceAdapter(draft.baseUrl);
            if (adapter === "router_local") {
                const localUrl = new URL(draft.baseUrl);
                if (!localUrl.port || !["localhost", "127.0.0.1", "127.0.0.01", "[::1]", "::1"].includes(localUrl.hostname.toLowerCase()) || (localUrl.pathname !== "/" && localUrl.pathname.replace(/\/+$/, "") !== "/api/v3")) {
                    throw new Error("Enter a loopback Router URL with an explicit port and optional /api/v3 path.");
                }
                const headers = { "x-router-origin": localUrl.origin, ...(draft.apiKey.trim() ? { Authorization: `Bearer ${draft.apiKey.trim()}` } : {}) };
                const ready = await fetch("/api/router-local/ready", { headers: { "x-router-origin": localUrl.origin }, cache: "no-store" });
                const readyResult = (await ready.json().catch(() => ({}))) as { ok?: boolean; issues?: string[]; error?: string };
                if (!ready.ok || !readyResult.ok) {
                    message.error(t("config.channelEditor.routerUnavailable", { detail: readyResult.issues?.join(", ") || readyResult.error || ready.status }));
                    return;
                }
                const taskCheck = await fetch("/api/router-local/api/v3/contents/generations/tasks/codex-connectivity-check-never-created", { headers, cache: "no-store" });
                const taskResult = (await taskCheck.json().catch(() => ({}))) as { error?: string | { message?: string }; message?: string };
                if (taskCheck.status === 404) message.success(t("config.channelEditor.routerConnectionPassed"));
                else if ([401, 403].includes(taskCheck.status)) message.error(t("config.channelEditor.routerConnectionAuthFailed"));
                else if (taskCheck.ok) message.success(t("config.channelEditor.routerConnectionPassed"));
                else message.error(t("config.channelEditor.routerUnavailable", { detail: taskResult.message || (typeof taskResult.error === "string" ? taskResult.error : taskResult.error?.message) || taskCheck.status }));
                return;
            }
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
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.seedanceAdapter")}</span>
                    <Select className="w-full" value={draft.seedanceAdapter || inferSeedanceAdapter(draft.baseUrl)} options={[{ value: "ark_official", label: t("config.channelEditor.adapters.ark_official") }, { value: "router_local", label: t("config.channelEditor.adapters.router_local") }]} onChange={changeSeedanceAdapter} />
                    <span className="mt-1 block text-xs text-stone-500">{t(draft.seedanceAdapter === "router_local" ? "config.channelEditor.routerLocalHint" : "config.channelEditor.arkOfficialHint")}</span>
                </label> : null}
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                    {draft.apiFormat === "volcengine_ark" ? <div className="mt-2 flex flex-wrap items-center gap-2"><Button size="small" loading={checkingArk} onClick={() => void checkArkConnection()}>{t(draft.seedanceAdapter === "router_local" ? "config.channelEditor.testRouterConnection" : "config.channelEditor.testArkConnection")}</Button><span className="text-xs text-stone-500">{t(draft.seedanceAdapter === "router_local" ? "config.channelEditor.routerConnectionHint" : "config.channelEditor.arkConnectionHint")}</span></div> : null}
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
                                {draft.apiFormat === "volcengine_ark" && model.capability === "video" ? <Select size="small" className="w-36" value={model.videoPreset} placeholder={t("config.channelEditor.seedancePreset")} options={seedancePresets.filter((preset) => draft.seedanceAdapter !== "router_local" || preset.videoPreset === "seedance-2.0").map((preset) => ({ value: preset.videoPreset, label: t(`config.channelEditor.presets.${preset.videoPreset}`) }))} onChange={(value) => setVideoPreset(model.name, value)} allowClear /> : null}
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

function createArkPresetModel(name: string, routerLocal = false): ChannelModel | undefined {
    const preset = seedancePresets.find((item) => item.name === name);
    return preset ? { name, capability: "video", videoPreset: preset.videoPreset, videoCapabilities: routerLocal && preset.videoPreset === "seedance-2.0" ? localRouterCapabilities : preset.videoCapabilities } : undefined;
}

function inferSeedanceAdapter(baseUrl: string): "ark_official" | "router_local" {
    try {
        const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
        return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname) || hostname === "127.0.0.01" ? "router_local" : "ark_official";
    } catch {
        return "ark_official";
    }
}
