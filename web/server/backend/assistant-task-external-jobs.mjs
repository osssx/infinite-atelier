import {createHash,randomUUID} from "node:crypto";
import {EXECUTION_MODES} from "./contracts.mjs";
import {assertNoRawCredentials,stableJson,writeTransaction,submitJobInTransaction} from "./repository.mjs";
import {verifyAssistantRunSequenceJob,assertNoPendingAssistantRunSequence} from "./assistant-task-run-sequences.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const id=v=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const hash=v=>createHash("sha256").update(stableJson(v)).digest("hex");
function freeze(value,max=32768){
 assertNoRawCredentials(value);
 const out=stableJson(value);
 if(Buffer.byteLength(out)>max)throw fail("assistant_task_payload_too_large",413);
 return out;
}
function event(db,taskId,stepId,kind,payload,at=Date.now()){
 db.prepare("INSERT INTO assistant_task_events(task_id,step_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)")
  .run(taskId,stepId,kind,freeze(payload,8000),at);
}
function context(db,projectId,taskId){
 if(!id(projectId)||!id(taskId))throw fail("assistant_step_invalid",400);
 const task=db.prepare("SELECT t.*,p.document_json,p.revision FROM assistant_tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL WHERE t.project_id=? AND t.id=?").get(projectId,taskId);
 if(!task)throw fail("assistant_task_not_found",404);
 return task;
}
function stepOf(db,taskId,stepId){
 const row=db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? AND id=?").get(taskId,stepId);
 if(!row)throw fail("assistant_step_not_found",404);
 return row;
}
function known(db,projectId,requestId,kind,payload){
 const digest=hash({kind,payload});
 const old=db.prepare("SELECT command_kind,payload_digest,status,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?").get(projectId,requestId);
 if(old){
  if(old.command_kind!==kind||old.payload_digest!==digest)throw fail("assistant_task_command_conflict");
  if(old.status!=="completed")throw fail("assistant_step_state_conflict");
  return {signature:digest,response:JSON.parse(old.response_json)};
 }
 return {signature:digest,response:null};
}
function saveCommand(db,projectId,taskId,requestId,kind,signature,response){
 db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,?,?,'completed',?,?)")
  .run(projectId,requestId,taskId,kind,signature,freeze(response),Date.now());
}
function dependencyCheck(db,taskId,planVersion,ordinal,ids){
 if(!Array.isArray(ids)||ids.length>20||new Set(ids).size!==ids.length||
    ids.some(item=>!id(item)))throw fail("assistant_step_dependency_invalid",400);
 for(const depId of ids){
  const row=db.prepare("SELECT plan_version,ordinal,status,receipt_trust,superseded_at FROM assistant_task_steps WHERE task_id=? AND id=?").get(taskId,depId);
  if(!row||row.plan_version!==planVersion||row.ordinal>=ordinal||row.superseded_at!==null||
   row.status!=="succeeded"||row.receipt_trust!=="server_committed")
   throw fail("assistant_step_dependency_unverified");
 }
}
const terminalStates=new Set(["completed","cancelled","blocked","failed","needs_reconcile","cancelling"]);
function jobShape(kind,job,revision){
 if(!job||typeof job!=="object"||Array.isArray(job)||
  Object.keys(job).some(key=>!["targetNodeId","sourceNodeFingerprint","executionMode","snapshot","skillAuthorizationId"].includes(key))||
  typeof job.targetNodeId!=="string"||!job.targetNodeId||job.targetNodeId.length>256||
  typeof job.sourceNodeFingerprint!=="string"||!job.sourceNodeFingerprint||job.sourceNodeFingerprint.length>256||
  !EXECUTION_MODES.includes(job.executionMode)||
  !job.snapshot||typeof job.snapshot!=="object"||Array.isArray(job.snapshot)||
  job.snapshot.adapterKind!==(kind==="comfy_workflow"?"comfy":"model")||
  (job.skillAuthorizationId!==undefined&&(!id(job.skillAuthorizationId)&&
   !/^[0-9a-f-]{36}$/.test(job.skillAuthorizationId))))
  throw fail("assistant_external_invalid",400);
 // Freeze the complete Job payload. Never include a user supplied idempotencyKey.
 const sanitized={targetNodeId:job.targetNodeId,sourceNodeFingerprint:job.sourceNodeFingerprint,
  executionMode:job.executionMode,snapshot:job.snapshot,
  ...(job.skillAuthorizationId?{skillAuthorizationId:job.skillAuthorizationId}:{})};
 // Production Comfy graphs and frozen model prompt context frequently exceed 30KB.
 // Keep a bounded, immutable Task snapshot rather than silently falling back
 // to the ordinary paid /jobs route.
 freeze(sanitized,512*1024);
 return {...sanitized,expectedProjectRevision:revision};
}
/** P2a: persist a plan without sending an upstream request or creating a Job.
 * Only a later approval + atomic enqueue can create the unique local Job.
 */
