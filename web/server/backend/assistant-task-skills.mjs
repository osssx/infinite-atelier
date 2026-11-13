import {randomUUID,createHash} from "node:crypto";
import {assertNoRawCredentials,stableJson,writeTransaction} from "./repository.mjs";
import {resolveAuthorizedSkillScript} from "./skill-script-source.mjs";
import {runSkillScript} from "./skill-script-runner.mjs";
import {blockUnreachableAssistantTaskStepsWithinTransaction} from "./assistant-task-step-gate.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const id=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const digest=value=>createHash("sha256").update(stableJson(value)).digest("hex");
function freeze(value,max=32768){
 assertNoRawCredentials(value);
 const result=stableJson(value);
 if(Buffer.byteLength(result)>max)throw fail("assistant_task_payload_too_large",413);
 return result;
}
function getTask(db,projectId,taskId){
 if(!id(projectId)||!id(taskId))throw fail("assistant_step_invalid",400);
 const row=db.prepare("SELECT t.*,p.document_json,p.revision FROM assistant_tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL WHERE t.project_id=? AND t.id=?").get(projectId,taskId);
 if(!row)throw fail("assistant_task_not_found",404);
 return row;
}
function getStep(db,taskId,stepId){
 const row=db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? AND id=?").get(taskId,stepId);
 if(!row)throw fail("assistant_step_not_found",404);
 return row;
}
function event(db,taskId,stepId,kind,data,at=Date.now()){
 db.prepare("INSERT INTO assistant_task_events(task_id,step_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)")
  .run(taskId,stepId,kind,freeze(data,8000),at);
}
const inactive=new Set(["blocked","failed","cancelled","cancelling","needs_reconcile","completed"]);
function command(db,projectId,taskId,requestId,kind,payload,response=null){
 const fingerprint=digest({kind,taskId,payload});
 const row=db.prepare("SELECT command_kind,payload_digest,status,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?").get(projectId,requestId);
 if(row){
  if(row.command_kind!==kind||row.payload_digest!==fingerprint)throw fail("assistant_task_command_conflict");
  if(row.status!=="completed")throw fail("assistant_step_state_conflict");
  return {existing:JSON.parse(row.response_json),fingerprint};
 }
 if(response!==null)db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,?,?,'completed',?,?)")
  .run(projectId,requestId,taskId,kind,fingerprint,freeze(response,8000),Date.now());
 return {existing:null,fingerprint};
}
const SKILL_ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function normalize(body){
 if(!body||typeof body!=="object"||Array.isArray(body)||
  Object.keys(body).some(key=>!["skill_id","version","script_path","entry_id","runtime","args","input_files","output_files"].includes(key))||
  !SKILL_ID.test(body.skill_id)||body.skill_id.length>80||
  typeof body.version!=="string"||!/^[a-f0-9]{12}$/.test(body.version)||
  Boolean(body.script_path)===Boolean(body.entry_id)||
  body.script_path!==undefined&&(typeof body.script_path!=="string"||body.script_path.length>240)||
  body.entry_id!==undefined&&(typeof body.entry_id!=="string"||body.entry_id.length>64)||
  body.runtime!==undefined&&(typeof body.runtime!=="string"||body.runtime.length>260)||
  body.args!==undefined&&(!Array.isArray(body.args)||body.args.length>64||
   body.args.some(x=>typeof x!=="string"||x.length>8192))||
  body.input_files!==undefined&&(!body.input_files||typeof body.input_files!=="object"||
   Array.isArray(body.input_files)||Object.keys(body.input_files).length>32||
   Object.entries(body.input_files).some(([path,value])=>path.length>240||
    typeof value!=="string"||value.length>262144))||
  body.output_files!==undefined&&(!Array.isArray(body.output_files)||body.output_files.length>32||
   body.output_files.some(x=>typeof x!=="string"||x.length>240)))throw fail("assistant_skill_invalid",400);
 const action={skill_id:body.skill_id,version:body.version,
  ...(body.script_path?{script_path:body.script_path}:{entry_id:body.entry_id}),
  ...(body.runtime?{runtime:body.runtime}:{}),args:body.args??[],
  input_files:body.input_files??{},output_files:body.output_files??[]};
 freeze(action,30000);
 return action;
}
function sources(db,skillRegistry,projectId,action){
 return resolveAuthorizedSkillScript(db,skillRegistry,{...action,project_id:projectId});
}
/** Freeze an explicit Skill script proposal as an approval-bound Task Step.
 * Filesystem version availability and permission are revalidated at execution.
 */
