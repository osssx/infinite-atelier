import {useCallback,useSyncExternalStore} from "react";
import {isComfyRunActive} from "./run-status";

/** Ephemeral visual state, never written to a saved canvas revision.
 * A node subscribes only to its own key; CSS runs the spinner without frames
 * passing through React. Jobs and scopes are identified to reject stale polls.
 */
export type ComfyExecutionError={nodeId:string|null;classType:string;type:string;message:string};
export type CanvasComfyLiveUpdate=
 | {kind:"progress";currentNode:string|null;nodeName?:string;step:number|null;steps:number|null;value:number|null}
 | {kind:"preview";mime:"image/png"|"image/jpeg"|"image/webp"|"video/mp4";version:number;step?:number;steps?:number}
 | {kind:"error";error:ComfyExecutionError};
export type CanvasComfyExecution={status:string;runId?:string;startedAt?:number;error?:string;previewEnabled?:boolean;
 progress?:Extract<CanvasComfyLiveUpdate,{kind:"progress"}>;
 preview?:Extract<CanvasComfyLiveUpdate,{kind:"preview"}>;
 errorDetail?:ComfyExecutionError};
let activeProject:string|null=null;
const executions=new Map<string,CanvasComfyExecution>();
const listeners=new Map<string,Set<()=>void>>();
const publish=(id:string)=>{for(const listener of listeners.get(id)??[])listener()};

export function resolveComfyExecutionStartedAt(previous:CanvasComfyExecution|undefined,
 incoming:CanvasComfyExecution,now=Date.now()):number|undefined {
 if(!isComfyRunActive(incoming.status))return incoming.startedAt;
 if(Number.isFinite(incoming.startedAt))return incoming.startedAt;
 if(Number.isFinite(previous?.startedAt)&&(
  previous?.runId===incoming.runId || !previous?.runId&&Boolean(incoming.runId)
 ))return previous!.startedAt;
 return now;
}

export function setCanvasComfyExecutionScope(projectId:string|null):void {
 if(activeProject===projectId)return;
 activeProject=projectId;
 executions.clear();
 for(const id of listeners.keys())publish(id);
}

export function setCanvasComfyExecution(projectId:string,nodeId:string,execution:CanvasComfyExecution):void {
 if(activeProject!==projectId)return;
 const previous=executions.get(nodeId);
 const normalized={...execution,startedAt:resolveComfyExecutionStartedAt(previous,execution)};
 if(normalized.startedAt===undefined)delete normalized.startedAt;
 if(previous?.status===normalized.status&&previous?.runId===normalized.runId&&previous?.startedAt===normalized.startedAt&&previous?.error===normalized.error&&previous?.previewEnabled===normalized.previewEnabled&&previous?.progress===normalized.progress&&previous?.preview===normalized.preview&&previous?.errorDetail===normalized.errorDetail)return;
 executions.set(nodeId,normalized);
 publish(nodeId);
}

/** Polls may complete out of order; never replace another run's state or
 * clobber an in-progress submission which has not received its job id yet.
 */
export function observeCanvasComfyExecution(projectId:string,nodeId:string,execution:CanvasComfyExecution):void {
 if(!execution.runId||activeProject!==projectId)return;
 const previous=executions.get(nodeId);
 if(previous&&previous.runId!==execution.runId)return;
 if(previous?.status==="cancelling"&&["queued","preparing","running"].includes(execution.status))return;
 const retain=previous?.runId===execution.runId;
 const active=["submitting","queued","preparing","running","collecting","importing","cancelling"].includes(execution.status);
 setCanvasComfyExecution(projectId,nodeId,{...execution,
  ...(retain&&active?{progress:previous?.progress,preview:previous?.preview}:{}),
  ...(retain&&active&&execution.previewEnabled===undefined?{previewEnabled:previous?.previewEnabled}:{}),
  ...(retain?{errorDetail:previous?.errorDetail,error:execution.error??previous?.error}:{}),
 });
}

/** Transport failures are observation failures, not evidence of GPU success.
 * Stop an otherwise endless spinner but keep the backend run identifier.
 */
export function markCanvasComfyRunUnobservable(projectId:string,runId:string,error?:string):void {
 if(activeProject!==projectId)return;
 for(const [nodeId,previous] of executions) {
  if(previous.runId===runId)
   setCanvasComfyExecution(projectId,nodeId,{runId,status:"unavailable",error});
 }
}

/** Ephemeral updates are scoped to the current job and never persisted. */
export function observeCanvasComfyLive(projectId:string,nodeId:string,runId:string,event:CanvasComfyLiveUpdate):void{
 if(activeProject!==projectId)return;
 const previous=executions.get(nodeId);
 if(!previous||previous.runId!==runId||!["queued","running","preparing","submitting"].includes(previous.status))return;
 if(event.kind==="progress")setCanvasComfyExecution(projectId,nodeId,{...previous,progress:event});
 else if(event.kind==="preview")setCanvasComfyExecution(projectId,nodeId,{...previous,preview:event});
 else if(event.kind==="error")setCanvasComfyExecution(projectId,nodeId,{...previous,errorDetail:event.error,error:event.error.message});
}

export function getCanvasComfyExecution(nodeId:string|null|undefined):CanvasComfyExecution|undefined {
 return nodeId?executions.get(nodeId):undefined;
}

export function subscribeCanvasComfyExecution(nodeId:string|null|undefined,listener:()=>void):()=>void {
 if(!nodeId)return ()=>{};
 let set=listeners.get(nodeId);
 if(!set){set=new Set();listeners.set(nodeId,set)}
 set.add(listener);
 return ()=>{
  const current=listeners.get(nodeId);
  current?.delete(listener);
  if(current?.size===0)listeners.delete(nodeId);
 };
}

export function useCanvasComfyExecution(nodeId:string|null|undefined):CanvasComfyExecution|undefined {
 const subscribe=useCallback((listener:()=>void)=>subscribeCanvasComfyExecution(nodeId,listener),[nodeId]);
 const snapshot=useCallback(()=>getCanvasComfyExecution(nodeId),[nodeId]);
 return useSyncExternalStore(subscribe,snapshot,snapshot);
}
