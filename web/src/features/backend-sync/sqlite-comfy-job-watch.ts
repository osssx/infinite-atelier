import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import type {BackendJobView} from "@/types/backend-contracts";
import {canvasApi,type CanvasBackendProject} from "./canvas-api";
import {canonicalBackendGraph} from "./backend-source-fingerprint";
import {safeRemoteCanvasMerge} from "./canvas-backend-sync";
import {awaitCanvasStorePersistence,useCanvasStore} from "@/stores/canvas/use-canvas-store";
import {subscribeSqliteJobEvents} from "./sqlite-job-events";
import {parseComfyLiveUpdate,subscribeComfyLiveEvents} from "./comfy-live-events";
import type {CanvasComfyLiveUpdate} from "@/features/comfy-workflow/canvas-execution-visual";

type Graph={nodes:CanvasNodeData[];connections:CanvasConnection[]};
type Row={artifactId:string;status:string;reason?:string};
const closed=new Set(["failed","cancelled"]);
const graphFromProject=(project:{nodes:CanvasNodeData[];connections:CanvasConnection[]}):Graph=>({
 nodes:project.nodes,connections:project.connections
});
function isSafeArtifactAdvance(base:Graph,candidate:Graph):boolean{
 const merged=safeRemoteCanvasMerge(base,candidate);
 return Boolean(merged&&canonicalBackendGraph(merged)===canonicalBackendGraph(candidate));
}
/** Recover the server-owned artifact graph by advancing the SQLite Store's
 * revision and applying only additive materializations. Never replace a local
 * dirty draft or overwrite modified source nodes.
 */
