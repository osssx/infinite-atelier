import {create} from "zustand";
import {nanoid} from "nanoid";
import i18n from "@/i18n";
import type {CanvasBackgroundMode} from "@/lib/canvas-theme";
import type {CanvasAssistantSession,CanvasConnection,CanvasNodeData,ViewportTransform} from "@/types/canvas";
import {canvasApi,type CanvasBackendProject,type CanvasBackendSummary} from "@/features/backend-sync/canvas-api";
import {createCanvasStatePersistence,preserveValidCanvasViewport} from "@/features/backend-sync/canvas-state-persistence";
import {safeRemoteCanvasMerge} from "@/features/backend-sync/canvas-backend-sync";
import {canonicalBackendGraph} from "@/features/backend-sync/backend-source-fingerprint";
import {rebaseCanvasArtifactAdditions,type GraphForRebase} from "@/features/backend-sync/canvas-artifact-save-rebase";
import {CanvasApiError} from "@/features/backend-sync/canvas-api";

/** Backend is authoritative. No IndexedDB, localStorage, or browser backup
 * participates in loading/saving canvas projects. */
export type CanvasProject={
 id:string;title:string;createdAt:string;updatedAt:string;
 nodes:CanvasNodeData[];connections:CanvasConnection[];
 chatSessions:CanvasAssistantSession[];activeChatId:string|null;
 backgroundMode:CanvasBackgroundMode;showImageInfo:boolean;
 comfyInstanceId?:string;viewport:ViewportTransform;
 nodeCount?:number;connectionCount?:number;
};
type Patch=Partial<Pick<CanvasProject,"nodes"|"connections"|"chatSessions"|"activeChatId"|"backgroundMode"|"showImageInfo"|"comfyInstanceId"|"viewport">>;
type CanvasStore={
 hydrated:boolean;loading:boolean;error:string|null;projects:CanvasProject[];
 loadProjects:()=>Promise<void>;loadProject:(id:string)=>Promise<CanvasProject>;
 createProject:(title?:string)=>Promise<string>;
 importProject:(project:Partial<CanvasProject>)=>Promise<string>;
 adoptBackendProject:(project:CanvasProject)=>boolean;
 openProject:(id:string)=>CanvasProject|null;
 renameProject:(id:string,title:string)=>Promise<void>;
 deleteProjects:(ids:string[])=>Promise<void>;
 replaceProjects:(projects:CanvasProject[])=>void;
 updateProject:(id:string,patch:Patch)=>void;
 adoptMaterializedGraph:(id:string,expected:{nodes:CanvasNodeData[];connections:CanvasConnection[]},remote:CanvasBackendProject)=>boolean;
};
const initialViewport:ViewportTransform={x:0,y:0,k:1};
const revisions=new Map<string,number>(),loaded=new Set<string>(),dirty=new Set<string>();
const baselines=new Map<string,CanvasBackendProject["document"]>();
const rebasedListeners=new Set<(id:string,graph:GraphForRebase)=>void>();
export function subscribeCanvasGraphRebased(callback:(id:string,graph:GraphForRebase)=>void):()=>void{
 rebasedListeners.add(callback);
 return ()=>rebasedListeners.delete(callback);
}
const cloned=<T,>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const sameMetadata=(a:Record<string,unknown>,b:Record<string,unknown>)=>{
 const nonGraph=(doc:Record<string,unknown>)=>{
  const {nodes,connections,...rest}=doc;void nodes;void connections;return rest;
 };
 return JSON.stringify(nonGraph(a))===JSON.stringify(nonGraph(b));
};

