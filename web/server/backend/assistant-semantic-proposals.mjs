/** P3: Model suggestions are explicitly non-executable, unconfirmed Task events.
 * Only completed, journalled model calls may produce these rows; the browser
 * cannot submit a replacement model answer or candidate body.
 */
import {randomUUID,createHash} from "node:crypto";
import {stableJson,writeTransaction,assertNoRawCredentials} from "./repository.mjs";

const fail=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const validId=v=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const sensitive=v=>/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[:=]\s*\S+/i.test(v)||
 /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_-]{16,})/i.test(v);
const digest=v=>createHash("sha256").update(stableJson(v)).digest("hex");
function policy(value){
 if(!value||typeof value!=="object"||typeof value.includeContext!=="boolean"||
  !["selection","overview"].includes(value.scope)||!Array.isArray(value.includedIds)||
  value.includedIds.length>12||value.includedIds.some(v=>typeof v!=="string"||v.length>128))
  throw fail("assistant_semantic_proposal_invalid");
 return {includeContext:value.includeContext,scope:value.scope,
  includedIds:[...new Set(value.includedIds)]};
}
function visibleTo(current,source){
 if(!source.includeContext)return true;
 if(!current.includeContext||source.scope!==current.scope)return false;
 return source.scope==="overview"||source.includedIds.every(id=>current.includedIds.includes(id));
}
function ensureProject(db,projectId,taskId){
 if(!validId(projectId)||!validId(taskId))throw fail("assistant_semantic_proposal_invalid");
 if(!db.prepare("SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId))
  throw fail("project_not_found",404);
 const task=db.prepare("SELECT * FROM assistant_tasks WHERE project_id=? AND id=?").get(projectId,taskId);
 if(!task)throw fail("assistant_task_not_found",404);
 return task;
}
function event(db,taskId,kind,payload){
 db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
  .run(taskId,kind,stableJson(payload),Date.now());
}
/** Invalid model JSON yields zero suggestions. Nothing is ever self-approved. */
export function parseAssistantSemanticCandidates(answer){
 if(typeof answer!=="string"||Buffer.byteLength(answer,"utf8")>8192)return [];
 let source=answer.trim();
 const fence=source.match(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i);
 if(fence)source=fence[1];
 let parsed;
 try{parsed=JSON.parse(source)}catch{return []}
 if(!parsed||Array.isArray(parsed)||!Array.isArray(parsed.proposals)||parsed.proposals.length>5)return [];
 const out=[],seen=new Set();
 for(const item of parsed.proposals){
  if(!item||typeof item!=="object"||Array.isArray(item)||
   !["goal","constraint","decision"].includes(item.kind)||typeof item.text!=="string")continue;
  const text=item.text.trim(),max=item.kind==="goal"?600:400;
  if(!text||text.length>max||Buffer.byteLength(text,"utf8")>1024||sensitive(text))continue;
  const key=item.kind+":"+text.toLocaleLowerCase();
  if(seen.has(key))continue;
  seen.add(key);out.push({kind:item.kind,text});
 }
 return out;
}
/** Stored atomically with a completed model-infer command. */
export function prepareAssistantSemanticProposals({answer,requestId,turnMessageId,contextPolicy}){
 if(!validId(requestId)||!validId(turnMessageId))throw fail("assistant_semantic_proposal_invalid");
 const frozen=policy(contextPolicy),candidates=parseAssistantSemanticCandidates(answer)
  .map(item=>({...item,id:randomUUID()}));
 return {requestId,turnMessageId,contextPolicy:frozen,candidates,source:"model_suggested"};
}
export function recordAssistantSemanticProposalsInTransaction(db,{taskId,proposals}){
 if(!Array.isArray(proposals?.candidates))throw fail("assistant_semantic_proposal_invalid");
 event(db,taskId,"semantic_proposals_generated",proposals);
}
function all(db,taskId){
 const events=db.prepare("SELECT seq,kind,payload_json FROM assistant_task_events WHERE task_id=? AND kind IN ('semantic_proposals_generated','semantic_proposal_decided') ORDER BY seq DESC LIMIT 200")
  .all(taskId).reverse();
 const candidates=new Map(),decisions=new Map();
 for(const row of events){
  let value;
  try{value=JSON.parse(row.payload_json)}catch{continue}
  if(row.kind==="semantic_proposals_generated"){
   if(!Array.isArray(value.candidates)||!value.contextPolicy)continue;
   for(const item of value.candidates)
    if(validId(item.id)&&["goal","constraint","decision"].includes(item.kind))
     candidates.set(item.id,{...item,requestId:value.requestId,
      contextPolicy:value.contextPolicy,source:"model_suggested",seq:row.seq});
  }else if(validId(value.proposalId))decisions.set(value.proposalId,value.decision==="accept"?"accepted":"rejected");
 }
 return [...candidates.values()].map(p=>({...p,status:decisions.get(p.id)??"pending"}))
  .sort((a,b)=>b.seq-a.seq);
}
export function listAssistantSemanticProposals(db,{projectId,taskId}){
 ensureProject(db,projectId,taskId);
 return {proposals:all(db,taskId).slice(0,50)};
}
/** User action is atomic: one accepted proposal -> one confirmed semantic
 * revision plus one decision event. Reject only records the decision.
 * The source disclosure policy is retained even if the current UI is wider.
 */
export function decideAssistantSemanticProposal(db,{projectId,taskId,proposalId,requestId,
 decision,expectedRevision,confirmed,contextPolicy}){
 if(!validId(proposalId)||!validId(requestId)||!["accept","reject"].includes(decision)||
  confirmed!==true||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)
  throw fail("assistant_semantic_proposal_invalid");
 const currentPolicy=policy(contextPolicy);
 const payload={taskId,proposalId,decision,expectedRevision,confirmed,contextPolicy:currentPolicy};
 return writeTransaction(db,()=>{
  const task=ensureProject(db,projectId,taskId);
  const signature=digest({kind:"semantic_proposal_decision",payload});
  const prior=db.prepare("SELECT command_kind,payload_digest,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?").get(projectId,requestId);
  if(prior){
   if(prior.command_kind!=="semantic_proposal_decision"||prior.payload_digest!==signature)
    throw fail("assistant_task_command_conflict",409);
   return {...JSON.parse(prior.response_json),existing:true};
  }
  if(task.read_only||task.cancel_requested_at!==null||["completed","cancelled","cancelling"].includes(task.status))
   throw fail("assistant_task_not_editable",409);
  const found=all(db,taskId).find(item=>item.id===proposalId);
  if(!found)throw fail("assistant_semantic_proposal_not_found",404);
  if(found.status!=="pending")throw fail("assistant_semantic_proposal_decided",409);
  const sourcePolicy=policy(found.contextPolicy);
  if(decision==="accept"&&!visibleTo(currentPolicy,sourcePolicy))throw fail("assistant_semantic_proposal_scope_changed",409);
  const goal=JSON.parse(task.goal_json),constraints=JSON.parse(task.constraints_json);
  const semantic=constraints.semantic??{revision:0,notes:[]};
  const revision=Number.isSafeInteger(semantic.revision)?semantic.revision:0;
  if(revision!==expectedRevision)throw fail("assistant_task_semantic_conflict",409);
  let noteId=null;
  if(decision==="accept"){
   const notes=Array.isArray(semantic.notes)?semantic.notes:[];
   if(found.kind==="goal")
    goal.current={text:found.text,provenance:"user_confirmed",confirmedAt:Date.now(),
     contextPolicy:sourcePolicy};
   else{
    if(notes.length>=16)throw fail("assistant_task_semantic_limit",409);
    noteId=randomUUID();
    semantic.notes=[...notes,{id:noteId,kind:found.kind,text:found.text,
     provenance:"user_confirmed",confirmedAt:Date.now(),contextPolicy:sourcePolicy}];
   }
   semantic.revision=revision+1;constraints.semantic=semantic;
   assertNoRawCredentials({goal,constraints});
   const goalJson=stableJson(goal),constraintsJson=stableJson(constraints);
   if(Buffer.byteLength(goalJson)>8000||Buffer.byteLength(constraintsJson)>16000)
    throw fail("assistant_task_payload_too_large",413);
   db.prepare("UPDATE assistant_tasks SET goal_json=?,constraints_json=?,updated_at=? WHERE id=? AND project_id=?")
    .run(goalJson,constraintsJson,Date.now(),taskId,projectId);
   event(db,taskId,"semantic_user_confirmed",{
    revision:revision+1,operation:found.kind==="goal"?"set_goal":
     found.kind==="constraint"?"add_constraint":"add_decision",
    noteId,sourceProposalId:proposalId,contentDigest:digest(found.text),executionStarted:false});
  }  event(db,taskId,"semantic_proposal_decided",{proposalId,decision,
   noteId,sourceRequestId:found.requestId,semanticRevision:decision==="accept"?revision+1:revision,
   executionStarted:false});
  const response={proposalId,decision,semanticRevision:decision==="accept"?revision+1:revision,
   executionStarted:false};
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,?,?,'completed',?,?)")
   .run(projectId,requestId,taskId,"semantic_proposal_decision",signature,stableJson(response),Date.now());
  return {...response,existing:false};
 });
}
