import {hydrateCreativeDocument} from "./creative-payloads.mjs";
/** P4.4c: durable bounded permission for frozen run_node jobs only.
 * This is a cap on new Job submissions, NOT a monetary price guarantee.
 * A grant never builds provider payloads or executes unknown work.
 */
import {createHash,randomUUID} from "node:crypto";
import {stableJson,writeTransaction,fingerprintSource} from "./repository.mjs";
import {assertAssistantBudgetRunEvidence} from "./assistant-task-run-sequences.mjs";
import {frozenLocalComfyScope} from "./assistant-local-comfy-scope.mjs";
import {freezeAssistantRunMediaGrant,authorizeAssistantRunMediaJob} from "./assistant-task-run-media-grant.mjs";
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const id=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const hash=x=>createHash("sha256").update(stableJson(x)).digest("hex");
const frozen=x=>stableJson(x);
const terminal=new Set(["failed","blocked","cancelled","cancelling","needs_reconcile","completed"]);
const nodeDigest=(doc,nodeId)=>hash(doc.nodes.find(n=>n.id===nodeId)??null);
const modelScope=snapshot=>({
 adapterKind:snapshot?.adapterKind,provider:snapshot?.provider,
 channelId:snapshot?.channelId??null,secretVersionRef:snapshot?.secretVersionRef??null,
 endpointBaseUrl:snapshot?.endpointBaseUrl??null,endpointFingerprint:snapshot?.endpointFingerprint??null,
 kind:snapshot?.task?.kind,model:snapshot?.task?.model
});
const validModelScope=scope=>scope.adapterKind==="model"&&
 typeof scope.provider==="string"&&scope.provider.length>0&&
 typeof scope.kind==="string"&&["text","image","audio","video"].includes(scope.kind)&&
 typeof scope.model==="string"&&scope.model.length>0;
const payloadDigest=job=>hash({executionMode:job.executionMode,snapshot:job.snapshot,
 skillAuthorizationId:job.skillAuthorizationId??null});
