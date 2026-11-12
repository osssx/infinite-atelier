import {createHash,randomUUID} from "node:crypto";
import {assertNoRawCredentials,stableJson,writeTransaction} from "./repository.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const id=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const alias=x=>typeof x==="string"&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(x);
const digest=x=>createHash("sha256").update(stableJson(x)).digest("hex");
const encode=x=>{
 assertNoRawCredentials(x);
 const out=stableJson(x);
 if(Buffer.byteLength(out)>32*1024)throw fail("assistant_task_payload_too_large",413);
 return out;
};
const stamp=()=>Date.now();
function get(db,projectId,taskId,stepId){
 if(!id(projectId)||!id(taskId)||!id(stepId))throw fail("assistant_step_invalid",400);
 const task=db.prepare("SELECT t.*,p.document_json,p.revision FROM assistant_tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL WHERE t.id=? AND t.project_id=?")
  .get(taskId,projectId);
 if(!task)throw fail("assistant_task_not_found",404);
 const step=db.prepare("SELECT * FROM assistant_task_steps WHERE id=? AND task_id=?")
  .get(stepId,taskId);
 if(!step)throw fail("assistant_step_not_found",404);
 return {task,step};
}
function validActive(task,step,expectedPlanVersion){
 if(!Number.isSafeInteger(expectedPlanVersion)||expectedPlanVersion<1)throw fail("assistant_step_invalid",400);
 if(task.read_only||task.cancel_requested_at!==null||
  !["planning","ready","waiting_approval","running"].includes(task.status))
  throw fail("assistant_task_not_editable");
 if(task.active_plan_version!==expectedPlanVersion||step.plan_version!==expectedPlanVersion||
  step.superseded_at!==null)throw fail("assistant_step_plan_conflict");
}
function log(db,taskId,stepId,kind,payload){
 db.prepare("INSERT INTO assistant_task_events(task_id,step_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)")
  .run(taskId,stepId,kind,encode(payload),stamp());
}
function assertFrozenAction(step){
 const action=JSON.parse(step.action_json);
 if(step.action_digest!==digest(action))throw fail("assistant_step_action_changed");
 return action;
}
function checkDependencies(db,taskId,step,{completed=false}={}){
 const deps=JSON.parse(step.depends_on_json);
 if(!Array.isArray(deps)||deps.some(dep=>!id(dep)))throw fail("assistant_step_invalid",400);
 for(const dep of new Set(deps)){
  const source=db.prepare("SELECT plan_version,ordinal,status,receipt_trust,superseded_at FROM assistant_task_steps WHERE id=? AND task_id=?")
   .get(dep,taskId);
  if(!source||source.plan_version!==step.plan_version||source.ordinal>=step.ordinal||source.superseded_at!==null)
   throw fail("assistant_step_dependency_invalid");
  if(completed&&(source.status!=="succeeded"||source.receipt_trust!=="server_committed"))
   throw fail("assistant_step_dependency_unverified");
 }
}
function aliases(values){
 if(!Array.isArray(values)||values.length>32||values.some(value=>!alias(value))||
  new Set(values).size!==values.length)throw fail("assistant_step_invalid",400);
 return values;
}
/** Stable aliases for every generated node/edge are frozen before approval.
 * They are not inserted into the graph until a future P1b transaction.
 */
export function deterministicAssistantRefs({taskId,stepId,newNodes=[],newConnections=[]}){
 if(!id(taskId)||!id(stepId))throw fail("assistant_step_invalid",400);
 const nodes=aliases(newNodes),connections=aliases(newConnections);
 const make=(kind,name)=>"task-"+kind+"-"+digest({taskId,stepId,kind,name}).slice(0,32);
 return {nodes:Object.fromEntries(nodes.map(name=>[name,make("node",name)])),
  connections:Object.fromEntries(connections.map(name=>[name,make("edge",name)]))};
}
/** Internal planner-only preparation: captures graph version, aliases and
 * authorisation requirement. No graph edits or external execution happen.
 */