export function planAssistantSkillStep(db,{projectId,taskId,requestId,
 expectedPlanVersion,expectedProjectRevision,proposal,dependsOn=[],finalizeTask=false,
 skillRegistry}){
 if(!id(requestId)||!Number.isSafeInteger(expectedPlanVersion)||expectedPlanVersion<1||
  !Number.isSafeInteger(expectedProjectRevision)||expectedProjectRevision<1||
  !Array.isArray(dependsOn)||dependsOn.length>20||new Set(dependsOn).size!==dependsOn.length||
  dependsOn.some(x=>!id(x))||typeof finalizeTask!=="boolean")
  throw fail("assistant_skill_invalid",400);
 const action=normalize(proposal);

 const payload={taskId,expectedPlanVersion,expectedProjectRevision,action,dependsOn,finalizeTask};
 return writeTransaction(db,()=>{
  const known=command(db,projectId,taskId,requestId,"skill_plan",payload);
  if(known.existing)return {...known.existing,existing:true};
  // New freeze must resolve the pinned package; replay needs only the durable record.
  sources(db,skillRegistry,projectId,action);
  const task=getTask(db,projectId,taskId);
  if(task.read_only||task.cancel_requested_at!==null||inactive.has(task.status))
   throw fail("assistant_task_not_editable");
  if(task.active_plan_version!==expectedPlanVersion)throw fail("assistant_step_plan_conflict");
  if(task.active_step_id!==null)throw fail("assistant_step_already_claimed");
  if(task.revision!==expectedProjectRevision)throw fail("assistant_step_source_changed");
  if(db.prepare("SELECT 1 FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL AND status IN ('pending','ready','waiting_approval','submitting','running','waiting_external','needs_reconcile') LIMIT 1").get(taskId,expectedPlanVersion))
   throw fail("assistant_step_already_planned");
  const ordinal=db.prepare("SELECT COALESCE(MAX(ordinal)+1,0) AS n FROM assistant_task_steps WHERE task_id=? AND plan_version=?").get(taskId,expectedPlanVersion).n;
  for(const sourceId of dependsOn){
   const predecessor=db.prepare("SELECT plan_version,ordinal,status,receipt_trust,superseded_at FROM assistant_task_steps WHERE task_id=? AND id=?").get(taskId,sourceId);
   if(!predecessor||predecessor.plan_version!==expectedPlanVersion||
    predecessor.ordinal>=ordinal||predecessor.status!=="succeeded"||
    predecessor.receipt_trust!=="server_committed"||predecessor.superseded_at!==null)
    throw fail("assistant_step_dependency_unverified");
  }
  const stepId=randomUUID(),at=Date.now(),actionDigest=digest(action),
   preconditions={projectRevision:expectedProjectRevision,
    projectGraphDigest:digest(JSON.parse(task.document_json)),requiresApproval:true,finalizeTask};
  db.prepare("INSERT INTO assistant_task_steps(id,task_id,plan_version,ordinal,kind,status,required,depends_on_json,action_json,action_digest,preconditions_json,created_at,updated_at) VALUES(?,?,?,?,'skill_script','waiting_approval',1,?,?,?,?,?,?)")
   .run(stepId,taskId,expectedPlanVersion,ordinal,freeze(dependsOn),freeze(action),actionDigest,freeze(preconditions),at,at);
  db.prepare("UPDATE assistant_tasks SET status='waiting_approval',updated_at=? WHERE id=?")
   .run(at,taskId);
  event(db,taskId,stepId,"skill_step_frozen",{skillId:action.skill_id,version:action.version,actionDigest},at);
  const value={taskId,stepId,planVersion:expectedPlanVersion,actionDigest,
   status:"waiting_approval",executionStarted:false};
  command(db,projectId,taskId,requestId,"skill_plan",payload,value);
  return {...value,existing:false};
 });
}
/** Only one local script may be launched for a Task Step.
 * The durable run ID is committed before ANY external child process spawns.
 */
