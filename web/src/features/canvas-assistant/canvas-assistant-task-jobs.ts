import {canvasApi} from "@/features/backend-sync/canvas-api";
import type {BackendJobView} from "@/types/backend-contracts";
import {confirmedAssistantTaskDependencies,type AssistantTaskDependencyStep} from "./canvas-assistant-task-dependencies";

export type AssistantTaskFrozenJob={
 stepId:string;planVersion:number;actionDigest:string;
 kind:"model_job"|"comfy_workflow";status:string;existing?:boolean
};
export type AssistantTaskJobContext={
 taskId:string;messageId:string;runSequenceId?:string;runIndex?:number;
 confirm:(step:AssistantTaskFrozenJob,payload:Record<string,unknown>)=>Promise<boolean>;
};
const taskPath=(projectId:string,taskId:string)=>"/api/v1/projects/"+
 encodeURIComponent(projectId)+"/assistant/tasks/"+encodeURIComponent(taskId);
const aborted=(signal:AbortSignal)=>{
 if(signal.aborted)throw new DOMException("Aborted","AbortError");
};
/** The normal generators still own CAS staging, version pins and source
 * fingerprints; their ONLY final submission boundary is swapped here.
 *
 * A frozen plan survives a lost response or tab close. We never submit a Job
 * to /api/v1/jobs from a Task-associated assistant turn.
 */
export async function submitAssistantTaskFrozenJob({
 projectId,context,actionIndex,payload,signal
}:{
 projectId:string;context:AssistantTaskJobContext;actionIndex:number;
 payload:Record<string,unknown>;signal:AbortSignal
}):Promise<BackendJobView>{
 aborted(signal);
 if(!Number.isSafeInteger(actionIndex)||actionIndex<0||actionIndex>=3||
  payload.projectId!==projectId||typeof payload.targetNodeId!=="string"||
  !Number.isSafeInteger(payload.expectedProjectRevision)||
  Number(payload.expectedProjectRevision)<1||
  typeof payload.sourceNodeFingerprint!=="string"||
  !["poll","immediate","stream"].includes(String(payload.executionMode))||
  !payload.snapshot||typeof payload.snapshot!=="object"||
  Array.isArray(payload.snapshot))
  throw Error("assistant_task_job_snapshot_invalid");
 const snapshot=payload.snapshot as Record<string,unknown>;
 if((context.runSequenceId===undefined)!==(context.runIndex===undefined)||
  context.runIndex!==undefined&&context.runIndex!==actionIndex)
  throw Error("assistant_task_run_sequence_conflict");
 if(snapshot.adapterKind!=="model"&&snapshot.adapterKind!=="comfy")
  throw Error("assistant_task_job_snapshot_invalid");
 const kind=snapshot.adapterKind==="comfy"?"comfy_workflow":"model_job";
 const base=taskPath(projectId,context.taskId);
 // The project save barrier already flushed the graph before this callback.
 const task=await canvasApi<{task:{status:string;activePlanVersion:number;steps:AssistantTaskDependencyStep[]}}>(base,"GET",undefined,signal);
  const dependsOn=confirmedAssistantTaskDependencies(task.task);
 aborted(signal);
 const stableId=context.messageId+"-job-"+actionIndex;
 const plan=await canvasApi<AssistantTaskFrozenJob>(base+"/external-jobs","POST",{
  requestId:stableId+"-plan",kind,expectedPlanVersion:task.task.activePlanVersion,
  expectedProjectRevision:payload.expectedProjectRevision,
  job:{targetNodeId:payload.targetNodeId,
   sourceNodeFingerprint:payload.sourceNodeFingerprint,
   executionMode:payload.executionMode,snapshot,
   ...(typeof payload.skillAuthorizationId==="string"?
    {skillAuthorizationId:payload.skillAuthorizationId}:{})},
  dependsOn,
  ...(context.runSequenceId?{runSequenceId:context.runSequenceId,runIndex:actionIndex}:{})
 },signal);
 if(plan.kind!==kind||!plan.stepId||!plan.actionDigest)
  throw Error("assistant_task_job_plan_invalid");
 const endpoint=base+"/steps/"+encodeURIComponent(plan.stepId);
 aborted(signal);
 const approved=await context.confirm(plan,payload);
 aborted(signal);
 await canvasApi(endpoint+"/approval","POST",{
  requestId:stableId+"-decision",expectedPlanVersion:plan.planVersion,
  actionDigest:plan.actionDigest,decision:approved?"approve":"reject"
 },signal);
 if(!approved)throw Error("assistant_task_job_rejected");
 aborted(signal);
 // Atomic Job + Attempt + frozen Step enqueue; repeated requests only inspect
 // the existing Job, never create a second external execution.
 const queued=await canvasApi<{jobId:string;status:string}>(
  endpoint+"/enqueue","POST",{
   requestId:stableId+"-enqueue",expectedPlanVersion:plan.planVersion,
   actionDigest:plan.actionDigest
  },signal);
 if(!queued.jobId)throw Error("assistant_task_job_receipt_missing");
 // This is a read-only lookup. Failure after enqueue must not re-submit.
 return canvasApi<BackendJobView>("/api/v1/jobs/"+encodeURIComponent(queued.jobId),
  "GET",undefined,signal).catch(()=>({
   id:queued.jobId,projectId,targetNodeId:payload.targetNodeId as string,
   status:"queued",executionMode:payload.executionMode as BackendJobView["executionMode"],
   createdAt:0,updatedAt:0,upstreamTaskId:null,attemptId:null,submitMarker:null,
   submissionStartedAt:null
  }));
}