export function prepareAssistantTaskStep(db,{projectId,taskId,stepId,expectedPlanVersion,
 expectedProjectRevision,newNodes=[],newConnections=[],requiresApproval=true}){
 if(!Number.isSafeInteger(expectedProjectRevision)||expectedProjectRevision<1||
  typeof requiresApproval!=="boolean")throw fail("assistant_step_invalid",400);
 return writeTransaction(db,()=>{
  const {task,step}=get(db,projectId,taskId,stepId);
  validActive(task,step,expectedPlanVersion);
  if(task.revision!==expectedProjectRevision)throw fail("assistant_step_source_changed");
  if(step.status!=="pending")throw fail("assistant_step_not_preparable");
  assertFrozenAction(step);
  checkDependencies(db,taskId,step);
  if(step.kind!=="clarification"&&!requiresApproval)throw fail("assistant_step_approval_required");
  const refs=deterministicAssistantRefs({taskId,stepId,newNodes,newConnections});
  const document=JSON.parse(task.document_json);
  const existingNodes=new Set(document.nodes.map(node=>node.id));
  const existingEdges=new Set(document.connections.map(edge=>edge.id));
  if(Object.values(refs.nodes).some(value=>existingNodes.has(value))||
   Object.values(refs.connections).some(value=>existingEdges.has(value)))
   throw fail("assistant_step_ref_conflict");
  const frozen={projectRevision:expectedProjectRevision,refs,
   projectGraphDigest:digest(document),requiresApproval};
  const updated=db.prepare("UPDATE assistant_task_steps SET preconditions_json=?,status=?,updated_at=? WHERE id=? AND task_id=? AND status='pending' AND plan_version=?")
   .run(encode(frozen),requiresApproval?"waiting_approval":"ready",stamp(),stepId,taskId,expectedPlanVersion);
  if(updated.changes!==1)throw fail("assistant_step_state_conflict");
  log(db,taskId,stepId,"step_frozen",{planVersion:expectedPlanVersion,actionDigest:step.action_digest,
   refs,projectRevision:expectedProjectRevision,requiresApproval});
  return {stepId,planVersion:expectedPlanVersion,actionDigest:step.action_digest,preconditions:frozen,
   status:requiresApproval?"waiting_approval":"ready",executionStarted:false};
 });
}
/** Public user decision: requestId is replay-safe and the server checks the
 * persisted frozen action, plan, graph fence and decision on every fresh vote.
 */
export function decideAssistantTaskStep(db,{projectId,taskId,stepId,requestId,
 expectedPlanVersion,actionDigest,decision}){
 if(!id(requestId)||!["approve","reject"].includes(decision)||
  typeof actionDigest!=="string"||!/^[a-f0-9]{64}$/.test(actionDigest))
  throw fail("assistant_step_invalid",400);
 const signature=digest({kind:"step_decision",taskId,stepId,expectedPlanVersion,actionDigest,decision});
 return writeTransaction(db,()=>{
  const known=db.prepare("SELECT command_kind,payload_digest,status,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?")
   .get(projectId,requestId);
  if(known){
   if(known.command_kind!=="step_decision"||known.payload_digest!==signature)
    throw fail("assistant_task_command_conflict");
   if(known.status!=="completed")throw fail("assistant_step_state_conflict");
   return {...JSON.parse(known.response_json),existing:true};
  }
  const {task,step}=get(db,projectId,taskId,stepId);
  validActive(task,step,expectedPlanVersion);
  if(step.action_digest!==actionDigest)throw fail("assistant_step_action_changed");
  assertFrozenAction(step);
  const frozen=JSON.parse(step.preconditions_json),approval=JSON.parse(step.approval_json);
  if(!Number.isSafeInteger(frozen.projectRevision)||frozen.projectRevision!==task.revision||
   frozen.projectGraphDigest!==digest(JSON.parse(task.document_json)))
   throw fail("assistant_step_source_changed");
  let response;
  if(approval.decision){
   if(approval.decision!==(decision==="approve"?"approved":"rejected")||
    approval.planVersion!==expectedPlanVersion||approval.actionDigest!==actionDigest)
    throw fail("assistant_step_approval_conflict");
   response={stepId,decision:approval.decision,planVersion:expectedPlanVersion,
    actionDigest,approvedAt:approval.decidedAt,status:step.status,executionStarted:false};
  }else{
   if(step.status!=="waiting_approval")throw fail("assistant_step_not_approvable");
   const decidedAt=stamp(),choice=decision==="approve"?"approved":"rejected";
   const record={decision:choice,planVersion:expectedPlanVersion,
    actionDigest,projectRevision:frozen.projectRevision,decidedAt};
   const next=decision==="approve"?"ready":"blocked";
   const updated=db.prepare("UPDATE assistant_task_steps SET approval_json=?,status=?,updated_at=? WHERE id=? AND task_id=? AND status='waiting_approval' AND plan_version=?")
    .run(encode(record),next,decidedAt,stepId,taskId,expectedPlanVersion);
   if(updated.changes!==1)throw fail("assistant_step_state_conflict");
   log(db,taskId,stepId,decision==="approve"?"step_approved":"step_rejected",
    {planVersion:expectedPlanVersion,actionDigest,decision:choice});
   response={stepId,decision:choice,planVersion:expectedPlanVersion,actionDigest,
    approvedAt:decidedAt,status:next,executionStarted:false};
  }
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,'step_decision',?,'completed',?,?)")
   .run(projectId,requestId,taskId,signature,encode(response),stamp());
  return {...response,existing:false};
 });
}
/** Internal-only reservation boundary. Claims never execute, submit, or
 * mark success. P1b must re-check this lease before any side effect.
 * Only canvas steps are claimable in P1a: Skill and Job require P2 grants.
 */
