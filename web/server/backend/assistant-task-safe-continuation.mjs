/** P4.4a: only non-billable, server-evidenced Task progression.
 * This may reconcile existing Job/Comfy artifacts and persist deterministic
 * branch-skip / Join checkpoints, but NEVER enqueue a Job, spawn a Skill,
 * mutate a graph, call Provider, or reissue unknown upstream work.
 */
import {createHash} from "node:crypto";
import {stableJson,writeTransaction} from "./repository.mjs";
import {reconcileAssistantExternalTask} from "./assistant-task-external-jobs.mjs";
import {getAssistantRunSequence,skipAssistantRunBranch,commitAssistantRunJoin}
 from "./assistant-task-run-sequences.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const id=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const digest=x=>createHash("sha256").update(stableJson(x)).digest("hex");
const deterministicRequest=(taskId,seqId,kind,index,evidenceDigest)=>
 "ac_"+digest({taskId,seqId,kind,index,evidenceDigest}).slice(0,40);
const scope=(db,projectId,taskId)=>{
 const task=db.prepare("SELECT t.id,t.project_id,t.status,t.active_plan_version,t.active_step_id,"+
  "t.read_only,t.cancel_requested_at,p.revision FROM assistant_tasks t "+
  "JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL "+
  "WHERE t.id=? AND t.project_id=?").get(taskId,projectId);
 if(!task)throw fail("assistant_task_not_found",404);
 return task;
};
const active=task=>!task.read_only&&task.cancel_requested_at===null&&
 !["completed","cancelled","cancelling","failed","blocked","needs_reconcile"].includes(task.status);
const summarizeSteps=(db,taskId,planVersion)=>{
 const rows=db.prepare("SELECT s.id,s.kind,s.status,s.receipt_trust,s.approval_json,a.external_kind,"+
  "a.external_id,a.status AS attempt_status FROM assistant_task_steps s "+
  "LEFT JOIN assistant_task_attempts a ON a.id=(SELECT id FROM assistant_task_attempts "+
  "WHERE step_id=s.id ORDER BY attempt_no DESC LIMIT 1) "+
  "WHERE s.task_id=? AND s.plan_version=? AND s.superseded_at IS NULL "+
  "AND s.kind IN ('model_job','comfy_workflow','materialize','skill_script') "+
  "ORDER BY s.ordinal").all(taskId,planVersion);
 return rows.map(r=>({stepId:r.id,kind:r.kind,status:r.status,
  approvalDecision:JSON.parse(r.approval_json).decision??null,
  receiptTrusted:r.receipt_trust==="server_committed"&&r.status==="succeeded",
  ...(r.external_id?{externalId:r.external_id,attemptStatus:r.attempt_status}: {})}));
};
function blockReason(task,steps,view){
 if(task.read_only)return "historical_only";
 if(task.cancel_requested_at!==null||["cancelled","cancelling"].includes(task.status))
  return "task_cancelled";
 if(task.status==="completed")return "task_completed";
 if(["failed","blocked"].includes(task.status))return "task_requires_replan";
 if(task.status==="needs_reconcile"||steps.some(s=>s.status==="needs_reconcile"||
  s.attemptStatus==="needs_reconcile"||s.attemptStatus==="submitting"))
  return "unknown_external_result";
 if(steps.some(s=>s.kind==="materialize"&&s.status!=="succeeded"))
  return "awaiting_verified_materialization";
 if(view?.state==="selection_required")return "user_selection_required";
 if(steps.some(s=>s.status==="ready"&&s.approvalDecision==="approved"))return "approved_step_ready";
 if(view?.state==="ready"&&view.next)return "paid_step_requires_approval";
 if(view?.state==="join_ready"||view?.state==="skip_ready")return "checkpoint_not_advanced";
 if(view?.state&&!["none","completed","waiting_approval","ready"].includes(view.state))
  return view.state;
 return null;
}
function continuationState(db,projectId,taskId){
 const task=scope(db,projectId,taskId);
 const steps=summarizeSteps(db,taskId,task.active_plan_version);
 const view=getAssistantRunSequence(db,{projectId,taskId});
 return {task,steps,view,stateDigest:digest({task,steps,view})};
}
function replayProjection(db,projectId,taskId,prior){
 const current=continuationState(db,projectId,taskId),{task,steps,view}=current;
 if(task.read_only)throw fail("assistant_task_not_editable");
 if(task.active_plan_version!==prior.planVersion)throw fail("assistant_step_plan_conflict");
 if(prior.stateDigest===current.stateDigest)return {...prior,existing:true};
 return {...prior,taskStatus:task.status,projectRevision:task.revision,steps,sequenceState:view.state,
  next:null,requiresApproval:false,requiresManualReview:task.status!=="completed",
  reason:blockReason(task,steps,view)??"task_state_changed",existing:true};
}
function recoverableMaterialization(db,task){
 if(task.status!=="blocked"||task.cancel_requested_at!==null||task.read_only||!task.active_step_id)return null;
 const rows=db.prepare("SELECT id,kind,status,error_code FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL")
  .all(task.id,task.active_plan_version);
 const step=rows.find(s=>s.id===task.active_step_id&&s.kind==="materialize"&&s.status==="blocked"&&
  s.error_code==="assistant_external_materialization_blocked");
 return step&&rows.every(s=>s.id===step.id||s.status==="succeeded")?step.id:null;
}
/** Same request ID replays its original conclusion; use a new request ID to
 * inspect a later Job/Skill materialization. Checkpoints have independent
 * stable, deduplicated command IDs, so crash between commits never duplicates.
 */
