import { useState } from "react";
import { Button, Input, Modal, Tag } from "antd";
import { Maximize2 } from "lucide-react";
import type { CanvasNodeData } from "@/types/canvas";
import { DRAMA_PIPELINE_NODE_TYPES, DRAMA_PIPELINE_STAGE_LABELS, type DramaPipelineStage } from "./canvas-drama-pipeline";
import { canvasApi } from "@/features/backend-sync/canvas-api";
import { ensureSqliteModelChannelForExecution, modelChannelProvider } from "@/features/backend-sync/model-channel-autoroute";
import { buildDramaFirstFrameInput, dramaFirstFrameMissingReferenceIds } from "./drama-pipeline-media";
import { validateDramaShotReferences, type DramaPipelineSnapshot } from "./canvas-drama-pipeline";
import { useEffectiveConfig, resolveModelChannel, modelOptionName } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { DramaAssetFields } from "./drama-asset-fields";
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

export function DramaPipelineNodePanel({ node, onChange, onRenderFirstFrame, projectId, upstreamText = "", upstreamContext = "", upstreamArtifacts = [], confirmedAssetPlan, savedAssetReferences, imageNodes = [], productionContext = "" }: {
    node: CanvasNodeData;
    onChange: (patch: Partial<CanvasNodeData["metadata"]>) => void;
    onRenderFirstFrame?: (prompt: string, input?: ReturnType<typeof buildDramaFirstFrameInput>) => void;
    projectId?: string;
    upstreamText?: string;
    upstreamContext?: string;
    upstreamArtifacts?: string[];
    confirmedAssetPlan?: string;
    savedAssetReferences?: string;
    productionContext?: string;
    imageNodes?: CanvasNodeData[];
}) {
    const stage = Object.entries(DRAMA_PIPELINE_NODE_TYPES).find(([, type]) => type === node.type)?.[0] as DramaPipelineStage | undefined;
    const [draft, setDraft] = useState(String(node.metadata?.dramaDraft || node.metadata?.dramaConfirmed || node.metadata?.content || ""));
    const [confirmed, setConfirmed] = useState(String(node.metadata?.dramaConfirmed ?? ""));
    const [validation, setValidation] = useState<string>("");
    const [generating, setGenerating] = useState(false);
    const [assetEditorExpanded, setAssetEditorExpanded] = useState(false);
    const [targetEpisodes, setTargetEpisodes] = useState(Number(node.metadata?.targetEpisodes ?? 10));
    const upstream = upstreamArtifacts.map(readDraft);
    const inlineAssets = stage === "assets";
    const previous = inlineAssets ? readAssetDraft(draft) : readDraft(draft);
    const liveAssets = readDraft(confirmedAssetPlan ?? "")?.assets;
    const assets = liveAssets ?? upstream.find(item => Array.isArray(item?.assets))?.assets ?? previous?.assets ?? [];
    const savedReferences = readDraft(savedAssetReferences ?? "")?.references;
    const upstreamReferences = (Array.isArray(savedReferences) ? savedReferences : undefined) ??
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
    const references = stage === "asset_references" ? assets.flatMap(asset => {
        const variants = asset.variants ?? [];
        const slots = asset.kind === "character" && variants.length ? variants : [undefined, ...variants];
        return slots.map(variant => ({
            assetId: asset.id,
            variantId: variant?.id,
            imageStorageKey: previous?.references?.find(ref => ref.assetId === asset.id && ref.variantId === variant?.id)?.imageStorageKey,
            requiredForRendering: asset.kind !== "prop",
        }));
    }) : upstreamReferences ?? previous?.references ?? [];
    const parsedSnapshot: DramaPipelineSnapshot = {version:1,stage:stage ?? "source",revision:1,inputRevisions:{},assets,references,shots};
    const images = imageNodes.flatMap(item => {
        const metadata = item.metadata;
        const keys = [metadata?.storageKey, ...(metadata?.images ?? []).map(image => image.storageKey)];
        return [...new Set(keys)].flatMap(key => key && /^cas:[a-f0-9]{64}$/.test(key) ? [{key,title:item.title}] : []);
    });
    const updateReference = (assetId: string, variantId: string | undefined, imageStorageKey: string) => {
        const references = parsedSnapshot.references.map(reference => reference.assetId === assetId && reference.variantId === variantId ? { ...reference, imageStorageKey: imageStorageKey.trim() || undefined } : reference);
        const next = JSON.stringify({ ...parsedSnapshot, references }, null, 2);
        setDraft(next);
        onChange({ dramaDraft: next });
    };
    const config = useEffectiveConfig();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const control = inlineAssets ? dramaNodeControl(theme) : undefined;
    const assetConfirmed = Boolean(confirmed && draft === confirmed);
    if (!stage) return null;
    const editor = <section className={inlineAssets ? assetEditorExpanded
        ? "flex h-full min-h-0 flex-col gap-4 text-sm"
        : dramaInlineNodeClass
        : "rounded-xl border border-slate-200 bg-white p-4 shadow-xl"}
        style={inlineAssets ? {color:theme.node.text} : undefined} data-canvas-no-zoom={inlineAssets ? "" : undefined}
        onWheel={inlineAssets ? event => event.stopPropagation() : undefined}
        onMouseDown={inlineAssets ? event => {
            if (event.target instanceof Element && event.target.closest("input, textarea, select, button, summary")) event.stopPropagation();
        } : undefined}
        onDoubleClick={inlineAssets ? event => event.stopPropagation() : undefined}
        onKeyDown={inlineAssets ? event => event.stopPropagation() : undefined}>
        <header className={`flex items-center justify-between gap-2 ${inlineAssets ? "" : "mb-3"}`}>
            {!assetEditorExpanded && <strong className={inlineAssets ? "text-sm" : undefined}>{DRAMA_PIPELINE_STAGE_LABELS[stage]}</strong>}
            {inlineAssets ? <div className="flex items-center gap-2">
                <DramaNodeStatus theme={theme} confirmed={assetConfirmed} />
                {!assetEditorExpanded && <button type="button" title="最大化资产编辑器" aria-label="最大化资产编辑器"
                    className="inline-grid size-7 place-items-center rounded-md border" style={control}
                    onClick={() => setAssetEditorExpanded(true)}><Maximize2 className="size-3.5" /></button>}
            </div> :
                <Tag color={confirmed ? "green" : "default"}>{confirmed ? "已确认" : "草案"}</Tag>}
        </header>
        <div className={inlineAssets ? assetEditorExpanded ? "flex min-h-0 flex-1 flex-col gap-4" :
            "thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain" : "contents"}
            onMouseDown={inlineAssets ? event => event.stopPropagation() : undefined}
            onPointerDown={inlineAssets ? event => event.stopPropagation() : undefined}>
        {inlineAssets ? <div className={assetEditorExpanded ? "thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1" : "contents"}>
            <DramaAssetFields assets={assets} theme={theme} expanded={assetEditorExpanded} disabled={generating} onChange={nextAssets => {
                const next = JSON.stringify({...previous, assets:nextAssets});
                setDraft(next);
                setValidation("");
                onChange({dramaDraft:next});
            }} />
            {draft && !previous && <p role="alert">这份资产草案无法读取，请重新生成或添加资产。</p>}
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
        {stage === "episodes" ? <label className="mt-2 block text-sm">目标集数
            <Input type="number" min={1} max={100} value={targetEpisodes} onChange={event => {
                const count = Math.max(1, Math.min(100, Number(event.target.value) || 1));
                setTargetEpisodes(count); onChange({targetEpisodes:count});
            }} />
        </label> : null}
        <div className={inlineAssets
            ? `flex flex-wrap items-center justify-end gap-2 pt-2 ${assetEditorExpanded ? "order-last shrink-0" : ""}`
            : "mt-3 flex gap-2"}>
            {!inlineAssets && <Button onClick={() => { onChange({ dramaDraft: draft, ...(stage === "source" ? { content: draft } : {}) }); }}>保存草案</Button>}
            <Button size={inlineAssets && !assetEditorExpanded ? "small" : "middle"} className={inlineAssets ? "order-last" : undefined}
                style={inlineAssets && previous && !generating ? dramaNodePrimary(theme) : undefined}
                type="primary" disabled={inlineAssets ? generating || !previous : !draft.trim() && !(stage === "asset_references" && references.length)} onClick={async () => {
                try {
                    if (stage === "assets" || stage === "episodes" || stage === "storyboard") {
                        const parsed: {assets?:unknown; episodes?:unknown; shots?:unknown} =
                            inlineAssets ? previous ?? {} : JSON.parse(draft);
                        const collection = stage === "assets" ? parsed.assets : stage === "episodes" ? parsed.episodes : parsed.shots;
                        if (!Array.isArray(collection) || (!inlineAssets && !collection.length)) throw Error("请确认有效的结构化 JSON 草案");
                        if (stage === "episodes" && collection.length !== targetEpisodes) throw Error(`剧集草案必须包含 ${targetEpisodes} 集`);
                        if (stage !== "episodes") {
                            const result = await canvasApi<{valid:boolean;errors:{code:string}[]}>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/drama-pipeline/validate`, "POST", {snapshot:parsedSnapshot});
                            if (!result.valid) throw Error(describeDramaValidation(result.errors, assets));
                        }
                    }
                    const content = stage === "asset_references" ? JSON.stringify(parsedSnapshot, null, 2) : inlineAssets ? JSON.stringify(previous) : draft;
                    setDraft(content); setConfirmed(content); setValidation("阶段已确认");
                    onChange({ dramaDraft: content, dramaConfirmed: content, dramaStage: stage, ...(stage === "source" ? { content } : {}) });
                } catch (error) { setValidation(error instanceof Error ? error.message : "结构化结果无效"); }
            }}>确认阶段</Button>
        <Button size={inlineAssets && !assetEditorExpanded ? "small" : "middle"} style={control} onClick={async () => {
            try {
                if (!previous || typeof previous !== "object" || Array.isArray(previous)) throw Error("请填写有效的结构化 JSON 草案");
                const result = await canvasApi<{valid:boolean;errors:{code:string}[]}>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/drama-pipeline/validate`, "POST", {snapshot:parsedSnapshot});
                setValidation(result.valid ? "检查通过" : describeDramaValidation(result.errors, assets));
            } catch (error) { setValidation(error instanceof Error ? error.message : "校验失败"); }
        }} disabled={!projectId || (inlineAssets && (!previous || generating))}>{inlineAssets ? "校验资产" : "校验结构化草案"}</Button>
        {stage === "assets" || stage === "episodes" || stage === "storyboard" ? <Button size={inlineAssets && !assetEditorExpanded ? "small" : "middle"} style={control} loading={generating} onClick={async () => {
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
                const assetDraft = inlineAssets ? readAssetDraft(result.answer) : undefined;
                if (inlineAssets && !assetDraft) throw Error("模型返回的资产格式有误，已保留原草案");
                const answer = assetDraft ? JSON.stringify(assetDraft) : result.answer;
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
        {stage === "asset_references" ? <div className="mt-3 space-y-2">
            <p className="text-sm font-medium">资产主图</p>
            {parsedSnapshot.references.map(reference => {
                const asset = parsedSnapshot.assets.find(item => item.id === reference.assetId);
                const variant = asset?.variants?.find(item => item.id === reference.variantId);
                return <div className="space-y-1 text-xs" key={`${reference.assetId}:${reference.variantId ?? "base"}`}>
                    <span>{asset?.name ?? reference.assetId}{variant ? ` · ${variant.name}` : ""}</span>
                    <Button size="small" onClick={() => onRenderFirstFrame?.(`制作单张${asset?.kind === "scene" ? "场景" : asset?.kind === "prop" ? "道具" : "角色"}参考图。\n${asset?.name}\n${asset?.description}\n${variant?.description ?? ""}`)}>生成参考图</Button>
                    <select aria-label={`${asset?.name ?? reference.assetId}主图`} value={reference.imageStorageKey ?? ""} onChange={event => updateReference(reference.assetId, reference.variantId, event.target.value)}>
                        <option value="">选择画布图片</option>
                        {images.map((image, index) => <option key={`${image.key}:${index}`} value={image.key}>{image.title} · {image.key.slice(4,12)}</option>)}
                    </select>
                </div>;
            })}
        </div> : null}
        {stage === "first_frames" && parsedSnapshot ? <div className="mt-3 space-y-2">
            {!upstreamReferences && <p className="text-sm">请在已连接的「资产参考图」节点选定主图。选图会自动保存，首帧渲染会读取最新选择。</p>}
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
        {confirmed && !inlineAssets ? <details className="mt-3"><summary>已确认内容</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{confirmed}</pre></details> : null}
        </div>
    </section>;
    if (!inlineAssets || !assetEditorExpanded) return editor;
    return <>
        <div className="flex h-full items-center justify-center text-xs" style={{color:theme.node.text}}>正在大面板中编辑</div>
        <Modal open centered title={<span style={{color:theme.node.text}}>资产规划</span>} width="min(1280px, calc(100vw - 32px))"
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
