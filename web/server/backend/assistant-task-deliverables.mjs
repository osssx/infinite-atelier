/** P4.0, schema-free, server-owned text deliverables.
 * An imported Task is always read-only; archive events are audit only.
 * The existing Task/Step/Attempt tables remain the only execution authority.
 */
import {createHash} from "node:crypto";
import {assertNoRawCredentials,stableJson,writeTransaction} from "./repository.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const id=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const sha=x=>createHash("sha256").update(stableJson(x)).digest("hex");
const serialized=(x,max=8000)=>{
 assertNoRawCredentials(x);
 const out=stableJson(x);
 if(Buffer.byteLength(out)>max)throw fail("assistant_task_payload_too_large",413);
 return out;
};
const record=(db,taskId,stepId,kind,payload,now=Date.now())=>db.prepare(
 "INSERT INTO assistant_task_events(task_id,step_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)")
 .run(taskId,stepId,kind,serialized(payload),now);
const requiredEvent=(db,taskId)=>db.prepare(
 "SELECT payload_json FROM assistant_task_events WHERE task_id=? AND kind='deliverable_required' ORDER BY seq DESC LIMIT 1")
 .get(taskId);

export function assistantTaskRequiresDeliverable(db,taskId){
 return !!requiredEvent(db,taskId);
}
/** The only legal completion route for a spec-bearing Task is verifyAssistantTextDeliverable. */
export function mayCompleteAssistantTask(db,taskId){
 return !assistantTaskRequiresDeliverable(db,taskId);
}
export function currentAssistantTextDeliverable(db,taskId){
 const row=requiredEvent(db,taskId);
 return row?JSON.parse(row.payload_json):null;
}
const meaningful=text=>typeof text==="string"?
 text.replace(/[\s，。；：、,.;:!*#\-=\d]/g,"").length:0;
const emptyLabels=text=>(text.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:姓名|身份\/职业|外貌|性格|背景故事|目标与动机|标志性台词)\s*[:：]\s*(?=\n|$)/g)??[]).length;
/** User-confirmed characters, not model-proposed names. No auto-generated identity from model text. */
export function registerAssistantTextDeliverable(db,{projectId,taskId,requestId,
 sourceTurnMessageId,characters,requiredFields=[],allowEmptyTemplate=false,confirmed=false}){
 if(!id(projectId)||!id(taskId)||!id(requestId)||!id(sourceTurnMessageId)||confirmed!==true||
  !Array.isArray(characters)||characters.length<1||characters.length>5||
  !Array.isArray(requiredFields)||requiredFields.length>6||
  requiredFields.some(f=>typeof f!=="string"||!f.trim()||f.length>60)||
  typeof allowEmptyTemplate!=="boolean")throw fail("assistant_deliverable_invalid",400);
 const clean=characters.map(c=>{
  if(!c||typeof c!=="object"||Array.isArray(c)||
   Object.keys(c).some(k=>!["ref","title","sourceNodeId"].includes(k))||
   !id(c.ref)||typeof c.title!=="string"||!c.title.trim()||c.title.length>100||
   (c.sourceNodeId!==undefined&&!id(c.sourceNodeId)))
   throw fail("assistant_deliverable_invalid",400);
  return {ref:c.ref,title:c.title.trim(),...(c.sourceNodeId?{sourceNodeId:c.sourceNodeId}:{})};
 });
 if(new Set(clean.map(c=>c.ref)).size!==clean.length||
  new Set(clean.map(c=>c.title)).size!==clean.length)
  throw fail("assistant_deliverable_invalid",400);
 const data={kind:"text_nodes",sourceTurnMessageId,characters:clean,
  requiredFields:[...new Set(requiredFields.map(v=>v.trim()))],allowEmptyTemplate};
 const digest=sha({taskId,data}),signature=sha({kind:"deliverable_require",taskId,data});
 return writeTransaction(db,()=>{
  const command=db.prepare("SELECT command_kind,payload_digest,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?")
   .get(projectId,requestId);
  if(command){
   if(command.command_kind!=="deliverable_require"||command.payload_digest!==signature)
    throw fail("assistant_task_command_conflict");
   return {...JSON.parse(command.response_json),existing:true};
  }
  const task=db.prepare("SELECT * FROM assistant_tasks WHERE project_id=? AND id=?").get(projectId,taskId);
  if(!task)throw fail("assistant_task_not_found",404);
  if(task.read_only||task.cancel_requested_at!==null||
   ["completed","cancelled","cancelling","needs_reconcile","blocked","failed"].includes(task.status))
   throw fail("assistant_task_not_editable");
  if(task.active_step_id!==null)throw fail("assistant_step_already_claimed");
  if(requiredEvent(db,taskId))throw fail("assistant_deliverable_already_required");
  const turn=db.prepare("SELECT payload_json FROM assistant_task_events WHERE task_id=? AND kind='user_turn' AND json_extract(payload_json,'$.messageId')=? ORDER BY seq DESC LIMIT 1")
   .get(taskId,sourceTurnMessageId);
  if(!turn)throw fail("assistant_task_turn_not_found");
  const sourceTurn=JSON.parse(turn.payload_json),contextPolicy=sourceTurn.contextPolicy;
  // P4.0 only permits names explicitly present in the current user turn;
  // untrusted model proposals cannot silently become a confirmed cast.
  if(clean.some(c=>!sourceTurn.preview?.includes(c.title))||
   allowEmptyTemplate&&!/(空白|空模板|不填正文)/.test(sourceTurn.preview??""))
   throw fail("assistant_deliverable_cast_unconfirmed",403);
  const doc=JSON.parse(db.prepare("SELECT document_json FROM projects WHERE id=? AND deleted_at IS NULL")
   .get(projectId)?.document_json??"null");
  if(!doc)throw fail("project_not_found",404);
  const byId=new Map((doc.nodes??[]).map(n=>[n.id,n]));
  for(const c of clean)if(c.sourceNodeId&&
   (!contextPolicy?.includeContext||contextPolicy.scope!=="selection"||
    !contextPolicy.includedIds?.includes(c.sourceNodeId)||!byId.has(c.sourceNodeId)))
   throw fail("assistant_deliverable_source_not_authorized",403);
  // First require event is the monotone Task-level completion guard, not an editable semantic constraint.
  const at=Date.now(),value={...data,taskId,requestId,digest};
  record(db,taskId,null,"deliverable_required",value,at);
  const response={taskId,kind:"text_nodes",requirementDigest:digest,
   characters:clean,allowEmptyTemplate,requiredFields:data.requiredFields};
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,'deliverable_require',?,'completed',?,?)")
   .run(projectId,requestId,taskId,signature,serialized(response),at);
  return {...response,existing:false};
 });
}
export function freezeAssistantTextSpec(requirement,{taskId,planVersion,projectRevision}){
 if(requirement?.kind!=="text_nodes"||requirement.taskId!==taskId)
  throw fail("assistant_deliverable_invalid");
 return {kind:"text_nodes",taskId,planVersion,sourceProjectRevision:projectRevision,
  characters:requirement.characters,expectedCount:requirement.characters.length,
  requiredFields:requirement.requiredFields??[],allowEmptyTemplate:requirement.allowEmptyTemplate===true,
  requirementDigest:requirement.digest};
}
export function assertAssistantTextActions(spec,actions){
 const cards=actions.filter(a=>a.type==="create_text"||
  a.type==="create_node"&&a.nodeType==="text");
 if(cards.length!==spec.expectedCount||
  actions.some(a=>a.type==="set_text"||a.type==="set_title"||a.type==="delete_node"||
   a.type==="create_node"&&a.nodeType!=="text"))
  throw fail("assistant_deliverable_content_invalid",422);
 const byRef=new Map(cards.map(a=>[a.ref,a]));
 if(byRef.size!==cards.length)throw fail("assistant_deliverable_content_invalid",422);
 for(const c of spec.characters){
  const a=byRef.get(c.ref);
  if(!a||a.title!==c.title)throw fail("assistant_deliverable_character_mismatch",422);
  const body=a.content;
  if(!spec.allowEmptyTemplate&&
   (meaningful(body)<18||emptyLabels(body)>=3||
    spec.requiredFields.some(field=>!body?.includes(field))))
   throw fail("assistant_deliverable_content_invalid",422);
  if(spec.allowEmptyTemplate&&typeof body!=="string"&&body!==undefined)
   throw fail("assistant_deliverable_content_invalid",422);
 }
}
/** Same serialization as Step Claim. Plan checks the complete candidate early. */
export function assertAssistantTextClaimBudget({projectId,taskId,stepId,planVersion,action,preconditions,actionDigest}){
 const frozen={projectId,taskId,stepId,planVersion,attemptNo:999999999,
  action,preconditions,actionDigest};
 if(Buffer.byteLength(stableJson(frozen))>32*1024-128)
  throw fail("assistant_task_payload_too_large",413);
}
export function assertAssistantDeliverableBinding(action,preconditions){
 const spec=preconditions?.deliverableSpec;
 if(spec===undefined){
  if(action?.deliverableSpecDigest!==undefined)throw fail("assistant_deliverable_spec_changed");
  return null;
 }
 const digest=sha(spec);
 if(action?.deliverableSpecDigest!==digest||
  preconditions.deliverableSpecDigest!==digest)
  throw fail("assistant_deliverable_spec_changed");
 assertAssistantTextActions(spec,action.actions);
 return {spec,digest};
}
/** No GPU/model calls. Atomic verification + completion; errors roll back both. */
export function verifyAssistantTextDeliverable(db,{projectId,taskId,stepId,requestId,
 expectedPlanVersion,actionDigest,afterVerificationEvent,afterCompletionUpdate}){
 if(![projectId,taskId,stepId,requestId].every(id)||
  !Number.isSafeInteger(expectedPlanVersion)||expectedPlanVersion<1||
  typeof actionDigest!=="string"||!/^[a-f0-9]{64}$/.test(actionDigest))
  throw fail("assistant_deliverable_invalid",400);
 const signature=sha({kind:"deliverable_verify",taskId,stepId,expectedPlanVersion,actionDigest});
 return writeTransaction(db,()=>{
  const prior=db.prepare("SELECT command_kind,payload_digest,status,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?")
   .get(projectId,requestId);
  if(prior){
   if(prior.command_kind!=="deliverable_verify"||prior.payload_digest!==signature)
    throw fail("assistant_task_command_conflict");
   if(prior.status!=="completed")throw fail("assistant_step_state_conflict");
   return {...JSON.parse(prior.response_json),existing:true};
  }
  const task=db.prepare("SELECT t.*,p.revision,p.document_json FROM assistant_tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL WHERE t.id=? AND t.project_id=?")
   .get(taskId,projectId);
  if(!task)throw fail("assistant_task_not_found",404);
  if(task.read_only||task.cancel_requested_at!==null||!assistantTaskRequiresDeliverable(db,taskId)||
   task.active_plan_version!==expectedPlanVersion||task.active_step_id!==null)
   throw fail("assistant_deliverable_not_verifiable");
  const step=db.prepare("SELECT * FROM assistant_task_steps WHERE id=? AND task_id=? AND plan_version=? AND superseded_at IS NULL")
   .get(stepId,taskId,expectedPlanVersion);
  if(!step||step.status!=="succeeded"||step.receipt_trust!=="server_committed"||
   step.action_digest!==actionDigest)
   throw fail("assistant_deliverable_step_unverified");
  const action=JSON.parse(step.action_json),pre=JSON.parse(step.preconditions_json);
  if(sha(action)!==actionDigest)throw fail("assistant_step_action_changed");
  const binding=assertAssistantDeliverableBinding(action,pre);
  if(!binding||binding.spec.taskId!==taskId||binding.spec.planVersion!==expectedPlanVersion)
   throw fail("assistant_deliverable_spec_changed");
  const approval=JSON.parse(step.approval_json);
  if(approval.decision!=="approved"||approval.actionDigest!==actionDigest||
   approval.planVersion!==expectedPlanVersion||approval.projectRevision!==pre.projectRevision)
   throw fail("assistant_step_approval_required");
  const receipt=JSON.parse(step.receipt_json),doc=JSON.parse(task.document_json);
  const projectDigest=sha(doc),receiptDigest=sha(receipt);
  let reason=null;
  if(task.revision!==receipt.projectRevision||projectDigest!==receipt.projectGraphDigest)
   reason="assistant_deliverable_source_changed";
  const byId=new Map((doc.nodes??[]).map(n=>[n.id,n]));
  const cardActions=new Map(action.actions.filter(a=>a.type==="create_text"||
   a.type==="create_node"&&a.nodeType==="text").map(a=>[a.ref,a]));
  const checkedNodeDigests={};
  if(!reason)for(const c of binding.spec.characters){
   const nodeId=receipt.refs?.nodes?.[c.ref],node=byId.get(nodeId),planned=cardActions.get(c.ref);
   const body=node?.metadata?.content;
   if(!node||node.type!=="text"||node.title!==c.title||!planned||
    (body??"")!==(planned.content??"")||
    !binding.spec.allowEmptyTemplate&&(meaningful(body)<18||emptyLabels(body)>=3||
     binding.spec.requiredFields.some(field=>!body?.includes(field)))){
    reason="assistant_deliverable_content_invalid";break;
   }
   checkedNodeDigests[nodeId]=sha({title:node.title,content:body??""});
  }
  const at=Date.now(),verified=!reason;
  if(task.status==="completed"){
   const old=db.prepare("SELECT payload_json FROM assistant_task_events WHERE task_id=? AND kind='deliverable_verified' AND step_id=? ORDER BY seq DESC LIMIT 1")
    .get(taskId,stepId);
   if(old)return {...JSON.parse(old.payload_json),existing:true};
   throw fail("assistant_deliverable_already_completed");
  }
  if(!["ready","planning"].includes(task.status))throw fail("assistant_deliverable_not_verifiable");
  // A valid card receipt cannot complete other required work in this plan.
  if(db.prepare("SELECT 1 FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL AND required=1 AND (status!='succeeded' OR receipt_trust!='server_committed') LIMIT 1")
   .get(taskId,expectedPlanVersion))throw fail("assistant_deliverable_steps_incomplete");
  const outcome={taskId,stepId,planVersion:expectedPlanVersion,specDigest:binding.digest,
   receiptDigest,projectRevision:task.revision,checkedNodeDigests,
   verified,...(reason?{reason}:{})};
  record(db,taskId,stepId,verified?"deliverable_verified":"deliverable_verification_failed",outcome,at);
  if(afterVerificationEvent)afterVerificationEvent(); // fault injection: whole transaction must roll back
  const changed=db.prepare("UPDATE assistant_tasks SET status=?,updated_at=?,finished_at=? WHERE id=? AND project_id=? AND active_plan_version=? AND active_step_id IS NULL AND status IN ('ready','planning') AND read_only=0 AND cancel_requested_at IS NULL")
   .run(verified?"completed":"blocked",at,verified?at:null,taskId,projectId,expectedPlanVersion);
  if(changed.changes!==1)throw fail("assistant_deliverable_state_changed");
  if(afterCompletionUpdate)afterCompletionUpdate(); // fault injection after Task CAS
  if(verified)record(db,taskId,null,"task_completed",
   {planVersion:expectedPlanVersion,source:"deliverable_verifier",specDigest:binding.digest},at);
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,'deliverable_verify',?,'completed',?,?)")
   .run(projectId,requestId,taskId,signature,serialized(outcome),at);
  return {...outcome,existing:false};
 });
}
