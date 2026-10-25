import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import type {BackendJobView} from "@/types/backend-contracts";
import {canvasApi,type CanvasBackendProject} from "./canvas-api";
import {canonicalBackendGraph} from "./backend-source-fingerprint";
import {awaitCanvasStorePersistence,useCanvasStore} from "@/stores/canvas/use-canvas-store";

type Graph={nodes:CanvasNodeData[];connections:CanvasConnection[]};
type Row={artifactId:string;status:string;reason?:string};
const closed=new Set(["failed","cancelled"]);
const delay=(ms:number,signal:AbortSignal)=>new Promise<void>(resolve=>{
 if(signal.aborted){resolve();return}
 const timer=setTimeout(()=>{signal.removeEventListener("abort",stop);resolve()},ms);
 const stop=()=>{clearTimeout(timer);resolve()};
 signal.addEventListener("abort",stop,{once:true});
});
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
 await awaitCanvasStorePersistence();
 if(canonicalBackendGraph(getLocalGraph())!==frozen)return false;
 const remote=await api<CanvasBackendProject>("/api/v1/projects/"+encodeURIComponent(projectId));
 if(canonicalBackendGraph(getLocalGraph())!==frozen)return false;
 const snapshot=getLocalGraph();
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
 onStatus,api=canvasApi,pollMs=1750,
}:{
 projectId:string;jobId:string;signal:AbortSignal;
 getLocalGraph:()=>Graph;applyGraph:(graph:Graph)=>void;
 onStatus?:(status:string,message?:string)=>void;
 api?:typeof canvasApi;pollMs?:number;
}):Promise<void>{
 const root="/api/v1/jobs/"+encodeURIComponent(jobId);
 let previous="",failures=0;
 while(!signal.aborted){
  try{
   const job=await api<BackendJobView>(root);
   if(signal.aborted)return;
   if(job.projectId!==projectId)throw Error("backend_job_project_mismatch");
   if(job.status!==previous){previous=job.status;onStatus?.(job.status)}
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
  await delay(Math.min(15000,pollMs*(2**Math.min(failures,4))),signal);
 }
}
