import {canvasApi} from "@/features/backend-sync/canvas-api";
import {awaitCanvasStorePersistence} from "@/stores/canvas/use-canvas-store";
import type {AssistantExecutionAction} from "./canvas-assistant-node-control";

export type AssistantRunIntent=AssistantExecutionAction;
export type AssistantRunSequenceView={
 sequence:{id:string;taskId:string;sourceMessageId:string;planVersion:number;
  actions:AssistantRunIntent[];status:string}|null;
 state:string;index?:number;stepId?:string;
 outputs?:{sourceStepId:string;materialStepId:string;runIndex:number|null;runSequenceId:string|null;
  jobId:string;artifactId:string;nodeId:string;kind:string;portId:string|null;sha256:string}[];
 next:{index:number;action:AssistantRunIntent;dependsOn:string[];last:boolean;
  needsBinding?:boolean;inputBinding?:{sourceArtifactId:string;sourceSha256:string;
   sourceMaterialStepId:string;sourceNodeId:string;sourcePortId:string;
   toNodeId:string;toPortId:string;sourceKind:"image"|"video"|"audio";valueKind:string}}|null;
};
const base=(projectId:string,taskId:string)=>"/api/v1/projects/"+encodeURIComponent(projectId)+
 "/assistant/tasks/"+encodeURIComponent(taskId);
const abort=(signal:AbortSignal)=>{if(signal.aborted)throw new DOMException("Aborted","AbortError");};
/** Freeze only typed target *intent*. Never pre-submit a second paid Job. */
export async function freezeAssistantRunSequence({
 projectId,taskId,messageId,actions,refs,signal
}:{
 projectId:string;taskId:string;messageId:string;actions:AssistantExecutionAction[];
 refs:ReadonlyMap<string,string>;signal:AbortSignal
}):Promise<AssistantRunSequenceView>{
 abort(signal);
 if(actions.length<2||actions.length>3)throw Error("assistant_task_run_invalid");
 const resolved=actions.map(action=>({...action,nodeId:refs.get(action.nodeId)??action.nodeId}));
 if(resolved.some(action=>!action.nodeId)||new Set(resolved.map(action=>action.nodeId)).size!==resolved.length)
  throw Error("assistant_task_run_invalid");
 await awaitCanvasStorePersistence(projectId);
 abort(signal);
 const uri=base(projectId,taskId);
 const [project,task]=await Promise.all([
  canvasApi<{revision:number}>("/api/v1/projects/"+encodeURIComponent(projectId),"GET",undefined,signal),
  canvasApi<{task:{activePlanVersion:number}}>(uri,"GET",undefined,signal)
 ]);
 abort(signal);
 const saved=await canvasApi<{sequenceId:string;planVersion:number;count:number}>(uri+"/run-sequences","POST",{
  requestId:messageId+"-run-sequence",sourceMessageId:messageId,
  expectedPlanVersion:task.task.activePlanVersion,expectedProjectRevision:project.revision,
  actions:resolved
 },signal);
 abort(signal);
 const view=await canvasApi<AssistantRunSequenceView>(uri+"/run-sequences","GET",undefined,signal);
 if(view.sequence?.id!==saved.sequenceId)throw Error("assistant_task_run_sequence_conflict");
 return view;
}
export function canLaunchAssistantRunSequenceStep(view:AssistantRunSequenceView){
 if(view.state!=="ready"||!view.sequence||!view.next)
  throw Error("assistant_task_run_not_ready:"+view.state);
 if(view.next.index<0||view.next.index>=view.sequence.actions.length||
  JSON.stringify(view.sequence.actions[view.next.index])!==JSON.stringify(view.next.action))
  throw Error("assistant_task_run_sequence_conflict");
 return view.next;
}
