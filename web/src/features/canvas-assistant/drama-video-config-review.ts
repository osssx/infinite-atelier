import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import type {DramaVideoInput} from "./drama-pipeline-media";
import {buildDramaVideoConfigGraph,dramaVideoExecutionBaseline,dramaVideoReferenceBaseline,type DramaRefreshFields} from "./drama-video-config";
import {dramaProductionSettingFingerprint} from "./drama-video-production-resolver";
import {validateCanvasPortConnections} from "@/lib/canvas/canvas-port-connections";
import {readStoryboardDraft} from "./canvas-drama-pipeline";

const json=(value:unknown)=>JSON.stringify(value);
const keys=(input:DramaVideoInput)=>input.referenceImages.map(ref=>ref.storageKey??"");
const bindingFor=(node:CanvasNodeData)=>node.metadata?.comfyMediaPreset??node.metadata?.comfyWorkflowSelections?.video;
const targetFor=(node:CanvasNodeData)=>{
 const binding=bindingFor(node);
 return binding?{kind:"comfy",templateId:binding.templateId,templateRevision:binding.templateRevision}:node.metadata?.model?{kind:"online",modelOption:node.metadata.model}:null;
};
const inputMode=(input:DramaVideoInput)=>input.mode??(input.referenceImages.length?"omni_reference":"text_to_video");
function sameReferenceBaseline(saved:string|undefined,current:string){
 if(!saved)return false;
 try{
  const clean=(value:string)=>{const parsed=JSON.parse(value);if(parsed.workflow)delete parsed.workflow.lastRunId;return json(parsed);};
  return clean(saved)===clean(current);
 }catch{return false;}
}

const roleFor=(mode:string,index:number)=>mode==="first_frame"?"first_frame":mode==="first_last_frame"?(index?"last_frame":"first_frame"):"reference_image";
function routeMatches(node:CanvasNodeData,input:DramaVideoInput,nodes:CanvasNodeData[],connections:CanvasConnection[]){
 const m=node.metadata,desired=input.productionSnapshot;
 if(!desired||m?.generationMode!=="video"||json(targetFor(node))!==json(desired.target)||m.videoMode!==inputMode(input))return false;
 const byId=new Map(nodes.map(n=>[n.id,n]));
 const actual=m.videoReferences??[];
 if(json(actual.map(ref=>[ref.kind,ref.role,byId.get(ref.id)?.metadata?.storageKey]))!==json(keys(input).map((key,index)=>["image",roleFor(inputMode(input),index),key])))return false;
 const binding=bindingFor(node),wanted=input.comfyBinding;
 if(Boolean(binding)!==Boolean(wanted))return false;
 if(binding&&wanted){
  if(binding.mediaMode!==wanted.mediaMode)return false;
  const ports=Object.entries(binding.slots).map(([port,slot])=>[port,byId.get(slot.nodeId)?.metadata?.storageKey,slot.imageId??""]).sort();
  const targetPorts=Object.entries(wanted.slots).map(([port,slot])=>[port,input.referenceImages.find(ref=>ref.id===slot.nodeId)?.storageKey,slot.imageId??""]).sort();
  if(json(ports)!==json(targetPorts))return false;
 }
 const inbound=connections.filter(e=>e.toNodeId===node.id&&e.fromNodeId!==m.dramaVideoSource?.nodeId);
 return actual.every(ref=>inbound.some(e=>e.fromNodeId===ref.id&&(!binding||Object.entries(binding.slots).some(([port,slot])=>slot.nodeId===ref.id&&e.toPortId===port))));
}