export function planAssistantExternalJobStep(db,{projectId,taskId,requestId,kind,
 expectedPlanVersion,expectedProjectRevision,job,dependsOn=[],finalizeTask=false,
 runSequenceId,runIndex}){
 if(!id(requestId)||!["model_job","comfy_workflow"].includes(kind)||
  !Number.isSafeInteger(expectedPlanVersion)||expectedPlanVersion<1||
  !Number.isSafeInteger(expectedProjectRevision)||expectedProjectRevision<1||
  typeof finalizeTask!=="boolean")throw fail("assistant_external_invalid",400);
 const frozenJob=jobShape(kind,job,expectedProjectRevision);
 const action={kind,job:frozenJob};
 if((runSequenceId===undefined)!==(runIndex===undefined))throw fail("assistant_task_run_invalid",400);
 const payload={taskId,expectedPlanVersion,expectedProjectRevision,action,dependsOn,finalizeTask,
  ...(runSequenceId!==undefined?{runSequenceId,runIndex}:{})};
 return writeTransaction(db,()=>{
  const {signature,response}=known(db,projectId,requestId,"external_plan",payload);
  if(response)return {...response,existing:true};
  const task=context(db,projectId,taskId);
  if(task.read_only||task.cancel_requested_at!==null||terminalStates.has(task.status))throw fail("assistant_task_not_editable");
  if(task.active_plan_version!==expectedPlanVersion)throw fail("assistant_step_plan_conflict");
  if(task.active_step_id!==null)throw fail("assistant_step_already_claimed");
  if(task.revision!==expectedProjectRevision)throw fail("assistant_step_source_changed");
  if(db.prepare("SELECT 1 FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL AND status IN ('pending','ready','waiting_approval','submitting','running','waiting_external','needs_reconcile') LIMIT 1")
   .get(taskId,expectedPlanVersion))throw fail("assistant_step_already_planned");
  if(runSequenceId===undefined)assertNoPendingAssistantRunSequence(db,{projectId,taskId});
  const sequence=runSequenceId!==undefined?verifyAssistantRunSequenceJob(db,{
   projectId,taskId,runSequenceId,runIndex,expectedPlanVersion,job:frozenJob,kind,dependsOn}):null;
  if(sequence&&finalizeTask)throw fail("assistant_task_run_invalid",400);
  const ordinal=db.prepare("SELECT COALESCE(MAX(ordinal)+1,0) AS n FROM assistant_task_steps WHERE task_id=? AND plan_version=?").get(taskId,expectedPlanVersion).n;
  dependencyCheck(db,taskId,expectedPlanVersion,ordinal,dependsOn);
  const stepId=randomUUID(),actionDigest=hash(action),at=Date.now();
  const pre={projectRevision:expectedProjectRevision,
   projectGraphDigest:hash(JSON.parse(task.document_json)),
   requiresApproval:true,finalizeTask:sequence?.finalizeTask??finalizeTask,
   ...(sequence?{runSequenceId,runIndex}:{})};
  db.prepare("INSERT INTO assistant_task_steps(id,task_id,plan_version,ordinal,kind,status,required,depends_on_json,action_json,action_digest,preconditions_json,created_at,updated_at) VALUES(?,?,?,?,?,'waiting_approval',1,?,?,?,?,?,?)")
   .run(stepId,taskId,expectedPlanVersion,ordinal,kind,freeze(dependsOn),freeze(action,550*1024),actionDigest,freeze(pre),at,at);
  db.prepare("UPDATE assistant_tasks SET status='waiting_approval',updated_at=? WHERE id=?").run(at,taskId);
  event(db,taskId,stepId,"external_step_frozen",{kind,actionDigest,
   targetNodeId:frozenJob.targetNodeId,adapterKind:frozenJob.snapshot.adapterKind,
   ...(sequence?{runSequenceId,runIndex}:{})},at);
  const value={taskId,stepId,kind,planVersion:expectedPlanVersion,actionDigest,
   status:"waiting_approval",executionStarted:false};
  saveCommand(db,projectId,taskId,requestId,"external_plan",signature,value);
  return {...value,existing:false};
 });
}
/** P2a's only enqueue boundary. Job, Attempt and Task Step are committed
 * together; the coordinator is the sole party that may later contact providers.
 */
