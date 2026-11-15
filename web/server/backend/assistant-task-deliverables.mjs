/** P4.0, schema-free, server-owned text deliverables.
 * An imported Task is always read-only; archive events are audit only.
 * The existing Task/Step/Attempt tables remain the only execution authority.
 */
import {createHash} from "node:crypto";
import {assertNoRawCredentials,stableJson,writeTransaction} from "./repository.mjs";
import {resolveAuthorizedCreativeCharacters} from "./assistant-creative-context.mjs";

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
 const row=db.prepare("SELECT payload_json FROM assistant_task_events WHERE task_id=? AND kind IN ('deliverable_required','deliverable_revised') ORDER BY seq DESC LIMIT 1")
  .get(taskId);
 return row?JSON.parse(row.payload_json):null;
}
const meaningful=text=>typeof text==="string"?
 text.replace(/[\s，。；：、,.;:!*#\-=\d]/g,"").length:0;
const emptyLabels=text=>(text.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:姓名|身份\/职业|外貌|性格|背景故事|目标与动机|标志性台词)\s*[:：]\s*(?=\n|$)/g)??[]).length;
const allowsEmptyTemplate=text=>/(空白|空模板|不填正文)/.test(text)&&
 !/(?:不要|不允许|不能|禁止|避免|无需|不是|非|拒绝|不接受|不需要)[^。！？;\n]{0,16}(?:空白|空模板|不填正文)/.test(text);
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
   Object.keys(c).some(k=>!["ref","title","sourceNodeId","sourceRef","sourceDigest"].includes(k))||
   !id(c.ref)||typeof c.title!=="string"||!c.title.trim()||c.title.length>100||
   (c.sourceNodeId!==undefined&&!id(c.sourceNodeId))||
   (c.sourceRef!==undefined&&!id(c.sourceRef))||
   (c.sourceDigest!==undefined&&
    (typeof c.sourceDigest!=="string"||!/^[a-f0-9]{64}$/.test(c.sourceDigest)))||
   (c.sourceRef!==undefined)!==(c.sourceDigest!==undefined))
   throw fail("assistant_deliverable_invalid",400);
  return {ref:c.ref,title:c.title.trim(),...(c.sourceNodeId?{sourceNodeId:c.sourceNodeId}:{}),
   ...(c.sourceRef?{sourceRef:c.sourceRef,sourceDigest:c.sourceDigest}:{})};
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
  const sourced=clean.filter(c=>c.sourceRef);
  if(sourced.length&&sourced.length!==clean.length)
   throw fail("assistant_deliverable_source_partial",400);
  if(sourced.length){
   // User approval is necessary but not sufficient; recalculate the original
   // references and their digests under this frozen turn's disclosure scope.
   const actual=resolveAuthorizedCreativeCharacters(db,{projectId,taskId,
    turnMessageId:sourceTurnMessageId,characters:sourced});
   if(actual.some((candidate,index)=>candidate.sourceNodeId!==sourced[index].sourceNodeId))
    throw fail("assistant_creative_source_changed");
  }
  if((!sourced.length&&clean.some(c=>!sourceTurn.preview?.includes(c.title)))||
   allowEmptyTemplate&&!allowsEmptyTemplate(sourceTurn.preview??""))
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
/** P4.3: confirmed, typed text requirements. Revision only after public safe replan.
 * No client or imported event can mark a Task completed. */