export function claimAssistantTaskStep(db,{projectId,taskId,stepId,expectedPlanVersion,leaseMs=30000}){
 if(!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>120000)
  throw fail("assistant_step_invalid",400);
 return writeTransaction(db,()=>{
  const {task,step}=get(db,projectId,taskId,stepId);
  validActive(task,step,expectedPlanVersion);
  if(step.kind!=="canvas_mutation")throw fail("assistant_step_kind_not_ready");
  if(task.active_step_id!==null)throw fail("assistant_step_already_claimed");
  if(step.status!=="ready"||step.lease_owner!==null)throw fail("assistant_step_already_claimed");
  const action=assertFrozenAction(step),pre=JSON.parse(step.preconditions_json),
   approval=JSON.parse(step.approval_json);
  if(!Number.isSafeInteger(pre.projectRevision)||task.revision!==pre.projectRevision||
   pre.projectGraphDigest!==digest(JSON.parse(task.document_json)))
   throw fail("assistant_step_source_changed");
  if(!pre.requiresApproval||approval.decision!=="approved"||
   approval.actionDigest!==step.action_digest||approval.planVersion!==expectedPlanVersion||
   approval.projectRevision!==pre.projectRevision)
   throw fail("assistant_step_approval_required");
  checkDependencies(db,taskId,step,{completed:true});
  const attemptNo=step.attempt_count+1,owner=randomUUID(),at=stamp();
  const executionKey=digest({taskId,stepId,planVersion:expectedPlanVersion,attemptNo});
  const frozen={projectId,taskId,stepId,planVersion:expectedPlanVersion,attemptNo,
   action,preconditions:pre,actionDigest:step.action_digest};
  const requestFingerprint=digest(frozen),attemptId=randomUUID();
  const updated=db.prepare("UPDATE assistant_task_steps SET status='running',lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND task_id=? AND plan_version=? AND status='ready' AND lease_owner IS NULL AND superseded_at IS NULL")
   .run(owner,at+leaseMs,at,stepId,taskId,expectedPlanVersion);
  if(updated.changes!==1)throw fail("assistant_step_already_claimed");
  db.prepare("INSERT INTO assistant_task_attempts(id,task_id,step_id,attempt_no,project_id,execution_key,action_digest,request_fingerprint,frozen_snapshot_json,status,lease_owner,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,'prepared',?,'{}',?)")
   .run(attemptId,taskId,stepId,attemptNo,projectId,executionKey,step.action_digest,
    requestFingerprint,encode(frozen),owner,at);
  db.prepare("UPDATE assistant_tasks SET active_step_id=?,updated_at=? WHERE id=?")
   .run(stepId,at,taskId);
  log(db,taskId,stepId,"step_claim_prepared",{attemptId,attemptNo,executionKey,
   requestFingerprint,planVersion:expectedPlanVersion,executionStarted:false});
  return {taskId,stepId,attemptId,attemptNo,planVersion:expectedPlanVersion,
   leaseOwner:owner,leaseExpiresAt:at+leaseMs,executionKey,requestFingerprint,
   frozenSnapshot:frozen,executionStarted:false};
 });
}
/** Strict ownership check intended for subsequent P1b commit barrier. */
export function verifyAssistantTaskClaim(db,{projectId,taskId,stepId,attemptId,leaseOwner,planVersion}){
 if(!id(attemptId)||!id(leaseOwner))throw fail("assistant_step_invalid",400);
 const {task,step}=get(db,projectId,taskId,stepId);
 validActive(task,step,planVersion);
 const attempt=db.prepare("SELECT * FROM assistant_task_attempts WHERE id=? AND project_id=? AND task_id=? AND step_id=?")
  .get(attemptId,projectId,taskId,stepId);
 if(!attempt||attempt.lease_owner!==leaseOwner||step.lease_owner!==leaseOwner||
  step.lease_expires_at<=stamp()||step.status!=="running"||
  attempt.status!=="prepared"||attempt.submitted_at!==null||attempt.submit_marker!==null)
  throw fail("assistant_step_lease_invalid");
 const frozen=JSON.parse(attempt.frozen_snapshot_json);
 if(frozen.planVersion!==planVersion||frozen.actionDigest!==step.action_digest)
  throw fail("assistant_step_action_changed");
 assertFrozenAction(step);
 if(task.revision!==frozen.preconditions?.projectRevision||
  frozen.preconditions.projectGraphDigest!==digest(JSON.parse(task.document_json)))
  throw fail("assistant_step_source_changed");
 const approval=JSON.parse(step.approval_json);
 if(approval.decision!=="approved"||approval.actionDigest!==step.action_digest||
  approval.planVersion!==planVersion)throw fail("assistant_step_approval_required");
 return {attemptId,executionKey:attempt.execution_key,requestFingerprint:attempt.request_fingerprint,
  frozenSnapshot:frozen,executionStarted:false};
}
/** Releasing a genuinely unsubmitted reservation needs the exact live lease. */
export function releaseUnsubmittedAssistantTaskClaim(db,{projectId,taskId,stepId,attemptId,leaseOwner,planVersion}){
 return writeTransaction(db,()=>{
  verifyAssistantTaskClaim(db,{projectId,taskId,stepId,attemptId,leaseOwner,planVersion});
  db.prepare("UPDATE assistant_task_attempts SET status='released_pre_submit',finished_at=? WHERE id=? AND status='prepared' AND submit_marker IS NULL")
   .run(stamp(),attemptId);
  db.prepare("UPDATE assistant_task_steps SET status='ready',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=? AND status='running'")
   .run(stamp(),stepId,leaseOwner);
  db.prepare("UPDATE assistant_tasks SET active_step_id=NULL,updated_at=? WHERE id=? AND active_step_id=?")
   .run(stamp(),taskId,stepId);
  log(db,taskId,stepId,"step_unsubmitted_release",{attemptId,planVersion});
  return {released:true,executionStarted:false};
 });
}
/** Old plan approvals are invalid by construction; claimed attempts stay as
 * historical evidence, but can never advance the new version.
 */
