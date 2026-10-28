import {useCallback,useSyncExternalStore} from "react";

/** Ephemeral visual state, never written to a saved canvas revision.
 * A node subscribes only to its own key; CSS runs the spinner without frames
 * passing through React. Jobs and scopes are identified to reject stale polls.
 */
export type CanvasComfyExecution={status:string;runId?:string;error?:string};
let activeProject:string|null=null;
const executions=new Map<string,CanvasComfyExecution>();
const listeners=new Map<string,Set<()=>void>>();
const publish=(id:string)=>{for(const listener of listeners.get(id)??[])listener()};

export function setCanvasComfyExecutionScope(projectId:string|null):void {
 if(activeProject===projectId)return;
 activeProject=projectId;
 executions.clear();
 for(const id of listeners.keys())publish(id);
}

export function setCanvasComfyExecution(projectId:string,nodeId:string,execution:CanvasComfyExecution):void {
 if(activeProject!==projectId)return;
 const previous=executions.get(nodeId);
 if(previous?.status===execution.status&&previous?.runId===execution.runId&&previous?.error===execution.error)return;
 executions.set(nodeId,execution);
 publish(nodeId);
}

/** Polls may complete out of order; never replace another run's state or
 * clobber an in-progress submission which has not received its job id yet.
 */
export function observeCanvasComfyExecution(projectId:string,nodeId:string,execution:CanvasComfyExecution):void {
 if(!execution.runId||activeProject!==projectId)return;
 const previous=executions.get(nodeId);
 if(previous && previous.runId!==execution.runId)return;
 setCanvasComfyExecution(projectId,nodeId,execution);
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
