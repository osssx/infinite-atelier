import {createHash,randomUUID} from "node:crypto";
import {stableJson,writeTransaction,assertNoRawCredentials} from "./repository.mjs";
import {validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {deterministicAssistantRefs,claimAssistantTaskStep,verifyAssistantTaskClaim} from "./assistant-task-step-gate.mjs";
import {assertAssistantCanvasPlan,applyFrozenAssistantCanvasPlan} from "./assistant-task-canvas-graph.mjs";
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const id=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const json=(value,max=64000)=>{
 assertNoRawCredentials(value);
 const valueJson=stableJson(value);
 if(Buffer.byteLength(valueJson)>max)throw fail("assistant_task_payload_too_large",413);
 return valueJson;
};
const event=(db,taskId,stepId,kind,data,at=Date.now())=>db.prepare(
 "INSERT INTO assistant_task_events(task_id,step_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)")
 .run(taskId,stepId,kind,json(data,8000),at);
function taskAndProject(db,projectId,taskId){
 if(!id(projectId)||!id(taskId))throw fail("assistant_step_invalid",400);
 const row=db.prepare("SELECT t.*,p.revision,p.document_json FROM assistant_tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL WHERE p.id=? AND t.id=?")
  .get(projectId,taskId);
 if(!row)throw fail("assistant_task_not_found",404);
 return row;
}
const projectView=(db,projectId)=>{
 const row=db.prepare("SELECT id,revision,document_json FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId);
 if(!row)throw fail("project_not_found",404);
 return {id:row.id,revision:row.revision,document:JSON.parse(row.document_json)};
};
const signature=(kind,payload)=>hash({kind,payload});
function oldCommand(db,projectId,requestId,kind,digest){
 const row=db.prepare("SELECT command_kind,payload_digest,status,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?")
  .get(projectId,requestId);
 if(!row)return null;
 if(row.command_kind!==kind||row.payload_digest!==digest)throw fail("assistant_task_command_conflict");
 if(row.status!=="completed")throw fail("assistant_step_state_conflict");
 return JSON.parse(row.response_json);
}
function commandResult(db,{projectId,requestId,taskId,kind,digest:commandDigest,response}){
 db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,?,?,'completed',?,?)")
  .run(projectId,requestId,taskId,kind,commandDigest,json(response),Date.now());
}
/** Only a directly depended-on, server-committed Step can provide an alias.
 * References use "stepId:alias" and never parse untrusted historical model text.
 */
function dependencies(db,taskId,step){
 const dependencyIds=JSON.parse(step.depends_on_json),resolved={};
 if(!Array.isArray(dependencyIds))throw fail("assistant_step_dependency_invalid");
 for(const depId of dependencyIds){
  const dep=db.prepare("SELECT * FROM assistant_task_steps WHERE id=? AND task_id=?").get(depId,taskId);
  if(!dep||dep.plan_version!==step.plan_version||dep.ordinal>=step.ordinal||
   dep.status!=="succeeded"||dep.receipt_trust!=="server_committed"||dep.superseded_at!==null)
   throw fail("assistant_step_dependency_unverified");
  const receipt=JSON.parse(dep.receipt_json);
  for(const [name,nodeId] of Object.entries(receipt.refs?.nodes??{}))
   resolved[depId+":"+name]=nodeId;
  for(const [name,edgeId] of Object.entries(receipt.refs?.connections??{}))
   resolved[depId+":"+name]=edgeId;
 }
 return resolved;
}
/** One durable, approved-intent candidate. Preview is performed on a clone
 * against an exact graph revision before any Step/command is inserted.
 */
export function planAssistantCanvasStep(db,{projectId,taskId,requestId,
 expectedPlanVersion,expectedProjectRevision,actions,center,dependsOn=[],finalizeTask=false}){
 if(!id(requestId)||!Number.isSafeInteger(expectedPlanVersion)||expectedPlanVersion<1||
  !Number.isSafeInteger(expectedProjectRevision)||expectedProjectRevision<1||
  !Array.isArray(dependsOn)||dependsOn.some(value=>!id(value))||
  new Set(dependsOn).size!==dependsOn.length||dependsOn.length>20||
  typeof finalizeTask!=="boolean")throw fail("assistant_step_invalid",400);
 const shape=assertAssistantCanvasPlan({actions,center});
 const payload={taskId,expectedPlanVersion,expectedProjectRevision,actions,center,dependsOn,finalizeTask};
 const sig=signature("canvas_plan",payload);
 return writeTransaction(db,()=>{
  const existing=oldCommand(db,projectId,requestId,"canvas_plan",sig);
  if(existing)return {...existing,existing:true};
  const task=taskAndProject(db,projectId,taskId);
  if(task.read_only||task.cancel_requested_at!==null||
   ["completed","cancelled","blocked","failed","needs_reconcile","cancelling"].includes(task.status))
   throw fail("assistant_task_not_editable");
  if(task.active_step_id!==null)throw fail("assistant_step_already_claimed");
  if(db.prepare("SELECT 1 FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL AND status IN ('pending','ready','waiting_approval','running','submitting','needs_reconcile') LIMIT 1").get(taskId,expectedPlanVersion))
   throw fail("assistant_step_already_planned");
  if(task.active_plan_version!==expectedPlanVersion)throw fail("assistant_step_plan_conflict");
  if(task.revision!==expectedProjectRevision)throw fail("assistant_step_source_changed");
  const stepId=randomUUID(),action={actions,center},
   actionDigest=hash(action);
  const ordinal=db.prepare("SELECT COALESCE(MAX(ordinal)+1,0) AS ordinal FROM assistant_task_steps WHERE task_id=? AND plan_version=?")
   .get(taskId,expectedPlanVersion).ordinal;
  const refs=deterministicAssistantRefs({taskId,stepId,...shape});
  const skeleton={plan_version:expectedPlanVersion,ordinal,
   depends_on_json:json(dependsOn)};
  const externalRefs=dependencies(db,taskId,skeleton);
  const original=JSON.parse(task.document_json);
  const preview=applyFrozenAssistantCanvasPlan(original,action,refs,{externalRefs});
  validateProjectDocument(preview.document);
  const preconditions={projectRevision:expectedProjectRevision,projectGraphDigest:hash(original),
   refs,requiresApproval:true,finalizeTask};
  const at=Date.now();
  db.prepare("INSERT INTO assistant_task_steps(id,task_id,plan_version,ordinal,kind,status,required,depends_on_json,action_json,action_digest,preconditions_json,approval_json,receipt_json,receipt_trust,result_json,created_at,updated_at) VALUES(?,?,?,?,'canvas_mutation','waiting_approval',1,?,?,?,?,'{}','{}','none','{}',?,?)")
   .run(stepId,taskId,expectedPlanVersion,ordinal,json(dependsOn),json(action,12000),
    actionDigest,json(preconditions),at,at);
  db.prepare("UPDATE assistant_tasks SET status='waiting_approval',updated_at=? WHERE id=?")
   .run(at,taskId);
  event(db,taskId,stepId,"step_frozen",{actionDigest,planVersion:expectedPlanVersion,
   projectRevision:expectedProjectRevision,refs,operationCount:actions.length},at);
  const response={stepId,taskId,planVersion:expectedPlanVersion,actionDigest,
   preconditions:{projectRevision:expectedProjectRevision,refs},status:"waiting_approval",
   operationCount:actions.length,executionStarted:false};
  commandResult(db,{projectId,requestId,taskId,kind:"canvas_plan",digest:sig,response});
  return {...response,existing:false};
 });
}
function committedStep(db,{projectId,taskId,stepId}){
 const step=db.prepare("SELECT * FROM assistant_task_steps WHERE id=? AND task_id=?").get(stepId,taskId);
 if(!step)throw fail("assistant_step_not_found",404);
 if(step.status!=="succeeded"||step.receipt_trust!=="server_committed")return null;
 return {receipt:JSON.parse(step.receipt_json),project:projectView(db,projectId),
  status:"succeeded",existing:true,executionStarted:false};
}
/** All local graph edits and receipts are one SQLite transaction. Crash after
 * COMMIT returns an already committed receipt; crash before COMMIT leaves no
 * graph change and can safely release a prepared claim on startup.
 */
export function commitAssistantCanvasAttempt(db,{projectId,taskId,stepId,
 attemptId,leaseOwner,planVersion,actionDigest,beforeReceipt}){
 return writeTransaction(db,()=>{
  const committed=committedStep(db,{projectId,taskId,stepId});
  if(committed)return committed;
  const active=verifyAssistantTaskClaim(db,{projectId,taskId,stepId,
   attemptId,leaseOwner,planVersion});
  const {frozenSnapshot}=active;
  if(frozenSnapshot.actionDigest!==actionDigest)throw fail("assistant_step_action_changed");
  const task=taskAndProject(db,projectId,taskId);
  const step=db.prepare("SELECT * FROM assistant_task_steps WHERE id=? AND task_id=?").get(stepId,taskId);
  const action=JSON.parse(step.action_json),pre=JSON.parse(step.preconditions_json);
  if(hash(action)!==step.action_digest||hash(action)!==actionDigest||
   hash(frozenSnapshot)!==active.requestFingerprint)
   throw fail("assistant_step_action_changed");
  if(task.revision!==pre.projectRevision||hash(JSON.parse(task.document_json))!==pre.projectGraphDigest)
   throw fail("assistant_step_source_changed");
  const externalRefs=dependencies(db,taskId,step);
  const applied=applyFrozenAssistantCanvasPlan(JSON.parse(task.document_json),action,pre.refs,{externalRefs});
  const content=validateProjectDocument(applied.document),at=Date.now(),revision=task.revision+1;
  // No async/external side effects may occur inside this BEGIN IMMEDIATE block.
  const updated=db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=? AND revision=? AND deleted_at IS NULL")
   .run(content,revision,projectId,task.revision);
  if(updated.changes!==1)throw fail("assistant_step_source_changed");
  emitProjectEvent(db,{id:projectId,revision,kind:"updated"});
  // Fault-injection only; a throw proves even a committed project UPDATE rolls back.
  if(beforeReceipt)beforeReceipt();
  const receipt={attemptId,executionKey:active.executionKey,planVersion,actionDigest,
   projectRevision:revision,projectGraphDigest:hash(applied.document),
   refs:pre.refs,applied:applied.applied,committedAt:at};
  const finalized=db.prepare("UPDATE assistant_task_steps SET status='succeeded',receipt_json=?,receipt_trust='server_committed',result_json=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND plan_version=?")
   .run(json(receipt),json({applied:applied.applied,refs:pre.refs}),at,stepId,leaseOwner,planVersion);
  if(finalized.changes!==1)throw fail("assistant_step_lease_invalid");
  const attemptUpdated=db.prepare("UPDATE assistant_task_attempts SET status='succeeded',evidence_json=?,finished_at=? WHERE id=? AND status='prepared' AND lease_owner=?")
   .run(json({receiptDigest:hash(receipt),projectRevision:revision}),at,attemptId,leaseOwner);
  if(attemptUpdated.changes!==1)throw fail("assistant_step_lease_invalid");
  const remain=db.prepare("SELECT status,receipt_trust,required FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL")
   .all(taskId,planVersion);
  const done=pre.finalizeTask===true&&remain.length>0&&remain.every(row=>
   !row.required||row.status==="succeeded"&&row.receipt_trust==="server_committed");
  db.prepare("UPDATE assistant_tasks SET status=?,active_step_id=NULL,updated_at=?,finished_at=? WHERE id=? AND active_plan_version=? AND active_step_id=?")
   .run(done?"completed":"ready",at,done?at:null,taskId,planVersion,stepId);
  event(db,taskId,stepId,"step_graph_committed",{attemptId,projectRevision:revision,
   actionDigest,receiptTrust:"server_committed",refs:pre.refs,applied:applied.applied},at);
  if(done)event(db,taskId,null,"task_completed",{planVersion,receiptTrust:"server_committed"},at);
  return {receipt,project:{id:projectId,revision,document:applied.document},
   status:"succeeded",existing:false,executionStarted:true};
 });
}
export function executeAssistantCanvasStep(db,{projectId,taskId,stepId,
 requestId,expectedPlanVersion,actionDigest,afterClaim,beforeReceipt}){
 if(!id(requestId)||!id(stepId)||!Number.isSafeInteger(expectedPlanVersion)||
  !/^[a-f0-9]{64}$/.test(actionDigest))throw fail("assistant_step_invalid",400);
 const payload={taskId,stepId,expectedPlanVersion,actionDigest},sig=signature("canvas_execute",payload);
 // First inspect committed work before trying to acquire a new lease.
 const inspect=writeTransaction(db,()=>{
  const old=oldCommand(db,projectId,requestId,"canvas_execute",sig);
  if(old)return {old};
  const task=taskAndProject(db,projectId,taskId);
  const step=db.prepare("SELECT * FROM assistant_task_steps WHERE id=? AND task_id=?").get(stepId,taskId);
  if(!step)throw fail("assistant_step_not_found",404);
  if(step.action_digest!==actionDigest||step.plan_version!==expectedPlanVersion)
   throw fail("assistant_step_action_changed");
  const committed=committedStep(db,{projectId,taskId,stepId});
  return {committed};
 });
 if(inspect.old)return {...committedStep(db,{projectId,taskId,stepId})??inspect.old,existing:true};
 if(inspect.committed)return inspect.committed;
 const claim=claimAssistantTaskStep(db,{projectId,taskId,stepId,expectedPlanVersion});
 if(afterClaim)afterClaim(claim); // test-only; must never be exposed by HTTP
 const result=commitAssistantCanvasAttempt(db,{projectId,taskId,stepId,
  attemptId:claim.attemptId,leaseOwner:claim.leaseOwner,
  planVersion:expectedPlanVersion,actionDigest,beforeReceipt});
 // Ledger completion is read-only; Step itself is the authoritative idempotency key.
 writeTransaction(db,()=>{
  const old=oldCommand(db,projectId,requestId,"canvas_execute",sig);
  if(!old)commandResult(db,{projectId,requestId,taskId,kind:"canvas_execute",digest:sig,
   response:{stepId,receipt:result.receipt}});
 });
 return result;
}
/** Startup recovery is invoked under the existing exclusive instance lock.
 * Prepared, unsubmitted local canvas attempts are safe to release; submitted
 * or unknown external attempts must be held for P2 reconciliation.
 */
export function recoverAssistantCanvasTasksAtStartup(db){
 return writeTransaction(db,()=>{
  let released=0,unknown=0;
  const rows=db.prepare("SELECT s.*,t.project_id,t.active_plan_version,t.cancel_requested_at,t.read_only,t.status AS task_status FROM assistant_task_steps s JOIN assistant_tasks t ON t.id=s.task_id WHERE s.status IN ('running','submitting')").all();
  for(const step of rows){
   const attempt=db.prepare("SELECT * FROM assistant_task_attempts WHERE step_id=? ORDER BY attempt_no DESC LIMIT 1").get(step.id);
   if(!attempt)continue;
   const at=Date.now(),submitted=attempt.submit_marker!==null||
    attempt.submitted_at!==null||attempt.status!=="prepared"||step.status==="submitting";
   if(submitted){
    db.prepare("UPDATE assistant_task_steps SET status='needs_reconcile',error_code='assistant_step_execution_unknown',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?")
     .run(at,step.id);
    db.prepare("UPDATE assistant_task_attempts SET status='needs_reconcile',finished_at=? WHERE id=?")
     .run(at,attempt.id);
    db.prepare("UPDATE assistant_tasks SET status=?,active_step_id=NULL,updated_at=? WHERE id=?")
     .run(step.cancel_requested_at!==null?"cancelling":"needs_reconcile",at,step.task_id);
    event(db,step.task_id,step.id,"step_needs_reconcile",{attemptId:attempt.id,reason:"startup_unknown"},at);
    unknown++;continue;
   }
   // A prepared local graph claim cannot have committed any graph update:
   // graph+receipt share the same transaction. Release without re-running.
   const current=db.prepare("SELECT revision,document_json,deleted_at FROM projects WHERE id=?").get(step.project_id);
   const pre=JSON.parse(step.preconditions_json);
   const valid=step.kind==="canvas_mutation"&&step.plan_version===step.active_plan_version&&
    !step.cancel_requested_at&&!step.read_only&&current&&current.deleted_at===null&&
    current.revision===pre.projectRevision&&hash(JSON.parse(current.document_json))===pre.projectGraphDigest;
   db.prepare("UPDATE assistant_task_attempts SET status='released_pre_submit',finished_at=? WHERE id=?")
    .run(at,attempt.id);
   db.prepare("UPDATE assistant_task_steps SET status=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?,error_code=? WHERE id=?")
    .run(valid?"ready":"blocked",at,valid?null:"assistant_step_source_changed",step.id);
   db.prepare("UPDATE assistant_tasks SET active_step_id=NULL,status=?,updated_at=? WHERE id=? AND active_step_id=?")
    .run(valid?"ready":"blocked",at,step.task_id,step.id);
   event(db,step.task_id,step.id,valid?"step_recovered_ready":"step_recovered_blocked",
    {attemptId:attempt.id,executionStarted:false},at);
   released++;
  }
  return {released,unknown};
 });
}
