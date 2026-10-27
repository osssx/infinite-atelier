import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import type {BlobUploadResponse,BackendJobView} from "@/types/backend-contracts";
import {canvasApi,canvasSession,CanvasApiError,type CanvasBackendProject} from "./canvas-api";
import {canonicalBackendGraph,fingerprintBackendSource} from "./backend-source-fingerprint";
import {awaitCanvasStorePersistence,useCanvasStore} from "@/stores/canvas/use-canvas-store";
import type {BackendCanvasGraph} from "./canvas-backend-sync";

/** JobCoordinator adapter for the SQLite-only Canvas.
 * No createCanvasBackendSync, no second project store or manual connect.
 * Never reads/writes an origin-local project document.
 */
export function createSqliteComfyBridge({
 projectId,getLocalGraph,
 api=canvasApi,session=canvasSession,
}:{
 projectId:string;
 getLocalGraph:()=>BackendCanvasGraph;
 api?:typeof canvasApi;
 session?:typeof canvasSession;
}){
 const projectPath="/api/v1/projects/"+encodeURIComponent(projectId);
 const compare=(graph:BackendCanvasGraph)=>canonicalBackendGraph(graph);
 const getLive=()=>getLocalGraph();
 return {
  state:{status:"connected" as const},
  async assertNoActiveJob(targetNodeId:string){
   const snapshot=await api<{jobs:Array<BackendJobView>}>("/api/v1/jobs/snapshot");
   if(!Array.isArray(snapshot.jobs))throw Error("backend_jobs_snapshot_invalid");
   const active=snapshot.jobs.find(job=>job.projectId===projectId&&
    job.targetNodeId===targetNodeId&&!["succeeded","failed","cancelled"].includes(job.status));
   if(active)throw Error("backend_prior_job_not_terminal:"+active.id);
  },
  async assertComfyReady(instanceId:string){
   const result=await api<{autoDispatch:boolean;comfyInstanceIds:string[]}>(
    "/api/v1/execution/capabilities");
   if(!result.autoDispatch||!result.comfyInstanceIds.includes(instanceId))
    throw new Error("backend_comfy_instance_not_ready");
  },
  async saveProjectNow(frozenGraph:BackendCanvasGraph,targetNodeId:string){
   const expected=compare(frozenGraph);
   if(compare(getLive())!==expected)throw Error("generation_draft_changed");
   // React effects can lag a synchronous click. Explicitly freeze the exact
   // nodes/edges into SQLite Store, then drain all graph/auxiliary queues.
   const store=useCanvasStore.getState();
   if(!store.openProject(projectId))throw Error("project_not_loaded");
   store.updateProject(projectId,{
    nodes:JSON.parse(JSON.stringify(frozenGraph.nodes)) as CanvasNodeData[],
    connections:JSON.parse(JSON.stringify(frozenGraph.connections)) as CanvasConnection[]
   });
   await awaitCanvasStorePersistence(projectId);
   if(compare(getLive())!==expected)throw Error("generation_draft_changed");
   const result=await api<CanvasBackendProject>(projectPath);
   const stored={nodes:result.document.nodes,connections:result.document.connections} as BackendCanvasGraph;
   if(compare(stored)!==expected||compare(getLive())!==expected)
    throw Error("generation_save_barrier_required");
   const sourceNodeFingerprint=await fingerprintBackendSource(stored,targetNodeId);
   if(compare(getLive())!==expected)throw Error("generation_draft_changed");
   return {projectId,revision:result.revision,sourceNodeFingerprint};
  },
  async uploadFrozenBlob(blob:Blob,mimeType:string):Promise<BlobUploadResponse>{
   if(!["image/png","image/jpeg","image/webp","video/mp4","video/quicktime","video/webm","video/x-matroska",
    "audio/wav","audio/flac","audio/ogg","audio/mpeg","text/plain"].includes(mimeType))
    throw Error("unsupported_blob_mime");
   for(let attempt=0;attempt<2;attempt++){
    const csrf=await session(attempt>0);
    const result=await fetch("/api/v1/blobs",{
     method:"POST",credentials:"same-origin",cache:"no-store",
     headers:{"content-type":"application/octet-stream",
      "x-atelier-mime":mimeType,"x-atelier-csrf":csrf},
     body:blob
    });
    if(result.status===401&&attempt===0)continue;
    const value:unknown=await result.json().catch(()=>null);
    if(!result.ok){
     const code=value&&typeof value==="object"&&"code" in value&&
      typeof value.code==="string"?value.code:"backend_blob_upload_failed";
     throw new CanvasApiError(code,result.status);
    }
    const uploaded=value as BlobUploadResponse;
    if(!uploaded||typeof uploaded.blobId!=="string"||
       uploaded.blobId!==uploaded.sha256||uploaded.byteSize!==blob.size)
     throw Error("backend_blob_response_invalid");
    return uploaded;
   }
   throw Error("backend_unauthorized");
  },
  async submitFrozenJob(payload:Record<string,unknown>){
   return api<BackendJobView>("/api/v1/jobs","POST",payload);
  }
 };
}
