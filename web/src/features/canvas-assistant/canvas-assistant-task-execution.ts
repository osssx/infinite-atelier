import {canvasApi,type CanvasBackendProject} from "@/features/backend-sync/canvas-api";
import {commitAssistantCanvasGraphWithSaveBarrier} from "@/stores/canvas/use-canvas-store";
import {confirmedAssistantTaskDependencies,type AssistantTaskDependencyStep} from "./canvas-assistant-task-dependencies";

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
 projectId,taskId,messageId,actions,center,signal,confirm,sequenceBinding
}:{
 projectId:string;taskId:string;messageId:string;actions:unknown[];
 center:{x:number;y:number};signal:AbortSignal;confirm:(step:FrozenCanvasTaskStep)=>Promise<boolean>;
 sequenceBinding?:{runSequenceId:string;runIndex:number;dependsOn:string[]};
}):Promise<{applied:number;stepId:string;revision:number;refs:Map<string,string>}>{
 requestError(signal);
 let committed:CanvasTaskCommit|null=null;
 let plan:FrozenCanvasTaskStep|null=null;
 const remote=await commitAssistantCanvasGraphWithSaveBarrier(projectId,async frozen=>{
  requestError(signal);
  const snapshot=await canvasApi<{task:{status:string;activePlanVersion:number;steps:AssistantTaskDependencyStep[]}}>(base(projectId,taskId),"GET",undefined,signal);
   const dependsOn=sequenceBinding?.dependsOn??confirmedAssistantTaskDependencies(snapshot.task);
  plan=await canvasApi<FrozenCanvasTaskStep>(base(projectId,taskId)+"/canvas-steps","POST",{
   requestId:messageId+"-canvas-plan",
   expectedPlanVersion:snapshot.task.activePlanVersion,
   expectedProjectRevision:frozen.expectedRevision,actions,center,dependsOn,
   ...(sequenceBinding?{runSequenceId:sequenceBinding.runSequenceId,runIndex:sequenceBinding.runIndex}:{})
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
  stepId:(plan as FrozenCanvasTaskStep|null)?.stepId??"",revision:remote.revision,
  refs:new Map(Object.entries((committed as CanvasTaskCommit|null)?.receipt.refs.nodes??{}))};
}
export type FrozenSkillTaskProposal={skill_id:string;version:string;script_path?:string;entry_id?:string;
 runtime?:string;args:string[];input_files:Record<string,string>;output_files:string[]};
export type TaskSkillScriptResult={run_id:string;status:string;exit_code?:number|null;
 stdout?:string;stderr?:string;artifacts?:{path:string;mime:string;blob_id:string;byte_length?:number;content?:string}[];
 log_blobs?:Record<string,string>};
/** Freeze with canvas save barrier, then release it before the long script run. */
export async function planAndRunAssistantSkillProposal({
 projectId,taskId,messageId,scriptIndex,proposal,signal,confirm
}:{projectId:string;taskId:string;messageId:string;scriptIndex:number;
 proposal:FrozenSkillTaskProposal;signal:AbortSignal;
 confirm:(proposal:FrozenSkillTaskProposal)=>Promise<boolean>}):Promise<TaskSkillScriptResult|null>{
 requestError(signal);
 let plan:{stepId:string;planVersion:number;actionDigest:string}|null=null;
 await commitAssistantCanvasGraphWithSaveBarrier(projectId,async frozen=>{
  requestError(signal);
  const snapshot=await canvasApi<{task:{activePlanVersion:number}}>(base(projectId,taskId),"GET",undefined,signal);
  plan=await canvasApi<{stepId:string;planVersion:number;actionDigest:string}>(
   base(projectId,taskId)+"/skill-steps","POST",{
    requestId:messageId+"-skill-"+scriptIndex+"-plan",
    expectedPlanVersion:snapshot.task.activePlanVersion,expectedProjectRevision:frozen.expectedRevision,
    proposal,dependsOn:[]
   },signal);
  return {id:projectId,revision:frozen.expectedRevision,document:frozen.document};
 });
 if(!plan)throw Error("assistant_skill_task_plan_missing");
 const frozen=plan as {stepId:string;planVersion:number;actionDigest:string};
 requestError(signal);
 const accepted=await confirm(proposal);
 requestError(signal);
 const endpoint=path(projectId,taskId,frozen.stepId);
 await canvasApi(endpoint+"/approval","POST",{
  requestId:messageId+"-skill-"+scriptIndex+"-decision",
  expectedPlanVersion:frozen.planVersion,actionDigest:frozen.actionDigest,
  decision:accepted?"approve":"reject"
 },signal);
 if(!accepted)return null;
 requestError(signal);
 const response=await canvasApi<TaskSkillScriptResult&{runId?:string}>(endpoint+"/run-skill","POST",{
  requestId:messageId+"-skill-"+scriptIndex+"-run",
  expectedPlanVersion:frozen.planVersion,actionDigest:frozen.actionDigest
 },signal);
 if(!response.run_id)throw Error("Task Skill 已存在运行记录 "+(response.runId??"未知")+
  "；本次没有重复执行。请在任务记录中核对后继续。");
 return response;
}
