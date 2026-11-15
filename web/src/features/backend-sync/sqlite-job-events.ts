import {canvasApi} from "./canvas-api";

/** One EventSource per open Canvas tab, multiplexed by durable job ID.
 * Server replays events newer than the snapshot cursor: no subscribe gap.
 * Browser EventSource reconnects with Last-Event-ID; polling remains fallback.
 */
export type SqliteJobEvent={jobId:string;kind:string;eventId:number;payload?:unknown};
const subscribers=new Map<string,Set<(event:SqliteJobEvent)=>void>>();
const readySubscribers=new Set<()=>void>();
let source:EventSource|null=null;
let startGeneration=0;
let connecting=false;
function start(){
 if(source||connecting||!subscribers.size||typeof EventSource==="undefined")return;
 connecting=true;
 const generation=++startGeneration;
 void canvasApi<{eventCursor:number}>("/api/v1/jobs/snapshot").then(snapshot=>{
  if(generation!==startGeneration||!subscribers.size)return;
  if(!Number.isSafeInteger(snapshot.eventCursor)||snapshot.eventCursor<0)return;
  const next=new EventSource("/api/v1/events?after="+snapshot.eventCursor,{withCredentials:true});
  if(generation!==startGeneration){next.close();return}
  source=next;
  next.addEventListener("job",(raw)=>{
   try{
    const row=JSON.parse((raw as MessageEvent).data) as SqliteJobEvent;
    if(typeof row.jobId!=="string"||typeof row.kind!=="string"||
      !Number.isSafeInteger(row.eventId))return;
    for(const callback of subscribers.get(row.jobId)??[])callback(row);
   }catch{/* malformed event never mutates Canvas state */}
  });
  // Consumers can now reread their snapshot. Events after this cursor are
  // replayed by SSE, including changes during that snapshot request.
  for(const ready of [...readySubscribers])try{ready()}catch{}
 }).catch(()=>{/* backend unavailable: watchers continue polling */})
  .finally(()=>{if(generation===startGeneration)connecting=false});
}
export function subscribeSqliteJobEvents(jobId:string,callback:(event:SqliteJobEvent)=>void,onReady?:()=>void):()=>void{
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(jobId))throw Error("invalid_job_id");
 let listeners=subscribers.get(jobId);
 if(!listeners){listeners=new Set();subscribers.set(jobId,listeners)}
 listeners.add(callback);
 const ready=()=>onReady?.();
 if(onReady){readySubscribers.add(ready);if(source)try{ready()}catch{}}
 start();
 return ()=>{
  listeners!.delete(callback);
  readySubscribers.delete(ready);
  if(!listeners!.size)subscribers.delete(jobId);
  if(!subscribers.size){
   startGeneration++;
   source?.close();source=null;connecting=false;
  }
 };
}
