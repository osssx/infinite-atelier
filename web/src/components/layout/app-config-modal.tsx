import { App, Button, Form, Input, Modal, Select, Tabs } from "antd";
import { Copy, Download, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { SkillManager } from "@/features/skills/skill-manager";
import { useCopyText } from "@/hooks/use-copy-text";
const ComfySettingsTab = lazy(() => import("@/features/comfy-workflow/comfy-settings-tab").then(module => ({ default: module.ComfySettingsTab })));
import { exportAppConfig, importAppConfig } from "@/services/config-file";
import {listComfyWorkflowModelOptionsByCapability,type WorkflowModelOption,workflowModelValue} from "@/features/comfy-workflow/workflow-model-options";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import {
    createModelChannel,
    modelOptionsFromChannels,
    normalizeModelOptionValue,
    selectableModelsByCapability,
    useConfigStore,
    awaitModelConfigPersistence,
    type AiConfig,
    type ApiCallFormat,
    type ConfigTabKey,
    type ModelCapability,
    type ModelChannel,
} from "@/stores/use-config-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    labelKey: string;
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", labelKey: "config.preferences.defaultImageModel" },
    { capability: "video", modelKey: "videoModel", labelKey: "config.preferences.defaultVideoModel" },
    { capability: "text", modelKey: "textModel", labelKey: "config.preferences.defaultTextModel" },
    { capability: "audio", modelKey: "audioModel", labelKey: "config.preferences.defaultAudioModel" },
];
function selectedWorkflowOption(options:WorkflowModelOption[],selection:{templateId:string;templateRevision:string}|undefined){
    if(!selection)return options;
    const value=workflowModelValue(selection.templateId,selection.templateRevision);
    return options.some(option=>option.value===value)?options:[...options,{value,label:"工作流版本不可用 · 请重新导入",disabled:true,templateId:selection.templateId,templateRevision:selection.templateRevision}];
}