export type DramaVideoConfigReview={
 token:string;routeChanged:boolean;promptChanged:boolean;durationChanged:boolean;aspectChanged:boolean;
 promptManual:boolean;executionManual:boolean;durationEditable:boolean;aspectEditable:boolean;
 currentPrompt:string;nextPrompt:string;currentDuration:string;nextDuration:string;currentAspect:string;nextAspect:string;
 currentEngine:string;nextEngine:string;currentMode:string;nextMode:string;currentCount:number;nextCount:number;
};
export function reviewDramaVideoConfig(node:CanvasNodeData,input:DramaVideoInput,nodes:CanvasNodeData[],connections:CanvasConnection[]):DramaVideoConfigReview{
 const m=node.metadata,source=m?.dramaVideoSource,snapshot=input.productionSnapshot;
 if(!source||!snapshot)throw Error("此配置缺少派生基线或有效预检，请先核对配置");
 const currentPrompt=source.productionSnapshot?.prompt??source.basePrompt??"";
 const promptManual=m?.prompt!==source.prompt||m?.composerContent!==source.prompt;
 const referenceState=dramaVideoReferenceBaseline(node,connections,nodes);
 const executionState=dramaVideoExecutionBaseline(node);
 // Older snapshots have no execution baseline. Infer only when every known
 // execution field and the old reference baseline agree; otherwise require review.
 const old=source.productionSnapshot;
 const executionManual=source.productionBaseline?source.productionBaseline!==executionState||!sameReferenceBaseline(source.referenceBaseline,referenceState):
  !old||json(targetFor(node))!==json(old.target)||String(old.durationSec)!==m?.seconds||old.aspectRatio!==m?.videoRatio||
  !sameReferenceBaseline(source.referenceBaseline,referenceState);
 const routeChanged=!old||!routeMatches(node,input,nodes,connections);
 const currentDuration=m?.seconds??"",currentAspect=m?.videoRatio??"";
 const durationEditable=snapshot.target.kind==="online"||!!input.comfyParameterPorts?.duration_seconds;
 const aspectEditable=snapshot.target.kind==="online"||!!input.comfyParameterPorts?.aspect_ratio;
 const promptChanged=currentPrompt!==snapshot.prompt||promptManual;
 const portChanged=(key:"duration_seconds"|"aspect_ratio")=>{
  const port=input.comfyParameterPorts?.[key];
  return !!port&&json(bindingFor(node)?.overrides[port])!==json(input.comfyBinding?.overrides[port]);
 };
 const durationChanged=currentDuration!==String(snapshot.durationSec)||portChanged("duration_seconds");
 const aspectChanged=currentAspect!==snapshot.aspectRatio||portChanged("aspect_ratio");
 const token=json([node.id,source,m?.prompt,m?.composerContent,executionState,referenceState,
  connections.filter(e=>e.fromNodeId===node.id||e.toNodeId===node.id),input]);
 return {token,routeChanged,promptChanged,durationChanged,aspectChanged,promptManual,executionManual,durationEditable,aspectEditable,
  currentPrompt:promptManual?(m?.composerContent??m?.prompt??"").replace(/@\[node:[^\]]+\]/g,"[图片引用]"):currentPrompt,
  nextPrompt:snapshot.prompt,
  currentDuration:old?.workflowControlledParameters?.includes("duration_seconds")||!routeChanged&&old?.target.kind==="comfy"&&!durationEditable?"由工作流决定":currentDuration||"未设置",
  nextDuration:durationEditable?String(snapshot.durationSec):"由工作流决定",
  currentAspect:old?.workflowControlledParameters?.includes("aspect_ratio")||!routeChanged&&old?.target.kind==="comfy"&&!aspectEditable?"由工作流决定":currentAspect||"未设置",
  nextAspect:aspectEditable?snapshot.aspectRatio:"由工作流决定",
  currentEngine:old&&json(old.target)===json(targetFor(node))&&old.channelLabel?[old.channelLabel,old.modelLabel].filter(Boolean).join(" · "):bindingFor(node)?"本地 ComfyUI":m?.model?"在线模型":"旧配置（渠道待核对）",
  nextEngine:snapshot.channelLabel?[snapshot.channelLabel,snapshot.modelLabel].filter(Boolean).join(" · "):snapshot.target.kind==="comfy"?"本地 ComfyUI":"在线模型",
  currentMode:m?.videoMode??"",nextMode:inputMode(input),currentCount:m?.videoReferences?.length??0,nextCount:input.referenceImages.length};
}

function assertCurrentShot(source:CanvasNodeData,input:DramaVideoInput){
 const snapshot=input.productionSnapshot;
 if(!snapshot)throw Error("请先通过当前镜头输入预检");
 const shot=readStoryboardDraft(source.metadata?.dramaConfirmed??"")?.shots.find(s=>s.id===input.shot.id);
 const saved=source.metadata?.dramaShotProduction?.[input.shot.id];
 const defaultSetting={mode:inputMode(input)};
 if(!shot||json(shot)!==json(input.shot)||snapshot.sourceRevisionId!==source.metadata?.dramaConfirmedVersionId||
  snapshot.settingFingerprint!==dramaProductionSettingFingerprint(saved??defaultSetting)&&snapshot.settingFingerprint!==dramaProductionSettingFingerprint(saved))
  throw Error("镜头生产设置已变化，请重新预检");
}
function reachable(from:string,to:string,edges:CanvasConnection[]){
 const seen=new Set<string>(),queue=[from];
 while(queue.length){const id=queue.pop()!;if(id===to)return true;if(seen.has(id))continue;seen.add(id);
  for(const edge of edges)if(edge.fromNodeId===id)queue.push(edge.toNodeId);}
 return false;
}
/** Apply only reviewed fields to a live graph. Route switches are atomic with
 * prompt and parameters; unknown/manual connections are never silently removed. */
