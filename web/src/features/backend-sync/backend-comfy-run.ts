import type {CanvasNodeData,CanvasConnection} from "@/types/canvas";
import type {ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";
import {prepareCanvasExternalInputSnapshot} from "@/lib/canvas/canvas-external-input-snapshot";
import type {BackendCanvasGraph} from "./canvas-backend-sync";
import {canonicalBackendGraph} from "./backend-source-fingerprint";
import {canvasCasUrl,isCanvasCasKey} from "./canvas-cas";
import type {BlobUploadResponse,BackendJobView} from "@/types/backend-contracts";

type Submitter={
 state:{status:string};
 assertNoActiveJob?:(nodeId:string)=>Promise<void>;
 assertComfyReady:(instanceId:string)=>Promise<void>;
 saveProjectNow:(draft:BackendCanvasGraph,nodeId:string)=>Promise<{projectId:string;revision:number;sourceNodeFingerprint:string}>;
 uploadFrozenBlob:(blob:Blob,mime:string)=>Promise<BlobUploadResponse>;
 submitFrozenJob:(payload:Record<string,unknown>)=>Promise<BackendJobView>;
};
type PendingStore=Pick<Storage,"getItem"|"setItem"|"removeItem">;
export const backendPendingKey=(projectId:string,nodeId:string)=>"comfy_backend_pending_v1:"+projectId+":"+nodeId;
export const backendLastJobKey=(projectId:string,nodeId:string)=>"comfy_backend_last_job_v1:"+projectId+":"+nodeId;
const copy=<T,>(item:T):T=>JSON.parse(JSON.stringify(item)) as T;

export type BackendComfyWorkflowArgs={
 bridge:Submitter;projectId:string;workflowNode:CanvasNodeData;
 nodes:readonly CanvasNodeData[];connections:readonly CanvasConnection[];
 template:ComfyWorkflowTemplate;instanceId:string;outputPortIds:readonly string[];
 readBlob?:(storageKey:string)=>Promise<Blob|null>;
 getBlob?:(url:string)=>Promise<Blob|null>;
 pending?:PendingStore;newKey?:()=>string;
 /** SQLite job snapshot is authoritative: never persist a browser pending payload. */
 serverAuthoritative?:boolean;
};
async function fromBrowserUrl(url:string):Promise<Blob|null>{
 if(!url.startsWith("blob:")&&!url.startsWith("data:"))return null;
 const response=await fetch(url,{cache:"no-store"});
 return response.ok?response.blob():null;
}

const backendTerminal=new Set(["succeeded","failed","cancelled"]);
/** Prevent cross-executor duplicate GPU tasks. Queries the last *known*
 * backend job only; legacy V2 users without a prior new-backend job are
 * unaffected. Unknown status fails closed, never guesses a terminal state.
 */
export async function assertNoActiveBackendComfyJob(projectId:string,nodeId:string,{
 storage=localStorage,fetcher=fetch
}:{
 storage?:Pick<Storage,"getItem">;fetcher?:typeof fetch
}={}):Promise<void>{
 if(storage.getItem(backendPendingKey(projectId,nodeId)))
  throw Error("backend_submission_pending_unknown");
 const id=storage.getItem(backendLastJobKey(projectId,nodeId));
 if(!id)return;
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw Error("backend_prior_job_id_invalid");
 let response:Response;
 try{response=await fetcher("/api/v1/jobs/"+encodeURIComponent(id),{
  credentials:"same-origin",cache:"no-store"
 })}
 catch{throw Error("backend_prior_job_status_unknown")}
 if(!response.ok)throw Error("backend_prior_job_status_unknown");
 const row:unknown=await response.json().catch(()=>null);
 const status=row&&typeof row==="object"&&"status" in row?(row as {status:unknown}).status:null;
 if(typeof status!=="string"||!backendTerminal.has(status))
  throw Error("backend_prior_job_not_terminal");
}
export async function startBackendComfyWorkflowRun(args:BackendComfyWorkflowArgs):Promise<BackendJobView>{
 const {bridge,projectId,workflowNode,template,instanceId,outputPortIds}=args;
 if(bridge.state.status!=="connected")throw Error("backend_sync_not_connected");
 await bridge.assertComfyReady(instanceId);
 // SQLite-only flow never records frozen GPU requests in localStorage.
 // A lost HTTP response is recovered from the DB snapshot on the next click.
 const pending=args.serverAuthoritative?null:(args.pending??localStorage);
 const key=backendPendingKey(projectId,workflowNode.id);
 if(args.serverAuthoritative){
  if(!bridge.assertNoActiveJob)throw Error("backend_sqlite_job_guard_missing");
  await bridge.assertNoActiveJob(workflowNode.id);
 }else{
  const older=pending!.getItem(key);
  if(older){
   // Exact legacy opt-in replay with immutable idempotency key.
   const payload=JSON.parse(older) as Record<string,unknown>;
   if(payload.projectId!==projectId||payload.targetNodeId!==workflowNode.id)
    throw Error("backend_pending_invalid");
   const result=await bridge.submitFrozenJob(payload);
   pending!.removeItem(key);
   pending!.setItem(backendLastJobKey(projectId,workflowNode.id),result.id);
   return result;
  }
  await assertNoActiveBackendComfyJob(projectId,workflowNode.id,{storage:pending!});
 }
 if(!instanceId||outputPortIds.length<1||outputPortIds.length>16||
    new Set(outputPortIds).size!==outputPortIds.length||
    outputPortIds.some(id=>!template.ports.some(port=>port.id===id&&port.direction==="source"&&
      port.capture?.kind!=="none"&&!!port.capture?.adapterId)))
  throw Error("backend_invalid_output_ports");
 const binding=workflowNode.metadata?.comfyWorkflow;
 if(!binding||binding.templateId!==template.id||binding.templateRevision!==template.revision)
  throw Error("backend_template_revision_mismatch");
 const graph=copy<BackendCanvasGraph>({nodes:[...args.nodes],connections:[...args.connections]});
 const original=canonicalBackendGraph(graph);
 const currentNode=graph.nodes.find(node=>node.id===workflowNode.id);
 if(!currentNode||currentNode.type!=="comfy:workflow")throw Error("backend_workflow_node_missing");
 const incoming=graph.connections.filter(edge=>edge.toNodeId===workflowNode.id);
 const missing=template.ports.filter(port=>port.direction==="target"&&port.inputBinding?.mode==="media-file"&&
  !graph.connections.some(edge=>edge.toNodeId===workflowNode.id&&edge.toPortId===port.id));
 if(missing.length)throw Error("请先连接媒体输入："+missing.map(p=>p.label).join("、"));
 if(incoming.some(edge=>!edge.toPortId||!edge.fromPortId))
  throw Error("工作流只能使用显式端口连线");
 if(incoming.some(edge=>!graph.nodes.some(n=>n.id===edge.fromNodeId&&["text","image","video","audio"].includes(n.type))))
  throw Error("工作流外部输入仅支持 Text / Image / Video / Audio 节点");
 const external=prepareCanvasExternalInputSnapshot(graph.nodes,incoming);
 const externalInputs:Array<Record<string,unknown>>=[];
 for(const value of external){
  if(value.kind==="scalar"){
   externalInputs.push({...value});continue;
  }
  const accepted:Record<"IMAGE"|"VIDEO"|"AUDIO",readonly string[]>={
   IMAGE:["image/png","image/jpeg","image/webp"],
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
   value.valueKind==="IMAGE"
    ? (await import("@/services/image-storage")).getImageBlob(key)
    : (await import("@/services/file-storage")).getMediaBlob(key)))(value.storageKey):null;
  if(!blob&&value.url)blob=await (args.getBlob??fromBrowserUrl)(value.url);
  if(!blob)throw Error("外部媒体源 Blob 不存在，请重新导入文件");
  const mime=blob.type||value.mimeType||"";
  if(!accepted[value.valueKind].includes(mime))
   throw Error("ComfyUI 外部媒体格式与端口类型不匹配："+value.valueKind);
  const uploaded=await bridge.uploadFrozenBlob(blob,mime);
  if(uploaded.blobId!==uploaded.sha256)throw Error("backend_asset_hash_mismatch");
  externalInputs.push({kind:"asset",sourceNodeId:value.sourceNodeId,sourcePortId:value.sourcePortId,
   valueKind:value.valueKind,assetId:uploaded.blobId,sha256:uploaded.sha256});
 }
 if(canonicalBackendGraph(graph)!==original)throw Error("backend_frozen_graph_mutated");
 const fence=await bridge.saveProjectNow(graph,workflowNode.id);
 const idempotencyKey=(args.newKey??(()=>crypto.randomUUID()))();
 const comfyRequest={
  schemaVersion:2,projectId,canvasRevision:String(fence.revision),instanceId,
  rootOutputs:outputPortIds.map(portId=>({nodeId:workflowNode.id,portId})),
  nodes:[{id:workflowNode.id,templateId:template.id,templateRevision:template.revision,
   inputOverrides:copy(binding.inputOverrides??{})}],
  edges:incoming.map(edge=>({fromNodeId:edge.fromNodeId,fromPortId:edge.fromPortId!,
   toNodeId:edge.toNodeId,toPortId:edge.toPortId!})),
  externalInputs,runOptions:{},idempotencyKey
 };
 const payload={
  projectId,targetNodeId:workflowNode.id,
  expectedProjectRevision:fence.revision,sourceNodeFingerprint:fence.sourceNodeFingerprint,
  executionMode:"poll",idempotencyKey,requestFingerprint:idempotencyKey,
  snapshot:{adapterKind:"comfy",instanceId,comfyRequest,comfyTemplate:copy(template)}
 };
 // Only legacy callers use browser pending storage. SQLite-only calls never
 // persist the payload in browser storage; recovery queries server jobs.
 if(pending)pending.setItem(key,JSON.stringify(payload));
 const result=await bridge.submitFrozenJob(payload);
 if(pending){
  pending.removeItem(key);
  pending.setItem(backendLastJobKey(projectId,workflowNode.id),result.id);
 }
 return result;
}
