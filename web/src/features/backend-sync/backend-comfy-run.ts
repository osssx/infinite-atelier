import {assignComfyMediaSlots,resolveComfyMediaMode} from "@/features/comfy-workflow/comfy-media-slot-assignment";
import type {CanvasNodeData,CanvasConnection} from "@/types/canvas";
import type {ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";
import type {MediaModeId} from "@/services/media-capabilities";
import {resolveMediaCapabilities,validateMediaRequest} from "@/services/media-capabilities";
import {missingComfyMediaInputs} from "@/features/comfy-workflow/run-types";
import {prepareCanvasExternalInputSnapshot} from "@/lib/canvas/canvas-external-input-snapshot";
import type {BackendCanvasGraph} from "./canvas-backend-sync";
import {canonicalBackendGraph,fingerprintComfyTargetBinding} from "./backend-source-fingerprint";
import {canvasCasUrl,isCanvasCasKey} from "./canvas-cas";
import type {BlobUploadResponse,BackendJobView} from "@/types/backend-contracts";
import {bboxLayoutToModelJson,validateBboxLayout} from "@/lib/canvas/bbox-layout";

type Submitter={
 state:{status:string};
 assertNoActiveJob?:(nodeId:string)=>Promise<void>;
 assertComfyReady:(instanceId:string)=>Promise<void>;
 saveProjectNow:(draft:BackendCanvasGraph,nodeId:string)=>Promise<{projectId:string;revision:number;sourceNodeFingerprint:string}>;
 uploadFrozenBlob:(blob:Blob,mime:string)=>Promise<BlobUploadResponse>;
 submitFrozenJob:(payload:Record<string,unknown>)=>Promise<BackendJobView>;
};
const copy=<T,>(item:T):T=>JSON.parse(JSON.stringify(item)) as T;

export type BackendComfyWorkflowArgs={
 bridge:Submitter;projectId:string;workflowNode:CanvasNodeData;
 nodes:readonly CanvasNodeData[];connections:readonly CanvasConnection[];
 template:ComfyWorkflowTemplate;instanceId:string;outputPortIds:readonly string[];
 mediaSlots?:Record<string,{nodeId:string;imageId?:string}>;
 prompt?:string;
 mediaBinding?:NonNullable<CanvasNodeData["metadata"]>["comfyMediaPreset"];
 workflowMode?:"image"|"video"|"audio";
 generationMode?:MediaModeId;
 beforeSubmit?:()=>void;
 submitFrozenJob?:(payload:Record<string,unknown>)=>Promise<BackendJobView>;
 readBlob?:(storageKey:string)=>Promise<Blob|null>;
 getBlob?:(url:string)=>Promise<Blob|null>;
 newKey?:()=>string;
};
async function fromBrowserUrl(url:string):Promise<Blob|null>{
 if(!url.startsWith("blob:")&&!url.startsWith("data:"))return null;
 const response=await fetch(url,{cache:"no-store"});
 return response.ok?response.blob():null;
}

export async function prepareBackendComfyWorkflowRun(args:BackendComfyWorkflowArgs,
 {readOnly=false,continuitySourceId}:{readOnly?:boolean;continuitySourceId?:string}={}){
 const {bridge,workflowNode,template,instanceId,outputPortIds}=args;
 if(bridge.state.status!=="connected")throw Error("backend_sync_not_connected");
 await bridge.assertComfyReady(instanceId);
 // The SQLite JobCoordinator owns pending status, recovery and the retry fence.
 // Never read or replay a frozen submission out of browser storage.
 if(!bridge.assertNoActiveJob)throw Error("backend_sqlite_job_guard_missing");
 await bridge.assertNoActiveJob(workflowNode.id);
 if(!instanceId||outputPortIds.length<1||outputPortIds.length>16||
    new Set(outputPortIds).size!==outputPortIds.length||
    outputPortIds.some(id=>!template.ports.some(port=>port.id===id&&port.direction==="source"&&
      port.capture?.kind!=="none"&&!!port.capture?.adapterId)))
  throw Error("backend_invalid_output_ports");
 const mediaBinding=args.mediaBinding??workflowNode.metadata?.comfyMediaPreset;
 const regularBinding=workflowNode.metadata?.comfyWorkflow;
 const binding=mediaBinding??regularBinding;
 if(!binding||binding.templateId!==template.id||binding.templateRevision!==template.revision)
  throw Error("backend_template_revision_mismatch");
 const graph=copy<BackendCanvasGraph>({nodes:[...args.nodes],connections:[...args.connections]});
 const original=canonicalBackendGraph(graph);
 const currentNode=graph.nodes.find(node=>node.id===workflowNode.id);
 if(!currentNode||currentNode.id!==workflowNode.id||
   currentNode.type!=="comfy:workflow"&&(!mediaBinding||!template.mediaUseCase||
    !["image","video","audio","config"].includes(currentNode.type)))throw Error("backend_workflow_node_missing");
 const allIncoming=graph.connections.filter(edge=>edge.toNodeId===workflowNode.id);
 // Media preset nodes may also carry old, untyped canvas references. They are
 // visual context only; only edges targeting declared Comfy ports can be sent.
 const incoming=mediaBinding?allIncoming.filter(edge=>!!edge.toPortId&&template.ports.some(port=>port.id===edge.toPortId)):allIncoming;
 const useCase=template.mediaUseCase;
 const explicitMode=mediaBinding?.mediaMode??args.generationMode;
 let generationMode=useCase?.mediaCapabilities?resolveComfyMediaMode(template,workflowNode.id,graph.nodes,graph.connections,explicitMode):undefined;
 let continuityPort:string|undefined;
 const assignmentGraph=continuitySourceId?copy(graph):graph;
 if(continuitySourceId){
  if(graph.nodes.some(node=>node.id===continuitySourceId))throw Error("接力素材标识已占用");
  assignmentGraph.nodes.push({id:continuitySourceId,type:"image" as CanvasNodeData["type"],title:"接力尾帧",
   position:{x:0,y:0},width:1,height:1,metadata:{storageKey:"cas:"+"0".repeat(64),mimeType:"image/png"}});
  const modes=(useCase?.mediaCapabilities?.modes??[]).filter(mode=>mode.enabled&&(!explicitMode||mode.id===explicitMode));
  modes.sort((a,b)=>Number(b.id==="first_frame")-Number(a.id==="first_frame"));
  let diagnostic="该工作流的当前模式没有首帧输入，请选择支持首帧的模式";
  for(const mode of modes){
   const ports=useCase?.modeBindings?.[mode.id]?.rolePorts?.first_frame;
   const portId=ports?.[0];
   if(ports?.length!==1||!portId||!template.ports.some(port=>port.id===portId&&port.direction==="target"&&port.valueKind==="IMAGE"))continue;
   const manual=assignComfyMediaSlots(template,workflowNode.id,graph.nodes,graph.connections,mode.id);
   if(incoming.some(edge=>edge.toPortId===portId)||args.mediaSlots?.[portId]||manual.slots[portId]||
      Object.hasOwn(mediaBinding?.overrides??regularBinding?.inputOverrides??{},portId)){
    diagnostic="首帧输入已占用，请清除手动首帧或选择独立开场";continue;
   }
   const edge={id:"handoff-"+continuitySourceId,fromNodeId:continuitySourceId,fromPortId:"image",toNodeId:workflowNode.id,toPortId:portId};
   if(mediaBinding&&workflowNode.type!=="comfy:workflow"){
    const candidate=assignComfyMediaSlots(template,workflowNode.id,assignmentGraph.nodes,[...graph.connections,edge],mode.id);
    if(candidate.errors.length){diagnostic=candidate.errors.join("；");continue;}
   }
   generationMode=mode.id;continuityPort=portId;assignmentGraph.connections.push(edge);incoming.push(edge);break;
  }
  if(!continuityPort)throw Error(diagnostic);
 }
 const modeBinding=generationMode?useCase?.modeBindings?.[generationMode]:undefined;
 const mappedPorts=new Set(Object.values(modeBinding?.rolePorts??{}).flat());
 const autoAssignment=mediaBinding&&workflowNode.type!=="comfy:workflow"?assignComfyMediaSlots(template,workflowNode.id,assignmentGraph.nodes,assignmentGraph.connections,generationMode):undefined;
 if(autoAssignment?.errors.length)throw Error(autoAssignment.errors.join("；"));
 const selectedSlots=autoAssignment?.slots??args.mediaSlots??{};
 const mediaEdges:CanvasConnection[]=[];
 if(mediaBinding&&useCase){
  const selected=selectedSlots;
  if(useCase.mediaCapabilities){
   const resolved=resolveMediaCapabilities({mediaCapabilities:useCase.mediaCapabilities},{kind:useCase.channel,
    supportedModes:Object.keys(useCase.modeBindings??{}),supportedParameters:[...new Set(Object.values(useCase.modeBindings??{}).flatMap(binding=>Object.keys(binding?.parameterPorts??{})))]});
   if(!generationMode)throw Error("Comfy 模板要求选择生成模式");
   const mapping=useCase.modeBindings?.[generationMode];
   if(!mapping)throw Error("当前 Comfy 模板未绑定该生成模式");
   const activePorts=new Set(Object.values(mapping.rolePorts??{}).flat());
   const refs:Array<{role:string;kind:string}>=[];
   for(const [role,portIds] of Object.entries(mapping.rolePorts??{}))for(const portId of portIds){
    if(selected[portId]||incoming.some(edge=>edge.toPortId===portId)){
     const kind=template.ports.find(port=>port.id===portId)?.valueKind;
     refs.push({role,kind:kind==="IMAGE"?"image":kind==="VIDEO"?"video":kind==="AUDIO"?"audio":"mask"});
    }
   for(const rule of useCase.mediaCapabilities.modes.find(mode=>mode.id===generationMode)?.inputs??[]){
    const ports=mapping.rolePorts?.[rule.role]??[];
    const count=ports.filter(portId=>Boolean(selected[portId])||incoming.some(edge=>edge.toPortId===portId)).length;
    if(count<rule.minItems||count>rule.maxItems)throw Error("媒体角色数量不符合模式要求："+rule.role);
   }
   }
   if(incoming.some(edge=>edge.toPortId&&!activePorts.has(edge.toPortId)&&useCase.slots.some(slot=>slot.id===edge.toPortId)))
    throw Error("当前模式不接受已连接的媒体槽位");
   const params:Record<string,unknown>={};
   for(const spec of useCase.mediaCapabilities.modes.find(mode=>mode.id===generationMode)?.parameters??[]){
    const portId=mapping.parameterPorts?.[spec.id];
    params[spec.id]=(portId?mediaBinding?.overrides?.[portId]:undefined)??(spec.mode==="fixed"?spec.fixedValue:spec.defaultValue);
   }
   const diagnostics=validateMediaRequest({mode:generationMode,references:refs,parameters:params},resolved);
   if(diagnostics.length)throw Error("Comfy 媒体能力校验失败："+diagnostics.map(item=>item.code).join("、"));
  }
  for(const slot of useCase.slots){
   if(useCase.mediaCapabilities&&!mappedPorts.has(slot.id)){
    if(selected[slot.id]||incoming.some(edge=>edge.toPortId===slot.id))throw Error("当前模式不接受已连接的媒体槽位："+slot.label);
    continue;
   }
   const ref=selected[slot.id];
   const role=Object.entries(modeBinding?.rolePorts??{}).find(([,ids])=>ids.includes(slot.id))?.[0];
   const rule=useCase.mediaCapabilities?.modes.find(item=>item.id===generationMode)?.inputs.find(item=>item.role===role);
   if(!rule&&slot.required&&!ref)throw Error("请先选择必填媒体槽位："+slot.label);
   if(!ref)continue;
   const source=assignmentGraph.nodes.find(node=>node.id===ref.nodeId);
   if(!source)throw Error("媒体槽位素材已从画布移除："+slot.label);
   if(!incoming.some(edge=>edge.toPortId===slot.id))mediaEdges.push({id:"media-slot-"+slot.id,fromNodeId:source.id,toNodeId:workflowNode.id,
    fromPortId:slot.valueKind.toLowerCase(),toPortId:slot.id});
  }
  for(const id of Object.keys(selected))if(!useCase.slots.some(slot=>slot.id===id))throw Error("backend_unknown_media_slot");
 }
 // Use the same required-port validation as the inspector.
 const activeRules=useCase?.mediaCapabilities?.modes.find(item=>item.id===generationMode)?.inputs??[];
 const requiredPortIds=new Set(activeRules.flatMap(rule=>(modeBinding?.rolePorts?.[rule.role]??[]).slice(0,rule.minItems)));
 const validationTemplate=useCase?.mediaCapabilities?{...template,mediaUseCase:{...useCase,
  slots:useCase.slots.filter(slot=>mappedPorts.has(slot.id)).map(slot=>({...slot,required:requiredPortIds.has(slot.id)}))}}:template;
 const missing=missingComfyMediaInputs(validationTemplate,workflowNode.id,[...incoming,...mediaEdges]);
 if(missing.length)throw Error("请先连接必填媒体输入："+missing.map(p=>p.label).join("、"));
 if(incoming.some(edge=>!edge.toPortId||!edge.fromPortId))
  throw Error("工作流只能使用显式端口连线");
 if(incoming.some(edge=>!assignmentGraph.nodes.some(n=>n.id===edge.fromNodeId&&["text","image","video","audio"].includes(n.type))))
  throw Error("工作流外部输入仅支持 Text / Image / Video / Audio 节点");
 const virtualMediaTargetPortIds=new Set([
  ...mediaEdges.map(edge=>edge.toPortId!),
  // A regular Comfy workflow can advertise media use cases too. Its existing
  // typed edges still use ordinary workflow execution, but the schema's slot
  // ports must be accepted when the UI has not materialized local port data.
  ...(useCase?.slots.map(slot=>slot.id)??[])
 ]);
 const imageIdsByTargetPort=new Map(Object.entries(selectedSlots).flatMap(([slotId,ref])=>ref?.imageId?[[slotId,ref.imageId] as const]:[]));
 const external=prepareCanvasExternalInputSnapshot(assignmentGraph.nodes,[...incoming,...mediaEdges],virtualMediaTargetPortIds,imageIdsByTargetPort);
 const externalInputs:Array<Record<string,unknown>>=[];
 for(const value of external){
  if(value.kind==="scalar"){
   externalInputs.push({...value});continue;
  }
  if(value.sourceNodeId===continuitySourceId){
   externalInputs.push({kind:"asset",sourceNodeId:value.sourceNodeId,sourcePortId:value.sourcePortId,
    valueKind:value.valueKind,assetId:"0".repeat(64),sha256:"0".repeat(64)});
   continue;
  }
  const accepted:Record<"IMAGE"|"MASK"|"VIDEO"|"AUDIO",readonly string[]>={
   IMAGE:["image/png","image/jpeg","image/webp"],
   MASK:["image/png"],
   VIDEO:["video/mp4","video/webm","video/x-matroska"],
   AUDIO:["audio/wav","audio/flac","audio/ogg","audio/mpeg"]
  };
  // Canvas media already lives in immutable backend CAS. Verify its MIME and
  // size using HEAD; never download a multi-GB video into the browser solely
  // to upload the identical bytes back to the same backend.
  if(value.storageKey&&isCanvasCasKey(value.storageKey)){
   const id=value.storageKey.slice(4),url=canvasCasUrl(value.storageKey)!;
   const response=await fetch(url,{method:"HEAD",credentials:"same-origin",cache:"no-store"});
   if(!response.ok)throw Error("外部 CAS 媒体不存在："+response.status);
   const mime=(response.headers.get("content-type")??"").split(";")[0].trim();
   const size=Number(response.headers.get("content-length"));
   if(!accepted[value.valueKind].includes(mime)||!Number.isSafeInteger(size)||size<=0)
    throw Error("外部 CAS 媒体类型或大小无效："+value.valueKind);
   externalInputs.push({kind:"asset",sourceNodeId:value.sourceNodeId,sourcePortId:value.sourcePortId,
    valueKind:value.valueKind,assetId:id,sha256:id});
   continue;
  }
  let blob=value.storageKey?await (args.readBlob??(async(key:string)=>
   (value.valueKind==="IMAGE"||value.valueKind==="MASK")
    ? (await import("@/services/image-storage")).getImageBlob(key)
    : (await import("@/services/file-storage")).getMediaBlob(key)))(value.storageKey):null;
  if(!blob&&value.url)blob=await (args.getBlob??fromBrowserUrl)(value.url);
  if(!blob)throw Error("外部媒体源 Blob 不存在，请重新导入文件");
  const mime=blob.type||value.mimeType||"";
  if(!accepted[value.valueKind].includes(mime))
   throw Error("ComfyUI 外部媒体格式与端口类型不匹配："+value.valueKind);
  if(readOnly){
   if(!blob.size)throw Error("外部媒体文件为空");
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer())),byte=>byte.toString(16).padStart(2,"0")).join("");
   externalInputs.push({kind:"asset",sourceNodeId:value.sourceNodeId,sourcePortId:value.sourcePortId,valueKind:value.valueKind,assetId:digest,sha256:digest});
   continue;
  }
  const uploaded=await bridge.uploadFrozenBlob(blob,mime);
  if(uploaded.blobId!==uploaded.sha256)throw Error("backend_asset_hash_mismatch");
  externalInputs.push({kind:"asset",sourceNodeId:value.sourceNodeId,sourcePortId:value.sourcePortId,
   valueKind:value.valueKind,assetId:uploaded.blobId,sha256:uploaded.sha256});
 }
 if(canonicalBackendGraph(graph)!==original)throw Error("backend_frozen_graph_mutated");
 const comfyTargetBinding=mediaBinding?{mode:args.workflowMode??useCase?.channel??"image",...(generationMode?{generationMode}:{}),binding:copy(mediaBinding)}:undefined;
 const comfyRequest={
  schemaVersion:2,instanceId,
  rootOutputs:outputPortIds.map(portId=>({nodeId:workflowNode.id,portId})),
  nodes:[{id:workflowNode.id,templateId:template.id,templateRevision:template.revision,
   inputOverrides:mediaBinding?mediaOverrides(template,mediaBinding,args.prompt??"",generationMode,workflowNode.metadata?.bboxLayout):copy(regularBinding?.inputOverrides??{})}],
  edges:[...incoming,...mediaEdges].map(edge=>({fromNodeId:edge.fromNodeId,fromPortId:edge.fromPortId!,
   toNodeId:edge.toNodeId,toPortId:edge.toPortId!})),
  externalInputs,runOptions:generationMode?{mediaMode:generationMode}:{}
 };
 return {graph,comfyRequest,comfyTargetBinding,continuityPort};
}