export function reserveAssistantSkillRun(db,{projectId,taskId,stepId,
 requestId,expectedPlanVersion,actionDigest,beforeCommit}){
 if(!id(requestId)||!id(stepId)||!Number.isSafeInteger(expectedPlanVersion)||
  !/^[a-f0-9]{64}$/.test(actionDigest))throw fail("assistant_skill_invalid",400);
 const payload={taskId,stepId,expectedPlanVersion,actionDigest};
 return writeTransaction(db,()=>{
  const known=command(db,projectId,taskId,requestId,"skill_run",payload);
  if(known.existing){
   const run=db.prepare("SELECT status FROM skill_script_runs WHERE id=? AND project_id=?")
    .get(known.existing.runId,projectId);
   return {...known.existing,status:run?.status??"needs_reconcile",
    existing:true,shouldLaunch:false};
  }
  const task=getTask(db,projectId,taskId),step=getStep(db,taskId,stepId);
  if(step.kind!=="skill_script")throw fail("assistant_step_kind_not_ready");
  if(step.plan_version!==expectedPlanVersion||task.active_plan_version!==expectedPlanVersion||
    step.superseded_at!==null)throw fail("assistant_step_plan_conflict");
  if(step.action_digest!==actionDigest)throw fail("assistant_step_action_changed");
  const previous=db.prepare("SELECT * FROM assistant_task_attempts WHERE step_id=? AND external_kind='skill_run' ORDER BY attempt_no DESC LIMIT 1").get(stepId);
  if(previous){
   const run=db.prepare("SELECT status FROM skill_script_runs WHERE id=? AND project_id=?").get(previous.external_id,projectId);
   if(!run)throw fail("assistant_skill_evidence_missing");
   const value={taskId,stepId,runId:previous.external_id,status:run.status,
    executionStarted:true};
   command(db,projectId,taskId,requestId,"skill_run",payload,value);
   return {...value,existing:true,shouldLaunch:false};
  }
  if(task.read_only||task.cancel_requested_at!==null||inactive.has(task.status))
   throw fail("assistant_task_not_editable");
  if(step.status!=="ready"||task.active_step_id!==null)throw fail("assistant_step_already_claimed");
  const action=JSON.parse(step.action_json),pre=JSON.parse(step.preconditions_json),
   approval=JSON.parse(step.approval_json);
  if(digest(action)!==step.action_digest)throw fail("assistant_step_action_changed");
  if(approval.decision!=="approved"||approval.actionDigest!==actionDigest||
   approval.planVersion!==expectedPlanVersion||approval.projectRevision!==pre.projectRevision)
   throw fail("assistant_step_approval_required");
  if(task.revision!==pre.projectRevision||
   digest(JSON.parse(task.document_json))!==pre.projectGraphDigest)
   throw fail("assistant_step_source_changed");
  const deps=JSON.parse(step.depends_on_json);
  for(const depId of deps){
   const dep=db.prepare("SELECT plan_version,status,receipt_trust,superseded_at FROM assistant_task_steps WHERE task_id=? AND id=?").get(taskId,depId);
   if(!dep||dep.plan_version!==expectedPlanVersion||dep.status!=="succeeded"||
    dep.receipt_trust!=="server_committed"||dep.superseded_at!==null)
    throw fail("assistant_step_dependency_unverified");
  }
  const attemptNo=step.attempt_count+1,attemptId=randomUUID(),runId=randomUUID(),
   executionKey=digest({taskId,stepId,planVersion:expectedPlanVersion,attemptNo}),
   requestFingerprint=digest({projectId,actionDigest,action}),at=Date.now();
  db.prepare("INSERT INTO skill_script_runs(id,project_id,skill_id,version,status,result_json,blob_refs_json,created_at,updated_at) VALUES(?,?,?,?,'started',?,'[]',?,?)")
   .run(runId,projectId,action.skill_id,action.version,
    freeze({run_id:runId,executionKey,taskId,stepId,status:"started"}),at,at);
  const snapshot={projectId,taskId,stepId,planVersion:expectedPlanVersion,
   attemptNo,actionDigest,executionKey,requestFingerprint,proposal:action};
  db.prepare("INSERT INTO assistant_task_attempts(id,task_id,step_id,attempt_no,project_id,execution_key,action_digest,request_fingerprint,frozen_snapshot_json,status,external_kind,external_id,submit_marker,submitted_at,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,'submitting','skill_run',?,'skill_spawn_possible',?,'{}',?)")
   .run(attemptId,taskId,stepId,attemptNo,projectId,executionKey,
    actionDigest,requestFingerprint,freeze(snapshot),runId,at,at);
  db.prepare("UPDATE assistant_task_steps SET status='submitting',attempt_count=?,result_json=?,updated_at=? WHERE id=? AND status='ready'")
   .run(attemptNo,freeze({runId,status:"started"}),at,stepId);
  db.prepare("UPDATE assistant_tasks SET active_step_id=?,status='running',updated_at=? WHERE id=?")
   .run(stepId,at,taskId);
  event(db,taskId,stepId,"skill_run_reserved",{runId,attemptId,executionKey,
   submissionMayHaveOccurred:true},at);
  if(beforeCommit)beforeCommit({runId,attemptId}); // test-only: rolls back reservation.
  const value={taskId,stepId,runId,status:"started",executionStarted:true};
  command(db,projectId,taskId,requestId,"skill_run",payload,value);
  return {...value,existing:false,shouldLaunch:true};
 });
}
/** Always writes Run evidence and Task outcome together. Cancel/plan changes
 * prevent downstream activation, but never erase a late script result.
 */
