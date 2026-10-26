import {canvasApi} from "./canvas-api";

/** One EventSource per open Canvas tab, multiplexed by durable job ID.
 * Server replays events newer than the snapshot cursor: no subscribe gap.
 * Browser EventSource reconnects with Last-Event-ID; polling remains fallback.
 */
const subscribers=new Map<string,Set<()=>void>>();
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
    const row=JSON.parse((raw as MessageEvent).data) as {jobId?:string};
    if(typeof row.jobId!=="string")return;
    for(const callback of subscribers.get(row.jobId)??[])callback();
   }catch{/* malformed event never mutates Canvas state */}
  });
 }).catch(()=>{/* backend unavailable: watchers continue polling */})
  .finally(()=>{if(generation===startGeneration)connecting=false});
}
export function subscribeSqliteJobEvents(jobId:string,callback:()=>void):()=>void{
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(jobId))throw Error("invalid_job_id");
 let listeners=subscribers.get(jobId);
 if(!listeners){listeners=new Set();subscribers.set(jobId,listeners)}
 listeners.add(callback);
 start();
 return ()=>{
  listeners!.delete(callback);
  if(!listeners!.size)subscribers.delete(jobId);
  if(!subscribers.size){
   startGeneration++;
   source?.close();source=null;connecting=false;
  }
 };
}