const structuredTypes={
 story:{keyword:/故事|剧情|大纲/,title:"故事大纲",minimum:60},
 scene:{keyword:/场景|环境设定/,title:"场景设定",minimum:35},
 storyboard:{keyword:/分镜|镜头提示词|镜头脚本/,title:"分镜提示词",minimum:40}
};
export function registerAssistantStructuredTextDeliverable(db,{projectId,taskId,requestId,
 sourceTurnMessageId,deliverableType,entries,requiredFields=[],allowEmptyTemplate=false,
 expectedPlanVersion,confirmed=false}){
 const rule=structuredTypes[deliverableType];
 if(![projectId,taskId,requestId,sourceTurnMessageId].every(id)||confirmed!==true||!rule||
  !Number.isSafeInteger(expectedPlanVersion)||expectedPlanVersion<1||
  !Array.isArray(entries)||entries.length<1||entries.length>8||
  !Array.isArray(requiredFields)||requiredFields.length>6||
  requiredFields.some(f=>typeof f!=="string"||!f.trim()||f.length>60)||
  typeof allowEmptyTemplate!=="boolean")throw fail("assistant_deliverable_invalid",400);
 const clean=entries.map(v=>{
  if(!v||typeof v!=="object"||Array.isArray(v)||
   Object.keys(v).some(k=>!["ref","title"].includes(k))||
   !id(v.ref)||typeof v.title!=="string"||!v.title.trim()||v.title.length>100)
   throw fail("assistant_deliverable_invalid",400);
  return {ref:v.ref,title:v.title.trim()};
 });
 if(new Set(clean.map(v=>v.ref)).size!==clean.length||
  new Set(clean.map(v=>v.title)).size!==clean.length)throw fail("assistant_deliverable_invalid",400);
 const data={kind:"text_nodes",deliverableType,sourceTurnMessageId,entries:clean,
  requiredFields:[...new Set(requiredFields.map(f=>f.trim()))],allowEmptyTemplate,
  planVersion:expectedPlanVersion,minMeaningfulChars:rule.minimum};
 const signature=sha({kind:"structured_deliverable_require",taskId,data});
 return writeTransaction(db,()=>{
  const old=db.prepare("SELECT command_kind,payload_digest,status,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?").get(projectId,requestId);
  if(old){
   if(old.command_kind!=="deliverable_require"||old.payload_digest!==signature)
    throw fail("assistant_task_command_conflict");
   if(old.status!=="completed")throw fail("assistant_step_state_conflict");
   return {...JSON.parse(old.response_json),existing:true};
  }
  const task=db.prepare("SELECT * FROM assistant_tasks WHERE id=? AND project_id=?").get(taskId,projectId);
  if(!task)throw fail("assistant_task_not_found",404);
  if(task.read_only||task.cancel_requested_at!==null||task.status!=="planning"||
   task.active_step_id!==null||task.active_plan_version!==expectedPlanVersion)
   throw fail("assistant_task_not_editable");
  if(db.prepare("SELECT 1 FROM assistant_task_steps WHERE task_id=? AND plan_version=? LIMIT 1")
   .get(taskId,expectedPlanVersion))throw fail("assistant_deliverable_plan_already_started");
  const current=currentAssistantTextDeliverable(db,taskId);
  if(current){
   if(!current.deliverableType||current.kind!=="text_nodes"||
    current.planVersion!==expectedPlanVersion-1||current.deliverableType!==deliverableType)
    throw fail("assistant_deliverable_revision_invalid");
   if(!db.prepare("SELECT 1 FROM assistant_task_events WHERE task_id=? AND kind='safe_replan_authorized' AND json_extract(payload_json,'$.toPlanVersion')=? LIMIT 1").get(taskId,expectedPlanVersion))
    throw fail("assistant_deliverable_revision_not_authorized",403);
  }else if(expectedPlanVersion!==1)throw fail("assistant_deliverable_revision_invalid");
  const turn=db.prepare("SELECT seq,payload_json FROM assistant_task_events WHERE task_id=? AND kind='user_turn' AND json_extract(payload_json,'$.messageId')=? ORDER BY seq DESC LIMIT 1").get(taskId,sourceTurnMessageId);
  const latest=db.prepare("SELECT seq FROM assistant_task_events WHERE task_id=? AND kind='user_turn' ORDER BY seq DESC LIMIT 1").get(taskId);
  if(!turn||turn.seq!==latest?.seq)throw fail("assistant_task_turn_not_current",403);
  const preview=JSON.parse(turn.payload_json).preview??"";
  if(!rule.keyword.test(preview)||
   clean.some(v=>!preview.includes(v.title)&&!(clean.length===1&&v.title===rule.title))||
   allowEmptyTemplate&&!allowsEmptyTemplate(preview))
   throw fail("assistant_deliverable_source_unconfirmed",403);
  const at=Date.now(),sourceTurnSeq=turn.seq,
   digest=sha({taskId,data,sourceTurnSeq}),
   value={...data,taskId,requestId,sourceTurnSeq,digest};
  record(db,taskId,null,current?"deliverable_revised":"deliverable_required",value,at);
  const response={taskId,kind:"text_nodes",deliverableType,requirementDigest:digest,
   entries:clean,planVersion:expectedPlanVersion,
   allowEmptyTemplate,requiredFields:data.requiredFields};
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,'deliverable_require',?,'completed',?,?)")
   .run(projectId,requestId,taskId,signature,serialized(response),at);
  return {...response,existing:false};
 });
}
export function freezeAssistantTextSpec(requirement,{taskId,planVersion,projectRevision}){
 if(requirement?.kind!=="text_nodes"||requirement.taskId!==taskId)
  throw fail("assistant_deliverable_invalid");
 if(requirement.deliverableType){
  const rule=structuredTypes[requirement.deliverableType];
  if(!rule||requirement.planVersion!==planVersion||
   requirement.minMeaningfulChars!==rule.minimum||!Array.isArray(requirement.entries))
   throw fail("assistant_deliverable_revision_invalid");
  return {kind:"text_nodes",deliverableType:requirement.deliverableType,taskId,
   planVersion,sourceProjectRevision:projectRevision,entries:requirement.entries,
   sourceTurnMessageId:requirement.sourceTurnMessageId,sourceTurnSeq:requirement.sourceTurnSeq,
   expectedCount:requirement.entries.length,minMeaningfulChars:rule.minimum,
   requiredFields:requirement.requiredFields??[],
   allowEmptyTemplate:requirement.allowEmptyTemplate===true,requirementDigest:requirement.digest};
 }
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
 for(const c of spec.entries??spec.characters){
  const a=byRef.get(c.ref);
  if(!a||a.title!==c.title)throw fail(spec.deliverableType?
   "assistant_deliverable_target_mismatch":"assistant_deliverable_character_mismatch",422);
  const body=a.content;
  if(!spec.allowEmptyTemplate&&
   (meaningful(body)<(spec.minMeaningfulChars??18)||
    (!spec.deliverableType&&emptyLabels(body)>=3)||
    spec.requiredFields.some(field=>!body?.includes(field))))
   throw fail("assistant_deliverable_content_invalid",422);
  if(spec.allowEmptyTemplate&&typeof body!=="string"&&body!==undefined)
   throw fail("assistant_deliverable_content_invalid",422);
 }
}
/** A newer user Turn revokes the authority of this immutable structured spec. */
export function isAssistantStructuredSourceCurrent(db,taskId,spec){
 if(!spec?.deliverableType)return true;
 if(!id(spec.sourceTurnMessageId)||!Number.isSafeInteger(spec.sourceTurnSeq))
  return false;
 const latest=db.prepare("SELECT seq,payload_json FROM assistant_task_events WHERE task_id=? AND kind='user_turn' ORDER BY seq DESC LIMIT 1").get(taskId);
 if(latest?.seq!==spec.sourceTurnSeq)return false;
 try{return JSON.parse(latest.payload_json).messageId===spec.sourceTurnMessageId}
 catch{return false}
}
export function assertAssistantStructuredSourceCurrent(db,taskId,spec,{turnMessageId}={}){
 if(!isAssistantStructuredSourceCurrent(db,taskId,spec))
  throw fail("assistant_deliverable_source_turn_stale",409);
 if(spec?.deliverableType&&(spec.planVersion!==db.prepare("SELECT active_plan_version FROM assistant_tasks WHERE id=?").get(taskId)?.active_plan_version||
  turnMessageId!==undefined&&turnMessageId!==spec.sourceTurnMessageId))
  throw fail("assistant_deliverable_source_binding_invalid",409);
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
  if(binding.spec.deliverableType){
   const current=currentAssistantTextDeliverable(db,taskId);
   if(!current||current.digest!==binding.spec.requirementDigest||
    current.planVersion!==expectedPlanVersion)
    throw fail("assistant_deliverable_spec_changed");
  }
  const approval=JSON.parse(step.approval_json);
  if(approval.decision!=="approved"||approval.actionDigest!==actionDigest||
   approval.planVersion!==expectedPlanVersion||approval.projectRevision!==pre.projectRevision)
   throw fail("assistant_step_approval_required");
  const receipt=JSON.parse(step.receipt_json),doc=JSON.parse(task.document_json);
  const projectDigest=sha(doc),receiptDigest=sha(receipt);
  let reason=binding.spec.deliverableType&&
   !isAssistantStructuredSourceCurrent(db,taskId,binding.spec)?
    "assistant_deliverable_source_turn_stale":null;
  if(task.revision!==receipt.projectRevision||projectDigest!==receipt.projectGraphDigest)
   reason="assistant_deliverable_source_changed";
  const byId=new Map((doc.nodes??[]).map(n=>[n.id,n]));
  const cardActions=new Map(action.actions.filter(a=>a.type==="create_text"||
   a.type==="create_node"&&a.nodeType==="text").map(a=>[a.ref,a]));
  const checkedNodeDigests={};
  if(!reason)for(const c of binding.spec.entries??binding.spec.characters){
   const nodeId=receipt.refs?.nodes?.[c.ref],node=byId.get(nodeId),planned=cardActions.get(c.ref);
   const body=node?.metadata?.content;
   if(!node||node.type!=="text"||node.title!==c.title||!planned||
    (body??"")!==(planned.content??"")||
    !binding.spec.allowEmptyTemplate&&
     (meaningful(body)<(binding.spec.minMeaningfulChars??18)||
      (!binding.spec.deliverableType&&emptyLabels(body)>=3)||
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