export function settleAssistantSkillRun(db,{projectId,taskId,stepId,runId,
 result,reason=null}){
 return writeTransaction(db,()=>{
  const task=getTask(db,projectId,taskId),step=getStep(db,taskId,stepId);
  const attempt=db.prepare("SELECT * FROM assistant_task_attempts WHERE step_id=? AND external_kind='skill_run' AND external_id=?").get(stepId,runId);
  if(!attempt)throw fail("assistant_skill_evidence_missing");
  const saved=db.prepare("SELECT * FROM skill_script_runs WHERE id=? AND project_id=?").get(runId,projectId);
  if(!saved)throw fail("assistant_skill_evidence_missing");
  if(saved.status!=="started")return {runId,status:saved.status,existing:true};
  const at=Date.now();
  const expected=JSON.parse(step.action_json).output_files??[];
  const artifacts=Array.isArray(result?.artifacts)?result.artifacts:[];
  const rawRefs=[...Object.values(result?.log_blobs??{}),...artifacts.map(x=>x.blob_id)];
  const validBlobs=rawRefs.every(ref=>typeof ref==="string"&&/^[a-f0-9]{64}$/.test(ref)&&
   db.prepare("SELECT 1 FROM blobs WHERE id=? AND status='ready'").get(ref));
  const validOutputs=expected.every(path=>artifacts.some(item=>item.path===path));
  const successful=!reason&&result?.status==="completed"&&result.exit_code===0&&
   validBlobs&&validOutputs;
  const status=successful?"completed":reason??(result?.status==="completed"?"failed":result?.status??"failed");
  const failure=reason??(result?.status==="completed"&&!successful?
   "assistant_skill_artifact_unverified":"assistant_skill_execution_failed");
  const record=result?{...result,run_id:runId}:{run_id:runId,status,error:reason};
  const refs=rawRefs.filter(x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x));
  // Result can contain text and artifact metadata; do not claim success without
  // persisting the canonical script-produced evidence.
  db.prepare("UPDATE skill_script_runs SET status=?,result_json=?,blob_refs_json=?,updated_at=? WHERE id=? AND status='started'")
   .run(status,freeze(record,64*1024),freeze(refs),at,runId);
  const outcome=successful?"succeeded":"failed";
  const receipt={runId,executionKey:attempt.execution_key,attemptId:attempt.id,
   skillId:saved.skill_id,version:saved.version,status,exitCode:result?.exit_code??null,
   blobIds:refs,completedAt:at};
  db.prepare("UPDATE assistant_task_attempts SET status=?,evidence_json=?,finished_at=? WHERE id=?")
   .run(outcome,freeze(receipt,16000),at,attempt.id);
  db.prepare("UPDATE assistant_task_steps SET status=?,receipt_json=?,receipt_trust=?,result_json=?,error_code=?,updated_at=? WHERE id=?")
   .run(outcome,freeze(receipt,16000),successful?"server_committed":"none",
    freeze({runId,status,exitCode:result?.exit_code??null,artifactCount:result?.artifacts?.length??0}),
    successful?null:failure,at,stepId);
  event(db,taskId,stepId,"skill_run_terminal",{runId,status,successful,receiptTrust:successful?"server_committed":"none"},at);
  const validPlan=step.plan_version===task.active_plan_version&&step.superseded_at===null;
  if(validPlan){
   if(task.cancel_requested_at!==null){
    db.prepare("UPDATE assistant_tasks SET status='cancelled',active_step_id=NULL,updated_at=?,finished_at=? WHERE id=?")
     .run(at,at,taskId);
   }else if(!successful){
    db.prepare("UPDATE assistant_tasks SET status='failed',active_step_id=NULL,updated_at=?,finished_at=? WHERE id=?")
     .run(at,at,taskId);
    blockUnreachableAssistantTaskStepsWithinTransaction(db,taskId,step.plan_version);
   }else{
    const all=db.prepare("SELECT status,receipt_trust,required FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL").all(taskId,step.plan_version);
    const done=JSON.parse(step.preconditions_json).finalizeTask===true&&
     all.every(s=>!s.required||s.status==="succeeded"&&s.receipt_trust==="server_committed");
    db.prepare("UPDATE assistant_tasks SET status=?,active_step_id=NULL,updated_at=?,finished_at=? WHERE id=?")
     .run(done?"completed":"ready",at,done?at:null,taskId);
    if(done)event(db,taskId,null,"task_completed",{planVersion:step.plan_version,source:"skill_run"},at);
   }
  }else if(task.active_step_id===stepId){
   // A stale-plan late result is audit only; release old active claim.
   db.prepare("UPDATE assistant_tasks SET active_step_id=NULL,updated_at=? WHERE id=? AND active_step_id=?")
    .run(at,taskId,stepId);
  }
  return {runId,status,success:successful,receipt,existing:false};
 });
}
/** Legacy Run has no reusable request key; Task-scoped runs always use
 * reserveAssistantSkillRun and never call /skills/execute directly.
 */