export function AppConfigPanel({ showDoneButton = false, initialTab = "channels" }: { showDoneButton?: boolean; initialTab?: ConfigTabKey }) {
    const { message,modal } = App.useApp();
    const { i18n, t } = useTranslation();
    const configInputRef = useRef<HTMLInputElement>(null);
    const [activeTab, setActiveTab] = useState<ConfigTabKey>(initialTab);
    const [editingChannelId, setEditingChannelId] = useState("");
    const [workflowOptions,setWorkflowOptions]=useState<Record<"image"|"video"|"audio",WorkflowModelOption[]>>({image:[],video:[],audio:[]});
    const [workflowCatalogError,setWorkflowCatalogError]=useState("");
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const editingChannel = config.channels.find((channel) => channel.id === editingChannelId) || null;
    useEffect(() => setActiveTab(initialTab), [initialTab]);
    useEffect(()=>{let active=true;void listComfyWorkflowModelOptionsByCapability()
        .then(rows=>{if(active){setWorkflowOptions(rows);setWorkflowCatalogError("");}})
        .catch(error=>{if(active)setWorkflowCatalogError(error instanceof Error?error.message:String(error));});return()=>{active=false};},[]);

    const saveConfig = (nextConfig: AiConfig) => {
        // One revision-fenced transaction rather than one request per setting.
        useConfigStore.setState({config:nextConfig});
    };

    const finishConfig = async () => {
        try { await awaitModelConfigPersistence(); }
        catch(error) { message.error(String(error));return }
        const ready = config.channels.some((channel) => channel.baseUrl.trim() &&
            channel.models.length);
        setConfigDialogOpen(false);
        if (!ready) return;
        message.success(t(shouldPromptContinue ? "config.savedContinue" : "config.saved"));
        clearPromptContinue();
    };

    const loadConfigFile = async (file: File) => {
        try {
            await importAppConfig(file);
            await awaitModelConfigPersistence();
            message.success(t("config.imported"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.importFailed"));
        } finally {
            if (configInputRef.current) configInputRef.current.value = "";
        }
    };

    const updateChannels = (channels: ModelChannel[]) => saveConfig(withChannels(config, channels));

    const addChannel = () => {
        const channel = createModelChannel({ name: t("config.channels.numberedName", { count: config.channels.length + 1 }) });
        updateChannels([...config.channels, channel]);
        setEditingChannelId(channel.id);
    };

    const deleteChannel = (id: string) => {
        if (config.channels.length <= 1) {
            message.warning(t("config.channels.keepOne"));
            return;
        }
        updateChannels(config.channels.filter((channel) => channel.id !== id));
    };

    const saveChannel = (channel: ModelChannel) => {
        updateChannels(config.channels.map((item) => (item.id === channel.id ? channel : item)));
    };

    return (
        <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-3 dark:border-stone-800">
                <div className="text-xs text-stone-500">{t("config.fileSecurity")}</div>
                <div className="flex gap-2">
                    <Button icon={<Upload className="size-4" />} onClick={() => configInputRef.current?.click()}>
                        {t("config.import")}
                    </Button>
                    <Button icon={<Download className="size-4" />} onClick={exportAppConfig}>
                        {t("config.export")}
                    </Button>
                    <input ref={configInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => event.target.files?.[0] && void loadConfigFile(event.target.files[0])} />
                </div>
            </div>
            <Tabs
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key as ConfigTabKey)}
                items={[
                    {
                        key: "channels",
                        label: t("config.tabs.channels"),
                        children: (
                            <div>
                                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                                    <div className="text-xs text-stone-500">{t("config.channels.description")}</div>
                                    <Button type="primary" icon={<Plus className="size-4" />} onClick={addChannel}>
                                        {t("config.channels.add")}
                                    </Button>
                                </div>
                                <div className="space-y-2">
                                    {config.channels.map((channel) => (
                                        <div key={channel.id} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800">
                                            <div className="min-w-0">
                                                <div className="truncate text-sm font-semibold">{channel.name || t("config.channels.unnamed")}</div>
                                                <div className="mt-1 truncate text-xs text-stone-500">
                                                    {apiFormatLabel(channel.apiFormat)} · {t("config.channels.modelCount", { count: channel.models.length })} · {channel.baseUrl || t("config.channels.missingUrl")}
                                                </div>
                                            </div>
                                            <div className="flex shrink-0 gap-2">
                                                <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditingChannelId(channel.id)}>
                                                    {t("common.edit")}
                                                </Button>
                                                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => deleteChannel(channel.id)} />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ),
                    },
                    {
                        key: "preferences",
                        label: t("config.tabs.preferences"),
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-2 text-sm font-semibold">{t("config.preferences.defaultModels")}</div>
                                <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                    {modelGroups.map((group) => {
                                        const workflowCapability=group.capability==="text"?undefined:group.capability;
                                        const selectedWorkflow=workflowCapability?config.comfyWorkflowDefaults?.[workflowCapability]:undefined;
                                        const availableOptions=workflowCapability?selectedWorkflowOption(workflowOptions[workflowCapability],selectedWorkflow):[];
                                        return <Form.Item key={group.modelKey} label={t(group.labelKey)} className="mb-0">
                                            <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => {
                                                updateConfig(group.modelKey, model);
                                                if(workflowCapability)updateConfig("comfyWorkflowDefaults",{...config.comfyWorkflowDefaults,[workflowCapability]:undefined});
                                            }} capability={group.capability} fullWidth
                                                externalOptions={availableOptions}
                                                externalValue={selectedWorkflow?workflowModelValue(selectedWorkflow.templateId,selectedWorkflow.templateRevision):undefined}
                                                onExternalSelect={value=>{
                                                    if(!workflowCapability)return;
                                                    const option=workflowOptions[workflowCapability].find(item=>item.value===value);
                                                    if(!option||option.disabled)return;
                                                    updateConfig("comfyWorkflowDefaults",{...config.comfyWorkflowDefaults,[workflowCapability]:{templateId:option.templateId,templateRevision:option.templateRevision}});
                                                }} />
                                            {workflowCapability&&selectedWorkflow&&!workflowOptions[workflowCapability].some(option=>option.value===workflowModelValue(selectedWorkflow.templateId,selectedWorkflow.templateRevision))?
                                                <div role="alert" className="mt-1 text-xs text-amber-600">默认工作流版本不可用；切换到渠道模型或重新导入该模板。</div>:null}
                                        </Form.Item>
                                    })}
                                </div>
                                {workflowCatalogError?<div role="alert" className="mb-3 text-xs text-amber-600">读取工作流预设失败：{workflowCatalogError}</div>:null}
                                <div className="mb-2 text-sm font-semibold">{t("config.preferences.generation")}</div>
                                <div className="grid gap-4 md:grid-cols-4">
                                    <Form.Item label={t("config.preferences.canvasImageCount")} extra={t("config.preferences.canvasImageCountDescription")} className="mb-4">
                                        <Input
                                            type="number"
                                            min={1}
                                            max={15}
                                            value={config.canvasImageCount}
                                            onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                            onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                                        />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.audioVoice")} className="mb-4">
                                        <Select value={config.audioVoice} options={audioVoiceOptions} onChange={(value) => updateConfig("audioVoice", value)} />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.audioFormat")} className="mb-4">
                                        <Select value={config.audioFormat} options={audioFormatOptions} onChange={(value) => updateConfig("audioFormat", value)} />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.audioSpeed")} className="mb-4">
                                        <Input
                                            type="number"
                                            min={0.25}
                                            max={4}
                                            step={0.05}
                                            value={config.audioSpeed}
                                            onChange={(event) => updateConfig("audioSpeed", event.target.value)}
                                            onBlur={(event) => updateConfig("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                                        />
                                    </Form.Item>
                                </div>
                                <Form.Item label={t("config.preferences.audioInstructions")} className="mb-4">
                                    <Input.TextArea rows={2} value={config.audioInstructions} placeholder={t("config.preferences.audioInstructionsPlaceholder")} onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                                </Form.Item>
                                <Form.Item label={t("config.preferences.systemPrompt")} className="mb-0">
                                    <Input.TextArea rows={4} value={config.systemPrompt} placeholder={t("config.preferences.systemPromptPlaceholder")} onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                                </Form.Item>
                            </Form>
                        ),
                    },
                    {
                        key: "skills",
                        label: t("config.tabs.skills"),
                        children: <SkillManager />,
                    },
                    {
                        key: "comfyui",
                        label: "ComfyUI",
                        children: <Suspense fallback={<div className="py-6 text-xs text-stone-500">正在加载 ComfyUI 配置…</div>}><ComfySettingsTab /></Suspense>,
                    },
                    {
                        key: "backup",
                        label: t("config.tabs.backup"),
                        children: <ConfigBackupTab />,
                    },
                ]}
            />
            {showDoneButton ? (
                <div className="mt-4 flex justify-end">
                    <Button type="primary" onClick={finishConfig}>
                        {t("common.done")}
                    </Button>
                </div>
            ) : null}
            <ChannelEditorDrawer open={Boolean(editingChannel)} channel={editingChannel} onSave={saveChannel} onClose={() => setEditingChannelId("")} />
        </>
    );
}
export function AppConfigModal() {
    const { t } = useTranslation();
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const configTab = useConfigStore((state) => state.configTab);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">{t("config.title")}</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">{t("config.modalDescription")}</div>
                </div>
            }
            open={isConfigOpen}
            width={980}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 12 } }}
            footer={null}
        >
            <AppConfigPanel showDoneButton initialTab={configTab} />
        </Modal>
    );
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const next: AiConfig = {
        ...config,
        channels,
        models: modelOptionsFromChannels(channels),
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey ?? "",
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
    };
    return {
        ...next,
        imageModel: pickDefaultModel(next, "image", config.imageModel),
        videoModel: pickDefaultModel(next, "video", config.videoModel),
        textModel: pickDefaultModel(next, "text", config.textModel),
        audioModel: pickDefaultModel(next, "audio", config.audioModel),
    };
}

