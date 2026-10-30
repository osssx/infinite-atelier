import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import type {BackendJobView} from "@/types/backend-contracts";
import {canvasApi,type CanvasBackendProject} from "./canvas-api";
import {canonicalBackendGraph} from "./backend-source-fingerprint";
import {awaitCanvasStorePersistence,useCanvasStore} from "@/stores/canvas/use-canvas-store";
import {subscribeSqliteJobEvents} from "./sqlite-job-events";
import {parseComfyLiveUpdate,subscribeComfyLiveEvents} from "./comfy-live-events";
import type {CanvasComfyLiveUpdate} from "@/features/comfy-workflow/canvas-execution-visual";

type Graph={nodes:CanvasNodeData[];connections:CanvasConnection[]};
type Row={artifactId:string;status:string;reason?:string};
const closed=new Set(["failed","cancelled"]);

/** Recover the server-owned artifact graph by advancing the SQLite Store's
 * revision and applying only additive materializations. Never replace a local
 * dirty draft or overwrite modified source nodes.
 */
export async function refreshSqliteComfyArtifacts({
 projectId,getLocalGraph,applyGraph,api=canvasApi
}:{
 projectId:string;getLocalGraph:()=>Graph;applyGraph:(graph:Graph)=>void;
 api?:typeof canvasApi
}):Promise<boolean>{
 const frozen=canonicalBackendGraph(getLocalGraph());
 await awaitCanvasStorePersistence(projectId);
 if(canonicalBackendGraph(getLocalGraph())!==frozen)return false;
 const remote=await api<CanvasBackendProject>("/api/v1/projects/"+encodeURIComponent(projectId));
 if(canonicalBackendGraph(getLocalGraph())!==frozen)return false;
 const snapshot=getLocalGraph();
 // Reopened Canvas may already include every server artifact. A no-op is
 // success, not a conflict and never triggers an extra SQLite PATCH.
 if(canonicalBackendGraph({
  nodes:remote.document.nodes as CanvasNodeData[],
  connections:remote.document.connections as CanvasConnection[]
 })===frozen)return true;
 if(!useCanvasStore.getState().adoptMaterializedGraph(projectId,snapshot,remote))return false;
 const updated=useCanvasStore.getState().openProject(projectId);
 if(!updated)return false;
 const current={nodes:updated.nodes,connections:updated.connections};
 // Store was changed synchronously by server adoption. Do not overwrite an
 // unrelated user gesture that happened while the HTTP request was running.
 if(canonicalBackendGraph(getLocalGraph())!==frozen)return false;
 applyGraph(current);
 return true;
}
export async function watchSqliteComfyJob({
 projectId,jobId,signal,getLocalGraph,applyGraph,
 onStatus,onTextDelta,onSkillText,onSkillTool,onComfyLive,api=canvasApi,pollMs=15000,
}:{
 projectId:string;jobId:string;signal:AbortSignal;
 getLocalGraph:()=>Graph;applyGraph:(graph:Graph)=>void;
 onStatus?:(status:string,message?:string,job?:BackendJobView)=>void;
  onComfyLive?:(event:CanvasComfyLiveUpdate,job:BackendJobView)=>void;
 onTextDelta?:(delta:string)=>void;
 onSkillText?:(delta:string,round:number)=>void;
 onSkillTool?:(event:{name:string;status:"started"|"completed"})=>void;
 api?:typeof canvasApi;pollMs?:number;
}):Promise<void>{
 const root="/api/v1/jobs/"+encodeURIComponent(jobId);
 let previous="",failures=0,eventRevision=0;
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
    ["search_skills","activate_skill","read_skill_resource"].includes(event.payload.name)&&
    "status" in event.payload&&
    (event.payload.status==="started"||event.payload.status==="completed"))
   onSkillTool({name:event.payload.name,status:event.payload.status});
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
    let applied=false;
    if(records.some(item=>item.status==="materialized")){
     applied=await refreshSqliteComfyArtifacts({
      projectId,getLocalGraph,applyGraph,api
     }).catch(()=>false);
     if(applied)onStatus?.("materialized");
    }
    if(records.length&&records.every(item=>item.status==="materialized")){
     if(!applied)onStatus?.("needs_refresh","local_graph_changed_or_already_restored");
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
