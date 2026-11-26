import { nanoid } from "nanoid";
import { canvasCasUrl } from "@/features/backend-sync/canvas-cas";
import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { buildDramaVideoInput } from "./drama-pipeline-media";
import {dramaProductionSettingFingerprint,dramaDefaultProduction} from "./drama-video-production-resolver";

export type DramaRefreshFields = {prompt:boolean;duration:boolean;references?:boolean;overwrite:boolean};
export type DramaBatchCreateResult={createdShotIds:string[];failures:{shotId:string;error:string}[]};

/** Classify every submitted shot against the current confirmed graph before mutating it. */
export function planDramaBatchVideoConfigs(source:CanvasNodeData|undefined,confirmedShots:readonly ReturnType<typeof buildDramaVideoInput>["shot"][],inputs:ReturnType<typeof buildDramaVideoInput>[],nodes:CanvasNodeData[],connections:CanvasConnection[],style?:string,ratio?:string){
 const existing=source?findDramaVideoConfigs(source.id,nodes,connections):new Map();
 const failures:DramaBatchCreateResult["failures"]=[];
 const seen=new Set<string>();
 const confirmedById=new Map(confirmedShots.map(shot=>[shot.id,JSON.stringify(shot)]));
 const valid=inputs.filter(input=>{
  const id=input.shot.id;
  if(seen.has(id))return false;
  seen.add(id);
  const error=!source?"分镜节点已不存在":existing.has(id)?"视频配置已存在，请刷新列表":confirmedById.get(id)!==JSON.stringify(input.shot)?"确认镜头已变化，请重新预检":undefined;
  const snapshot=input.productionSnapshot;
  const saved=source?.metadata?.dramaShotProduction?.[id];
  // With no saved setting, the default inferred mode is the audited mode.
  const setting=saved??(snapshot?{...dramaDefaultProduction(input),mode:input.mode??dramaDefaultProduction(input).mode}:undefined);
  const stale=snapshot&&((snapshot.sourceRevisionId!==undefined&&snapshot.sourceRevisionId!==source?.metadata?.dramaConfirmedVersionId)||
   snapshot.settingFingerprint!==dramaProductionSettingFingerprint(setting)&&snapshot.settingFingerprint!==dramaProductionSettingFingerprint(saved));
  const reason=error??(stale?"镜头生产设置已变化，请重新预检":undefined);
  if(reason)failures.push({shotId:id,error:reason});
  return !reason;
 });
 const graph=source?buildDramaVideoConfigGraph(source,valid,nodes,connections,style,ratio):{nodes,connections,configIds:[]};
 const createdSet=new Set(graph.configIds);
 const createdShotIds=graph.nodes.filter(node=>createdSet.has(node.id)).flatMap(node=>node.metadata?.dramaShotId?[node.metadata.dramaShotId]:[]);
 for(const input of valid)if(!createdShotIds.includes(input.shot.id))failures.push({shotId:input.shot.id,error:"未创建视频配置，请重新预检"});
 return {graph,result:{createdShotIds,failures} satisfies DramaBatchCreateResult};
}

function referenceBaseline(node:CanvasNodeData,connections:CanvasConnection[],nodes:CanvasNodeData[]) {
    return JSON.stringify({mode:node.metadata?.videoMode,references:node.metadata?.videoReferences,
        workflow:node.metadata?.comfyWorkflowSelections?.video,
        edges:connections.filter(edge=>edge.toNodeId===node.id&&edge.fromNodeId!==node.metadata?.dramaVideoSource?.nodeId)
            .map(edge=>[edge.fromNodeId,edge.fromPortId??"",edge.toPortId??"",
                nodes.find(input=>input.id===edge.fromNodeId)?.metadata?.storageKey??""]).sort()});
}

