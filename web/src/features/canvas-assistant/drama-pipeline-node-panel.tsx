import { useState } from "react";
import { Button, Input, Modal, Tag } from "antd";
import { History, Maximize2 } from "lucide-react";
import type { CanvasNodeData } from "@/types/canvas";
import { DRAMA_PIPELINE_NODE_TYPES, DRAMA_PIPELINE_STAGE_LABELS, type DramaPipelineStage } from "./canvas-drama-pipeline";
import { canvasApi } from "@/features/backend-sync/canvas-api";
import { canvasCasUrl } from "@/features/backend-sync/canvas-cas";
import { CanvasNodeReferenceBar } from "@/components/canvas/canvas-node-reference-bar";
import { ensureSqliteModelChannelForExecution, modelChannelProvider } from "@/features/backend-sync/model-channel-autoroute";
import { buildDramaFirstFrameInput, dramaFirstFrameMissingReferenceIds } from "./drama-pipeline-media";
import { dramaAssetSlots, dramaReferenceImageKeys, referencesForDramaAssets, validateDramaShotReferences, type DramaAssetReference, type DramaPipelineSnapshot } from "./canvas-drama-pipeline";
import { useEffectiveConfig, resolveModelChannel, modelOptionName } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { DramaAssetFields } from "./drama-asset-fields";
import { DramaEpisodeFields } from "./drama-episode-fields";
import { readEpisodeDraft } from "../../../server/canvas-text-content.mjs";
import { dramaInlineNodeClass, dramaNodeControl, dramaNodePrimary, DramaNodeStatus } from "./drama-node-style";

const { TextArea } = Input;

export function isDramaPipelineNode(type: string): type is string {
    return Object.values(DRAMA_PIPELINE_NODE_TYPES).includes(type);
}

function readDraft(value: string): Partial<DramaPipelineSnapshot> | null {
    try { return JSON.parse(value); } catch { return null; }
}

function readAssetDraft(value: string) {
    const draft = readDraft(value.trim().replace(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i, "$1"));
    if (!Array.isArray(draft?.assets) || !draft.assets.every(asset => asset &&
        ["character","scene","prop"].includes(asset.kind) && typeof asset.id === "string" &&
        typeof asset.name === "string" && typeof asset.description === "string" &&
        Array.isArray(asset.sourceRefs) && asset.sourceRefs.every(ref => typeof ref === "string") &&
        (asset.variants === undefined || (Array.isArray(asset.variants) && asset.variants.every(variant =>
            variant && typeof variant.id === "string" && typeof variant.name === "string" && typeof variant.description === "string"))))) return null;
    return draft as typeof draft & {assets: NonNullable<typeof draft.assets>};
}

function describeDramaValidation(errors: {code:string;shotId?:string;id?:string}[], assets: DramaPipelineSnapshot["assets"]) {
    const sceneIds = assets.filter(asset => asset.kind === "scene").map(asset => `${asset.name}（${asset.id}）`);
    return [...new Set(errors.map(({code, shotId, id}) => {
        const detail = code === "shot_scene_invalid" ? `场景 ID ${id ?? ""} 不在已确认资产中` :
            code === "shot_scene_variant_invalid" ? `场景变体 ${id ?? ""} 不属于所选场景` :
            [code, id].filter(Boolean).join(" ");
        return shotId ? `${shotId}：${detail}` : detail;
    }))].concat(errors.some(error => error.code === "shot_scene_invalid")
        ? [sceneIds.length ? `可用场景：${sceneIds.join("、")}` : "请先确认包含场景的资产表，或为无场景镜头省略 sceneId"]
        : []).join("\n");
}

