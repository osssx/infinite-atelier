import {useCallback,useSyncExternalStore} from "react";

/** Shared model execution state. Legacy text export names remain compatible.
 * Transient per-source UI only. Durable job state always comes from SQLite.
 * Concurrent model requests have distinct job IDs; one completion must not
 * clear the indicator while a later request is still running.
 */
const activeStatuses=new Set(["submitting","queued","preparing","running","collecting"]);
export type CanvasModelKind="image"|"text"|"video"|"audio";
export function canvasModelExecutionPhase(status:string,modelKind?:string):string{
 return status==="succeeded"&&["image","video","audio"].includes(modelKind??"")?"collecting":status;
}
export const textExecutionLabel=(status:string,modelKind:CanvasModelKind="text"):string=>{
 const name={image:"图片",text:"文本",video:"视频",audio:"音频"}[modelKind];
 switch(status){
  case "submitting":return `正在提交${name}请求…`;
  case "queued":return `${name}任务排队中…`;
  case "preparing":return "正在准备模型输入…";
  case "running":return `${name}生成中…`;
  case "collecting":return `正在保存${name}结果…`;
  default:return "等待模型响应…";
 }
};
export type CanvasTextExecution={status:string;modelKind:CanvasModelKind;activeCount:number;stopping?:boolean};
let scope:string|null=null;
const entries=new Map<string,Map<string,{status:string;modelKind:CanvasModelKind}>>();
const submissions=new Map<string,{nodeId:string;stopped:boolean}>();
const cancellations=new Map<string,Promise<void>>();
const views=new Map<string,CanvasTextExecution>();
const listeners=new Map<string,Set<()=>void>>();
const notify=(nodeId:string)=>{for(const cb of listeners.get(nodeId)??[])cb()};
function publish(nodeId:string){
 const jobs=entries.get(nodeId);
 if(!jobs?.size){entries.delete(nodeId);views.delete(nodeId)}
 else{
  const statuses=[...jobs.values()];
  views.set(nodeId,{...statuses.at(-1)!,activeCount:statuses.length,...(cancellations.has(nodeId)||[...submissions.values()].some(s=>s.nodeId===nodeId&&s.stopped)?{stopping:true}:{})});
 }
 notify(nodeId);
}
export function setCanvasTextExecutionScope(projectId:string|null):void{
 if(scope===projectId)return;
 scope=projectId;
 entries.clear();views.clear();submissions.clear();cancellations.clear();
 for(const nodeId of listeners.keys())notify(nodeId);
}
function change(projectId:string,nodeId:string,jobId:string,status:string,replaceId?:string,modelKind?:CanvasModelKind){
 if(scope!==projectId||!nodeId||!jobId)return;
 let jobs=entries.get(nodeId);
 if(!jobs){
  if(!activeStatuses.has(status))return;
  jobs=new Map();entries.set(nodeId,jobs);
 }
 const kind=modelKind??jobs.get(jobId)?.modelKind??(replaceId?jobs.get(replaceId)?.modelKind:undefined)??"text";
 if(replaceId)jobs.delete(replaceId);
 const old=jobs.get(jobId);
 if(activeStatuses.has(status)){
  if(old?.status===status&&old.modelKind===kind&&!replaceId)return;
  jobs.set(jobId,{status,modelKind:kind});
 }else if(!jobs.delete(jobId)&&!replaceId)return;
 publish(nodeId);
}
/** Called before the first await so the source node animates immediately. */
export function beginCanvasTextSubmission(projectId:string,nodeId:string,token:string,modelKind:CanvasModelKind="text"):void{
 if(projectId!==scope)return;
 submissions.set(token,{nodeId,stopped:false});
 change(projectId,nodeId,token,"submitting",undefined,modelKind);
}
/** Transfer a pending click to its durable backend job, or restore a job
 * after reload from the authoritative SQLite snapshot.
 */
export function trackCanvasTextJob(projectId:string,nodeId:string,jobId:string,status:string,token?:string,modelKind?:CanvasModelKind):void{
 change(projectId,nodeId,jobId,status,token,modelKind);
}
export function finishCanvasTextSubmission(projectId:string,nodeId:string,token:string):void{
 if(projectId!==scope)return;
 submissions.delete(token);
 change(projectId,nodeId,token,"finished");
 publish(nodeId);
}
export function updateCanvasTextJob(projectId:string,jobId:string,status:string):void{
 if(projectId!==scope)return;
 for(const [nodeId,jobs] of entries){
  if(!jobs.has(jobId))continue;
  change(projectId,nodeId,jobId,status);
  return;
 }
}
export function finishCanvasTextJob(projectId:string,jobId:string):void{
 updateCanvasTextJob(projectId,jobId,"finished");
}
export function getCanvasTextExecution(nodeId:string):CanvasTextExecution|undefined{
 return views.get(nodeId);
}
export function subscribeCanvasTextExecution(nodeId:string,cb:()=>void):()=>void{
 let set=listeners.get(nodeId);
 if(!set){set=new Set();listeners.set(nodeId,set)}
 set.add(cb);
 return ()=>{set?.delete(cb);if(!set?.size)listeners.delete(nodeId)};
}
export function useCanvasTextExecution(nodeId:string):CanvasTextExecution|undefined{
 const subscribe=useCallback((cb:()=>void)=>subscribeCanvasTextExecution(nodeId,cb),[nodeId]);
 const snapshot=useCallback(()=>getCanvasTextExecution(nodeId),[nodeId]);
 return useSyncExternalStore(subscribe,snapshot,snapshot);
}

export function canvasSubmissionStopped(projectId:string,token:string):boolean{
 return projectId!==scope||submissions.get(token)?.stopped===true;
}
export function assertCanvasSubmissionActive(projectId:string,token:string):void{
 if(canvasSubmissionStopped(projectId,token))throw Error("canvas_submission_stopped");
}
/** Stop pending preparation and cancel each durable job, retaining unsupported jobs. */
export function cancelCanvasNodeExecution(projectId:string,nodeId:string,
 cancel:(jobId:string)=>Promise<{cancelled:boolean;reason?:string}>,
 report:(message:string)=>void,jobIds?:readonly string[]):Promise<void>{
 if(projectId!==scope)return Promise.resolve();
 const existing=cancellations.get(nodeId);
 if(existing)return existing;
 for(const pending of submissions.values())if(pending.nodeId===nodeId)pending.stopped=true;
 const ids=[...(entries.get(nodeId)?.keys()??[])].filter(id=>!submissions.has(id)&&(!jobIds||jobIds.includes(id)));
 // Defer work until the lock is installed, even when there are no durable IDs yet.
 const work=Promise.resolve().then(async()=>{
  for(const id of ids){
   if(projectId!==scope)return;
   if(!entries.get(nodeId)?.has(id))continue;
   try{
    const result=await cancel(id);
    if(projectId!==scope)return;
    if(result.cancelled)finishCanvasTextJob(projectId,id);
    else if(entries.get(nodeId)?.has(id))report("无法取消当前任务："+(result.reason??"not_cancellable"));
   }catch(error){if(projectId===scope&&entries.get(nodeId)?.has(id))report(error instanceof Error?error.message:String(error))}
  }
 }).finally(()=>{
  if(projectId===scope&&cancellations.get(nodeId)===work){cancellations.delete(nodeId);publish(nodeId)}
 });
 cancellations.set(nodeId,work);publish(nodeId);
 return work;
}

/** A job ID can arrive while the initial stop call is still settling. */
export async function waitForCanvasNodeCancellation(projectId:string,nodeId:string):Promise<void>{
 if(projectId===scope)await cancellations.get(nodeId);
}
