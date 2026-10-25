import {create} from "zustand";
import {nanoid} from "nanoid";
import i18n from "@/i18n";
import type {CanvasBackgroundMode} from "@/lib/canvas-theme";
import type {CanvasAssistantSession,CanvasConnection,CanvasNodeData,ViewportTransform} from "@/types/canvas";
import {canvasApi,type CanvasBackendProject,type CanvasBackendSummary} from "@/features/backend-sync/canvas-api";

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
};
const initialViewport:ViewportTransform={x:0,y:0,k:1};
const revisions=new Map<string,number>(),loaded=new Set<string>(),dirty=new Set<string>();
const timers=new Map<string,ReturnType<typeof setTimeout>>();
const activeWrites=new Map<string,Promise<void>>();
const lastErrors=new Map<string,unknown>();
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
 nodes:value.nodes,connections:value.connections,chatSessions:value.chatSessions,
 activeChatId:value.activeChatId,backgroundMode:value.backgroundMode,
 showImageInfo:value.showImageInfo,comfyInstanceId:value.comfyInstanceId,
 viewport:value.viewport
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
    revisions.set(id,response.revision);lastErrors.delete(id);
    useCanvasStore.setState({error:null});
   }catch(error){
    dirty.add(id);lastErrors.set(id,error);
    useCanvasStore.setState({error:error instanceof Error?error.message:"project_save_failed"});
    throw error;
   }
  }
 })();
 activeWrites.set(id,run);
 try{await run}finally{if(activeWrites.get(id)===run)activeWrites.delete(id)}
}
export function flushCanvasStorePersistence():void{
 for(const [id,timer] of timers){clearTimeout(timer);timers.delete(id)}
 for(const id of dirty)void saveProject(id).catch(()=>{});
}
export async function awaitCanvasStorePersistence():Promise<void>{
 flushCanvasStorePersistence();
 for(const id of new Set([...activeWrites.keys(),...dirty]))await saveProject(id);
 if(lastErrors.size)throw lastErrors.values().next().value;
}
function updateCached(id:string,update:(project:CanvasProject)=>CanvasProject){
 useCanvasStore.setState(state=>state.projects.some(p=>p.id===id)?
  {projects:state.projects.map(project=>project.id===id?update(project):project)}:state);
 if(loaded.has(id)){dirty.add(id);schedule(id)}
}
if(typeof window!=="undefined"){
 window.addEventListener("beforeunload",event=>{
  if(dirty.size===0&&activeWrites.size===0)return;
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
  if(dirty.has(id))throw Error("project_unsaved_local_edits");
  const remote=await canvasApi<CanvasBackendProject>("/api/v1/projects/"+encodeURIComponent(id));
  const project=asProject(remote);
  revisions.set(id,remote.revision);loaded.add(id);lastErrors.delete(id);
  set(state=>({projects:[...state.projects.filter(item=>item.id!==id),project],error:null,hydrated:true}));
  return project;
 },
 createProject:async(title=i18n.t("canvas.project.untitled"))=>{
  const id=nanoid(),createdAt=now();
  const document={title,nodes:[],connections:[],chatSessions:[],activeChatId:null,
   createdAt,updatedAt:createdAt,backgroundMode:"lines",showImageInfo:false,viewport:initialViewport};
  const response=await canvasApi<CanvasBackendProject>("/api/v1/projects","POST",{id,document});
  revisions.set(id,response.revision);loaded.add(id);
  set(state=>({projects:[asProject(response),...state.projects],error:null,hydrated:true}));
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
  revisions.set(id,response.revision);loaded.add(id);
  set(state=>({projects:[asProject(response),...state.projects]}));
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
   loaded.delete(id);dirty.delete(id);revisions.delete(id);lastErrors.delete(id);
   const timer=timers.get(id);if(timer)clearTimeout(timer);timers.delete(id);
  }
 },
 replaceProjects:()=>{throw Error("canvas_legacy_browser_restore_not_supported")},
 updateProject:(id,patch)=>updateCached(id,project=>({...project,...patch,updatedAt:now()}))
}));
