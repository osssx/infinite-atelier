import type {CanvasComfyLiveUpdate,ComfyExecutionError} from "@/features/comfy-workflow/canvas-execution-visual";
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const nullableNumber=(v:unknown):v is number|null=>v===null||(typeof v==="number"&&Number.isFinite(v));
const nullableNode=(v:unknown):v is string|null=>v===null||(typeof v==="string"&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(v));
export function parseComfyLiveUpdate(raw:unknown):CanvasComfyLiveUpdate|null {
 if(!object(raw))return null;
 if(raw.kind==="progress"&&nullableNode(raw.currentNode)&&nullableNumber(raw.step)&&nullableNumber(raw.steps)&&
    nullableNumber(raw.value)&&(raw.value===null||raw.value>=0&&raw.value<=1))
  return {kind:"progress",currentNode:raw.currentNode,step:raw.step,steps:raw.steps,value:raw.value,
   ...(typeof raw.nodeName==="string"&&raw.nodeName.trim().length>0&&raw.nodeName.length<=120?{nodeName:raw.nodeName}:{})};
 if(raw.kind==="preview"&&(raw.mime==="image/png"||raw.mime==="image/jpeg")&&typeof raw.data==="string"&&
    raw.data.length>0&&raw.data.length<=350000&&/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data))
  return {kind:"preview",mime:raw.mime,data:raw.data};
 if(raw.kind==="error"&&object(raw.error)){
  const error=raw.error;
  if(nullableNode(error.nodeId)&&typeof error.classType==="string"&&error.classType.length<=100&&
     typeof error.type==="string"&&error.type.length<=100&&
     typeof error.message==="string"&&error.message.length<=500)
   return {kind:"error",error:error as ComfyExecutionError};
 }
 return null;
}
/** Per-running-job browser stream. Native EventSource retries; poll/history is still authoritative. */
export function subscribeComfyLiveEvents(jobId:string,callback:(event:CanvasComfyLiveUpdate)=>void):()=>void{
 if(typeof EventSource==="undefined")return ()=>{};
 if(!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId))return ()=>{};
 const source=new EventSource("/api/v1/jobs/"+encodeURIComponent(jobId)+"/live",{withCredentials:true});
 source.addEventListener("live",raw=>{
  try{
   const update=parseComfyLiveUpdate(JSON.parse((raw as MessageEvent).data));
   if(update)callback(update);
  }catch{/* unsupported/malformed ComfyUI events are ignored */}
 });
 return ()=>source.close();
}