function pickDefaultModel(config: AiConfig, capability: ModelCapability, current: string) {
    const options = selectableModelsByCapability(config, capability);
    const normalized = normalizeModelOptionValue(current, config.channels);
    return options.includes(normalized) ? normalized : options[0] || "";
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}

function apiFormatLabel(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return "Gemini";
    if (apiFormat === "volcengine_ark") return "Volcengine Ark";
    return "OpenAI";
}

/** The legacy browser ZIP cannot back up authoritative SQLite/CAS data.
 * Full local data backups require an offline snapshot, not a live browser action.
 */
export function ConfigBackupTab() {
    const { t } = useTranslation();
    const copyText = useCopyText();
    const example = t("config.backup.commands");

    return (
        <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800" data-backup-mode="offline-backend">
            <div className="mb-1 text-sm font-semibold">{t("config.backup.title")}</div>
            <p className="mb-3 text-xs leading-5 text-stone-500">{t("config.backup.description")}</p>
            <div className="mb-3 rounded-md bg-stone-100 p-3 text-xs leading-6 text-stone-700 dark:bg-stone-900 dark:text-stone-300">
                <div className="font-medium">{t("config.backup.locationTitle")}</div>
                <code className="break-all">ATELIER_DATA_DIR</code> {t("config.backup.locationFallback")}{" "}
                <code className="break-all">%LOCALAPPDATA%\\InfiniteAtelier\\data</code>
            </div>
            <p className="mb-2 text-xs leading-5 text-stone-600 dark:text-stone-400">{t("config.backup.steps")}</p>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-medium">{t("config.backup.commandsTitle")}</div>
                <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copyText(example)}>
                    {t("config.backup.copyCommands")}
                </Button>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-stone-100 p-3 font-mono text-[11px] leading-5 dark:bg-stone-900">{example}</pre>
            <p className="mt-3 text-xs leading-5 text-stone-500">{t("config.backup.restoreNote")}</p>
        </section>
    );
}