export async function startBackendComfyWorkflowRun(args:BackendComfyWorkflowArgs):Promise<BackendJobView>{
 const {bridge,projectId,workflowNode,template,instanceId}=args;
 const {graph,comfyRequest,comfyTargetBinding}=await prepareBackendComfyWorkflowRun(args);
 const fence=await bridge.saveProjectNow(graph,workflowNode.id);
 const sourceNodeFingerprint=comfyTargetBinding?await fingerprintComfyTargetBinding(fence.sourceNodeFingerprint,comfyTargetBinding):fence.sourceNodeFingerprint;
 const idempotencyKey=(args.newKey??(()=>crypto.randomUUID()))();
 const payload={
  projectId,targetNodeId:workflowNode.id,
  expectedProjectRevision:fence.revision,sourceNodeFingerprint,
  executionMode:"poll",idempotencyKey,requestFingerprint:idempotencyKey,
  snapshot:{adapterKind:"comfy",instanceId,comfyRequest:{...comfyRequest,projectId,canvasRevision:String(fence.revision),idempotencyKey},comfyTemplate:copy(template),
   ...(comfyTargetBinding?{comfyTargetBinding}:{})}
 };
 args.beforeSubmit?.();
 // Lost HTTP replies are reconciled via the SQLite job snapshot; browser
 // storage must never retain a replayable frozen request payload.
 const result=await (args.submitFrozenJob??bridge.submitFrozenJob)(payload); return result;
}