export function continueAssistantTaskSafely(db,{projectId,taskId,requestId,expectedPlanVersion,
 afterCheckpoint,beforeCommandCommit}={}){
 if(![projectId,taskId,requestId].every(id)||
  !Number.isSafeInteger(expectedPlanVersion)||expectedPlanVersion<1)
  throw fail("assistant_safe_continue_invalid",400);
 // Re-validate the Task even on a cached request. A later read-only archive
 // or plan revision cannot resurrect an old response as an approval hint.
 let task=scope(db,projectId,taskId);
 if(task.read_only)throw fail("assistant_task_not_editable");
 if(task.active_plan_version!==expectedPlanVersion)throw fail("assistant_step_plan_conflict");
 const payloadDigest=digest({kind:"safe_continuation",taskId,expectedPlanVersion});
 const known=db.prepare("SELECT command_kind,payload_digest,status,response_json FROM assistant_task_commands "+
  "WHERE project_id=? AND request_id=?").get(projectId,requestId);
 if(known){
  if(known.command_kind!=="safe_continuation"||known.payload_digest!==payloadDigest)
   throw fail("assistant_task_command_conflict");
  if(known.status!=="completed")throw fail("assistant_step_state_conflict");
  return replayProjection(db,projectId,taskId,JSON.parse(known.response_json));
 }
 const checkpoints=[];
 let reconciled={advanced:0,checked:0};
 // No new upstream work; the old terminal Job may be safely reconciled even if
 // Task currently needs_reconcile, but an unknown Skill is NEVER restarted.
 if(active(task)||task.status==="needs_reconcile")
  reconciled=reconcileAssistantExternalTask(db,{projectId,taskId,expectedPlanVersion});
 else{
  const onlyMaterializeStepId=recoverableMaterialization(db,task);
  if(onlyMaterializeStepId)reconciled=reconcileAssistantExternalTask(db,{projectId,taskId,onlyMaterializeStepId,expectedPlanVersion});
 }
 // A sequence only advances after independently verified Job/materialized and
 // Skill receipts; every checkpoint call revalidates source evidence in its own
 // BEGIN IMMEDIATE transaction. Never speculate past an unknown attempt.
 for(let count=0;count<4;count++){
  task=scope(db,projectId,taskId);
  if(task.active_plan_version!==expectedPlanVersion)
   throw fail("assistant_step_plan_conflict");
  if(task.read_only)throw fail("assistant_task_not_editable");
  const steps=summarizeSteps(db,taskId,expectedPlanVersion);
  if(!active(task)||steps.some(s=>s.status==="needs_reconcile"||
    s.attemptStatus==="needs_reconcile"||s.attemptStatus==="submitting"))
   break;
  const view=getAssistantRunSequence(db,{projectId,taskId});
  if(!view.sequence||!["skip_ready","join_ready"].includes(view.state))break;
  const common={projectId,taskId,expectedPlanVersion,
   expectedProjectRevision:task.revision,runSequenceId:view.sequence.id,
   runIndex:view.index};
  let result;
  if(view.state==="skip_ready"&&view.skip){
   const evidenceDigest=view.skip.evidenceDigest;
   result=skipAssistantRunBranch(db,{...common,evidenceDigest,
    requestId:deterministicRequest(taskId,view.sequence.id,"skip",view.index,evidenceDigest)});
   if(!result.existing)checkpoints.push({kind:"skip",index:view.index,evidenceDigest,result:result.skipped===true});
  }else if(view.state==="join_ready"&&view.join){
   const evidenceDigest=view.join.evidenceDigest;
   result=commitAssistantRunJoin(db,{...common,evidenceDigest,
    requestId:deterministicRequest(taskId,view.sequence.id,"join",view.index,evidenceDigest)});
   if(!result.existing)checkpoints.push({kind:"join",index:view.index,evidenceDigest,result:result.joined===true});
  }else break;
  if(afterCheckpoint&&!result.existing)afterCheckpoint(checkpoints.at(-1)); // test crash window
 }
 task=scope(db,projectId,taskId);
 if(task.active_plan_version!==expectedPlanVersion)throw fail("assistant_step_plan_conflict");
 if(task.read_only)throw fail("assistant_task_not_editable");
 const snapshot=continuationState(db,projectId,taskId);
 task=snapshot.task;
 if(task.read_only)throw fail("assistant_task_not_editable");
 if(task.active_plan_version!==expectedPlanVersion)throw fail("assistant_step_plan_conflict");
 const {steps,view,stateDigest}=snapshot;
 const reason=blockReason(task,steps,view);
 const value={taskId,planVersion:expectedPlanVersion,taskStatus:task.status,
  projectRevision:task.revision,stateDigest,
  reconciledJobs:reconciled.advanced,checkpoints,sequenceState:view.state,
  next:view.state==="ready"&&view.next?{
   index:view.next.index,type:view.next.action.type,nodeId:view.next.action.nodeId,
   needsBinding:!!view.next.needsBinding}:null,
  requiresApproval:active(task)&&(view.state==="ready"&&!!view.next||view.state==="waiting_approval"||
   steps.some(step=>step.status==="waiting_approval")),
  requiresManualReview:!!reason&&!["paid_step_requires_approval","approved_step_ready","task_completed"].includes(reason),
  reason,steps,executionStarted:false};
 // Idempotent command is committed only AFTER the checkpoint evidence. If a
 // process crashes before this transaction, the next call re-reads authority.
 if(beforeCommandCommit)beforeCommandCommit(); // deterministic test fault injection
 return writeTransaction(db,()=>{
  // Verify Task ownership and Graph revision inside the final command CAS.
  // No interleaved cancellation or replan may cache an obsolete next-step hint.
  const current=continuationState(db,projectId,taskId),fresh=current.task;
  if(fresh.read_only)throw fail("assistant_task_not_editable");
  if(fresh.active_plan_version!==expectedPlanVersion)throw fail("assistant_step_plan_conflict");
  if(current.stateDigest!==stateDigest||fresh.status!==task.status||fresh.revision!==task.revision||
   fresh.active_step_id!==task.active_step_id||
   fresh.cancel_requested_at!==task.cancel_requested_at)
   throw fail("assistant_safe_continue_state_changed");
  const old=db.prepare("SELECT command_kind,payload_digest,response_json FROM assistant_task_commands "+
   "WHERE project_id=? AND request_id=?").get(projectId,requestId);
  if(old){
   if(old.command_kind!=="safe_continuation"||old.payload_digest!==payloadDigest)
    throw fail("assistant_task_command_conflict");
   return replayProjection(db,projectId,taskId,JSON.parse(old.response_json));
  }
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) "+
   "VALUES(?,?,?,'safe_continuation',?,'completed',?,?)")
   .run(projectId,requestId,taskId,payloadDigest,stableJson(value),Date.now());
  return {...value,existing:false};
 });
}