export function enqueueAssistantExternalJobStep(db,{projectId,taskId,stepId,requestId,
 expectedPlanVersion,actionDigest,beforeLink}){
 if(!id(requestId)||!id(stepId)||!Number.isSafeInteger(expectedPlanVersion)||
   !/^[a-f0-9]{64}$/.test(actionDigest))throw fail("assistant_external_invalid",400);
 const payload={taskId,stepId,expectedPlanVersion,actionDigest};
 return writeTransaction(db,()=>{
  const {signature,response}=known(db,projectId,requestId,"external_enqueue",payload);
  if(response)return {...response,existing:true};
  const task=context(db,projectId,taskId),step=stepOf(db,taskId,stepId);
  if(step.kind!=="model_job"&&step.kind!=="comfy_workflow")throw fail("assistant_step_kind_not_ready");
  if(step.plan_version!==expectedPlanVersion||task.active_plan_version!==expectedPlanVersion||
   step.superseded_at!==null)throw fail("assistant_step_plan_conflict");
  if(step.action_digest!==actionDigest)throw fail("assistant_step_action_changed");
  if(step.status==="waiting_external"||step.status==="succeeded"){
   const attempt=db.prepare("SELECT external_id FROM assistant_task_attempts WHERE step_id=? AND external_kind='job' ORDER BY attempt_no DESC LIMIT 1").get(stepId);
   if(!attempt)throw fail("assistant_external_evidence_missing");
   const value={taskId,stepId,jobId:attempt.external_id,status:step.status,
    executionStarted:true};
   saveCommand(db,projectId,taskId,requestId,"external_enqueue",signature,value);
   return {...value,existing:true};
  }
  if(task.read_only||task.cancel_requested_at!==null||terminalStates.has(task.status))
   throw fail("assistant_task_not_editable");
  if(step.status!=="ready"||task.active_step_id!==null)throw fail("assistant_step_already_claimed");
  const action=JSON.parse(step.action_json),pre=JSON.parse(step.preconditions_json),
   approval=JSON.parse(step.approval_json);
  if(hash(action)!==actionDigest)throw fail("assistant_step_action_changed");
  if(approval.decision!=="approved"||approval.planVersion!==expectedPlanVersion||
   approval.actionDigest!==actionDigest||approval.projectRevision!==pre.projectRevision)
   throw fail("assistant_step_approval_required");
  if(task.revision!==pre.projectRevision||hash(JSON.parse(task.document_json))!==pre.projectGraphDigest)
   throw fail("assistant_step_source_changed");
  dependencyCheck(db,taskId,expectedPlanVersion,step.ordinal,JSON.parse(step.depends_on_json));
  const attemptNo=step.attempt_count+1,attemptId=randomUUID(),
   executionKey=hash({taskId,stepId,planVersion:expectedPlanVersion,attemptNo}),
   at=Date.now();
  // Comfy requires the inner request key and the queued Job idempotency key
  // to match. Replace the provisional browser key ONLY at atomic enqueue:
  // the consent-bound frozen Step/action digest remains unchanged.
  const job=action.kind==="comfy_workflow"?
   {...action.job,snapshot:{...action.job.snapshot,
    comfyRequest:{...action.job.snapshot.comfyRequest,idempotencyKey:executionKey}}}:
   action.job;
  const requestFingerprint=hash({projectId,actionDigest,job});
  const queued=submitJobInTransaction(db,{principal:"local-owner",projectId,
   targetNodeId:job.targetNodeId,expectedProjectRevision:job.expectedProjectRevision,
   sourceNodeFingerprint:job.sourceNodeFingerprint,executionMode:job.executionMode,
   snapshot:job.snapshot,...(job.skillAuthorizationId?{skillAuthorizationId:job.skillAuthorizationId}:{}),
   idempotencyKey:executionKey,requestFingerprint,requireSkillGrant:true});
  if(beforeLink)beforeLink({jobId:queued.jobId,executionKey}); // fault-injection only
  const frozen={projectId,taskId,stepId,planVersion:expectedPlanVersion,attemptNo,
   actionDigest,executionKey,requestFingerprint,job};
  db.prepare("INSERT INTO assistant_task_attempts(id,task_id,step_id,attempt_no,project_id,execution_key,action_digest,request_fingerprint,frozen_snapshot_json,status,external_kind,external_id,submit_marker,submitted_at,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,'waiting_external','job',?,'job_queued_atomic',?,'{}',?)")
   .run(attemptId,taskId,stepId,attemptNo,projectId,executionKey,actionDigest,
    requestFingerprint,freeze(frozen,550*1024),queued.jobId,at,at);
  db.prepare("UPDATE assistant_task_steps SET status='waiting_external',attempt_count=?,result_json=?,updated_at=? WHERE id=? AND status='ready'")
   .run(attemptNo,freeze({jobId:queued.jobId,jobStatus:"queued"}),at,stepId);
  db.prepare("UPDATE assistant_tasks SET status='waiting_external',active_step_id=?,updated_at=? WHERE id=?")
   .run(stepId,at,taskId);
  event(db,taskId,stepId,"external_job_queued",{attemptId,jobId:queued.jobId,
   executionKey,kind:step.kind},at);
  const value={taskId,stepId,jobId:queued.jobId,status:"waiting_external",
   executionStarted:true};
  saveCommand(db,projectId,taskId,requestId,"external_enqueue",signature,value);
  return {...value,existing:false};
 });
}
const materializationResults=(db,jobId,projectId,artifacts)=>{
 const rows=db.prepare("SELECT a.id AS artifact_id,m.status,m.node_id FROM artifacts a LEFT JOIN materializations m ON m.artifact_id=a.id AND m.project_id=? WHERE a.job_id=? ORDER BY a.id")
  .all(projectId,jobId);
 if(rows.length!==artifacts.length)return {state:"needs_reconcile",rows};
 const blocked=rows.some(x=>x.status==="blocked");
 const nodes=new Set(JSON.parse(db.prepare("SELECT document_json FROM projects WHERE id=?").get(projectId)?.document_json??'{"nodes":[]}').nodes.map(n=>n.id));
 const ready=rows.every(x=>x.status==="materialized"&&typeof x.node_id==="string"&&nodes.has(x.node_id));
 return {state:ready?"materialized":blocked?"blocked":"waiting_external",rows};
};
/** Reconcile local DB evidence only; never sends a provider POST or restarts
 * a model, Skill, or Comfy job. Job success and materialization are separate.
 */