export async function refreshSqliteComfyArtifacts({
 projectId,getLocalGraph,applyGraph,api=canvasApi
}:{
 projectId:string;getLocalGraph:()=>Graph;applyGraph:(graph:Graph)=>void;
 api?:typeof canvasApi
}):Promise<"changed"|"unchanged"|"conflict">{
 const frozen=canonicalBackendGraph(getLocalGraph());
 const frozenGraph=JSON.parse(frozen) as Graph;
 await awaitCanvasStorePersistence(projectId);
 // A pending SQLite save can itself merge newly materialized artifacts into
 // the rendered graph. Accept that delta only when all original source nodes
 // and edges remain unchanged and safeRemoteCanvasMerge validates additions.
 let pageGraph=getLocalGraph();
 if(canonicalBackendGraph(pageGraph)!==frozen&&!isSafeArtifactAdvance(frozenGraph,pageGraph)){
  return "conflict";
 }
 const remote=await api<CanvasBackendProject>("/api/v1/projects/"+encodeURIComponent(projectId));
 const afterFetch=getLocalGraph();
 if(canonicalBackendGraph(afterFetch)!==canonicalBackendGraph(pageGraph)){
  if(!isSafeArtifactAdvance(frozenGraph,afterFetch)){
   return "conflict";
  }
  pageGraph=afterFetch;
 }
 const remoteGraph:Graph={nodes:remote.document.nodes as CanvasNodeData[],
  connections:remote.document.connections as CanvasConnection[]};
 if(!isSafeArtifactAdvance(frozenGraph,remoteGraph)){
  return "conflict";
 }
 const stored=useCanvasStore.getState().openProject(projectId);
 if(!stored)return "conflict";
 let current=graphFromProject(stored);
 if(!isSafeArtifactAdvance(frozenGraph,current)){
  return "conflict";
 }

 // An autosave may already have advanced Store to the fetched server graph.
 // Repair a lagging page ref only from this verified Store snapshot.
 if(canonicalBackendGraph(current)===canonicalBackendGraph(remoteGraph)){
  if(canonicalBackendGraph(pageGraph)===canonicalBackendGraph(current))return "unchanged";
  if(!safeRemoteCanvasMerge(pageGraph,current)){
   return "conflict";
  }
  if(canonicalBackendGraph(getLocalGraph())!==canonicalBackendGraph(pageGraph)){
   return "conflict";
  }
  applyGraph(current);
  return "changed";
 }

 // Backend may be ahead of Store. Validate additive adoption from the exact
 // Store graph; Store still rejects dirty projects and stale revisions.
 if(!safeRemoteCanvasMerge(current,remoteGraph)){
  return "conflict";
 }
 const beforeAdopt=getLocalGraph();
 if(canonicalBackendGraph(beforeAdopt)!==canonicalBackendGraph(pageGraph)&&
    !isSafeArtifactAdvance(frozenGraph,beforeAdopt)){
  return "conflict";
 }
 const latestStore=useCanvasStore.getState().openProject(projectId);
 if(!latestStore)return "conflict";
 const latestStoreGraph=graphFromProject(latestStore);
 if(canonicalBackendGraph(latestStoreGraph)!==canonicalBackendGraph(current)){
  return "conflict";
 }
 if(!useCanvasStore.getState().adoptMaterializedGraph(projectId,latestStoreGraph,remote)){
  // Another sync may have adopted this project while the request was open.
  const adopted=useCanvasStore.getState().openProject(projectId);
  if(!adopted||canonicalBackendGraph(graphFromProject(adopted))!==canonicalBackendGraph(remoteGraph)){
   return "conflict";
  }
  current=graphFromProject(adopted);
 }else{
  const adopted=useCanvasStore.getState().openProject(projectId);
  if(!adopted)return "conflict";
  current=graphFromProject(adopted);
 }
 const pageNow=getLocalGraph();
 if(canonicalBackendGraph(pageNow)!==canonicalBackendGraph(beforeAdopt)&&
    !isSafeArtifactAdvance(frozenGraph,pageNow)){
  return "conflict";
 }
 if(canonicalBackendGraph(pageNow)===canonicalBackendGraph(current))return "unchanged";
 const merged=safeRemoteCanvasMerge(pageNow,current);
 if(!merged)return "conflict";
 if(canonicalBackendGraph(getLocalGraph())!==canonicalBackendGraph(pageNow)){
  return "conflict";
 }
 applyGraph(merged);
 return "changed";
}
export async function watchSqliteComfyJob({
 projectId,jobId,signal,getLocalGraph,applyGraph,
 onStatus,onTextDelta,onSkillText,onSkillTool,onComfyLive,notifyOnMaterialization=false,api=canvasApi,pollMs=15000,
}:{
 projectId:string;jobId:string;signal:AbortSignal;
 getLocalGraph:()=>Graph;applyGraph:(graph:Graph)=>void;
 onStatus?:(status:string,message?:string,job?:BackendJobView)=>void;
  onComfyLive?:(event:CanvasComfyLiveUpdate,job:BackendJobView)=>void;
 notifyOnMaterialization?:boolean;
 onTextDelta?:(delta:string)=>void;
 onSkillText?:(delta:string,round:number)=>void;
 onSkillTool?:(event:{name:string;status:"started"|"completed"|"failed";result?:{status?:string;exit_code?:number|null;stderr?:string;stdout?:string}})=>void;
 api?:typeof canvasApi;pollMs?:number;
}):Promise<void>{
 const root="/api/v1/jobs/"+encodeURIComponent(jobId);
 let previous="",failures=0,eventRevision=0,materializationNotified=false;
  let latestJob:BackendJobView|null=null;
  let stopLive:(()=>void)|null=null;
 let wake:(()=>void)|null=null;
 const unsubscribe=subscribeSqliteJobEvents(jobId,event=>{
  if(event.kind==="job_comfy_error"&&latestJob?.adapterKind==="comfy"&&onComfyLive){
    const parsed=parseComfyLiveUpdate({kind:"error",error:event.payload});
    if(parsed)onComfyLive(parsed,latestJob);
   }
   if(event.kind==="model_text_delta"&&onTextDelta&&
    event.payload&&typeof event.payload==="object"&&
    "delta" in event.payload&&typeof event.payload.delta==="string"&&
    event.payload.delta.length<=4096)onTextDelta(event.payload.delta);
  if(event.kind==="skill_text_delta"&&onSkillText&&
    event.payload&&typeof event.payload==="object"&&
    "delta" in event.payload&&typeof event.payload.delta==="string"&&
    event.payload.delta.length<=4096&&
    "round" in event.payload&&typeof event.payload.round==="number"&&
    Number.isSafeInteger(event.payload.round)&&event.payload.round>=0)
   onSkillText(event.payload.delta,event.payload.round);
  if(event.kind==="skill_tool"&&onSkillTool&&event.payload&&
    typeof event.payload==="object"&&
    "name" in event.payload&&typeof event.payload.name==="string"&&
    ["search_skills","activate_skill","read_skill_resource","run_skill_script"].includes(event.payload.name)&&
    "status" in event.payload&&
    (event.payload.status==="started"||event.payload.status==="completed"||event.payload.status==="failed")) {
   const result="result" in event.payload&&event.payload.result&&typeof event.payload.result==="object"?
    event.payload.result as {status?:string;exit_code?:number|null;stderr?:string;stdout?:string}:undefined;
   onSkillTool({name:event.payload.name,status:event.payload.status,...(result?{result}:{})});
  }
  eventRevision++;
  wake?.();
 });
 try{
 while(!signal.aborted){
  const observedRevision=eventRevision;
  try{
   const job=await api<BackendJobView>(root);
   if(signal.aborted)return;
   if(job.projectId!==projectId)throw Error("backend_job_project_mismatch");
    latestJob=job;
    if(job.adapterKind==="comfy"&&onComfyLive&&!stopLive&&!closed.has(job.status)&&job.status!=="succeeded")
     stopLive=subscribeComfyLiveEvents(jobId,event=>{if(!signal.aborted&&latestJob)onComfyLive(event,latestJob)});
    if(job.adapterKind==="comfy"&&job.status==="failed"&&onComfyLive){
     const diagnostic=await api<{error:unknown}>(root+"/comfy-diagnostic").catch(()=>null);
     const parsed=parseComfyLiveUpdate({kind:"error",error:diagnostic?.error});
     if(parsed&&!signal.aborted)onComfyLive(parsed,job);
    }
   if(job.status!==previous){previous=job.status;onStatus?.(job.status,undefined,job)}
   if(closed.has(job.status))return;
   if(job.status==="succeeded"){
    const result=await api<{materializations:Row[]}>(root+"/materializations");
    if(signal.aborted)return;
    const records=result.materializations??[];
    if(records.some(item=>item.status==="blocked")){
     onStatus?.("blocked","artifact_materialization_blocked");
     return;
    }
    let refreshResult:"changed"|"unchanged"|"conflict"="unchanged";
    if(records.some(item=>item.status==="materialized")){
     refreshResult=await refreshSqliteComfyArtifacts({
      projectId,getLocalGraph,applyGraph,api
     }).catch(()=>"conflict");
     if(!materializationNotified&&refreshResult!=="conflict"&&
      (refreshResult==="changed"||notifyOnMaterialization)){
      materializationNotified=true;
      onStatus?.("materialized",undefined,job);
     }
    }
    if(records.length&&records.every(item=>item.status==="materialized")){
     if(refreshResult==="conflict")onStatus?.("needs_refresh","local_graph_changed_during_refresh",job);
     return;
    }
   }
   failures=0;
  }catch(error){
   failures++;
   if(failures>=6){onStatus?.("unavailable",String(error));return}
  }
  if(eventRevision!==observedRevision)continue;
  await new Promise<void>(resolve=>{
   if(signal.aborted){resolve();return}
   let done=false;
   const complete=()=>{
    if(done)return;
    done=true;clearTimeout(timer);
    signal.removeEventListener("abort",complete);
    if(wake===complete)wake=null;
    resolve();
   };
   const timer=setTimeout(complete,Math.min(60000,pollMs*(2**Math.min(failures,4))));
   wake=complete;
   signal.addEventListener("abort",complete,{once:true});
   if(eventRevision!==observedRevision)complete();
  });
 }
 }finally{unsubscribe();stopLive?.()}
}