export function refreshDramaVideoConfigGraph(source:CanvasNodeData,input:ReturnType<typeof buildDramaVideoInput>,
    configId:string,nodes:CanvasNodeData[],connections:CanvasConnection[],fields:DramaRefreshFields,style?:string,ratio?:string) {
    const current=nodes.find(node=>node.id===configId);
    if(!current)throw Error("视频配置已删除");
    const metadata=refreshDramaVideoConfig(current,input,fields);
    if(fields.prompt&&current.metadata?.dramaVideoSource?.visualStyle!==style){
        const oldStyle=current.metadata?.dramaVideoSource?.visualStyle;
        const suffix=current.metadata!.dramaVideoSource!.prompt.slice(current.metadata!.dramaVideoSource!.basePrompt!.length);
        const oldLine=oldStyle?`\n影片风格：${oldStyle}`:"";
        const refs=oldLine&&suffix.startsWith(oldLine)?suffix.slice(oldLine.length):suffix;
        metadata.prompt=input.prompt+(style?`\n影片风格：${style}`:"")+refs;
        metadata.composerContent=metadata.prompt;
        metadata.dramaVideoSource={...metadata.dramaVideoSource!,prompt:metadata.prompt,visualStyle:style};
    }
    if(!fields.references)return {nodes:nodes.map(node=>node.id===configId?{...node,metadata}:node),connections};
    if(!fields.prompt)throw Error("采用参考图时需要同时更新提示词中的图片引用");
    const baseline=current.metadata?.dramaVideoSource?.referenceBaseline;
    if(!fields.overwrite&&(!baseline||baseline!==referenceBaseline(current,connections,nodes)))
        throw Error("参考图连线或输入设置已有人工修改，或基线待核对，请明确选择覆盖后再采用");
    const graph=buildDramaVideoConfigGraph(source,[input],nodes.filter(node=>node.id!==configId),
        connections.filter(edge=>edge.toNodeId!==configId&&edge.fromNodeId!==configId),style,ratio);
    const proposed=graph.nodes.find(node=>graph.configIds.includes(node.id))!;
    const nextConnections=[...connections.filter(edge=>edge.toNodeId!==configId||edge.fromNodeId===source.id),
        ...graph.connections.filter(edge=>edge.toNodeId===proposed.id&&edge.fromNodeId!==source.id)
            .map(edge=>({...edge,toNodeId:configId}))];
    const next={...current,metadata:{...metadata,videoMode:proposed.metadata?.videoMode,
        videoReferences:proposed.metadata?.videoReferences,
        comfyWorkflowSelections:{...metadata.comfyWorkflowSelections,video:proposed.metadata?.comfyWorkflowSelections?.video},
        prompt:proposed.metadata?.prompt,composerContent:proposed.metadata?.composerContent,
        dramaVideoSource:{...metadata.dramaVideoSource!,referenceKeys:proposed.metadata!.dramaVideoSource!.referenceKeys,
            prompt:proposed.metadata!.prompt!,revisionId:source.metadata?.dramaConfirmedVersionId}}};
    next.metadata.dramaVideoSource.referenceBaseline=referenceBaseline(next,nextConnections,graph.nodes);
    return {nodes:[...nodes.map(node=>node.id===configId?next:node),
        ...graph.nodes.filter(node=>!nodes.some(old=>old.id===node.id)&&node.id!==proposed.id)],connections:nextConnections};
}

export function refreshDramaVideoConfig(config:CanvasNodeData,input:ReturnType<typeof buildDramaVideoInput>,
    fields:DramaRefreshFields){
    const source=config.metadata?.dramaVideoSource;
    if(!source?.basePrompt)throw Error("此配置缺少派生基线，请手动核对");
    const metadata={...config.metadata};
    const nextSource={...source};
    if(fields.prompt){
        if(!fields.overwrite&&(source.productionSnapshot?.manualPrompt||metadata.prompt!==source.prompt||metadata.composerContent!==source.prompt))
            throw Error("配置提示词已有人工修改，请明确选择覆盖后再采用");
        const prompt=input.prompt+source.prompt.slice(source.basePrompt.length);
        metadata.prompt=prompt;
        metadata.composerContent=prompt;
        nextSource.prompt=prompt;
        nextSource.basePrompt=input.prompt;
        nextSource.promptShot=JSON.stringify(input.shot);
        // A legacy refresh is not a new production audit. Invalidate the old snapshot.
        delete nextSource.productionSnapshot;
    }
    if(fields.duration&&input.shot.durationSec){
        if(!fields.overwrite&&metadata.seconds!==source.seconds)
            throw Error("配置时长已有人工修改，请明确选择覆盖后再采用");
        metadata.seconds=String(input.shot.durationSec);
        nextSource.seconds=metadata.seconds;
    }
    metadata.dramaVideoSource=nextSource;
    return metadata;
}

export function findDramaVideoConfigs(sourceId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const targets = new Set(connections.filter(edge => edge.fromNodeId === sourceId).map(edge => edge.toNodeId));
    const configs = new Map<string, CanvasNodeData>();
    for (const node of nodes) {
        const shotId = node.metadata?.dramaShotId;
        if (node.type === CanvasNodeType.Config && shotId && targets.has(node.id) && !configs.has(shotId)) {
            configs.set(shotId, node);
        }
    }
    return configs;
}

