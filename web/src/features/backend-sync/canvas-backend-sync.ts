import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import type {BackendJobEvent,BackendJobsSnapshot,BackendErrorResponse} from "@/types/backend-contracts";
import type {BackendJobView,BlobUploadResponse} from "@/types/backend-contracts";
import {canonicalBackendGraph,fingerprintBackendSource} from "./backend-source-fingerprint";

export type BackendCanvasGraph={nodes:CanvasNodeData[];connections:CanvasConnection[]};
export type BackendSyncStatus="disabled"|"connecting"|"connected"|"conflict"|"disconnected"|"error";
export type BackendSyncState={status:BackendSyncStatus;revision:number|null;cursor:number;message?:string};
export type BackendProjectResponse={id:string;revision:number;document:BackendCanvasGraph&{title?:string};deletedAt?:number|null};
type Fetcher=(url:string,init?:RequestInit)=>Promise<Response>;
type EventStream={addEventListener:(type:string,callback:(event:MessageEvent<string>)=>void)=>void;onerror:((event:Event)=>void)|null;close:()=>void};
type Options={
 projectId:string;getLocalGraph:()=>BackendCanvasGraph;
 applyRemoteGraph:(graph:BackendCanvasGraph)=>void;
 applyRemoteTitle?:(title:string)=>void;
 onStatus?:(state:BackendSyncState)=>void;
 fetcher?:Fetcher;openEventStream?:(url:string)=>EventStream;
 /** The launcher prints a single-use token; request it explicitly, never persist it. */
 requestBootstrap?:()=>Promise<string|null>;
 getLocalMetadata?:()=>{title?:string;viewport?:unknown;backgroundMode?:string;showImageInfo?:boolean};
 debounceMs?:number;
};
export type ProjectDocumentDiagnostic={reason?:string;nodeIndex?:number;connectionIndex?:number};
export class BackendSyncError extends Error{
 constructor(readonly code:string,readonly httpStatus:number=0,readonly details?:ProjectDocumentDiagnostic){
  super(code);this.name="BackendSyncError";
 }
}
const cloneGraph=(graph:BackendCanvasGraph):BackendCanvasGraph=>JSON.parse(JSON.stringify({
 nodes:graph.nodes,connections:graph.connections
})) as BackendCanvasGraph;
const graphString=(graph:BackendCanvasGraph)=>canonicalBackendGraph(graph);
const isGenerated=(n:CanvasNodeData)=>Boolean(n.metadata?.comfyArtifact?.artifactId||n.metadata?.modelArtifact?.artifactId);
function canonical(value:unknown):string{
 if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
 if(value&&typeof value==="object"){
  const items=Object.entries(value).filter(([,v])=>v!==undefined)
   .sort(([a],[b])=>a<b?-1:a>b?1:0);
  return "{"+items.map(([k,v])=>JSON.stringify(k)+":"+canonical(v)).join(",")+"}";
 }
 return JSON.stringify(value);
}
/** Only append server-materialized artifacts to a matching original document.
 * Never silently overwrite or delete a user's canvas edit.
 */