const timers=new Map<string,ReturnType<typeof setTimeout>>();
const activeWrites=new Map<string,Promise<void>>();
const lastErrors=new Map<string,unknown>();
const auxiliary=createCanvasStatePersistence(error=>{
 if(error===null&&lastErrors.size)return;
 useCanvasStore.setState({error:error instanceof Error?error.message:null});
});
export type PersistTiming={sequence:number;stringifyMs:number;bytes:number;writeMs:number;onHide:boolean};
export const drainPersistTimings=():PersistTiming[]=>[];
const now=()=>new Date().toISOString();
function asProject(remote:CanvasBackendProject):CanvasProject{
 const doc=remote.document;
 if(!Array.isArray(doc.nodes)||!Array.isArray(doc.connections))throw Error("invalid_project_document");
 return {
  id:remote.id,title:typeof doc.title==="string"?doc.title:remote.id,
  createdAt:typeof doc.createdAt==="string"?doc.createdAt:now(),
  updatedAt:typeof doc.updatedAt==="string"?doc.updatedAt:now(),
  nodes:doc.nodes as CanvasNodeData[],connections:doc.connections as CanvasConnection[],
  chatSessions:Array.isArray(doc.chatSessions)?doc.chatSessions as CanvasAssistantSession[]:[],
  activeChatId:typeof doc.activeChatId==="string"?doc.activeChatId:null,
  backgroundMode:(doc.backgroundMode??"lines") as CanvasBackgroundMode,
  showImageInfo:doc.showImageInfo===true,
  comfyInstanceId:typeof doc.comfyInstanceId==="string"?doc.comfyInstanceId:undefined,
  viewport:doc.viewport&&typeof doc.viewport==="object"?doc.viewport as ViewportTransform:initialViewport
 };
}
const asDocument=(value:CanvasProject)=>({
 title:value.title,createdAt:value.createdAt,updatedAt:value.updatedAt,
 nodes:value.nodes,connections:value.connections,
 backgroundMode:value.backgroundMode,showImageInfo:value.showImageInfo,
 comfyInstanceId:value.comfyInstanceId
});
function schedule(id:string){
 const timer=timers.get(id);if(timer)clearTimeout(timer);
 timers.set(id,setTimeout(()=>{timers.delete(id);void saveProject(id).catch(()=>{})},450));
}
async function saveProject(id:string):Promise<void>{
 const existing=activeWrites.get(id);
 if(existing){await existing;if(dirty.has(id))return saveProject(id);return}
 if(!dirty.has(id)||!revisions.has(id))return;
 const run=(async()=>{
  let rebases=0;
  while(dirty.has(id)){
   const project=useCanvasStore.getState().openProject(id);
   if(!project)return;
   dirty.delete(id);
   const revision=revisions.get(id);
   if(revision===undefined)throw Error("project_not_loaded");
   try{
    const response=await canvasApi<CanvasBackendProject>("/api/v1/projects/"+encodeURIComponent(id),"PATCH",{
     expectedRevision:revision,document:asDocument(project)
    });
    revisions.set(id,response.revision);baselines.set(id,cloned(response.document));
    lastErrors.delete(id);
    if(!auxiliary.hasPending())useCanvasStore.setState({error:null});
   }catch(error){
    if(error instanceof CanvasApiError&&error.code==="project_revision_conflict"&&rebases<3){
     try{
      // Rebase only additive generated artifacts; do not overwrite user data.
      const remote=await canvasApi<CanvasBackendProject>("/api/v1/projects/"+encodeURIComponent(id));
      const baseline=baselines.get(id);
      const local=useCanvasStore.getState().openProject(id);
      if(remote.id===id&&baseline&&local&&remote.revision>revision&&
         sameMetadata(baseline,remote.document)){
       const merged=rebaseCanvasArtifactAdditions(
        {nodes:baseline.nodes as CanvasNodeData[],connections:baseline.connections as CanvasConnection[]},
        {nodes:local.nodes,connections:local.connections},
        {nodes:remote.document.nodes as CanvasNodeData[],connections:remote.document.connections as CanvasConnection[]}
       );
       if(merged){
        rebases++;
        revisions.set(id,remote.revision);baselines.set(id,cloned(remote.document));
        useCanvasStore.setState(state=>({projects:state.projects.map(value=>
         value.id===id?{...value,nodes:merged.nodes,connections:merged.connections}:value)}));
        dirty.add(id);lastErrors.delete(id);
        useCanvasStore.setState({error:null});
        for(const cb of rebasedListeners){try{cb(id,merged)}catch{/* UI observer cannot abort the save */}}
        continue;
       }
      }
     }catch{/* Preserve the unsaved draft on any unsafe or failed rebase. */}
    }
    dirty.add(id);lastErrors.set(id,error);
    useCanvasStore.setState({error:error instanceof Error?error.message:"project_save_failed"});
    throw error;
   }
  }
 })();
 activeWrites.set(id,run);
 try{await run}finally{if(activeWrites.get(id)===run)activeWrites.delete(id)}
}
export function flushCanvasStorePersistence(projectId?:string):void{
 for(const [id,timer] of timers){
  if(projectId&&id!==projectId)continue;
  clearTimeout(timer);timers.delete(id);
 }
 for(const id of dirty)if(!projectId||id===projectId)void saveProject(id).catch(()=>{});
 void auxiliary.flush(projectId).catch(()=>{});
}
export async function awaitCanvasStorePersistence(projectId?:string):Promise<void>{
 flushCanvasStorePersistence(projectId);
 for(const id of new Set([...activeWrites.keys(),...dirty]))
  if(!projectId||id===projectId)await saveProject(id);
 await auxiliary.flush(projectId);
 if(projectId){
  const failure=lastErrors.get(projectId);
  if(failure)throw failure;
 }else if(lastErrors.size)throw lastErrors.values().next().value;
}
function updateCached(id:string,update:(project:CanvasProject)=>CanvasProject){
 useCanvasStore.setState(state=>state.projects.some(p=>p.id===id)?
  {projects:state.projects.map(project=>project.id===id?update(project):project)}:state);
 if(loaded.has(id)){dirty.add(id);schedule(id)}
}
if(typeof window!=="undefined"){
 window.addEventListener("beforeunload",event=>{
  if(dirty.size===0&&activeWrites.size===0&&!auxiliary.hasPending())return;
  event.preventDefault();
  event.returnValue="";
 });
 window.addEventListener("pagehide",()=>flushCanvasStorePersistence());
}
export const useCanvasStore=create<CanvasStore>((set,get)=>({
 hydrated:false,loading:false,error:null,projects:[],
 loadProjects:async()=>{
  set({loading:true,error:null});
  try{
   const listing=await canvasApi<{projects:CanvasBackendSummary[]}>("/api/v1/projects");
   set(state=>({hydrated:true,loading:false,error:null,projects:listing.projects.map(summary=>{
    const cached=state.projects.find(project=>project.id===summary.id);
    if(cached&&(loaded.has(summary.id)||dirty.has(summary.id)))return cached;
    return {id:summary.id,title:summary.title,createdAt:now(),updatedAt:now(),
     nodes:[],connections:[],chatSessions:[],activeChatId:null,backgroundMode:"lines" as CanvasBackgroundMode,
     showImageInfo:false,viewport:initialViewport,nodeCount:summary.nodeCount,connectionCount:summary.connectionCount};
   })}));
  }catch(error){set({loading:false,error:error instanceof Error?error.message:"backend_unavailable"});throw error}
 },
 loadProject:async id=>{
  if(dirty.has(id)||activeWrites.has(id)||auxiliary.hasPending(id))throw Error("project_unsaved_local_edits");
  const [remote,state]=await Promise.all([
   canvasApi<CanvasBackendProject>("/api/v1/projects/"+encodeURIComponent(id)),
   auxiliary.load(id)
  ]);
  const project={...asProject(remote),viewport:state.viewport,chatSessions:state.sessions,activeChatId:state.activeChatId};
  revisions.set(id,remote.revision);baselines.set(id,cloned(remote.document));loaded.add(id);lastErrors.delete(id);
  set(state=>({projects:[...state.projects.filter(item=>item.id!==id),project],error:null,hydrated:true}));
  return project;
 },
 createProject:async(title=i18n.t("canvas.project.untitled"))=>{
  const id=nanoid(),createdAt=now();
  const document={title,nodes:[],connections:[],chatSessions:[],activeChatId:null,
   createdAt,updatedAt:createdAt,backgroundMode:"lines",showImageInfo:false,viewport:initialViewport};
  const response=await canvasApi<CanvasBackendProject>("/api/v1/projects","POST",{id,document});
  revisions.set(id,response.revision);baselines.set(id,cloned(response.document));loaded.add(id);
  set(state=>({projects:[asProject(response),...state.projects],error:null,hydrated:true}));
  auxiliary.initialize(id,{viewport:initialViewport,sessions:[],activeChatId:null});
  return id;
 },
 importProject:async source=>{
  const id=nanoid(),timestamp=now();
  const document={title:source.title||i18n.t("canvas.project.imported"),
   createdAt:timestamp,updatedAt:timestamp,nodes:source.nodes??[],connections:source.connections??[],
   chatSessions:source.chatSessions??[],activeChatId:source.activeChatId??null,
   backgroundMode:source.backgroundMode??"lines",showImageInfo:source.showImageInfo??false,
   comfyInstanceId:source.comfyInstanceId,viewport:source.viewport??initialViewport};
  const response=await canvasApi<CanvasBackendProject>("/api/v1/projects","POST",{id,document});
  revisions.set(id,response.revision);baselines.set(id,cloned(response.document));loaded.add(id);
  set(state=>({projects:[asProject(response),...state.projects]}));
  auxiliary.initialize(id,{viewport:source.viewport??initialViewport,sessions:source.chatSessions??[],activeChatId:source.activeChatId??null});
  return id;
 },
 adoptBackendProject:()=>false,
 openProject:id=>get().projects.find(item=>item.id===id)??null,
 renameProject:async(id,title)=>{
  if(!loaded.has(id))await get().loadProject(id);
  updateCached(id,project=>({...project,title:title.trim()||project.title,updatedAt:now()}));
  await awaitCanvasStorePersistence();
 },
 deleteProjects:async ids=>{
  await awaitCanvasStorePersistence();
  for(const id of ids){
   await canvasApi<{deleted:boolean}>("/api/v1/projects/"+encodeURIComponent(id),"DELETE");
   // Each committed DELETE is reflected immediately, even if a later item fails.
   set(state=>({projects:state.projects.filter(item=>item.id!==id)}));
   loaded.delete(id);dirty.delete(id);revisions.delete(id);baselines.delete(id);lastErrors.delete(id);
   auxiliary.discard(id);
   const timer=timers.get(id);if(timer)clearTimeout(timer);timers.delete(id);
  }
 },
 adoptMaterializedGraph:(id,expected,remote)=>{
  if(remote.id!==id||dirty.has(id)||activeWrites.has(id)||!loaded.has(id))return false;
  const revision=revisions.get(id);
  if(revision===undefined||remote.revision<=revision)return false;
  const project=get().openProject(id);
  if(!project)return false;
  const current={nodes:project.nodes,connections:project.connections};
  if(canonicalBackendGraph(current)!==canonicalBackendGraph(expected))return false;
  if(!Array.isArray(remote.document.nodes)||!Array.isArray(remote.document.connections))return false;
  const merged=safeRemoteCanvasMerge(current,{
   nodes:remote.document.nodes as CanvasNodeData[],
   connections:remote.document.connections as CanvasConnection[]
  });
  if(!merged)return false;
  // Single synchronous Store commit: accepted server revision + graph always
  // advance together. No PATCH: this is a backend-authoritative materialization.
  revisions.set(id,remote.revision);baselines.set(id,cloned(remote.document));
  set(state=>({projects:state.projects.map(item=>item.id===id?
   {...item,nodes:merged.nodes,connections:merged.connections}:item)}));
  return true;
 },
 replaceProjects:()=>{throw Error("canvas_legacy_browser_restore_not_supported")},
 updateProject:(id,patch)=>{
  const {viewport,chatSessions,activeChatId,...graphPatch}=patch;
  const existing=get().openProject(id);
  const validViewport=viewport===undefined?undefined:
   preserveValidCanvasViewport(viewport,existing?.viewport??initialViewport);
  const viewportChanged=validViewport!==undefined&&(
   validViewport.x!==existing?.viewport.x||
   validViewport.y!==existing?.viewport.y||
   validViewport.k!==existing?.viewport.k);
  // Reapplying the exact authoritative arrays after a materialization must
  // not create another redundant PATCH and move its server revision.
  const graphChanged=Object.entries(graphPatch).some(([key,value])=>
   existing?.[key as keyof CanvasProject]!==value);
  const chatsChanged=(activeChatId!==undefined&&activeChatId!==existing?.activeChatId)||
   (chatSessions!==undefined&&JSON.stringify(chatSessions)!==
    JSON.stringify(existing?.chatSessions));
  // The page's initial hydration effect often replays []/null unchanged.
  // It must not advance the chats revision or create an unnecessary PUT.
  if(!graphChanged&&!viewportChanged&&!chatsChanged)return;
  useCanvasStore.setState(state=>state.projects.some(project=>project.id===id)?
   {projects:state.projects.map(project=>project.id===id?
    {...project,...patch,...(validViewport!==undefined?{viewport:validViewport}:{}),
     updatedAt:graphChanged?now():project.updatedAt}:project)}:state);
  if(!loaded.has(id))return;
  if(graphChanged){dirty.add(id);schedule(id)}
  if(viewportChanged&&validViewport!==undefined)auxiliary.updateViewport(id,validViewport);
  if(chatsChanged){
   const project=useCanvasStore.getState().openProject(id);
   if(project)auxiliary.updateChats(id,project.chatSessions,project.activeChatId);
  }
 }
}));