export function buildDramaVideoConfigGraph(
    source: CanvasNodeData,
    inputs: ReturnType<typeof buildDramaVideoInput>[],
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    style?: string,
    ratio?: string,
) {
    const configs = findDramaVideoConfigs(source.id, nodes, connections);
    const imageByKey = new Map(nodes.flatMap(node => {
        const key = node.metadata?.storageKey;
        return node.type === CanvasNodeType.Image && key && !node.metadata?.images?.length ? [[key, node] as const] : [];
    }));
    const added: CanvasNodeData[] = [];
    const edges: CanvasConnection[] = [];
    const configIds: string[] = [];
    const top = Math.max(source.position.y, ...Array.from(configs.values(), node => node.position.y + node.height + 32));
    let y = top;
    let imageByKeyAdded = 0;
    for (const { shot, episodeTitle,prompt, referenceImages, mode,comfyBinding,productionSnapshot } of inputs) {
        if (configs.has(shot.id)) continue;
        const refs = referenceImages.flatMap(reference => {
            const key = reference.storageKey;
            if (!key || !/^cas:[a-f0-9]{64}$/.test(key)) return [];
            const existing = imageByKey.get(key);
            if (existing) return [{ node: existing, name: reference.name }];
            const image = createCanvasNode(CanvasNodeType.Image,
                { x: source.position.x + source.width + 160, y: top + 120 + imageByKeyAdded * 240 },
                { content: canvasCasUrl(key) ?? "", storageKey: key, status: "success", mimeType: reference.type });
            imageByKeyAdded++;
            image.title = `参考图 · ${reference.name}`;
            imageByKey.set(key, image);
            added.push(image);
            return [{ node: image, name: reference.name }];
        });
        const text = [
            productionSnapshot?.prompt??prompt,
            !productionSnapshot&&style && `影片风格：${style}`,
            ...refs.map(ref => `${ref.name}：@[node:${ref.node.id}]`),
        ].filter(Boolean).join("\n");
        const workflowBinding=comfyBinding?{...comfyBinding,slots:Object.fromEntries(Object.entries(comfyBinding.slots)
            .flatMap(([portId,slot])=>{
                const index=referenceImages.findIndex(reference=>reference.id===slot.nodeId);
                return refs[index]?[[portId,{nodeId:refs[index].node.id}]]:[];
            }))}:undefined;
        const config = createCanvasNode(CanvasNodeType.Config, { x: 0, y: 0 }, {
            generationMode: "video",
            ...(productionSnapshot?.target.kind==="online"?{model:productionSnapshot.target.modelOption}:{}),
            ...(workflowBinding?{comfyWorkflowSelections:{video:workflowBinding}}:{}),
            videoMode: mode ?? (refs.length ? "omni_reference" : "text_to_video"),
            videoReferences:refs.map((ref,index)=>({id:ref.node.id,kind:"image",
                role:mode==="first_frame"?"first_frame":mode==="first_last_frame"?(index?"last_frame":"first_frame"):"reference_image"})),
            ...((productionSnapshot?.durationSec??shot.durationSec)?{seconds:String(productionSnapshot?.durationSec??shot.durationSec)}:{}),
            dramaShotId: shot.id,
            dramaVideoSource: {
                nodeId: source.id,
                revisionId: source.metadata?.dramaConfirmedVersionId,
                shot: JSON.stringify(shot),
                referenceKeys: referenceImages.flatMap(reference => reference.storageKey ? [reference.storageKey] : []),
                prompt: text,
                basePrompt:productionSnapshot?.manualPrompt?productionSnapshot.prompt:prompt,
                visualStyle:style,
                seconds:(productionSnapshot?.durationSec??shot.durationSec)?String(productionSnapshot?.durationSec??shot.durationSec):undefined,
                ...(productionSnapshot?{productionSnapshot}:{}),
            },
            prompt: text,
            composerContent: text,
            ...((productionSnapshot?.aspectRatio??ratio) ? { videoRatio: productionSnapshot?.aspectRatio??ratio } : {}),
        });
        config.position = { x: source.position.x + source.width + 400, y };
        y += config.height + 32;
        config.title = `${episodeTitle?.trim()||"未命名剧集"} · 镜头 ${shot.order} · 视频配置`;
        added.push(config);
        configs.set(shot.id, config);
        configIds.push(config.id);
        for (const fromNodeId of [source.id, ...refs.map(ref => ref.node.id)]) {
            const slot=workflowBinding&&Object.entries(workflowBinding.slots).find(([,value])=>value.nodeId===fromNodeId)?.[0];
            edges.push({ id: nanoid(), fromNodeId, toNodeId: config.id,...(slot?{fromPortId:"image",toPortId:slot}:{}) });
        }
        config.metadata!.dramaVideoSource!.referenceBaseline=referenceBaseline(config,edges,[...nodes,...added]);
    }
    return { nodes: [...nodes, ...added], connections: [...connections, ...edges], configIds };
}