function reconcileTaskInTransaction(db,projectId,taskId){
 const task=context(db,projectId,taskId),steps=db.prepare(
  "SELECT * FROM assistant_task_steps WHERE task_id=? AND kind IN ('model_job','comfy_workflow','materialize') ORDER BY plan_version,ordinal").all(taskId);
 let advanced=0;
 for(const step of steps){
  if(step.kind==="materialize")continue;
  if(!["waiting_external","needs_reconcile","succeeded"].includes(step.status))continue;
  const attempt=db.prepare("SELECT * FROM assistant_task_attempts WHERE step_id=? AND external_kind='job' ORDER BY attempt_no DESC LIMIT 1").get(step.id);
  if(!attempt)continue;
  const job=db.prepare("SELECT * FROM jobs WHERE id=? AND project_id=?").get(attempt.external_id,projectId);
  const frozen=JSON.parse(attempt.frozen_snapshot_json);
  if(!job||job.idempotency_key!==attempt.execution_key||
   job.request_fingerprint!==attempt.request_fingerprint||
   job.snapshot_json!==stableJson(frozen.job.snapshot)){
   db.prepare("UPDATE assistant_task_steps SET status='needs_reconcile',error_code='assistant_external_evidence_missing',updated_at=? WHERE id=?").run(Date.now(),step.id);
   db.prepare("UPDATE assistant_tasks SET status=?,updated_at=? WHERE id=?")
    .run(task.cancel_requested_at?"cancelling":"needs_reconcile",Date.now(),taskId);
   advanced++;continue;
  }
  if(step.status==="succeeded")continue;
  const now=Date.now(),cancelled=task.cancel_requested_at!==null,validPlan=step.plan_version===task.active_plan_version&&step.superseded_at===null;
  if(job.status==="submission_unknown"){
   db.prepare("UPDATE assistant_task_attempts SET status='needs_reconcile',evidence_json=? WHERE id=?")
    .run(freeze({jobId:job.id,jobStatus:job.status}),attempt.id);
   db.prepare("UPDATE assistant_task_steps SET status='needs_reconcile',error_code='assistant_external_submission_unknown',updated_at=? WHERE id=?")
    .run(now,step.id);
   if(validPlan)db.prepare("UPDATE assistant_tasks SET status=?,updated_at=? WHERE id=?")
    .run(cancelled?"cancelling":"needs_reconcile",now,taskId);
   advanced++;continue;
  }
  if(!["succeeded","failed","cancelled"].includes(job.status)){
   if(step.status==="needs_reconcile"){
    db.prepare("UPDATE assistant_task_steps SET status='waiting_external',error_code=NULL,updated_at=? WHERE id=?").run(now,step.id);
    db.prepare("UPDATE assistant_task_attempts SET status='waiting_external' WHERE id=?").run(attempt.id);
    if(validPlan)db.prepare("UPDATE assistant_tasks SET status=?,updated_at=? WHERE id=?")
     .run(cancelled?"cancelling":"waiting_external",now,taskId);
    advanced++;
   }
   continue;
  }
  const artifacts=db.prepare("SELECT id FROM artifacts WHERE job_id=? ORDER BY id").all(job.id).map(x=>x.id);
  if(job.status==="succeeded"&&!artifacts.length){
   db.prepare("UPDATE assistant_task_steps SET status='needs_reconcile',error_code='assistant_external_artifacts_missing',updated_at=? WHERE id=?").run(now,step.id);
   db.prepare("UPDATE assistant_task_attempts SET status='needs_reconcile',evidence_json=? WHERE id=?")
    .run(freeze({jobId:job.id,jobStatus:job.status,artifacts:0}),attempt.id);
   if(validPlan)db.prepare("UPDATE assistant_tasks SET status=?,updated_at=? WHERE id=?")
    .run(cancelled?"cancelling":"needs_reconcile",now,taskId);
   advanced++;continue;
  }
  const success=job.status==="succeeded",receipt={jobId:job.id,
   executionKey:attempt.execution_key,attemptId:attempt.id,jobStatus:job.status,
   artifactIds:artifacts,committedAt:now};
  db.prepare("UPDATE assistant_task_steps SET status=?,receipt_json=?,receipt_trust=?,result_json=?,error_code=?,updated_at=? WHERE id=?")
   .run(success?"succeeded":"failed",freeze(receipt),success?"server_committed":"none",
    freeze({jobId:job.id,jobStatus:job.status,artifactIds:artifacts}),
    success?null:"assistant_external_job_failed",now,step.id);
  db.prepare("UPDATE assistant_task_attempts SET status=?,evidence_json=?,finished_at=? WHERE id=?")
   .run(success?"succeeded":"failed",freeze({jobId:job.id,jobStatus:job.status,artifactIds:artifacts}),now,attempt.id);
  event(db,taskId,step.id,"external_job_terminal",{jobId:job.id,
   jobStatus:job.status,artifactIds:artifacts,receiptTrust:success?"server_committed":"none"},now);
  if(validPlan){
   if(cancelled){
    db.prepare("UPDATE assistant_tasks SET status='cancelled',active_step_id=NULL,finished_at=?,updated_at=? WHERE id=?")
     .run(now,now,taskId);
   }else if(!success){
    db.prepare("UPDATE assistant_tasks SET status='failed',active_step_id=NULL,finished_at=?,updated_at=? WHERE id=?")
     .run(now,now,taskId);
   }else{
    // Generation succeeded does NOT mean the output has appeared on canvas.
    const materialStepId=randomUUID(),ordinal=db.prepare(
     "SELECT COALESCE(MAX(ordinal)+1,0) AS n FROM assistant_task_steps WHERE task_id=? AND plan_version=?").get(taskId,step.plan_version).n;
    const action={jobId:job.id,artifactIds:artifacts},pre={
     sourceStepId:step.id,finalizeTask:JSON.parse(step.preconditions_json).finalizeTask===true};
    db.prepare("INSERT INTO assistant_task_steps(id,task_id,plan_version,ordinal,kind,status,required,depends_on_json,action_json,action_digest,preconditions_json,created_at,updated_at) VALUES(?,?,?,?,'materialize','waiting_external',1,?,?,?,?,?,?)")
     .run(materialStepId,taskId,step.plan_version,ordinal,freeze([step.id]),
      freeze(action),hash(action),freeze(pre),now,now);
    db.prepare("UPDATE assistant_tasks SET status='waiting_external',active_step_id=?,updated_at=? WHERE id=?")
     .run(materialStepId,now,taskId);
    event(db,taskId,materialStepId,"materialize_waiting",{jobId:job.id,
     artifactCount:artifacts.length},now);
   }
  }
  advanced++;
 }
 // Materialization is observed and proven independently. Never invoke a new Job.
 const current=db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? AND kind='materialize' AND status IN ('waiting_external','needs_reconcile','blocked') ORDER BY ordinal").all(taskId);
 for(const step of current){
  const action=JSON.parse(step.action_json),pre=JSON.parse(step.preconditions_json);
  const results=materializationResults(db,action.jobId,projectId,action.artifactIds);
  if(results.state==="waiting_external"){
   if(step.status!=="waiting_external"&&task.cancel_requested_at===null){
    const at=Date.now();
    db.prepare("UPDATE assistant_task_steps SET status='waiting_external',error_code=NULL,updated_at=? WHERE id=?").run(at,step.id);
    if(step.plan_version===task.active_plan_version&&step.superseded_at===null)
     db.prepare("UPDATE assistant_tasks SET status='waiting_external',updated_at=? WHERE id=?").run(at,taskId);
    advanced++;
   }
   continue;
  }
  const at=Date.now(),cancelled=task.cancel_requested_at!==null,
   valid=step.plan_version===task.active_plan_version&&step.superseded_at===null;
  if(results.state==="materialized"){
   const bindings=results.rows.map(r=>({artifactId:r.artifact_id,nodeId:r.node_id}));
   const receipt={jobId:action.jobId,bindings,committedAt:at};
   db.prepare("UPDATE assistant_task_steps SET status='succeeded',receipt_trust='server_committed',receipt_json=?,result_json=?,error_code=NULL,updated_at=? WHERE id=?")
    .run(freeze(receipt),freeze(receipt),at,step.id);
   event(db,taskId,step.id,"materialize_verified",{jobId:action.jobId,bindings},at);
   if(valid&&!cancelled){
    const all=db.prepare("SELECT status,receipt_trust,required FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL").all(taskId,step.plan_version);
    const completed=pre.finalizeTask===true&&all.every(s=>!s.required||s.status==="succeeded"&&s.receipt_trust==="server_committed");
    db.prepare("UPDATE assistant_tasks SET status=?,active_step_id=NULL,updated_at=?,finished_at=? WHERE id=?")
     .run(completed?"completed":"ready",at,completed?at:null,taskId);
    if(completed)event(db,taskId,null,"task_completed",{planVersion:step.plan_version,source:"materialize"},at);
   }
  }else{
   const block=results.state==="blocked";
   db.prepare("UPDATE assistant_task_steps SET status=?,error_code=?,updated_at=? WHERE id=?")
    .run(block?"blocked":"needs_reconcile",block?"assistant_external_materialization_blocked":"assistant_external_materialization_unknown",at,step.id);
   if(valid&&!cancelled)db.prepare("UPDATE assistant_tasks SET status=?,updated_at=? WHERE id=?")
    .run(block?"blocked":"needs_reconcile",at,taskId);
  }
  advanced++;
 }
 return {taskId,advanced,checked:steps.length};
}
export function reconcileAssistantExternalTask(db,{projectId,taskId}){
 return writeTransaction(db,()=>reconcileTaskInTransaction(db,projectId,taskId));
}
/** Run only after the exclusive single-instance lock and DB migration.
 * This reads existing jobs/artifacts/materializations; never submits a Job.
 */
export function recoverAssistantExternalTasksAtStartup(db){
 return writeTransaction(db,()=>{
  const rows=db.prepare("SELECT DISTINCT t.project_id,t.id FROM assistant_tasks t JOIN assistant_task_steps s ON s.task_id=t.id JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL WHERE s.kind IN ('model_job','comfy_workflow','materialize') AND s.status IN ('waiting_external','needs_reconcile')").all();
  let advanced=0;
  for(const item of rows)advanced+=reconcileTaskInTransaction(db,item.project_id,item.id).advanced;
  return {tasks:rows.length,advanced};
 });
}