export function reviseAssistantTaskPlan(db,{projectId,taskId,expectedPlanVersion}){
 return writeTransaction(db,()=>{
  if(!id(projectId)||!id(taskId))throw fail("assistant_step_invalid",400);
  const task=db.prepare("SELECT t.* FROM assistant_tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL WHERE t.id=? AND t.project_id=?")
   .get(taskId,projectId);
  if(!task)throw fail("assistant_task_not_found",404);
  if(task.read_only||task.cancel_requested_at!==null)throw fail("assistant_task_not_editable");
  if(task.active_plan_version!==expectedPlanVersion)throw fail("assistant_step_plan_conflict");
  const at=stamp();
  let clearActive=false;
  if(task.active_step_id){
   const old=db.prepare("SELECT id,lease_owner,status FROM assistant_task_steps WHERE id=? AND task_id=?")
    .get(task.active_step_id,taskId);
   const attempt=old&&db.prepare("SELECT id FROM assistant_task_attempts WHERE step_id=? AND lease_owner=? AND status='prepared' AND submitted_at IS NULL AND submit_marker IS NULL ORDER BY attempt_no DESC LIMIT 1")
    .get(old.id,old.lease_owner);
   // A prepared reservation has not crossed the submit barrier; it can be
   // invalidated atomically. A submitted or unknown attempt retains its block.
   if(old?.status==="running"&&attempt){
    db.prepare("UPDATE assistant_task_attempts SET status='superseded_pre_submit',finished_at=? WHERE id=? AND status='prepared'")
     .run(at,attempt.id);
    db.prepare("UPDATE assistant_task_steps SET status='blocked',superseded_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running'")
     .run(at,at,old.id);
    log(db,taskId,old.id,"step_superseded_pre_submit",{attemptId:attempt.id,
     fromPlanVersion:expectedPlanVersion,executionStarted:false});
    clearActive=true;
   }
  }
  db.prepare("UPDATE assistant_task_steps SET superseded_at=?,updated_at=? WHERE task_id=? AND plan_version=? AND status IN ('pending','waiting_approval','ready')")
   .run(at,at,taskId,expectedPlanVersion);
  db.prepare("UPDATE assistant_tasks SET active_plan_version=active_plan_version+1,status='planning',active_step_id=CASE WHEN ? THEN NULL ELSE active_step_id END,updated_at=? WHERE id=? AND active_plan_version=?")
   .run(clearActive?1:0,at,taskId,expectedPlanVersion);
  log(db,taskId,null,"plan_revised",{from:expectedPlanVersion,to:expectedPlanVersion+1});
  return {taskId,activePlanVersion:expectedPlanVersion+1,executionStarted:false};
 });
}