export async function executeAssistantSkillStep({
 db,skillRegistry,blobStore,projectId,taskId,stepId,requestId,
 expectedPlanVersion,actionDigest,signal,runner=runSkillScript,afterReserve
}){
 const previous=db.prepare("SELECT a.external_id FROM assistant_task_attempts a JOIN assistant_task_steps s ON s.id=a.step_id WHERE a.step_id=? AND s.task_id=? AND s.kind='skill_script' ORDER BY a.attempt_no DESC LIMIT 1")
  .get(stepId,taskId);
 if(previous)return reserveAssistantSkillRun(db,{projectId,taskId,stepId,
  requestId,expectedPlanVersion,actionDigest});
 const step=getStep(db,taskId,stepId);
 if(step.kind!=="skill_script")throw fail("assistant_step_kind_not_ready");
 const action=JSON.parse(step.action_json);
 let source;
 try{source=sources(db,skillRegistry,projectId,action)}
 catch(error){
  if(["skill_authorization_changed","skill_version_not_found",
   "skill_package_integrity_failed","skill_scan_required",
   "skill_script_not_authorized"].includes(error?.code)){
   writeTransaction(db,()=>{
    const current=getTask(db,projectId,taskId),fresh=getStep(db,taskId,stepId);
    if(fresh.status==="ready"&&fresh.plan_version===current.active_plan_version&&
      fresh.superseded_at===null&&!current.cancel_requested_at){
     const at=Date.now();
     db.prepare("UPDATE assistant_task_steps SET status='blocked',error_code=?,updated_at=? WHERE id=?")
      .run(error.code,at,stepId);
     db.prepare("UPDATE assistant_tasks SET status='blocked',updated_at=? WHERE id=?")
      .run(at,taskId);
     event(db,taskId,stepId,"skill_version_unavailable",
      {skillId:action.skill_id,version:action.version,reason:error.code},at);
    }
   });
  }
  throw error;
 }
 const reservation=reserveAssistantSkillRun(db,{projectId,taskId,stepId,requestId,
  expectedPlanVersion,actionDigest});
 if(!reservation.shouldLaunch)return reservation;
 if(afterReserve)afterReserve(reservation); // test-only: intentionally leaves unknown.
 try{
  const result=await runner({...source,args:action.args,inputFiles:action.input_files,
   outputFiles:action.output_files,...(action.runtime?{runtime:action.runtime}:{}),
   blobStore,signal});
  const completed=settleAssistantSkillRun(db,{projectId,taskId,stepId,
   runId:reservation.runId,result});
  return {...result,run_id:reservation.runId,taskStatus:completed.status};
 }catch(error){
  const code=typeof error?.code==="string"?error.code:"skill_script_failed";
  try{settleAssistantSkillRun(db,{projectId,taskId,stepId,runId:reservation.runId,
   reason:code});}catch{/* Persisted unknown state prohibits retry on startup. */}
  throw error;
 }
}
/** A restart cannot attest whether a started child process performed side
 * effects. Mark unknown and preserve its exact Run/Attempt identity.
 */
