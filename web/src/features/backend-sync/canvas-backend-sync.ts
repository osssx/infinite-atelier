import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import type {BackendJobEvent,BackendJobsSnapshot,BackendErrorResponse} from "@/types/backend-contracts";

export type BackendCanvasGraph={nodes:CanvasNodeData[];connections:CanvasConnection[]};
export type BackendSyncStatus="disabled"|"connecting"|"connected"|"conflict"|"disconnected"|"error";
export type BackendSyncState={status:BackendSyncStatus;revision:number|null;cursor:number;message?:string};
export type BackendProjectResponse={id:string;revision:number;document:BackendCanvasGraph;deletedAt?:number|null};
type Fetcher=(url:string,init?:RequestInit)=>Promise<Response>;
type EventStream={addEventListener:(type:string,callback:(event:MessageEvent<string>)=>void)=>void;onerror:((event:Event)=>void)|null;close:()=>void};
type Options={
 projectId:string;getLocalGraph:()=>BackendCanvasGraph;
 applyRemoteGraph:(graph:BackendCanvasGraph)=>void;
 onStatus?:(state:BackendSyncState)=>void;
 fetcher?:Fetcher;openEventStream?:(url:string)=>EventStream;
 /** The launcher prints a single-use token; request it explicitly, never persist it. */
 requestBootstrap?:()=>Promise<string|null>;
 debounceMs?:number;
};
export class BackendSyncError extends Error{
 constructor(readonly code:string,readonly httpStatus:number=0){
  super(code);this.name="BackendSyncError";
 }
}
const cloneGraph=(graph:BackendCanvasGraph):BackendCanvasGraph=>JSON.parse(JSON.stringify({
 nodes:graph.nodes,connections:graph.connections
})) as BackendCanvasGraph;
const graphString=(graph:BackendCanvasGraph)=>canonical(cloneGraph(graph));
const isGenerated=(n:CanvasNodeData)=>Boolean(n.metadata?.comfyArtifact?.artifactId);
function canonical(value:unknown):string{
 if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
 if(value&&typeof value==="object"){
  const items=Object.entries(value).filter(([,v])=>v!==undefined)
   .sort(([a],[b])=>a.localeCompare(b));
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
  const origin=node.metadata?.comfyArtifact;
  if(!origin||!isGenerated(node)||!localNodes.has(origin.workflowNodeId)||
    !["image","video","audio","text"].includes(origin.kind)||
    node.type!==origin.kind) return null;
  const existing=local.nodes.find(n=>n.metadata?.comfyArtifact?.artifactId===origin.artifactId);
  if(existing)return null;
  if(!remote.connections.some(e=>e.fromNodeId===origin.workflowNodeId&&e.fromPortId===origin.portId&&
     e.toNodeId===node.id&&e.toPortId==="comfy-artifact"))return null;
 }
 for(const edge of remote.connections.filter(e=>!localEdges.has(e.id))){
  if(!newIds.has(edge.toNodeId)||edge.toPortId!=="comfy-artifact"||
     !localNodes.has(edge.fromNodeId))return null;
 }
 return cloneGraph(remote);
}
async function responseJson<T>(response:Response):Promise<T>{
 const value:unknown=await response.json().catch(()=>null);
 if(!response.ok){
  const error=value as Partial<BackendErrorResponse>|null;
  throw new BackendSyncError(typeof error?.code==="string"?error.code:"backend_http_error",response.status);
 }
 if(!value||typeof value!=="object"||Array.isArray(value))throw new BackendSyncError("backend_invalid_json",response.status);
 return value as T;
}
export function createCanvasBackendSync(options:Options){
 if(!/^[a-zA-Z0-9_-]{1,128}$/.test(options.projectId))throw new Error("invalid_sync_project_id");
 const fetcher=options.fetcher??((url,init)=>fetch(url,{...init,credentials:"same-origin",cache:"no-store"}));
 const eventStream=options.openEventStream??((url)=>new EventSource(url,{withCredentials:true}));
 const projectUrl="/api/v1/projects/"+encodeURIComponent(options.projectId);
 const debounce=options.debounceMs??450;
 let state:BackendSyncState={status:"disabled",revision:null,cursor:0};
 let baseline="",remoteDoc:(BackendCanvasGraph&Record<string,unknown>)|null=null,csrf="",source:EventStream|null=null;
 let closed=false,started=false,timer:ReturnType<typeof setTimeout>|null=null;
 let saving:Promise<void>|null=null,refreshing:Promise<void>|null=null;
 
 const publish=(next:Partial<BackendSyncState>)=>{
  state={...state,...next};options.onStatus?.({...state});
 };
 const isActive=()=>!closed&&started;
 const api=async<T>(path:string,init?:RequestInit):Promise<T>=>{
  let response:Response;
  try{response=await fetcher(path,{...init,credentials:"same-origin",cache:"no-store",
   headers:{...(init?.body?{"content-type":"application/json"}:{}),...init?.headers}});
  }catch{throw new BackendSyncError("backend_unreachable")}
  return responseJson<T>(response);
 };
 const graphNow=()=>cloneGraph(options.getLocalGraph());
 function clearSaveTimer(){if(timer){clearTimeout(timer);timer=null}}
 function conflict(message:string){clearSaveTimer();publish({status:"conflict",message})}
 async function saveFrozen(frozen:BackendCanvasGraph){
  if(!isActive()||state.status!=="connected"||state.revision===null||!remoteDoc)return;
  if(graphString(frozen)===baseline)return;
  try{
   const result=await api<BackendProjectResponse>(projectUrl,{method:"PATCH",
    headers:{"if-match":'"'+state.revision+'"',"x-atelier-csrf":csrf},
    body:JSON.stringify({expectedRevision:state.revision,document:{...remoteDoc,...frozen}})});
   if(!isActive())return;
   baseline=graphString(frozen);remoteDoc=JSON.parse(JSON.stringify(result.document)) as BackendCanvasGraph&Record<string,unknown>;
   publish({revision:result.revision,message:undefined});
   if(graphString(graphNow())!==baseline)scheduleSave();
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
  if(saving){await saving;if(isActive()&&state.status==="connected"&&graphString(graphNow())!==baseline) return flush();return}
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
   if(graphString(local)!==baseline){
    conflict("local_unsaved_changes_before_remote_update");return;
   }
   const merged=safeRemoteCanvasMerge(local,project.document);
   if(!merged){conflict("remote_canvas_diverged");return}
   baseline=graphString(merged);remoteDoc=JSON.parse(JSON.stringify(project.document)) as BackendCanvasGraph&Record<string,unknown>;
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
   let project:BackendProjectResponse;
   try{project=await api<BackendProjectResponse>(projectUrl)}
   catch(error){
    if(!(error instanceof BackendSyncError)||error.httpStatus!==404)throw error;
    const draft=graphNow();
    project=await api<BackendProjectResponse>("/api/v1/projects",{method:"POST",
     headers:{"x-atelier-csrf":csrf},body:JSON.stringify({id:options.projectId,document:draft})});
   }
   if(closed)return;
   const current=graphNow();
   const merged=safeRemoteCanvasMerge(current,project.document);
   if(!merged){conflict("backend_project_baseline_conflict");return}
   started=true;baseline=graphString(merged);remoteDoc=JSON.parse(JSON.stringify(project.document)) as BackendCanvasGraph&Record<string,unknown>;
   publish({status:"connected",revision:project.revision,cursor:snapshot.eventCursor,message:undefined});
   if(graphString(current)!==graphString(merged))options.applyRemoteGraph(merged);
   openStream();
   // Catch up even if events arrived between GET project and EventSource registration.
   await replay();
  }catch(error){
   if(!closed)publish({status:"error",message:error instanceof Error?error.message:"connect_failed"});
  }
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
  source?.close();source=null;publish({status:"disabled",message:undefined});
 }
 return {connect,flush,scheduleSave,refresh,replay,reconcileConflict,disconnect,get state(){return {...state}}};
}