export function safeRemoteCanvasMerge(local:BackendCanvasGraph,remote:BackendCanvasGraph):BackendCanvasGraph|null {
 if(!Array.isArray(remote?.nodes)||!Array.isArray(remote.connections))return null;
 const localNodes=new Map(local.nodes.map(n=>[n.id,n]));
 const remoteNodes=new Map(remote.nodes.map(n=>[n.id,n]));
 const localEdges=new Map(local.connections.map(e=>[e.id,e]));
 if(localNodes.size!==local.nodes.length||remoteNodes.size!==remote.nodes.length||
    localEdges.size!==local.connections.length)return null;
 for(const node of local.nodes){
  const same=remoteNodes.get(node.id);
  if(!same||canonical(node)!==canonical(same))return null;
 }
 for(const edge of local.connections){
  const same=remote.connections.find(e=>e.id===edge.id);
  if(!same||canonical(edge)!==canonical(same))return null;
 }
 const newNodes=remote.nodes.filter(n=>!localNodes.has(n.id));
 const newIds=new Set(newNodes.map(n=>n.id));
 for(const node of newNodes){
  if(!isGenerated(node))return null;
  const origin=node.metadata?.comfyArtifact;
  const model=node.metadata?.modelArtifact;
  if(origin){
   if(!localNodes.has(origin.workflowNodeId)||
    !["image","video","audio","text"].includes(origin.kind)||
    node.type!==origin.kind)return null;
   if(local.nodes.some(n=>n.metadata?.comfyArtifact?.artifactId===origin.artifactId))return null;
   if(!remote.connections.some(e=>e.fromNodeId===origin.workflowNodeId&&e.fromPortId===origin.portId&&
      e.toNodeId===node.id&&e.toPortId==="comfy-artifact"))return null;
  }else if(model){
   if(!/^[a-zA-Z0-9_-]{1,128}$/.test(model.artifactId)||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(model.jobId)||
    node.id!=="artifact-"+model.artifactId||
    !localNodes.has(model.sourceNodeId)||node.type!==model.kind||
    !["image","audio","text","video"].includes(model.kind))return null;
   if(local.nodes.some(n=>n.metadata?.modelArtifact?.artifactId===model.artifactId))return null;
   if(!remote.connections.some(e=>e.fromNodeId===model.sourceNodeId&&
     e.toNodeId===node.id&&!e.fromPortId&&!e.toPortId))return null;
  }else return null;
 }
 for(const edge of remote.connections.filter(e=>!localEdges.has(e.id))){
  if(!newIds.has(edge.toNodeId)||!localNodes.has(edge.fromNodeId))return null;
  const target=remoteNodes.get(edge.toNodeId);
  const comfy=target?.metadata?.comfyArtifact;
  const model=target?.metadata?.modelArtifact;
  if(comfy?edge.toPortId!=="comfy-artifact"||edge.fromPortId!==comfy.portId:
   model?Boolean(edge.fromPortId||edge.toPortId)||edge.fromNodeId!==model.sourceNodeId:true)
    return null;
 }
 return cloneGraph(remote);
}
async function responseJson<T>(response:Response,path:string):Promise<T>{
 const contentType=response.headers.get("content-type")?.toLowerCase()??"";
 if(!contentType.includes("application/json")&&!contentType.includes("+json")){
  // Vite SPA fallback serves index.html with HTTP 200 when /api/v1 isn't proxied.
  if(path.startsWith("/api/v1/")&&contentType.includes("text/html"))
   throw new BackendSyncError("backend_proxy_not_configured",response.status);
  throw new BackendSyncError(response.ok?"backend_non_json_response":"backend_proxy_unavailable",response.status);
 }
 const value:unknown=await response.json().catch(()=>null);
 if(!response.ok){
  const error=value as Partial<BackendErrorResponse>|null;
  throw new BackendSyncError(typeof error?.code==="string"?error.code:"backend_http_error",response.status,
   error?.code==="invalid_project_document" && error.details && typeof error.details==="object"
    ? error.details as ProjectDocumentDiagnostic : undefined);
 }
 if(!value||typeof value!=="object"||Array.isArray(value))throw new BackendSyncError("backend_invalid_json",response.status);
 return value as T;
}
export function explainBackendSyncError(code:string):string{
 if(code.startsWith("invalid_project_document")){
  const [,reason,index]=code.split(":");
  const position=Number.isSafeInteger(Number(index))&&index!==undefined?Number(index)+1:null;
  if(reason==="node_id")return "画布第 "+(position??"?")+" 个节点的 ID 不符合后端限制。请重启本地后端加载最新的 Comfy/插件节点 ID 兼容修复；本地项目没有被删除。";
  if(reason==="duplicate_node_id")return "画布第 "+(position??"?")+" 个节点的 ID 与其他节点重复；后端未修改项目。";
  if(reason==="node_type")return "画布第 "+(position??"?")+" 个节点缺少有效的类型；后端未修改项目。";
  if(reason==="dangling_connection")return "画布第 "+(position??"?")+" 条连接引用了不存在的节点；请检查断开的连接，项目仍保留在本地。";
  if(reason==="self_connection")return "画布第 "+(position??"?")+" 条连接是节点到自身的连接；后端拒绝该文档以避免无效执行。";
  return "项目文档校验未通过。请重启本地后端并重试；如仍失败，检查节点 ID、重复节点和已失效连接，本地项目未被删除。";
 }

 if(code==="invalid_bootstrap_token")
  return "一次性 Token 无效：可能已过期（仅 5 分钟）、已使用或复制错误。请在运行 npm run dev:backend 的终端输入 r 并按回车获取新 Token，然后重新连接。旧版本后端需要先重启一次。";
 if(code==="backend_proxy_not_configured")
  return "本地后端代理未启用：请停止当前前端开发服务，在 web 目录同一个 PowerShell 中设置 $env:ATELIER_BACKEND_URL = \"http://127.0.0.1:8788\"，再执行 npm run dev 并刷新画布。";
 if(code==="backend_proxy_unavailable"||code==="backend_unreachable")
  return "无法连接本地后端：请确认 npm run dev:backend 已启动，并检查前端的 ATELIER_BACKEND_URL 配置。";
 if(code==="backend_invalid_json"||code==="backend_non_json_response")
  return "后端 API 返回了非预期格式，请确认 /api/v1/session 返回 JSON，而不是 HTML 或其他服务的响应。";
 return code;
}
export function createCanvasBackendSync(options:Options){
 if(!/^[a-zA-Z0-9_-]{1,128}$/.test(options.projectId))throw new Error("invalid_sync_project_id");
 const fetcher=options.fetcher??((url,init)=>fetch(url,{...init,credentials:"same-origin",cache:"no-store"}));
 const eventStream=options.openEventStream??((url)=>new EventSource(url,{withCredentials:true}));
 const projectUrl="/api/v1/projects/"+encodeURIComponent(options.projectId);
 const debounce=options.debounceMs??450;
 let state:BackendSyncState={status:"disabled",revision:null,cursor:0};
 let baseline="",remoteDoc:(BackendCanvasGraph&Record<string,unknown>)|null=null,csrf="",source:EventStream|null=null;
 let baselineTitle:string|undefined;
 let projectSource:EventStream|null=null,projectCursor=0;
 let projectRetryTimer:ReturnType<typeof setTimeout>|null=null,replayFailures=0;
 let closed=false,started=false,timer:ReturnType<typeof setTimeout>|null=null;
 let saving:Promise<void>|null=null,refreshing:Promise<void>|null=null;
 
 const publish=(next:Partial<BackendSyncState>)=>{
  state={...state,...next};options.onStatus?.({...state});
 };
 const isActive=()=>!closed&&started;
 const api=async<T>(path:string,init?:RequestInit):Promise<T>=>{
  let response:Response;
  try{response=await fetcher(path,{...init,credentials:"same-origin",cache:"no-store",
   headers:{...(typeof init?.body==="string"?{"content-type":"application/json"}:init?.body?{"content-type":"application/octet-stream"}:{}),...init?.headers}});
  }catch{throw new BackendSyncError("backend_unreachable")}
  return responseJson<T>(response,path);
 };
 const graphNow=()=>cloneGraph(options.getLocalGraph());
 const localTitle=()=>options.getLocalMetadata?.().title;
 const hasUnsaved=()=>graphString(graphNow())!==baseline ||
  (localTitle()!==undefined&&localTitle()!==baselineTitle);
 function clearSaveTimer(){if(timer){clearTimeout(timer);timer=null}}
 function conflict(message:string){clearSaveTimer();publish({status:"conflict",message})}
 async function saveFrozen(frozen:BackendCanvasGraph){
  if(!isActive()||state.status!=="connected"||state.revision===null||!remoteDoc)return;
  const nextDocument={...remoteDoc,...(localTitle()!==undefined?{title:localTitle()}:{}),...frozen};
  if(canonical(nextDocument)===canonical(remoteDoc))return;
  try{
   const result=await api<BackendProjectResponse>(projectUrl,{method:"PATCH",
    headers:{"if-match":'"'+state.revision+'"',"x-atelier-csrf":csrf},
    body:JSON.stringify({expectedRevision:state.revision,document:nextDocument})});
   if(!isActive())return;
   baseline=graphString(frozen);remoteDoc=JSON.parse(JSON.stringify(result.document)) as BackendCanvasGraph&Record<string,unknown>;
   baselineTitle=typeof result.document.title==="string"?result.document.title:undefined;
   publish({revision:result.revision,message:undefined});
   if(hasUnsaved())scheduleSave();
  }catch(error){
   if(!isActive())return;
   if(error instanceof BackendSyncError&&error.httpStatus===409)conflict("backend_project_revision_conflict");
   else publish({status:"disconnected",message:error instanceof Error?error.message:"save_failed"});
  }
 }
 function scheduleSave(){
  if(!isActive()||state.status!=="connected")return;
  // Avoid serializing hundreds of nodes during pointer-drag frames.
  clearSaveTimer();
  timer=setTimeout(()=>{timer=null;void flush()},debounce);
 }
 async function flush(){
  if(!isActive()||state.status!=="connected")return;
  clearSaveTimer();
  if(saving){await saving;if(isActive()&&state.status==="connected"&&hasUnsaved()) return flush();return}
  const frozen=graphNow();
  saving=saveFrozen(frozen);
  try{await saving}finally{saving=null}
 }
 async function refresh(){
  if(!isActive()||state.status==="conflict")return;
  if(refreshing)return refreshing;
  refreshing=(async()=>{
   const project=await api<BackendProjectResponse>(projectUrl);
   if(!isActive())return;
   if(state.revision!==null&&project.revision<state.revision)return;
   const local=graphNow();
   if(state.revision===project.revision){
    if(state.status==="disconnected")publish({status:"connected",message:undefined});
    return;
   }
   if(saving)await saving;
   if(!isActive()||state.status==="conflict")return;
   if(state.revision!==null&&project.revision<state.revision)return;
   if(hasUnsaved()){
    conflict("local_unsaved_changes_before_remote_update");return;
   }
   // Full remote document for ordinary edits and artifacts; no local dirty writes.
   const merged=cloneGraph(project.document);
   baseline=graphString(merged);remoteDoc=JSON.parse(JSON.stringify(project.document)) as BackendCanvasGraph&Record<string,unknown>;
   baselineTitle=typeof project.document.title==="string"?project.document.title:undefined;
   if(baselineTitle!==undefined&&baselineTitle!==localTitle())options.applyRemoteTitle?.(baselineTitle);
   publish({revision:project.revision,status:"connected",message:undefined});
   if(graphString(local)!==graphString(merged))options.applyRemoteGraph(merged);
  })();
  try{await refreshing}finally{refreshing=null}
 }
 function ingest(event:BackendJobEvent){
  if(!isActive()||!Number.isSafeInteger(event.eventId)||event.eventId<=state.cursor)return;
  publish({cursor:event.eventId});
  if(event.kind==="artifact_materialized"&&
    (event.payload as {projectId?:string}|null)?.projectId===options.projectId)
   void refresh().catch(()=>publish({status:"disconnected",message:"remote_refresh_failed"}));
 }
 async function replay(){
  if(!isActive())return;
  let response:Response;
  try{response=await fetcher("/api/v1/events?after="+state.cursor+"&once=1",{credentials:"same-origin",cache:"no-store"})}
  catch{publish({status:"disconnected",message:"event_replay_unavailable"});return}
  if(response.status===409){
   // Retention window expired: snapshot first, then new cursor, then reconnect SSE.
   try{
    const snapshot=await api<BackendJobsSnapshot>("/api/v1/jobs/snapshot");
    await refresh();
    if(isActive()&&state.status!=="conflict"){
     publish({cursor:snapshot.eventCursor,status:"connected"});
     openStream(); // replace URL with the fresh retained event cursor
    }
   }catch{publish({status:"disconnected",message:"event_snapshot_unavailable"})}
   return;
  }
  if(!response.ok){publish({status:"disconnected",message:"event_replay_unavailable"});return}
  const body=await response.text();
  const events=body.split(/\r?\n\r?\n/);
  for(const block of events){
   const data=block.split(/\r?\n/).filter(s=>s.startsWith("data: ")).map(s=>s.slice(6)).join("\n");
   if(!data)continue;
   try{ingest(JSON.parse(data) as BackendJobEvent)}catch{publish({status:"disconnected",message:"invalid_event_payload"})}
  }
 }
 function openStream(){
  source?.close();
  source=eventStream("/api/v1/events?after="+state.cursor);
  source.addEventListener("job",event=>{
   try{ingest(JSON.parse(event.data) as BackendJobEvent)}
   catch{publish({status:"disconnected",message:"invalid_event_payload"})}
  });
  source.onerror=()=>{
   if(!isActive()||state.status==="conflict")return;
   publish({status:"disconnected",message:"event_stream_disconnected"});
   void replay().then(()=>{if(isActive()&&state.status!=="conflict")void refresh().catch(()=>{})});
  };
 }

 function ingestProject(event:{eventId:number;projectId:string;revision:number}){
  if(!isActive()||!Number.isSafeInteger(event.eventId)||event.eventId<=projectCursor)return;
  projectCursor=event.eventId;
  if(event.projectId===options.projectId&&event.revision>(state.revision??0))
   void refresh().catch(()=>publish({status:"disconnected",message:"project_refresh_failed"}));
 }
 async function replayProject(){
  if(!isActive())return;
  let response:Response;
  try{response=await fetcher("/api/v1/projects/events?after="+projectCursor+"&once=1",{
   credentials:"same-origin",cache:"no-store"})}
  catch{publish({status:"disconnected",message:"project_events_unavailable"});return false}
  if(response.status===409){
   const latest=await api<{eventCursor:number}>("/api/v1/projects");
   await refresh();
   if(isActive()&&state.status!=="conflict"){
    projectCursor=latest.eventCursor;
   }
   return true;
  }
  if(!response.ok){publish({status:"disconnected",message:"project_events_unavailable"});return false}
  const body=await response.text();
  for(const block of body.split(/\r?\n\r?\n/)){
   const data=block.split(/\r?\n/).filter(line=>line.startsWith("data: ")).map(line=>line.slice(6)).join("\n");
   if(!data)continue;
   try{ingestProject(JSON.parse(data))}catch{publish({status:"disconnected",message:"invalid_project_event"})}
  }
  if(state.status==="disconnected")await refresh();
  return true;
 }

 function retryProjectStream(){
  if(!isActive()||state.status==="conflict"||projectRetryTimer)return;
  const delay=Math.min(30000,1000*2**Math.min(5,replayFailures++));
  projectRetryTimer=setTimeout(()=>{
   projectRetryTimer=null;
   void replayProject().then(ok=>{
    if(!isActive()||state.status==="conflict")return;
    if(ok){replayFailures=0;openProjectStream()}
    else retryProjectStream();
   }).catch(()=>retryProjectStream());
  },delay);
 }
 function openProjectStream(){
  projectSource?.close();
  projectSource=eventStream("/api/v1/projects/events?after="+projectCursor);
  projectSource.addEventListener("project",event=>{
   try{ingestProject(JSON.parse(event.data))}
   catch{publish({status:"disconnected",message:"invalid_project_event"})}
  });
  projectSource.onerror=()=>{
   if(!isActive()||state.status==="conflict")return;
   publish({status:"disconnected",message:"project_stream_disconnected"});
   projectSource?.close();projectSource=null;
   retryProjectStream();
  };
 }
 async function connect(){
  if(closed)throw new Error("backend_sync_closed");
  if(started)return;
  publish({status:"connecting",message:undefined});
  try{
   let session:{csrfToken:string};
   try{session=await api<{csrfToken:string}>("/api/v1/session")}
   catch(error){
    if(!(error instanceof BackendSyncError)||error.httpStatus!==401||!options.requestBootstrap)throw error;
    const bootstrap=await options.requestBootstrap();
    if(!bootstrap)throw new BackendSyncError("backend_session_not_authorized",401);
    await api("/api/v1/session",{method:"POST",headers:{authorization:"Bearer "+bootstrap},body:"{}"});
    session=await api<{csrfToken:string}>("/api/v1/session");
   }
   csrf=session.csrfToken;
   // Snapshot first: event replay later catches materializations during connect.
   const snapshot=await api<BackendJobsSnapshot>("/api/v1/jobs/snapshot");
   const projectSnapshot=await api<{eventCursor:number}>("/api/v1/projects");
   let project:BackendProjectResponse;
   try{project=await api<BackendProjectResponse>(projectUrl)}
   catch(error){
    if(!(error instanceof BackendSyncError)||error.httpStatus!==404)throw error;
    const draft=graphNow();
    project=await api<BackendProjectResponse>("/api/v1/projects",{method:"POST",
     headers:{"x-atelier-csrf":csrf},body:JSON.stringify({id:options.projectId,document:{...options.getLocalMetadata?.(),...draft}})});
   }
   if(closed)return;
   const current=graphNow();
   const merged=safeRemoteCanvasMerge(current,project.document);
   if(!merged){conflict("backend_project_baseline_conflict");return}
   started=true;baseline=graphString(merged);remoteDoc=JSON.parse(JSON.stringify(project.document)) as BackendCanvasGraph&Record<string,unknown>;
   baselineTitle=typeof project.document.title==="string"?project.document.title:undefined;
   publish({status:"connected",revision:project.revision,cursor:snapshot.eventCursor,message:undefined});
   projectCursor=projectSnapshot.eventCursor;
   if(graphString(current)!==graphString(merged))options.applyRemoteGraph(merged);
   openStream();
   openProjectStream();
   // Catch up even if events arrived between GET project and EventSource registration.
   await replay();
   await replayProject();
  }catch(error){
   if(!closed){
    const code=error instanceof BackendSyncError&&error.code==="invalid_project_document"&&error.details?.reason
     ? "invalid_project_document:"+error.details.reason+":"+(error.details.nodeIndex??error.details.connectionIndex??"")
     : error instanceof Error?error.message:"connect_failed";
    publish({status:"error",message:code});
   }
  }
 }


 /** Strict, explicit generation save barrier. Never submit from a draft whose
  * exact saved graph and revision cannot be verified after async flush.
  */
 async function saveProjectNow(frozenGraph:BackendCanvasGraph,targetNodeId:string){
  if(!isActive()||state.status!=="connected")throw new BackendSyncError("backend_sync_not_connected");
  const frozen=canonicalBackendGraph(frozenGraph);
  if(canonicalBackendGraph(graphNow())!==frozen)throw new BackendSyncError("generation_draft_changed");
  await flush();
  if(!isActive()||state.status!=="connected"||state.revision===null||
     canonicalBackendGraph(graphNow())!==frozen||baseline!==frozen)
   throw new BackendSyncError("generation_save_barrier_required");
  const revision=state.revision;
  const sourceNodeFingerprint=await fingerprintBackendSource(frozenGraph,targetNodeId);
  if(!isActive()||state.status!=="connected"||state.revision!==revision||
     canonicalBackendGraph(graphNow())!==frozen||baseline!==frozen)
   throw new BackendSyncError("generation_draft_changed");
  return {projectId:options.projectId,revision,sourceNodeFingerprint};
 }

 async function assertComfyReady(instanceId:string){
  if(!isActive()||state.status!=="connected")throw new BackendSyncError("backend_sync_not_connected");
  const config=await api<{autoDispatch:boolean;comfyInstanceIds:string[]}>("/api/v1/execution/capabilities");
  if(!config.autoDispatch||!config.comfyInstanceIds.includes(instanceId))
   throw new BackendSyncError("backend_comfy_instance_not_ready");
 }
 async function uploadFrozenBlob(blob:Blob,mimeType:string):Promise<BlobUploadResponse>{
  if(!isActive()||state.status!=="connected")throw new BackendSyncError("backend_sync_not_connected");
  if(!["image/png","image/jpeg","image/webp"].includes(mimeType))
   throw new BackendSyncError("unsupported_blob_mime");
  // Streaming bytes (not JSON), within same-origin Session + CSRF guard.
  return api<BlobUploadResponse>("/api/v1/blobs",{
   method:"POST",headers:{"x-atelier-csrf":csrf,"x-atelier-mime":mimeType},body:blob
  });
 }
 async function submitFrozenJob(payload:Record<string,unknown>):Promise<BackendJobView>{
  if(!isActive()||state.status!=="connected")throw new BackendSyncError("backend_sync_not_connected");
  // The backend independently verifies project revision/fingerprint in SQLite.
  return api<BackendJobView>("/api/v1/jobs",{method:"POST",
   headers:{"x-atelier-csrf":csrf},body:JSON.stringify(payload)});
 }
 /** Explicit conflict recovery. Only merges server-added artifacts into a local
  * draft when the relevant source nodes and the entire server baseline match.
  * A PATCH with If-Match is required before reporting success.
  */
 async function reconcileConflict():Promise<boolean>{
  if(!isActive()||state.status!=="conflict"||!baseline)return false;
  try{
   const project=await api<BackendProjectResponse>(projectUrl);
   if(!isActive())return false;
   const old=JSON.parse(baseline) as BackendCanvasGraph;
   const incremental=safeRemoteCanvasMerge(old,project.document);
   if(!incremental)return false;
   const local=graphNow(),localIds=new Set(local.nodes.map(n=>n.id));
   const oldIds=new Set(old.nodes.map(n=>n.id));
   const newNodes=incremental.nodes.filter(n=>!oldIds.has(n.id));
   const newIds=new Set(newNodes.map(n=>n.id));
   for(const node of newNodes){
    const sourceId=node.metadata?.comfyArtifact?.workflowNodeId;
    const oldSource=old.nodes.find(n=>n.id===sourceId);
    const liveSource=local.nodes.find(n=>n.id===sourceId);
    if(!oldSource||!liveSource||canonical(oldSource)!==canonical(liveSource)||
       localIds.has(node.id))return false;
   }
   const oldLinks=new Set(old.connections.map(e=>e.id));
   const extraLinks=incremental.connections.filter(e=>!oldLinks.has(e.id));
   if(extraLinks.some(e=>!newIds.has(e.toNodeId)||
      local.connections.some(existing=>existing.id===e.id||
       existing.toNodeId===e.toNodeId)))return false;
   const merged={nodes:[...local.nodes,...newNodes],connections:[...local.connections,...extraLinks]};
   // Preserve the backend's unrelated document fields and require the latest revision.
   const result=await api<BackendProjectResponse>(projectUrl,{method:"PATCH",
    headers:{"if-match":'"'+project.revision+'"',"x-atelier-csrf":csrf},
    body:JSON.stringify({expectedRevision:project.revision,document:{...project.document,...merged}})});
   if(!isActive())return false;
   baseline=graphString(merged);
   remoteDoc=JSON.parse(JSON.stringify(result.document)) as BackendCanvasGraph&Record<string,unknown>;
   if(graphString(graphNow())!==graphString(local)){
    // Another user edit happened during PATCH; keep it on screen, never replace.
    publish({revision:result.revision,status:"conflict",message:"local_changed_during_reconciliation"});
    return false;
   }
   options.applyRemoteGraph(merged);
   publish({revision:result.revision,status:"connected",message:undefined});
   return true;
  }catch(error){
   if(isActive())publish({status:"conflict",message:error instanceof Error?error.message:"conflict_reconciliation_failed"});
   return false;
  }
 }
 function disconnect(){
  clearSaveTimer();started=false;closed=true;
  if(projectRetryTimer){clearTimeout(projectRetryTimer);projectRetryTimer=null}
  source?.close();source=null;projectSource?.close();projectSource=null;
  publish({status:"disabled",message:undefined});
 }
 return {connect,flush,scheduleSave,saveProjectNow,assertComfyReady,uploadFrozenBlob,submitFrozenJob,refresh,replay,reconcileConflict,disconnect,get state(){return {...state}}};
}