export function DramaPipelineNodePanel({ node, onChange, onRenderFirstFrame, onCreateReferenceConfig, onPickCanvasImage, projectId, upstreamText = "", upstreamContext = "", upstreamArtifacts = [], confirmedAssetPlan, savedAssetReferences, mergedReferences, legacyAssetPlanning = false, imageNodes = [], productionContext = "", onOpenVersions, onConfirmEpisodes, versionBusy = false }: {
    node: CanvasNodeData;
    onChange: (patch: Partial<CanvasNodeData["metadata"]>) => void;
    onRenderFirstFrame?: (prompt: string, input?: ReturnType<typeof buildDramaFirstFrameInput>) => void;
    onCreateReferenceConfig?: (assetName: string, prompt: string) => void;
    onPickCanvasImage?: (onPick: (storageKey: string) => void) => void;
    projectId?: string;
    upstreamText?: string;
    upstreamContext?: string;
    upstreamArtifacts?: string[];
    confirmedAssetPlan?: string;
    savedAssetReferences?: string;
    mergedReferences?: DramaAssetReference[];
    legacyAssetPlanning?: boolean;
    productionContext?: string;
    onOpenVersions?: () => void;
    onConfirmEpisodes?: (draft: string) => Promise<void>;
    versionBusy?: boolean;
    imageNodes?: CanvasNodeData[];
}) {
    const stage = Object.entries(DRAMA_PIPELINE_NODE_TYPES).find(([, type]) => type === node.type)?.[0] as DramaPipelineStage | undefined;
    const storedDraft = node.metadata?.dramaDraft || node.metadata?.dramaConfirmed || node.metadata?.content || "";
    const [localDraft, setDraft] = useState(storedDraft);
    const [localConfirmed, setConfirmed] = useState(String(node.metadata?.dramaConfirmed ?? ""));
    const [validation, setValidation] = useState<string>("");
    const [generating, setGenerating] = useState(false);
    const [assetEditorExpanded, setAssetEditorExpanded] = useState(false);
    const [targetEpisodes, setTargetEpisodes] = useState(Number(node.metadata?.targetEpisodes ?? 10));
    const upstream = upstreamArtifacts.map(readDraft);
    const assetPlanning = stage === "assets";
    const referenceEditing = stage === "asset_references";
    const mergedEditing = assetPlanning && !legacyAssetPlanning;
    const episodePlanning = stage === "episodes";
    const draft = episodePlanning ? storedDraft : localDraft;
    const confirmed = episodePlanning ? node.metadata?.dramaConfirmed ?? "" : localConfirmed;
    const episodeDraft = episodePlanning ? readEpisodeDraft(draft) : null;
    const inlineEditor = assetPlanning || referenceEditing || episodePlanning;
    const previous = assetPlanning ? readAssetDraft(draft) : readDraft(draft);
    const liveAssets = readDraft(confirmedAssetPlan ?? "")?.assets;
    const assets = liveAssets ?? upstream.find(item => Array.isArray(item?.assets))?.assets ?? previous?.assets ?? [];
    const savedReferences = readDraft(savedAssetReferences ?? "")?.references;
    const upstreamReferences = (mergedReferences ? referencesForDramaAssets(liveAssets ?? [], mergedReferences) : undefined) ??
        (Array.isArray(savedReferences) ? savedReferences : undefined) ??
        upstream.find(item => Array.isArray(item?.references))?.references;
    const shots = upstream.find(item => Array.isArray(item?.shots))?.shots ?? previous?.shots ?? [];
    const scenes = assets.filter(asset => asset.kind === "scene");
    const invalidSceneIds = stage === "storyboard" ? [...new Set(shots.flatMap(shot =>
        shot?.sceneId && !scenes.some(scene => scene.id === shot.sceneId) ? [shot.sceneId] : [],
    ))] : [];
    const replaceScene = (oldId: string, newId: string) => {
        const nextShots = shots.map(shot => {
            if (shot?.sceneId !== oldId) return shot;
            const updated = { ...shot, sceneId: newId };
            if (!scenes.find(scene => scene.id === newId)?.variants?.some(variant => variant.id === shot.sceneVariantId)) {
                delete updated.sceneVariantId;
            }
            return updated;
        });
        const next = JSON.stringify({ ...previous, shots: nextShots }, null, 2);
        setDraft(next);
        onChange({dramaDraft: next});
        setValidation(`已替换 ${oldId}，请检查并确认草案`);
    };
    const storedReferences = mergedEditing ? node.metadata?.dramaAssetReferences : previous?.references;
    const references = referenceEditing || mergedEditing ? dramaAssetSlots(assets).map(slot => ({
        ...slot, imageStorageKeys:dramaReferenceImageKeys(storedReferences?.find(ref =>
            ref.assetId === slot.assetId && ref.variantId === slot.variantId)),
    })) : upstreamReferences ?? previous?.references ?? [];
    const parsedSnapshot: DramaPipelineSnapshot = {version:1,stage:stage ?? "source",revision:1,inputRevisions:{},assets,references,shots};
    const images = imageNodes.flatMap(item => {
        const metadata = item.metadata;
        const keys = [metadata?.storageKey, ...(metadata?.images ?? []).map(image => image.storageKey)];
        return [...new Set(keys)].flatMap(key => key && /^cas:[a-f0-9]{64}$/.test(key) ? [{key,title:item.title}] : []);
    });
    const updateReference = (assetId: string, variantId: string | undefined, key: string, remove = false) => {
        const slot = references.find(ref => ref.assetId === assetId && ref.variantId === variantId);
        if (!slot) return;
        const keys = dramaReferenceImageKeys(slot);
        const imageStorageKeys = remove ? keys.filter(item => item !== key) : [...new Set([...keys, key])];
        const referencesToKeep = (mergedEditing ? storedReferences ?? [] : references)
            .filter(ref => ref.assetId !== assetId || ref.variantId !== variantId);
        const referencesNext = [...referencesToKeep, {...slot, imageStorageKeys}];
        if (mergedEditing) {
            onChange({dramaAssetReferences:referencesNext});
            return;
        }
        const next = JSON.stringify({ ...parsedSnapshot, references:referencesNext }, null, 2);
        setDraft(next);
        onChange({ dramaDraft: next });
    };
    const config = useEffectiveConfig();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const control = inlineEditor ? dramaNodeControl(theme) : undefined;
    const assetConfirmed = Boolean(confirmed && draft === confirmed);
    const inlineReady = referenceEditing ? references.length > 0 : episodePlanning ? Boolean(episodeDraft?.episodes.length) : Boolean(previous);
    if (!stage) return null;
    const editor = <section className={inlineEditor ? assetEditorExpanded
        ? "flex h-full min-h-0 flex-col gap-4 text-sm"
        : dramaInlineNodeClass
        : "rounded-xl border border-slate-200 bg-white p-4 shadow-xl"}
        style={inlineEditor ? {color:theme.node.text} : undefined} data-canvas-no-zoom={inlineEditor ? "" : undefined}
        onWheel={inlineEditor ? event => event.stopPropagation() : undefined}
        onMouseDown={inlineEditor ? event => {
            if (event.target instanceof Element && event.target.closest("input, textarea, select, button, summary")) event.stopPropagation();
        } : undefined}
        onDoubleClick={inlineEditor ? event => event.stopPropagation() : undefined}
        onKeyDown={inlineEditor ? event => event.stopPropagation() : undefined}>
        <header className={`flex items-center justify-between gap-2 ${inlineEditor ? "" : "mb-3"}`}>
            {!assetEditorExpanded && <strong className={inlineEditor ? "text-sm" : undefined}>{DRAMA_PIPELINE_STAGE_LABELS[stage]}</strong>}
            {inlineEditor ? <div className="flex items-center gap-2">
                <DramaNodeStatus theme={theme} confirmed={assetConfirmed} />
                {episodePlanning && onOpenVersions && <Button size="small" icon={<History size={14} />}
                    style={control} onClick={onOpenVersions}>历史版本</Button>}
                {!assetEditorExpanded && <button type="button" title="最大化编辑器" aria-label={`最大化${DRAMA_PIPELINE_STAGE_LABELS[stage]}`}
                    className="inline-grid size-7 place-items-center rounded-md border" style={control}
                    onClick={() => setAssetEditorExpanded(true)}><Maximize2 className="size-3.5" /></button>}
            </div> :
                <Tag color={confirmed ? "green" : "default"}>{confirmed ? "已确认" : "草案"}</Tag>}
        </header>
        <div className={inlineEditor ? assetEditorExpanded ? "flex min-h-0 flex-1 flex-col gap-4" :
            "thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-1" : "contents"}
            onMouseDown={inlineEditor ? event => event.stopPropagation() : undefined}
            onPointerDown={inlineEditor ? event => event.stopPropagation() : undefined}>
        {inlineEditor ? <div className={assetEditorExpanded ? "thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1" : episodePlanning ? "grid gap-3" : "contents"}>
            {episodePlanning ? <>
                <label className="flex items-center justify-between gap-3 rounded-xl border px-3 py-1.5 font-medium" style={control}>目标集数
                    <Input size="small" className="!w-20" type="number" min={1} max={100} value={targetEpisodes} disabled={generating} style={control}
                        onChange={event => {
                            const count = Math.max(1, Math.min(100, Math.trunc(Number(event.target.value)) || 1));
                            setTargetEpisodes(count);
                            setValidation("");
                            onChange({targetEpisodes:count});
                        }} />
                </label>
                <DramaEpisodeFields episodes={episodeDraft?.episodes ?? []} expanded={assetEditorExpanded} disabled={generating} control={control} onChange={episodes => {
                    const next = JSON.stringify({...episodeDraft,episodes});
                    setValidation("");
                    onChange({dramaDraft:next});
                }} />
                {draft && !episodeDraft && <p role="alert">这份剧集草案格式无法读取，请重新生成。</p>}
            </> : <DramaAssetFields assets={assets} theme={theme} expanded={assetEditorExpanded} disabled={generating} onChange={assetPlanning ? nextAssets => {
                const next = JSON.stringify({...previous, assets:nextAssets});
                setDraft(next);
                setValidation("");
                onChange({dramaDraft:next});
            } : undefined} renderReferences={referenceEditing || mergedEditing ? (asset, variantId) => <div className="min-w-0 space-y-3">
                {references.filter(reference => reference.assetId === asset.id && (!mergedEditing || reference.variantId === variantId)).map(reference => {
                    const variant = asset.variants?.find(item => item.id === reference.variantId);
                    const name = variant?.name || asset.name;
                    const keys = dramaReferenceImageKeys(reference);
                    return <section key={reference.variantId ?? asset.id} className="space-y-3 rounded-xl border p-3" style={control}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="font-semibold">{name}</h3>
                            <span className="text-xs" style={{color:theme.node.muted}}>{keys.length ? `已选 ${keys.length} 张` : "待选参考图"}</span>
                        </div>
                        <CanvasNodeReferenceBar nodeId={node.id}
                            references={keys.map((key, index) => ({
                                id:key, nodeId:key, kind:"image", active:true,
                                title:images.find(image => image.key === key)?.title || `${name}参考图 ${index + 1}`,
                                label:`参考图 ${index + 1}`, previewUrl:canvasCasUrl(key) ?? undefined,
                            }))}
                            onDisconnect={key => updateReference(asset.id, reference.variantId, key, true)}
                            onStartSelection={!assetEditorExpanded && onPickCanvasImage
                                ? () => onPickCanvasImage(key => updateReference(asset.id, reference.variantId, key))
                                : undefined} />
                        <div className="flex flex-wrap items-center gap-2">
                            {assetEditorExpanded ? <select className="min-w-0 flex-1 rounded-lg border px-2 py-1.5" style={control}
                                aria-label={`添加${name}参考图`} value=""
                                onChange={event => { if (event.target.value) updateReference(asset.id, reference.variantId, event.target.value); }}>
                                <option value="">从画布图片列表添加</option>
                                {images.filter(image => !keys.includes(image.key)).map((image, index) => <option key={`${image.key}:${index}`} value={image.key}>{image.title} · {image.key.slice(4,12)}</option>)}
                            </select> : null}
                            <Button size="small" style={control} disabled={!onCreateReferenceConfig} onClick={() => {
                                onCreateReferenceConfig?.(asset.name, [
                                    `制作单张${asset.kind === "scene" ? "场景" : asset.kind === "prop" ? "道具" : "角色"}参考图。`,
                                    asset.name, asset.description, variant?.name, variant?.description,
                                ].filter(Boolean).join("\n"));
                                setAssetEditorExpanded(false);
                            }}>创建生图配置</Button>
                        </div>
                    </section>;
                })}
            </div> : undefined} />}
            {assetPlanning && draft && !previous && <p role="alert">这份资产草案无法读取，请重新生成或添加资产。</p>}
            {referenceEditing && !assets.length && <p style={{color:theme.node.muted}}>请先在已连接的资产规划节点确认资产。</p>}
        </div> : <TextArea value={draft} onChange={event => setDraft(event.target.value)} autoSize={{ minRows: 5, maxRows: 16 }}
            placeholder={stage === "source" ? "粘贴小说或剧本原文" : "填写或粘贴本阶段结构化草案"} />}
        {stage === "source" ? <label className="mt-2 block text-sm">导入文本文件
            <input className="ml-2" type="file" accept=".txt,.md,text/plain,text/markdown" onChange={async event => {
                const file = event.currentTarget.files?.[0];
                if (!file) return;
                try { const content = await file.text(); setDraft(content); onChange({dramaDraft:content,content,sourceFilename:file.name}); setValidation("原文已载入，保存节点以持久化"); }
                catch { setValidation("无法读取该文本文件"); }
            }} />
        </label> : null}
        <div className={inlineEditor
            ? `flex flex-wrap items-center justify-end gap-2 pt-2 ${assetEditorExpanded ? "order-last shrink-0" : ""}`
            : "mt-3 flex gap-2"}>
            {!inlineEditor && <Button onClick={() => { onChange({ dramaDraft: draft, ...(stage === "source" ? { content: draft } : {}) }); }}>保存草案</Button>}
            <Button size={inlineEditor && !assetEditorExpanded ? "small" : "middle"} className={inlineEditor ? "order-last" : undefined}
                style={inlineEditor && inlineReady && !generating ? dramaNodePrimary(theme) : undefined}
                type="primary" disabled={inlineEditor ? generating || !inlineReady || (episodePlanning && versionBusy) : !draft.trim()} onClick={async () => {
                try {
                    if (stage === "assets" || stage === "episodes" || stage === "storyboard") {
                        const parsed: {assets?:unknown; episodes?:unknown; shots?:unknown} =
                            assetPlanning ? previous ?? {} : episodePlanning ? episodeDraft ?? {} : JSON.parse(draft);
                        const collection = stage === "assets" ? parsed.assets : stage === "episodes" ? parsed.episodes : parsed.shots;
                        if (!Array.isArray(collection) || (!assetPlanning && !collection.length)) throw Error("请确认有效的结构化 JSON 草案");
                        if (stage === "episodes" && collection.length !== targetEpisodes) throw Error(`剧集草案必须包含 ${targetEpisodes} 集`);
                        if (stage !== "episodes") {
                            const result = await canvasApi<{valid:boolean;errors:{code:string}[]}>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/drama-pipeline/validate`, "POST", {snapshot:parsedSnapshot});
                            if (!result.valid) throw Error(describeDramaValidation(result.errors, assets));
                        }
                    }
                    if (episodePlanning && onConfirmEpisodes) {
                        await onConfirmEpisodes(draft);
                        setValidation("阶段已确认");
                        return;
                    }
                    const content = stage === "asset_references" ? JSON.stringify(parsedSnapshot, null, 2) :
                        assetPlanning ? JSON.stringify(previous) : episodePlanning ? JSON.stringify(episodeDraft) : draft;
                    setDraft(content); setConfirmed(content); setValidation("阶段已确认");
                    onChange({ dramaDraft: content, dramaConfirmed: content, dramaStage: stage,
                        ...(mergedEditing ? {dramaAssetReferences:referencesForDramaAssets(assets, storedReferences ?? [])} : {}),
                        ...(stage === "source" ? { content } : {}) });
                } catch (error) { setValidation(error instanceof Error ? error.message : "结构化结果无效"); }
            }}>确认阶段</Button>
        <Button size={inlineEditor && !assetEditorExpanded ? "small" : "middle"} style={control} onClick={async () => {
            try {
                if (episodePlanning) {
                    if (episodeDraft?.episodes.length !== targetEpisodes) throw Error(`剧集草案必须包含 ${targetEpisodes} 集`);
                    setValidation("检查通过");
                    return;
                }
                if (!referenceEditing && (!previous || typeof previous !== "object" || Array.isArray(previous))) throw Error("请填写有效的结构化 JSON 草案");
                const result = await canvasApi<{valid:boolean;errors:{code:string}[]}>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/drama-pipeline/validate`, "POST", {snapshot:parsedSnapshot});
                setValidation(result.valid ? "检查通过" : describeDramaValidation(result.errors, assets));
            } catch (error) { setValidation(error instanceof Error ? error.message : "校验失败"); }
        }} disabled={!projectId || (inlineEditor && (!inlineReady || generating))}>{referenceEditing ? "校验主图" : assetPlanning ? "校验资产" : episodePlanning ? "校验剧集" : "校验结构化草案"}</Button>
        {stage === "assets" || stage === "episodes" || stage === "storyboard" ? <Button size={inlineEditor && !assetEditorExpanded ? "small" : "middle"} style={control} loading={generating} onClick={async () => {
            setGenerating(true);
            try {
                const model = config.textModel;
                const channel = resolveModelChannel(config, model);
                const provider = modelChannelProvider(channel, "text");
                if (!channel || !provider || provider === "volcengine_ark") throw Error("请先在全局设置选择支持文本生成的模型渠道");
                const sourceText = String(node.metadata?.content ?? upstreamText);
                const baseContext = [upstreamContext || upstreamArtifacts.join("\n\n"), productionContext].filter(Boolean).join("\n\n");
                const context = stage === "storyboard" ? `${baseContext}\n\n已确认场景白名单：${JSON.stringify(scenes.map(scene => ({id:scene.id,name:scene.name,description:scene.description})))}。台阶、墙边等局部位置写入画面描述，sceneId 使用所属的已确认场景 ID。确实没有可引用场景时省略 sceneId。` : baseContext;
                if (stage === "storyboard" && upstreamArtifacts.length < 2) throw Error("请先确认资产规划和剧集规划");
                if (stage !== "storyboard" && !sourceText.trim()) throw Error("请先确认原文");
                await ensureSqliteModelChannelForExecution(channel, provider);
                const result = await canvasApi<{answer:string}>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/drama-pipeline/generate`, "POST", {
                    stage,
                    channelId: channel.id,
                    provider,
                    baseUrl: channel.baseUrl,
                    model: modelOptionName(model),
                    sourceText,
                    context,
                    targetEpisodes,
                });
                const assetDraft = assetPlanning ? readAssetDraft(result.answer) : undefined;
                const generatedEpisodes = episodePlanning ? readEpisodeDraft(result.answer) : undefined;
                if (assetPlanning && !assetDraft) throw Error("模型返回的资产格式有误，已保留原草案");
                if (episodePlanning && !generatedEpisodes?.episodes.length) throw Error("模型返回的剧集格式有误，已保留原草案");
                const structured = assetDraft ?? generatedEpisodes;
                const answer = structured ? JSON.stringify(structured) : result.answer;
                setDraft(answer);
                setValidation("已生成草案，请检查并保存或确认");
                onChange({dramaDraft:answer});
            } catch (error) { setValidation(error instanceof Error ? error.message : "生成失败"); }
            finally { setGenerating(false); }
        }} disabled={!projectId}>生成草案</Button> : null}
        </div>
        {validation ? <p role="status" className={`mt-2 whitespace-pre-wrap text-sm ${assetEditorExpanded ? "thin-scrollbar max-h-24 shrink-0 overflow-y-auto" : ""}`}>{validation}</p> : null}
        {invalidSceneIds.map(id => <label className="mt-2 block text-sm" key={id}>
            将所有引用 {id} 的镜头改为
            <select className="ml-2" value="" onChange={event => {
                if (event.target.value) replaceScene(id, event.target.value);
            }}>
                <option value="">选择已确认场景</option>
                {scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.name}（{scene.id}）</option>)}
            </select>
        </label>)}
        {stage === "first_frames" && parsedSnapshot ? <div className="mt-3 space-y-2">
            {!upstreamReferences?.length && <p className="text-sm">请在已连接的资产节点添加参考图。选图会自动保存。</p>}
            {parsedSnapshot.shots.map(shot => {
                const problems = validateDramaShotReferences(shot, assets);
                if (!problems.length) problems.push(...dramaFirstFrameMissingReferenceIds(parsedSnapshot, shot).map(id => `缺少主图：${id}`));
                const input = problems.length ? null : buildDramaFirstFrameInput(parsedSnapshot, shot);
                return <div className="space-y-1" key={shot.id}>
                    <span className="text-sm">镜头 {shot.order} · {shot.description}</span>
                    <Button size="small" disabled={!input} onClick={() => input && onRenderFirstFrame?.(input.prompt, input)}>生成</Button>
                    <p className="text-xs">{problems.join("、") || input?.referenceImages.map(image => image.name).join("、")}</p>
                </div>;
            })}
        </div> : null}
        {confirmed && !inlineEditor ? <details className="mt-3"><summary>已确认内容</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{confirmed}</pre></details> : null}
        </div>
    </section>;
    if (!inlineEditor || !assetEditorExpanded) return editor;
    return <>
        <div className="flex h-full items-center justify-center text-xs" style={{color:theme.node.text}}>正在大面板中编辑</div>
        <Modal open centered title={<span style={{color:theme.node.text}}>{DRAMA_PIPELINE_STAGE_LABELS[stage]}</span>} width="min(1280px, calc(100vw - 32px))"
            footer={null} onCancel={() => setAssetEditorExpanded(false)}
            styles={{
                container:{background:theme.node.fill},
                header:{background:theme.node.fill},
                body:{height:"min(880px, calc(100dvh - 128px))", overflow:"hidden", padding:"12px 4px 16px"},
            }}>
            {editor}
        </Modal>
    </>;
}