function simpleTextSnapshot(doc,nodeId,anchorJob){
 const node=doc.nodes.find(n=>n.id===nodeId),meta=node?.metadata??{};
 const task=anchorJob.snapshot?.task;
 const prompt=meta.composerContent??meta.prompt;
 if(node?.type!=="text"||typeof prompt!=="string"||!prompt.trim()||
  meta.content!==undefined&&meta.content!==null&&(typeof meta.content!=="string"||meta.content.trim())||
  doc.connections.some(edge=>edge.toNodeId===nodeId)||
  meta.skillBinding&&meta.skillBinding.mode!=="off"||task?.kind!=="text"||
  anchorJob.skillAuthorizationId||task.script||task.skills||task.images||task.mask)
  throw fail("assistant_run_budget_payload_requires_approval",400);
 const snapshot=JSON.parse(stableJson(anchorJob.snapshot));
 if(task.messages!==undefined){
  if(!Array.isArray(task.messages)||task.messages.some(m=>!m||typeof m.content!=="string")||
   task.messages.filter(m=>m.role==="user").length!==1||
   task.messages.at(-1)?.role!=="user"||task.messages.at(-1)?.content!==task.prompt||
   task.messages.some(m=>!["system","user"].includes(m.role)))
   throw fail("assistant_run_budget_payload_requires_approval",400);
  snapshot.task.messages=task.messages.map(m=>m.role==="user"?{...m,content:prompt.trim()}:m);
 }
 snapshot.task.prompt=prompt.trim();
 if(Object.hasOwn(snapshot,"sourceNodeType"))snapshot.sourceNodeType=node.type;
 return {...anchorJob,snapshot};
}
function context(db,projectId,taskId){
 if(!id(projectId)||!id(taskId))throw fail("assistant_run_budget_invalid",400);
 const row=db.prepare("SELECT t.*,p.revision,p.document_json FROM assistant_tasks t "+
  "JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL "+
  "WHERE t.id=? AND t.project_id=?").get(taskId,projectId);
 if(!row)throw fail("assistant_task_not_found",404);
 return row;
}
function seqRow(db,task,seqId){
 const row=db.prepare("SELECT * FROM assistant_task_run_sequences WHERE id=? AND project_id=? AND task_id=?")
  .get(seqId,task.project_id,task.id);
 if(!row||row.plan_version!==task.active_plan_version||row.status!=="active")
  throw fail("assistant_run_budget_sequence_invalid");
 return row;
}
function ledger(db,taskId,grantId){
 return db.prepare("SELECT kind,payload_json FROM assistant_task_events WHERE task_id=? "+
  "AND kind IN ('run_budget_granted','run_budget_revoked','run_budget_consumed') ORDER BY seq")
  .all(taskId).map(e=>({kind:e.kind,payload:JSON.parse(e.payload_json)}))
  .filter(e=>e.payload.grantId===grantId);
}
function stateFor(db,projectId,taskId,grantId){
 const task=context(db,projectId,taskId),records=ledger(db,taskId,grantId);
 const grant=records.find(e=>e.kind==="run_budget_granted")?.payload;
 if(!grant)return null;
 const spent=records.filter(e=>e.kind==="run_budget_consumed");
 const revoked=records.some(e=>e.kind==="run_budget_revoked");
 if(new Set(spent.map(e=>e.payload.stepId)).size!==spent.length)
  throw fail("assistant_run_budget_evidence_invalid");
 const active=!revoked&&!task.read_only&&task.cancel_requested_at===null&&
  (grant.mode!=="local_comfy"||!!grant.comfyInstanceUrl&&
   db.prepare("SELECT url FROM comfy_instances WHERE id=?").get(grant.comfyScopeSummary?.instanceId)?.url===grant.comfyInstanceUrl)&&
  [1,2,3].includes(grant.payloadPolicyVersion)&&!!grant.payloadDigests&&!!grant.sourceFingerprints&&
  !terminal.has(task.status)&&task.active_plan_version===grant.planVersion&&
  Date.now()<grant.expiresAt&&spent.length<grant.maxJobs;
 return {grantId,sequenceId:grant.sequenceId,planVersion:grant.planVersion,
  maxJobs:grant.maxJobs,consumedJobs:spent.length,remainingJobs:Math.max(0,grant.maxJobs-spent.length),
  allowedIndices:grant.allowedIndices,expiresAt:grant.expiresAt,revoked,active,
  modelScopeSummary:grant.modelScopeSummary,
  ...(["local_comfy","local_comfy_media"].includes(grant.mode)?
   {mode:grant.mode,comfyScopeSummary:grant.comfyScopeSummary}:{mode:"model"}),
  executionStarted:spent.length>0};
}
export function getAssistantRunBudgetState(db,{projectId,taskId}){
 context(db,projectId,taskId);
 const current=db.prepare("SELECT json_extract(payload_json,'$.grantId') AS id "+
  "FROM assistant_task_events WHERE task_id=? AND kind='run_budget_granted' "+
  "ORDER BY seq DESC LIMIT 1").get(taskId);
 return {grant:current?getAssistantRunBudgetGrant(db,{projectId,taskId,grantId:current.id}):null};
}
export function getAssistantRunBudgetGrant(db,{projectId,taskId,grantId}){
 if(!id(grantId))throw fail("assistant_run_budget_invalid",400);
 const state=stateFor(db,projectId,taskId,grantId);
 if(!state)throw fail("assistant_run_budget_not_found",404);
 return state;
}
export function createAssistantRunBudgetGrant(db,{projectId,taskId,requestId,sequenceId,
 expectedPlanVersion,maxJobs,allowedIndices,expiresInMinutes=30,confirmed,mode="model",instanceId}={}){
 if(![projectId,taskId,requestId,sequenceId].every(id)||
  !["model","local_comfy","local_comfy_media"].includes(mode)||
  mode==="local_comfy_media"&&(!id(instanceId)||maxJobs!==1||allowedIndices?.length!==1)||
  !Number.isSafeInteger(expectedPlanVersion)||expectedPlanVersion<1||confirmed!==true||
  !Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>4||
  !Number.isSafeInteger(expiresInMinutes)||expiresInMinutes<1||expiresInMinutes>1440||
  !Array.isArray(allowedIndices)||!allowedIndices.length||allowedIndices.length>4||
  allowedIndices.some(n=>!Number.isInteger(n)||n<0||n>3)||
  new Set(allowedIndices).size!==allowedIndices.length||maxJobs>allowedIndices.length)
  throw fail("assistant_run_budget_invalid",400);
 const payload={taskId,sequenceId,expectedPlanVersion,maxJobs,allowedIndices,expiresInMinutes,confirmed:true,
  ...(mode==="local_comfy_media"?{mode,instanceId}:mode==="local_comfy"?{mode}:{})};
 const signature=hash(payload);
 return writeTransaction(db,()=>{
  const prior=db.prepare("SELECT command_kind,payload_digest,response_json FROM assistant_task_commands "+
   "WHERE project_id=? AND request_id=?").get(projectId,requestId);
  if(prior){
   if(prior.command_kind!=="run_budget_grant"||prior.payload_digest!==signature)
    throw fail("assistant_task_command_conflict");
   const old=JSON.parse(prior.response_json);
   return {...getAssistantRunBudgetGrant(db,{projectId,taskId,grantId:old.grantId}),existing:true};
  }
  const task=context(db,projectId,taskId);
  if(task.read_only||task.cancel_requested_at!==null||terminal.has(task.status)||
   task.active_plan_version!==expectedPlanVersion)throw fail("assistant_task_not_editable");
  const seq=seqRow(db,task,sequenceId),actions=JSON.parse(seq.actions_json),doc=hydrateCreativeDocument(db,task.project_id,JSON.parse(task.document_json));
  // No two simultaneously active budget envelopes for the same Task/Sequence.
  const grants=db.prepare("SELECT json_extract(payload_json,'$.grantId') id FROM assistant_task_events "+
   "WHERE task_id=? AND kind='run_budget_granted'").all(taskId);
  if(grants.some(row=>stateFor(db,projectId,taskId,row.id)?.active))
   throw fail("assistant_run_budget_already_active");
  const mediaScope=mode==="local_comfy_media"?freezeAssistantRunMediaGrant(db,{
   doc,actions,runIndex:allowedIndices[0],instanceId}):null;
  // A prior individual approval anchors the exact model/channel/kind. UI may
  // authorize only remaining homogeneous node generations under this anchor.
  const anchorRows=db.prepare("SELECT s.action_json,s.approval_json,s.preconditions_json FROM assistant_task_steps s "+
   "WHERE s.task_id=? AND s.plan_version=? AND s.superseded_at IS NULL "+
   "AND s.kind=? AND json_extract(s.preconditions_json,'$.runSequenceId')=? "+
   "ORDER BY s.ordinal DESC")
   .all(taskId,expectedPlanVersion,mode==="local_comfy"?"comfy_workflow":"model_job",sequenceId);
  const anchor=anchorRows.find(row=>{
   const approval=JSON.parse(row.approval_json);
   return approval.decision==="approved"&&!approval.grantId;
  });
  const anchorJob=anchor&&JSON.parse(anchor.action_json).job;
  const anchorScope=mode==="model"&&anchorJob&&modelScope(anchorJob.snapshot);
  if(mode==="model"&&(!anchorScope||!validModelScope(anchorScope)))
   throw fail("assistant_run_budget_model_scope_missing");
  if(mode==="local_comfy"&&!anchorJob)throw fail("assistant_local_comfy_approval_required");
  const anchorComfy=mode==="local_comfy"?frozenLocalComfyScope(anchorJob.snapshot,{
   projectId,targetNodeId:anchorJob.targetNodeId,document:doc}):null;
  const comfyInstanceUrl=mode==="local_comfy"?db.prepare("SELECT url FROM comfy_instances WHERE id=?")
   .get(anchorComfy.instanceId)?.url:null;
  if(mode==="local_comfy"&&(!comfyInstanceUrl||
   JSON.parse(anchor.approval_json).comfyInstanceUrl!==comfyInstanceUrl))
   throw fail("assistant_local_comfy_scope_unsupported",400);
  if(mode==="local_comfy"&&anchorJob.executionMode!=="poll")
   throw fail("assistant_local_comfy_scope_unsupported",400);
  const nodeDigests={},sourceFingerprints={},payloadDigests={};
  for(const index of allowedIndices){
   const action=actions[index];
   if(!action||action.type!==(mode==="model"?"run_node":"run_workflow")||
    (mode!=="local_comfy_media"&&action.inputFromPrevious)||action.join||
    typeof action.nodeId!=="string"||!doc.nodes.some(n=>n.id===action.nodeId))
    throw fail("assistant_run_budget_scope_invalid",400);
   nodeDigests[index]=nodeDigest(doc,action.nodeId);
   sourceFingerprints[index]=fingerprintSource(doc,action.nodeId);
   if(mode==="local_comfy_media"){
    if(index!==allowedIndices[0]||action.nodeId!==mediaScope.targetNodeId)
     throw fail("assistant_run_media_scope_invalid",400);
    payloadDigests[index]=hash(mediaScope);
   }else if(mode==="local_comfy"){
    const node=doc.nodes.find(n=>n.id===action.nodeId);
    if(node?.type!=="comfy:workflow"||node.metadata?.comfyMediaPreset||
     doc.connections.some(edge=>edge.toNodeId===action.nodeId)||
     node.metadata?.comfyWorkflow?.templateId!==anchorComfy.templateId||
     node.metadata?.comfyWorkflow?.templateRevision!==anchorComfy.templateRevision||
     stableJson(node.metadata?.comfyWorkflow?.inputOverrides??{})!==stableJson(anchorComfy.inputOverrides))
     throw fail("assistant_local_comfy_scope_unsupported",400);
    payloadDigests[index]=hash(anchorComfy);
   }else{
    const approved=anchorRows.find(row=>JSON.parse(row.preconditions_json).runIndex===index&&
     JSON.parse(row.approval_json).decision==="approved"&&!JSON.parse(row.approval_json).grantId);
    const job=approved?JSON.parse(approved.action_json).job:simpleTextSnapshot(doc,action.nodeId,anchorJob);
    if(hash(modelScope(job.snapshot))!==hash(anchorScope))throw fail("assistant_run_budget_scope_invalid",400);
    payloadDigests[index]=payloadDigest(job);
   }
  }
  const at=Date.now(),grantId=randomUUID(),grant={grantId,sequenceId,planVersion:expectedPlanVersion,
   intentDigest:seq.intent_digest,allowedIndices,maxJobs,nodeDigests,sourceFingerprints,payloadDigests,
   payloadPolicyVersion:mode==="local_comfy_media"?3:mode==="local_comfy"?2:1,
   ...(mode==="local_comfy_media"?{mode,runIndex:allowedIndices[0],mediaScope,
    comfyScopeSummary:{instanceId,templateId:mediaScope.templateId,
     templateRevision:mediaScope.templateRevision}}:{}),
   ...(mode==="local_comfy"?{mode,comfyInstanceUrl,comfyScopeDigest:hash(anchorComfy),
    comfyScopeSummary:{instanceId:anchorComfy.instanceId,templateId:anchorComfy.templateId,
     templateRevision:anchorComfy.templateRevision}}:
    mode==="local_comfy_media"?{}:{modelScopeDigest:hash(anchorScope),modelScopeSummary:{
     provider:anchorScope.provider,kind:anchorScope.kind,model:anchorScope.model}}),
   createdAt:at,
   expiresAt:at+expiresInMinutes*60000};
  db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) "+
   "VALUES(?,'run_budget_granted',?,?)").run(taskId,frozen(grant),at);
  const response={grantId,sequenceId,planVersion:expectedPlanVersion,
   maxJobs,consumedJobs:0,remainingJobs:maxJobs,allowedIndices,expiresAt:grant.expiresAt,
   active:true,revoked:false,executionStarted:false,
   ...(mode==="local_comfy"||mode==="local_comfy_media"?
    {mode,comfyScopeSummary:grant.comfyScopeSummary}:
    {modelScopeSummary:grant.modelScopeSummary})};
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) "+
   "VALUES(?,?,?,'run_budget_grant',?,'completed',?,?)")
   .run(projectId,requestId,taskId,signature,frozen(response),at);
  return {...response,existing:false};
 });
}
export function revokeAssistantRunBudgetGrant(db,{projectId,taskId,grantId,requestId}={}){
 if(!id(requestId)||!id(grantId))throw fail("assistant_run_budget_invalid",400);
 return writeTransaction(db,()=>{
  const task=context(db,projectId,taskId),state=stateFor(db,projectId,taskId,grantId);
  if(!state)throw fail("assistant_run_budget_not_found",404);
  if(task.read_only)throw fail("assistant_task_not_editable");
  if(!state.revoked)
   db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) "+
    "VALUES(?,'run_budget_revoked',?,?)")
    .run(taskId,frozen({grantId,requestId,at:Date.now()}),Date.now());
  return {...stateFor(db,projectId,taskId,grantId),executionStarted:false};
 });
}
/** BEGIN IMMEDIATE is owned by enqueueAssistantExternalJobStep. */
export function authorizeAssistantRunBudgetEnqueue(db,{projectId,taskId,grantId,step,task}){
 if(!id(grantId))throw fail("assistant_run_budget_invalid",400);
 const state=stateFor(db,projectId,taskId,grantId);
 if(!state?.active)throw fail("assistant_run_budget_not_active");
 const grant=ledger(db,taskId,grantId).find(e=>e.kind==="run_budget_granted")?.payload;
 const pre=JSON.parse(step.preconditions_json),action=JSON.parse(step.action_json),seq=seqRow(db,task,grant.sequenceId);
 if(grant.mode==="local_comfy_media"){
  const admission=authorizeAssistantRunMediaJob(db,{projectId,taskId,grantId,step});
  assertAssistantBudgetRunEvidence(db,{projectId,taskId,sequenceId:grant.sequenceId,
   planVersion:grant.planVersion,runIndex:grant.runIndex});
  return admission;
 }
 const doc=hydrateCreativeDocument(db,task.project_id,JSON.parse(task.document_json));
 const comfy=grant.mode==="local_comfy"&&grant.payloadPolicyVersion===2;
 if(seq.intent_digest!==grant.intentDigest||pre.runSequenceId!==grant.sequenceId||
  step.plan_version!==grant.planVersion||!state.allowedIndices.includes(pre.runIndex)||
  !["waiting_approval","ready"].includes(step.status)||
  step.kind!==(comfy?"comfy_workflow":"model_job")||
  action.kind!==(comfy?"comfy_workflow":"model_job")||
  action.job.targetNodeId!==JSON.parse(seq.actions_json)[pre.runIndex]?.nodeId||
  nodeDigest(doc,action.job.targetNodeId)!==grant.nodeDigests[pre.runIndex]||
  fingerprintSource(doc,action.job.targetNodeId)!==grant.sourceFingerprints?.[pre.runIndex])
  throw fail("assistant_run_budget_scope_changed");
 if(comfy){
  const projected=frozenLocalComfyScope(action.job.snapshot,{projectId,
   targetNodeId:action.job.targetNodeId,document:doc});
  // An instance ID can be repointed between terminal Jobs. Old grants lacking
  // endpoint evidence must also require fresh consent.
  const instanceUrl=db.prepare("SELECT url FROM comfy_instances WHERE id=?")
   .get(projected.instanceId)?.url;
  if(!grant.comfyInstanceUrl||instanceUrl!==grant.comfyInstanceUrl||
   action.job.executionMode!=="poll"||
   hash(projected)!==grant.comfyScopeDigest||
   hash(projected)!==grant.payloadDigests?.[pre.runIndex]||
   String(task.revision)!==action.job.snapshot.comfyRequest.canvasRevision)
   throw fail("assistant_run_budget_scope_changed");
 }else if(payloadDigest(action.job)!==grant.payloadDigests?.[pre.runIndex]||
  !validModelScope(modelScope(action.job.snapshot))||
  hash(modelScope(action.job.snapshot))!==grant.modelScopeDigest)
  throw fail("assistant_run_budget_scope_changed");
 assertAssistantBudgetRunEvidence(db,{projectId,taskId,sequenceId:grant.sequenceId,
  planVersion:grant.planVersion,runIndex:pre.runIndex});
 return {grantId,runIndex:pre.runIndex};
}
export function commitAssistantRunBudgetConsumption(db,{taskId,admission,stepId,jobId}){
 db.prepare("INSERT INTO assistant_task_events(task_id,step_id,kind,payload_json,created_at) "+
  "VALUES(?,?,'run_budget_consumed',?,?)")
  .run(taskId,stepId,frozen({grantId:admission.grantId,runIndex:admission.runIndex,
   stepId,jobId,at:Date.now()}),Date.now());
}
