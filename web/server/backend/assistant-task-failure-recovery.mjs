/** P3c3d: an explicitly confirmed, no-provider failover to a previously
 * frozen independent run target. A failed Job is NOT by itself proof of failure.
 * Never treat collecting->failed or submission_unknown as permission to retry.
 */
import {randomUUID,createHash} from "node:crypto";
import {writeTransaction,stableJson} from "./repository.mjs";
import {inspectAssistantTaskRecovery} from "./assistant-task-safe-replan.mjs";
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const id=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const terminalFailureSources=new Set(["preparing","submitting","running"]);
const allowedNodes=new Set(["text","image","video","audio","config"]);
const modes=new Set(["text","image","video","audio"]);

function taskRow(db,projectId,taskId){
 const row=db.prepare("SELECT t.*,p.revision,p.document_json FROM assistant_tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL WHERE t.id=? AND t.project_id=?")
  .get(taskId,projectId);
 if(!row)throw fail("assistant_task_not_found",404);
 return row;
}
/** A complete immutable Job, Attempt, Step and coordinator-authored failure event.
 * A collection error happens AFTER remote generation and is intentionally excluded.
 */
export function verifiedAssistantFailure(db,{projectId,taskId,stepId}){
 const step=db.prepare("SELECT * FROM assistant_task_steps WHERE id=? AND task_id=?").get(stepId,taskId);
 if(!step||!["model_job","comfy_workflow"].includes(step.kind)||
  step.status!=="failed"||step.receipt_trust!=="none"||
  step.superseded_at!==null||step.error_code!=="assistant_external_job_failed")return null;
 const attempt=db.prepare("SELECT * FROM assistant_task_attempts WHERE step_id=? AND external_kind='job' ORDER BY attempt_no DESC LIMIT 1")
  .get(step.id);
 if(!attempt||attempt.task_id!==taskId||attempt.project_id!==projectId||
  attempt.status!=="failed"||!attempt.finished_at||!attempt.external_id||
  attempt.action_digest!==step.action_digest||attempt.attempt_no!==step.attempt_count)return null;
 const job=db.prepare("SELECT * FROM jobs WHERE id=? AND project_id=?")
  .get(attempt.external_id,projectId);
 if(!job||job.status!=="failed"||job.lease_owner!==null||
  job.idempotency_key!==attempt.execution_key||
  job.request_fingerprint!==attempt.request_fingerprint)return null;
 const frozen=JSON.parse(attempt.frozen_snapshot_json??"null");
 const receipt=JSON.parse(step.receipt_json??"null");
 const outcome=JSON.parse(attempt.evidence_json??"null");
 if(frozen?.stepId!==step.id||frozen?.executionKey!==attempt.execution_key||
  frozen?.actionDigest!==step.action_digest||
  stableJson(frozen?.job?.snapshot)!==job.snapshot_json||
  receipt?.jobId!==job.id||receipt?.attemptId!==attempt.id||
  receipt?.executionKey!==attempt.execution_key||
  receipt?.jobStatus!=="failed"||!Array.isArray(receipt.artifactIds)||
  receipt.artifactIds.length!==0||
  outcome?.jobId!==job.id||outcome?.jobStatus!=="failed"||
  !Array.isArray(outcome.artifactIds)||outcome.artifactIds.length!==0)return null;
 if(db.prepare("SELECT 1 FROM artifacts WHERE job_id=? LIMIT 1").get(job.id)||
  db.prepare("SELECT 1 FROM materializations WHERE job_id=? LIMIT 1").get(job.id))return null;
 const events=db.prepare("SELECT seq,kind,payload_json FROM job_events WHERE job_id=? AND kind IN ('job_status','job_reconciliation_verified') ORDER BY seq DESC")
  .all(job.id);
 const verified=events.find(row=>{
  const ev=JSON.parse(row.payload_json);
  if(row.kind==="job_status"&&ev.to==="failed"){
   if(!terminalFailureSources.has(ev.from))return false;
   if(ev.from==="preparing")return job.submit_marker===null&&job.submission_started_at===null;
   if(ev.from==="submitting")return !!job.submit_marker&&job.submission_started_at!==null;
   return !!job.upstream_task_id;
  }
  return row.kind==="job_reconciliation_verified"&&ev.verified===true&&
   ev.from==="submission_unknown"&&ev.to==="failed"&&
   ev.remoteTaskVerified===true&&!!job.upstream_task_id;
 });
 if(!verified)return null;
 const ev=JSON.parse(verified.payload_json);
 const evidenceDigest=hash({projectId,taskId,stepId,planVersion:step.plan_version,
  jobId:job.id,jobStatus:job.status,jobFingerprint:job.request_fingerprint,
  executionKey:attempt.execution_key,attemptId:attempt.id,
  stepActionDigest:step.action_digest,stepReceipt:receipt,attemptEvidence:outcome,
  failureEvent:{seq:verified.seq,kind:verified.kind,payload:ev}});
 return {sourceStepId:step.id,sourceJobId:job.id,sourceAttemptId:attempt.id,
  sourcePlanVersion:step.plan_version,
  sourceRunIndex:JSON.parse(step.preconditions_json??"{}").runIndex,
  evidenceDigest,failureReason:verified.kind==="job_reconciliation_verified"?"reconciled_remote_failure":
   ev.from==="preparing"?"pre_submission_prepare_failed":
   ev.from==="submitting"?"provider_confirmed_not_accepted":"remote_terminal_failed"};
}
function candidate(db,projectId,taskId){
 const task=taskRow(db,projectId,taskId),base={
  taskId,planVersion:task.active_plan_version,projectRevision:task.revision};
 const denied=reason=>({...base,canRecover:false,reason});
 if(task.status!=="failed"||task.read_only||task.cancel_requested_at!==null||
  task.active_step_id!==null)return denied("task_not_definitively_failed");
 const safe=inspectAssistantTaskRecovery(db,{projectId,taskId});
 if(!safe.canReplan)return denied(safe.reason);
 const seq=db.prepare("SELECT * FROM assistant_task_run_sequences WHERE task_id=? AND plan_version=? AND status='active' ORDER BY created_at DESC,id DESC LIMIT 1")
  .get(taskId,task.active_plan_version);
 if(!seq)return denied("frozen_run_sequence_missing");
 const actions=JSON.parse(seq.actions_json);
 const failures=db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND status='failed' AND kind IN ('model_job','comfy_workflow') AND superseded_at IS NULL")
  .all(taskId,seq.plan_version);
 if(failures.length!==1)return denied("single_definitive_failure_required");
 const step=failures[0],pre=JSON.parse(step.preconditions_json??"{}");
 const index=pre.runIndex;
 if(pre.runSequenceId!==seq.id||!Number.isInteger(index)||index<0||
  index>=actions.length-1)return denied("no_frozen_independent_fallback");
 const action=actions[index+1];
 if(action?.type!=="run_node"||action.when!==undefined||action.join!==undefined||
  action.inputFromPrevious!==undefined||!id(action.nodeId)||
  action.nodeId===actions[index]?.nodeId)return denied("no_frozen_independent_fallback");
 const nodes=JSON.parse(task.document_json).nodes??[];
 const node=nodes.find(n=>n.id===action.nodeId);
 const mode=node?.type==="config"?node.metadata?.generationMode??"image":node?.type;
 if(!allowedNodes.has(node?.type)||!modes.has(mode)||
  (action.mode!==undefined&&action.mode!==mode))return denied("fallback_target_changed");
 if(db.prepare("SELECT 1 FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL AND ordinal>? AND kind IN ('model_job','comfy_workflow') LIMIT 1")
  .get(taskId,seq.plan_version,step.ordinal))return denied("later_job_already_exists");
 const proof=verifiedAssistantFailure(db,{projectId,taskId,stepId:step.id});
 if(!proof||proof.sourceRunIndex!==index)return denied("job_failure_evidence_unverified");
 return {...base,canRecover:true,reason:"definitive_failure_fallback_ready",
  sourceSequenceId:seq.id,sourceStepId:step.id,sourceJobId:proof.sourceJobId,
  sourceAttemptId:proof.sourceAttemptId,sourceRunIndex:index,
  failureReason:proof.failureReason,evidenceDigest:proof.evidenceDigest,
  fallbackAction:action};
}
export function inspectAssistantRunFailureRecovery(db,{projectId,taskId}){
 if(!id(projectId)||!id(taskId))throw fail("assistant_task_run_failure_invalid",400);
 return candidate(db,projectId,taskId);
}
/** Called at planning AND immediately before the paid enqueue. */
export function verifyAssistantFrozenFailover(db,{projectId,taskId,runSequenceId,
 expectedPlanVersion,evidenceDigest}){
 const row=db.prepare("SELECT * FROM assistant_task_run_failovers WHERE sequence_id=? AND project_id=? AND task_id=? AND plan_version=?")
  .get(runSequenceId,projectId,taskId,expectedPlanVersion);
 if(!row||row.evidence_digest!==evidenceDigest)
  throw fail("assistant_task_run_failure_evidence_invalidated");
 const proof=verifiedAssistantFailure(db,{projectId,taskId,stepId:row.source_step_id});
 const seq=db.prepare("SELECT * FROM assistant_task_run_sequences WHERE id=? AND project_id=? AND task_id=? AND plan_version=? AND status='active'")
  .get(runSequenceId,projectId,taskId,expectedPlanVersion);
 const saved=JSON.parse(row.receipt_json??"null"),actions=seq&&JSON.parse(seq.actions_json);
 const original=db.prepare("SELECT * FROM assistant_task_run_sequences WHERE id=? AND project_id=? AND task_id=? AND plan_version=? AND status='cancelled'")
  .get(row.source_sequence_id,projectId,taskId,row.source_plan_version);
 const sourceStep=db.prepare("SELECT preconditions_json FROM assistant_task_steps WHERE id=? AND task_id=? AND plan_version=?")
  .get(row.source_step_id,taskId,row.source_plan_version);
 const originPre=sourceStep&&JSON.parse(sourceStep.preconditions_json);
 const originActions=original&&JSON.parse(original.actions_json);
 if(!proof||proof.evidenceDigest!==evidenceDigest||
  proof.sourcePlanVersion!==row.source_plan_version||
  proof.sourceRunIndex!==row.source_run_index||
  proof.sourceJobId!==row.source_job_id||proof.sourceAttemptId!==row.source_attempt_id||
  saved?.receiptTrust!=="server_committed"||saved?.evidenceDigest!==evidenceDigest||
  saved.sourceSequenceId!==row.source_sequence_id||saved.sourceStepId!==row.source_step_id||
  saved.sourceJobId!==row.source_job_id||saved.sourceAttemptId!==row.source_attempt_id||
  saved.sourcePlanVersion!==row.source_plan_version||
  saved.sourceRunIndex!==row.source_run_index||
  originPre?.runSequenceId!==row.source_sequence_id||
  originPre?.runIndex!==row.source_run_index||
  !Array.isArray(originActions)||originActions.length<=row.source_run_index+1||
  stableJson(originActions[row.source_run_index+1])!==stableJson(saved.fallbackAction)||
  !Array.isArray(actions)||actions.length!==1||
  stableJson(actions[0])!==stableJson(saved.fallbackAction))
  throw fail("assistant_task_run_failure_evidence_invalidated");
 return proof;
}
export function confirmAssistantRunFailureRecovery(db,{projectId,taskId,requestId,
 expectedPlanVersion,expectedProjectRevision,evidenceDigest}){
 if(!id(requestId)||!id(projectId)||!id(taskId)||
  !Number.isSafeInteger(expectedPlanVersion)||expectedPlanVersion<1||
  !Number.isSafeInteger(expectedProjectRevision)||expectedProjectRevision<1||
  typeof evidenceDigest!=="string"||!/^[a-f0-9]{64}$/.test(evidenceDigest))
  throw fail("assistant_task_run_failure_invalid",400);
 const payload={taskId,expectedPlanVersion,expectedProjectRevision,evidenceDigest};
 const signature=hash(payload);
 return writeTransaction(db,()=>{
  const existing=db.prepare("SELECT command_kind,payload_digest,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?")
   .get(projectId,requestId);
  if(existing){
   if(existing.command_kind!=="run_failure_recovery"||existing.payload_digest!==signature)
    throw fail("assistant_task_command_conflict");
   return {...JSON.parse(existing.response_json),existing:true};
  }
  const state=candidate(db,projectId,taskId);
  if(!state.canRecover||state.evidenceDigest!==evidenceDigest||
   state.planVersion!==expectedPlanVersion||
   state.projectRevision!==expectedProjectRevision)
   throw fail("assistant_task_run_failure_not_ready");
  const now=Date.now(),newPlan=expectedPlanVersion+1,sequenceId=randomUUID();
  const action=state.fallbackAction;
  const receipt={decision:"confirmed_independent_failover",
   receiptTrust:"server_committed",sourceSequenceId:state.sourceSequenceId,
   sourceStepId:state.sourceStepId,sourceJobId:state.sourceJobId,
   sourceAttemptId:state.sourceAttemptId,sourcePlanVersion:expectedPlanVersion,
   sourceRunIndex:state.sourceRunIndex,failureReason:state.failureReason,
   fallbackAction:action,evidenceDigest};
  // Keep the failed Job, Step, Attempt and audit trail immutable.
  db.prepare("UPDATE assistant_task_steps SET superseded_at=?,updated_at=? WHERE task_id=? AND plan_version=? AND superseded_at IS NULL AND status IN ('pending','ready','waiting_approval','blocked','skipped')")
   .run(now,now,taskId,expectedPlanVersion);
  db.prepare("UPDATE assistant_task_run_sequences SET status='cancelled',updated_at=? WHERE task_id=? AND plan_version=? AND status='active'")
   .run(now,taskId,expectedPlanVersion);
  const change=db.prepare("UPDATE assistant_tasks SET status='planning',active_plan_version=?,active_step_id=NULL,finished_at=NULL,updated_at=? WHERE id=? AND project_id=? AND status='failed' AND active_plan_version=? AND active_step_id IS NULL")
   .run(newPlan,now,taskId,projectId,expectedPlanVersion);
  if(change.changes!==1)throw fail("assistant_task_run_failure_not_ready");
  const sourceMessageId="failover-"+state.sourceStepId;
  db.prepare("INSERT INTO assistant_task_run_sequences(id,project_id,task_id,plan_version,source_message_id,base_step_id,actions_json,intent_digest,expected_project_revision,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,?,?,?,?)")
   .run(sequenceId,projectId,taskId,newPlan,sourceMessageId,stableJson([action]),
    hash({sourceSequenceId:state.sourceSequenceId,action,evidenceDigest}),
    expectedProjectRevision,now,now);
  db.prepare("INSERT INTO assistant_task_run_failovers(sequence_id,task_id,project_id,plan_version,source_sequence_id,source_step_id,source_job_id,source_attempt_id,source_plan_version,source_run_index,evidence_digest,receipt_json,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
   .run(sequenceId,taskId,projectId,newPlan,state.sourceSequenceId,
    state.sourceStepId,state.sourceJobId,state.sourceAttemptId,
    expectedPlanVersion,state.sourceRunIndex,evidenceDigest,stableJson(receipt),now);
  db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
   .run(taskId,"run_failure_failover_confirmed",stableJson({sequenceId,receipt,executionStarted:false}),now);
  const response={taskId,sequenceId,planVersion:newPlan,fallbackAction:action,
   evidenceDigest,executionStarted:false,status:"planned"};
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,'run_failure_recovery',?,'completed',?,?)")
   .run(projectId,requestId,taskId,signature,stableJson(response),now);
  return {...response,existing:false};
 });
}
