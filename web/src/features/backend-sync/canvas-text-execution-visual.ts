import {useCallback,useSyncExternalStore} from "react";

/** Transient per-source UI only. Durable job state always comes from SQLite.
 * Concurrent text requests have distinct job IDs; one completion must not
 * clear the indicator while a later request is still running.
 */
const activeStatuses=new Set(["submitting","queued","preparing","running","collecting"]);
export const textExecutionLabel=(status:string):string=>{
 switch(status){
  case "submitting":return "正在提交文本请求…";
  case "queued":return "文本任务排队中…";
  case "preparing":return "正在准备模型输入…";
  case "running":return "文本生成中…";
  case "collecting":return "正在保存文本结果…";
  default:return "等待模型响应…";
 }
};
export type CanvasTextExecution={status:string;activeCount:number};
let scope:string|null=null;
const entries=new Map<string,Map<string,string>>();
const views=new Map<string,CanvasTextExecution>();
const listeners=new Map<string,Set<()=>void>>();
const notify=(nodeId:string)=>{for(const cb of listeners.get(nodeId)??[])cb()};
function publish(nodeId:string){
 const jobs=entries.get(nodeId);
 if(!jobs?.size){entries.delete(nodeId);views.delete(nodeId)}
 else{
  const statuses=[...jobs.values()];
  views.set(nodeId,{status:statuses.at(-1)!,activeCount:statuses.length});
 }
 notify(nodeId);
}
export function setCanvasTextExecutionScope(projectId:string|null):void{
 if(scope===projectId)return;
 scope=projectId;
 entries.clear();views.clear();
 for(const nodeId of listeners.keys())notify(nodeId);
}
function change(projectId:string,nodeId:string,jobId:string,status:string,replaceId?:string){
 if(scope!==projectId||!nodeId||!jobId)return;
 let jobs=entries.get(nodeId);
 if(!jobs){
  if(!activeStatuses.has(status))return;
  jobs=new Map();entries.set(nodeId,jobs);
 }
 if(replaceId)jobs.delete(replaceId);
 const old=jobs.get(jobId);
 if(activeStatuses.has(status)){
  if(old===status&&!replaceId)return;
  jobs.set(jobId,status);
 }else if(!jobs.delete(jobId)&&!replaceId)return;
 publish(nodeId);
}
/** Called before the first await so the source node animates immediately. */
export function beginCanvasTextSubmission(projectId:string,nodeId:string,token:string):void{
 change(projectId,nodeId,token,"submitting");
}
/** Transfer a pending click to its durable backend job, or restore a job
 * after reload from the authoritative SQLite snapshot.
 */
export function trackCanvasTextJob(projectId:string,nodeId:string,jobId:string,status:string,token?:string):void{
 change(projectId,nodeId,jobId,status,token);
}
export function finishCanvasTextSubmission(projectId:string,nodeId:string,token:string):void{
 change(projectId,nodeId,token,"finished");
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