export function applyDramaVideoConfigReview(source:CanvasNodeData,input:DramaVideoInput,configId:string,nodes:CanvasNodeData[],connections:CanvasConnection[],fields:DramaRefreshFields,style?:string){
 assertCurrentShot(source,input);
 const current=nodes.find(n=>n.id===configId);
 if(!current||current.metadata?.dramaShotId!==input.shot.id||current.metadata.dramaVideoSource?.nodeId!==source.id||
  !connections.some(e=>e.fromNodeId===source.id&&e.toNodeId===configId))throw Error("视频配置已删除或来源已变化");
 const review=reviewDramaVideoConfig(current,input,nodes,connections),snapshot=input.productionSnapshot!;
 if(!fields.expectedReview||fields.expectedReview!==review.token)throw Error("配置内容已变化，请重新审核");
 if(!fields.prompt&&!fields.duration&&!fields.aspect&&!fields.references)throw Error("请选择需要更新的字段");
 if(fields.prompt&&review.promptManual&&!fields.overwrite)throw Error("配置提示词已有人工修改，请明确选择覆盖后再采用");
 const execution=!!(fields.references||fields.duration||fields.aspect);
 if(execution&&review.executionManual&&!fields.overwrite)throw Error("生成设置或参考连线已有人工修改，请明确选择覆盖后再采用");
 if(review.routeChanged&&!fields.references)throw Error("渠道或参考素材已变化，请同时更新生成设置与提示词");
 if(fields.references&&(!fields.prompt||!fields.duration||!fields.aspect))throw Error("更新渠道和输入需要同时采用提示词、时长及画幅");
 const old=current.metadata!,baseline=old.dramaVideoSource!;
 let next={...current,metadata:{...old,dramaVideoSource:{...baseline}}};
 let nextNodes=nodes,nextConnections=connections;
 const nextSource=next.metadata.dramaVideoSource;
 if(fields.references){
  const binding=bindingFor(current);
  const managed=new Set(binding?Object.entries(binding.slots).map(([port,slot])=>json([slot.nodeId,"image",port])):
   (old.videoReferences??[]).map(ref=>json([ref.id,"",""])));
  const seen=new Set<string>();
  if(connections.some(e=>{
   if(e.toNodeId!==configId||e.fromNodeId===source.id)return false;
   const key=json([e.fromNodeId,e.fromPortId??"",e.toPortId??""]);
   if(!managed.has(key)||seen.has(key))return true;
   seen.add(key);return false;
  }))throw Error("存在额外人工输入连线，请先在画布中核对，未自动删除");
  if(review.routeChanged&&connections.some(e=>e.fromNodeId===configId&&(e.fromPortId||e.toPortId)))
   throw Error("存在带端口的下游连线，请先在画布中核对，未自动切换工作流");
  const graph=buildDramaVideoConfigGraph(source,[input],nodes.filter(n=>n.id!==configId),connections.filter(e=>e.toNodeId!==configId&&e.fromNodeId!==configId),style);
  const proposed=graph.nodes.find(n=>n.id===graph.configIds[0]);
  if(!proposed?.metadata?.dramaVideoSource)throw Error("未创建有效的配置预览");
  const pm=proposed.metadata;
  const newEdges=graph.connections.filter(e=>e.toNodeId===proposed.id&&e.fromNodeId!==source.id).map(e=>({...e,toNodeId:configId}));
  const preserved=connections.filter(e=>e.toNodeId!==configId||e.fromNodeId===source.id);
  if(newEdges.some(e=>reachable(configId,e.fromNodeId,preserved)))throw Error("素材连线将形成循环，请更换参考图片");
  nextConnections=[...preserved,...newEdges];
  next={...current,metadata:{...old,model:pm.model,generationMode:"video",videoMode:pm.videoMode,videoReferences:pm.videoReferences,
   comfyMediaPreset:undefined,comfyMediaPreviewRatio:undefined,comfyWorkflowSelections:{...old.comfyWorkflowSelections,video:pm.comfyWorkflowSelections?.video},
   seconds:pm.seconds,videoRatio:pm.videoRatio,prompt:pm.prompt,composerContent:pm.composerContent,dramaVideoSource:{...pm.dramaVideoSource!}}};
  nextNodes=[...nodes.map(n=>n.id===configId?next:n),...graph.nodes.filter(n=>n.id!==proposed.id&&!nodes.some(o=>o.id===n.id))];
  const affected=new Set(nextConnections.filter(e=>e.fromNodeId===configId||e.toNodeId===configId).map(e=>e.id));
  if(validateCanvasPortConnections(nextNodes,nextConnections).some(e=>affected.has(e.connectionId)))throw Error("新工作流与当前连线不兼容，请检查端口");
  next.metadata.dramaVideoSource.referenceBaseline=dramaVideoReferenceBaseline(next,nextConnections,nextNodes);
  next.metadata.dramaVideoSource.productionBaseline=dramaVideoExecutionBaseline(next);
  return {nodes:nextNodes,connections:nextConnections};
 }
 if(execution&&review.executionManual)throw Error("生成设置已有人工修改，请整体审核采用，或在画布中手动更新");
 if(fields.prompt&&!sameReferenceBaseline(baseline.referenceBaseline,dramaVideoReferenceBaseline(current,connections,nodes)))
  throw Error("参考图连线已有人工修改，请在画布中核对后再更新提示词");
 if(fields.duration&&!review.durationEditable||fields.aspect&&!review.aspectEditable)throw Error("当前工作流未声明可编辑参数，请检查工作流模板");
 if(fields.prompt){
  const prefix=baseline.productionSnapshot?.prompt??baseline.basePrompt;
  if(!prefix||!baseline.prompt.startsWith(prefix))throw Error("旧提示词来源待核对，请整体审核采用");
  const text=snapshot.prompt+baseline.prompt.slice(prefix.length);
  next.metadata.prompt=text;next.metadata.composerContent=text;nextSource.prompt=text;nextSource.basePrompt=snapshot.prompt;
  nextSource.promptShot=json(input.shot);nextSource.visualStyle=style;
 }
 if(fields.duration)next.metadata.seconds=nextSource.seconds=String(snapshot.durationSec);
 if(fields.aspect)next.metadata.videoRatio=nextSource.aspectRatio=snapshot.aspectRatio;
 if(execution&&input.comfyBinding){
  const currentBinding=bindingFor(current);
  if(!currentBinding)throw Error("工作流绑定已变化，请重新审核");
  const overrides={...currentBinding.overrides};
  for(const param of [fields.duration?"duration_seconds":null,fields.aspect?"aspect_ratio":null] as const){
   if(!param)continue;const port=input.comfyParameterPorts?.[param];if(!port||!(port in input.comfyBinding.overrides))throw Error("工作流参数映射已变化，请重新审核");
   overrides[port]=input.comfyBinding.overrides[port];
  }
  const updated={...currentBinding,overrides};
  if(old.comfyMediaPreset)next.metadata.comfyMediaPreset=updated;
  else next.metadata.comfyWorkflowSelections={...old.comfyWorkflowSelections,video:updated};
 }
 // A partial application is not a claim that the entire new source revision was adopted.
 if(baseline.productionSnapshot){
  const previous=baseline.productionSnapshot;
  nextSource.productionSnapshot={...previous,...(fields.prompt?{prompt:snapshot.prompt,manualPrompt:snapshot.manualPrompt,promptSourceFingerprint:snapshot.promptSourceFingerprint}:{}),
   ...(fields.duration?{durationSec:snapshot.durationSec}:{}),...(fields.aspect?{aspectRatio:snapshot.aspectRatio}:{}),sourceRevisionId:undefined,settingFingerprint:""};
 }
 nextNodes=nodes.map(n=>n.id===configId?next:n);
 if(execution){nextSource.productionBaseline=dramaVideoExecutionBaseline(next);nextSource.referenceBaseline=dramaVideoReferenceBaseline(next,nextConnections,nextNodes);}
 return {nodes:nextNodes,connections:nextConnections};
}
