import type {CanvasAssistantSession,ViewportTransform} from "@/types/canvas";
import {canvasApi,CanvasApiError} from "./canvas-api";
type Api=typeof canvasApi;
export type CanvasViewportState={viewport:ViewportTransform;revision:number};
export type CanvasChatsState={sessions:CanvasAssistantSession[];activeChatId:string|null;revision:number};
/** A broken zoom animation can produce NaN/Infinity. JSON.stringify turns
 * them into null and Fastify rejects the viewport PUT. Keep the last valid
 * transform so a temporary render failure cannot poison project autosave. */
export function preserveValidCanvasViewport(next:ViewportTransform,previous:ViewportTransform):ViewportTransform{
 return next&&typeof next==="object"&&
  Number.isFinite(next.x)&&Math.abs(next.x)<=1e9&&
  Number.isFinite(next.y)&&Math.abs(next.y)<=1e9&&
  Number.isFinite(next.k)&&next.k>0&&next.k<=100?next:previous;
}

type Kind="viewport"|"chats";
type Entry={viewport:CanvasViewportState;chats:CanvasChatsState;pending:Set<Kind>;
 timers:Partial<Record<Kind,ReturnType<typeof setTimeout>>>;
 active:Partial<Record<Kind,Promise<void>>>;errors:Partial<Record<Kind,unknown>>;
 backoff:Partial<Record<Kind,number>>};
export function createCanvasStatePersistence(
 onError:(error:unknown|null)=>void,
 api:Api=canvasApi,
){
 const entries=new Map<string,Entry>();
 const path=(id:string,kind:Kind)=>"/api/v1/projects/"+encodeURIComponent(id)+"/"+kind;
 const anyErrors=()=>[...entries.values()].some(e=>Object.values(e.errors).some(Boolean));
 const emitError=(error:unknown|null)=>onError(error??(anyErrors()?Error("canvas_state_save_failed"):null));
 const schedule=(id:string,kind:Kind,delay:number)=>{
  const entry=entries.get(id);if(!entry)return;
  if(entry.timers[kind])clearTimeout(entry.timers[kind]);
  entry.timers[kind]=setTimeout(()=>{
   delete entry.timers[kind];
   void save(id,kind).catch(()=>{});
  },delay);
 };
 async function save(id:string,kind:Kind):Promise<void>{
  const entry=entries.get(id);if(!entry)return;
  const current=entry.active[kind];
  if(current){await current;if(entry.pending.has(kind))return save(id,kind);return}
  if(!entry.pending.has(kind))return;
  const running=(async()=>{
   while(entry.pending.has(kind)){
    entry.pending.delete(kind);
    const data=entry[kind];
    const payload=kind==="viewport"?
     {viewport:(data as CanvasViewportState).viewport,expectedRevision:data.revision}:
     {sessions:(data as CanvasChatsState).sessions,activeChatId:(data as CanvasChatsState).activeChatId,
      expectedRevision:data.revision};
    try{
     const response=await api<CanvasViewportState&CanvasChatsState>(path(id,kind),"PUT",payload);
     // The request only confirms its own revision. A newer viewport/chat
     // payload may have arrived while this PUT was in flight.
     entry[kind]={...entry[kind],revision:response.revision} as never;
     delete entry.errors[kind];entry.backoff[kind]=750;
     if(!anyErrors())emitError(null);
    }catch(error){
     entry.pending.add(kind);entry.errors[kind]=error;emitError(error);
     // Do not retry conflicts or validation errors; drafts remain in memory.
     if(!(error instanceof CanvasApiError)||error.status===0||error.status>=500){
      const wait=entry.backoff[kind]??750;
      entry.backoff[kind]=Math.min(30000,wait*2);
      schedule(id,kind,wait);
     }
     throw error;
    }
   }
  })();
  entry.active[kind]=running;
  try{await running}finally{if(entry.active[kind]===running)delete entry.active[kind]}
 }
 return {
  async load(id:string){
   const [viewport,chats]=await Promise.all([
    api<CanvasViewportState>(path(id,"viewport")),
    api<CanvasChatsState>(path(id,"chats"))
   ]);
   const existing=entries.get(id);
   if(existing?.pending.size||existing?.active.viewport||existing?.active.chats)
    throw Error("canvas_state_unsaved_local_edits");
   entries.set(id,{viewport,chats,pending:new Set(),timers:{},active:{},errors:{},backoff:{}});
   return {viewport:viewport.viewport,sessions:chats.sessions,activeChatId:chats.activeChatId};
  },
  initialize(id:string,{viewport,sessions,activeChatId}:{
   viewport:ViewportTransform;sessions:CanvasAssistantSession[];activeChatId:string|null}){
   entries.set(id,{viewport:{viewport,revision:1},
    chats:{sessions,activeChatId,revision:1},
    pending:new Set(),timers:{},active:{},errors:{},backoff:{}});
  },
  updateViewport(id:string,viewport:ViewportTransform){
   const entry=entries.get(id);if(!entry)return;
   // Defense in depth even for callers outside the SQLite Canvas Store.
   const next=preserveValidCanvasViewport(viewport,entry.viewport.viewport);
   if(next===entry.viewport.viewport||
     (next.x===entry.viewport.viewport.x&&next.y===entry.viewport.viewport.y&&
      next.k===entry.viewport.viewport.k))return;
   entry.viewport={...entry.viewport,viewport:next};entry.pending.add("viewport");
   schedule(id,"viewport",650);
  },
  updateChats(id:string,sessions:CanvasAssistantSession[],activeChatId:string|null){
   const entry=entries.get(id);if(!entry)return;
   entry.chats={...entry.chats,sessions,activeChatId};
   entry.pending.add("chats");schedule(id,"chats",500);
  },
  async flush(id?:string){
   const ids=id?[id]:[...entries.keys()];
   for(const key of ids){
    const entry=entries.get(key);if(!entry)continue;
    for(const kind of ["viewport","chats"] as const){
     if(entry.timers[kind])clearTimeout(entry.timers[kind]);
     delete entry.timers[kind];
     await save(key,kind);
    }
   }
  },
  hasPending(id?:string){
   return [...entries.entries()].some(([key,entry])=>(!id||id===key)&&
    (entry.pending.size>0||Boolean(entry.active.viewport)||Boolean(entry.active.chats)));
  },
  discard(id:string){
   const entry=entries.get(id);if(!entry)return;
   if(entry.active.viewport||entry.active.chats)throw Error("canvas_state_save_in_flight");
   for(const timer of Object.values(entry.timers))if(timer)clearTimeout(timer);
   entries.delete(id);
  }
 };
}