export function recoverAssistantSkillTasksAtStartup(db){
 return writeTransaction(db,()=>{
  const rows=db.prepare("SELECT a.*,s.plan_version,t.cancel_requested_at,t.active_plan_version,t.status AS task_status FROM assistant_task_attempts a JOIN assistant_task_steps s ON s.id=a.step_id JOIN assistant_tasks t ON t.id=a.task_id WHERE a.external_kind='skill_run' AND a.status='submitting'").all();
  let unknown=0;
  for(const attempt of rows){
   const run=db.prepare("SELECT status FROM skill_script_runs WHERE id=? AND project_id=?").get(attempt.external_id,attempt.project_id);
   const at=Date.now();
   if(run?.status==="started")db.prepare("UPDATE skill_script_runs SET status='needs_reconcile',updated_at=? WHERE id=?")
    .run(at,attempt.external_id);
   db.prepare("UPDATE assistant_task_attempts SET status='needs_reconcile',evidence_json=? WHERE id=?")
    .run(freeze({runId:attempt.external_id,reason:"process_restarted_no_verified_completion"}),attempt.id);
   db.prepare("UPDATE assistant_task_steps SET status='needs_reconcile',error_code='assistant_skill_outcome_unknown',updated_at=? WHERE id=?")
    .run(at,attempt.step_id);
   if(attempt.active_plan_version===attempt.plan_version){
    db.prepare("UPDATE assistant_tasks SET status=?,updated_at=? WHERE id=?")
     .run(attempt.cancel_requested_at!==null?"cancelling":"needs_reconcile",at,attempt.task_id);
   }
   event(db,attempt.task_id,attempt.step_id,"skill_run_needs_reconcile",{runId:attempt.external_id,
    reason:"process_restarted"},at);unknown++;
  }
  return {unknown};
 });
}
