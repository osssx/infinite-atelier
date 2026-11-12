import {canvasApi,type CanvasBackendProject} from "@/features/backend-sync/canvas-api";
import {commitAssistantCanvasGraphWithSaveBarrier} from "@/stores/canvas/use-canvas-store";

export type FrozenCanvasTaskStep={
 stepId:string;taskId:string;planVersion:number;actionDigest:string;status:string;
 preconditions?:{projectRevision:number;refs:{nodes:Record<string,string>;connections:Record<string,string>}};
};
export type CanvasTaskCommit={status:string;project:CanvasBackendProject;receipt:{
 stepId?:string;attemptId:string;projectRevision:number;refs:{nodes:Record<string,string>;connections:Record<string,string>};
 applied:number};existing:boolean};

const base=(projectId:string,taskId:string)=>"/api/v1/projects/"+encodeURIComponent(projectId)+
 "/assistant/tasks/"+encodeURIComponent(taskId);
const path=(projectId:string,taskId:string,stepId:string)=>
 base(projectId,taskId)+"/steps/"+encodeURIComponent(stepId);
const requestError=(signal:AbortSignal)=>{
 if(signal.aborted)throw new DOMException("Aborted","AbortError");
};
/** No graph is mutated in the browser before server approval/commit.
 * This also handles previously frozen steps after a refresh.
 */
export async function executeFrozenAssistantCanvasTaskStep({
 projectId,taskId,step,signal,decision
}:{
 projectId:string;taskId:string;step:Pick<FrozenCanvasTaskStep,"stepId"|"planVersion"|"actionDigest">;
 signal:AbortSignal;decision?:"approve"|"reject"
}):Promise<CanvasTaskCommit|null>{
 requestError(signal);
 if(decision==="reject"){
  await canvasApi(path(projectId,taskId,step.stepId)+"/approval","POST",{
   requestId:step.stepId+"-rejected",expectedPlanVersion:step.planVersion,
   actionDigest:step.actionDigest,decision:"reject"
  },signal);
  return null;
 }
  let saved:CanvasTaskCommit|null=null;
  await commitAssistantCanvasGraphWithSaveBarrier(projectId,async()=>{
   requestError(signal);
   if(decision==="approve")await canvasApi(path(projectId,taskId,step.stepId)+"/approval","POST",{
    requestId:step.stepId+"-approved",expectedPlanVersion:step.planVersion,
    actionDigest:step.actionDigest,decision:"approve"
   },signal);
   requestError(signal);
   saved=await canvasApi<CanvasTaskCommit>(path(projectId,taskId,step.stepId)+"/execute","POST",{
    requestId:step.stepId+"-execute",expectedPlanVersion:step.planVersion,
    actionDigest:step.actionDigest
   },signal);
   if(saved.status!=="succeeded"||!saved.project?.document)throw Error("assistant_task_graph_response_invalid");
   return saved.project;
  });
  return saved;}
/** A frozen Step survives the browser tab. Approval is user-driven; never
 * automatically reconstruct and approve a different set of actions.
 */
export async function planAndExecuteAssistantCanvasActions({
 projectId,taskId,messageId,actions,center,signal,confirm
}:{
 projectId:string;taskId:string;messageId:string;actions:unknown[];
 center:{x:number;y:number};signal:AbortSignal;confirm:(step:FrozenCanvasTaskStep)=>Promise<boolean>;
}):Promise<{applied:number;stepId:string;revision:number}>{
 requestError(signal);
 let committed:CanvasTaskCommit|null=null;
 let plan:FrozenCanvasTaskStep|null=null;
 const remote=await commitAssistantCanvasGraphWithSaveBarrier(projectId,async frozen=>{
  requestError(signal);
  const snapshot=await canvasApi<{task:{activePlanVersion:number}}>(base(projectId,taskId),"GET",undefined,signal);
  plan=await canvasApi<FrozenCanvasTaskStep>(base(projectId,taskId)+"/canvas-steps","POST",{
   requestId:messageId+"-canvas-plan",
   expectedPlanVersion:snapshot.task.activePlanVersion,
   expectedProjectRevision:frozen.expectedRevision,actions,center,dependsOn:[]
  },signal);
  requestError(signal);
  const accepted=await confirm(plan);
  requestError(signal);
  await canvasApi(path(projectId,taskId,plan.stepId)+"/approval","POST",{
   requestId:messageId+"-canvas-decision",expectedPlanVersion:plan.planVersion,
   actionDigest:plan.actionDigest,decision:accepted?"approve":"reject"
  },signal);
  if(!accepted)throw Error("assistant_task_canvas_rejected");
  committed=await canvasApi<CanvasTaskCommit>(path(projectId,taskId,plan.stepId)+"/execute","POST",{
   requestId:messageId+"-canvas-execute",expectedPlanVersion:plan.planVersion,
   actionDigest:plan.actionDigest
  },signal);
  if(committed.status!=="succeeded"||!committed.project?.document)
   throw Error("assistant_task_graph_response_invalid");
  return committed.project;
 });
 return {applied:(committed as CanvasTaskCommit|null)?.receipt.applied??actions.length,
  stepId:(plan as FrozenCanvasTaskStep|null)?.stepId??"",revision:remote.revision};
}
