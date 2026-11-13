/** P3c safe replan. Planning is an explicit, idempotent local operation.
 * No provider POST, GPU enqueue, Skill execution, or automatic replay.
 * Unknown/active upstream attempts or successful but unmaterialized artifacts
 * deliberately block revision until authoritative evidence is reconciled.
 */
import {createHash} from "node:crypto";
import {stableJson,writeTransaction} from "./repository.mjs";
import {trustedAssistantTaskOutputs} from "./assistant-task-produced-artifacts.mjs";
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const validId=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const hash=x=>createHash("sha256").update(stableJson(x)).digest("hex");
function context(db,projectId,taskId){
 if(!validId(projectId)||!validId(taskId))throw fail("assistant_task_invalid",400);
 const row=db.prepare("SELECT t.*,p.document_json,p.revision FROM assistant_tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL WHERE t.id=? AND t.project_id=?")
  .get(taskId,projectId);
 if(!row)throw fail("assistant_task_not_found",404);
 return row;
}
function inspect(db,projectId,taskId){
 const task=context(db,projectId,taskId);
 const base={taskId,planVersion:task.active_plan_version,projectRevision:task.revision};
 const denied=(reason)=>({...base,canReplan:false,reason});
 if(!["failed","blocked"].includes(task.status))return denied("task_not_failed_or_blocked");
 if(task.read_only||task.cancel_requested_at!==null)return denied("task_not_editable");
 if(task.active_step_id!==null)return denied("active_step_must_be_reconciled");
 const steps=db.prepare("SELECT id,kind,status,receipt_trust FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL")
  .all(taskId,task.active_plan_version);
 if(steps.some(step=>["running","submitting","waiting_external","needs_reconcile"].includes(step.status)))
  return denied("active_or_unknown_step_must_be_reconciled");
 const attempts=db.prepare("SELECT a.external_kind,a.status AS attempt_status,a.external_id,s.kind,s.status AS step_status,s.receipt_trust,j.status AS job_status,j.id AS job_id FROM assistant_task_attempts a JOIN assistant_task_steps s ON s.id=a.step_id LEFT JOIN jobs j ON j.id=a.external_id AND j.project_id=? WHERE a.task_id=? AND s.plan_version=? ORDER BY a.created_at")
  .all(projectId,taskId,task.active_plan_version);
 if(attempts.some(attempt=>attempt.external_kind==="skill_run"&&
  !(attempt.step_status==="succeeded"&&attempt.receipt_trust==="server_committed")))
  return denied("skill_effects_not_verified");
 const outputs=trustedAssistantTaskOutputs(db,{projectId,taskId,planVersion:task.active_plan_version});
 for(const attempt of attempts){
  if(attempt.external_kind!=="job")continue;
  if(!attempt.job_id||!["succeeded","failed","cancelled"].includes(attempt.job_status))
   return denied("job_outcome_unknown");
  if(attempt.job_status!=="succeeded"&&
   !(attempt.step_status==="failed"&&attempt.attempt_status==="failed"))
   return denied("job_failure_receipt_unverified");
  if(attempt.job_status==="succeeded"){
   const count=db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(attempt.job_id).n;
   if(count===0||outputs.filter(output=>output.jobId===attempt.job_id).length!==count)
    return denied("successful_job_materialization_unverified");
  }else if(db.prepare("SELECT 1 FROM artifacts WHERE job_id=? LIMIT 1").get(attempt.job_id))
   return denied("failed_job_has_partial_artifacts");
 }
 return {...base,canReplan:true,reason:"verified_safe_to_replan",
  completedArtifacts:outputs.length,failedJobs:attempts.filter(a=>a.external_kind==="job"&&a.job_status==="failed").length};
}
export function inspectAssistantTaskRecovery(db,{projectId,taskId}){
 return inspect(db,projectId,taskId);
}
export function replanAssistantTaskSafely(db,{projectId,taskId,requestId,expectedPlanVersion,expectedProjectRevision}){
 if(!validId(requestId)||!Number.isSafeInteger(expectedPlanVersion)||expectedPlanVersion<1||
  !Number.isSafeInteger(expectedProjectRevision)||expectedProjectRevision<1)
  throw fail("assistant_task_replan_invalid",400);
 const payload={taskId,expectedPlanVersion,expectedProjectRevision};
 const signature=hash({kind:"safe_replan",payload});
 return writeTransaction(db,()=>{
  const existing=db.prepare("SELECT command_kind,payload_digest,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?").get(projectId,requestId);
  if(existing){
   if(existing.command_kind!=="safe_replan"||existing.payload_digest!==signature)
    throw fail("assistant_task_command_conflict");
   return {...JSON.parse(existing.response_json),existing:true};
  }
  const state=inspect(db,projectId,taskId);
  if(state.planVersion!==expectedPlanVersion)throw fail("assistant_step_plan_conflict");
  if(state.projectRevision!==expectedProjectRevision)throw fail("assistant_step_source_changed");
  if(!state.canReplan)throw fail("assistant_task_replan_blocked");
  const now=Date.now();
  // Supersede only unexecuted steps. Completed/failed evidence stays immutable.
  db.prepare("UPDATE assistant_task_steps SET superseded_at=?,updated_at=? WHERE task_id=? AND plan_version=? AND superseded_at IS NULL AND status IN ('pending','ready','waiting_approval','blocked','skipped')")
   .run(now,now,taskId,expectedPlanVersion);
  db.prepare("UPDATE assistant_task_run_sequences SET status='cancelled',updated_at=? WHERE task_id=? AND plan_version=? AND status='active'")
   .run(now,taskId,expectedPlanVersion);
  const changed=db.prepare("UPDATE assistant_tasks SET status='planning',active_plan_version=active_plan_version+1,active_step_id=NULL,finished_at=NULL,updated_at=? WHERE id=? AND project_id=? AND active_plan_version=? AND status IN ('blocked','failed') AND active_step_id IS NULL")
   .run(now,taskId,projectId,expectedPlanVersion);
  if(changed.changes!==1)throw fail("assistant_step_plan_conflict");
  db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
   .run(taskId,"safe_replan_authorized",stableJson({fromPlanVersion:expectedPlanVersion,toPlanVersion:expectedPlanVersion+1,
    completedArtifacts:state.completedArtifacts,failedJobs:state.failedJobs,executionStarted:false}),now);
  const response={taskId,activePlanVersion:expectedPlanVersion+1,executionStarted:false,
   completedArtifacts:state.completedArtifacts};
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,'safe_replan',?,'completed',?,?)")
   .run(projectId,requestId,taskId,signature,stableJson(response),now);
  return {...response,existing:false};
 });
}