function mediaOverrides(_template:ComfyWorkflowTemplate,binding:NonNullable<CanvasNodeData["metadata"]>["comfyMediaPreset"],prompt:string,generationMode?:MediaModeId,layout?:NonNullable<CanvasNodeData["metadata"]>["bboxLayout"]):Record<string,unknown>{
 const overrides=copy(binding?.overrides??{});
 const mode=generationMode?_template.mediaUseCase?.modeBindings?.[generationMode]:undefined;
 const contractMode=_template.mediaUseCase?.mediaCapabilities?.modes.find(item=>item.id===generationMode);
 let deliveredPrompt=prompt;
 if(contractMode?.layout&&layout){
  const issue=validateBboxLayout(layout);if(issue)throw Error("结构化布局无效："+issue);
  const layoutJson=bboxLayoutToModelJson(layout);
  if(contractMode.layout.delivery==="prompt_json")deliveredPrompt=layoutJson;
  else if(mode?.layoutPortId)overrides[mode.layoutPortId]=layoutJson;
  else throw Error("当前生成模式未绑定结构化布局输入");
 }
 const promptPort=mode?.promptPortId??_template.mediaUseCase!.promptPortId;
 overrides[promptPort]=deliveredPrompt;
 for(const spec of contractMode?.parameters??[]){const portId=mode?.parameterPorts?.[spec.id];if(portId&&overrides[portId]===undefined&&spec.mode==="fixed")overrides[portId]=spec.fixedValue;}
 return overrides;
}
