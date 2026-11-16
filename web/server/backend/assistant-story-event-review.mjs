/** P4.9i: source-frozen, user-driven editorial review of Story Event IR.
 *
 * This creates audit events ONLY. It never modifies semantic user-confirmed
 * facts, canvas transactions, model commands, or Task completion state.
 */
import {createHash} from "node:crypto";
import {stableJson,writeTransaction} from "./repository.mjs";
import {assistantModelCommandTurns} from "./assistant-model-command-turns.mjs";
import {mayRepeatTurn} from "./assistant-task-context.mjs";
import {hasSelectedAssistantCreativeMaterials} from "./assistant-creative-materials.mjs";
import {isStoryEventRevisionIntent} from "./assistant-story-event-context.mjs";
import {defineStoryEventCatalog,extractStoryEventIR,compareStoryEventIR} from "./assistant-story-event-ir.mjs";

const fail=(code,statusCode=409)=>{throw Object.assign(Error(code),{code,statusCode})};
const goodId=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const goodDigest=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
const digest=x=>createHash("sha256").update(stableJson(x)).digest("hex");
const catalog=defineStoryEventCatalog();
const catalogDigest=digest(catalog);
const shotTitle=/^\s*(?:【\s*)?(?:修订)?(?:镜头|分镜)\s*0?[1-9](?=$|[^\d])/;
const completedActions=row=>{
 if(row.status!=="completed")return null;
 let response;
 try{response=JSON.parse(row.response_json)}catch{return null}
 if(!Array.isArray(response?.actions)||response.actions.length>120)return null;
 const storyboard=response.actions.filter(a=>
  (a?.type==="create_text"||a?.type==="create_node"&&a.nodeType==="text")&&
  shotTitle.test(a?.title??"")&&typeof a.content==="string"&&
  a.content.length<=40000);
 if(storyboard.length<2)return null;
 return storyboard;
};
function validateOwnership(db,projectId,taskId){
 if(!goodId(projectId)||!goodId(taskId))fail("assistant_story_review_invalid",400);
 const project=db.prepare("SELECT revision FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId);
 if(!project)fail("project_not_found",404);
 const task=db.prepare("SELECT id,status,active_plan_version,read_only,cancel_requested_at,constraints_json FROM assistant_tasks WHERE id=? AND project_id=?").get(taskId,projectId);
 if(!task)fail("assistant_task_not_found",404);
 return {project,task};
}
function currentTurn(db,taskId,turnMessageId){
 if(!goodId(turnMessageId))fail("assistant_story_review_invalid",400);
 const latest=db.prepare("SELECT seq,payload_json FROM assistant_task_events WHERE task_id=? AND kind='user_turn' ORDER BY seq DESC LIMIT 1").get(taskId);
 if(!latest)fail("assistant_task_turn_not_found",404);
 let turn;
 try{turn=JSON.parse(latest.payload_json)}catch{fail("assistant_story_review_invalid_source")}
 if(turn.messageId!==turnMessageId)fail("assistant_story_review_turn_stale");
 if(!turn.contextPolicy||typeof turn.contextPolicy.includeContext!=="boolean"||
  !isStoryEventRevisionIntent(turn.preview??""))
  fail("assistant_story_review_not_revision",400);
 return {...turn,seq:latest.seq};
}
function verifiedCalls(db,taskId,requestId){
 const calls=db.prepare("SELECT status FROM assistant_model_calls WHERE task_id=? AND request_id=? ORDER BY call_index")
  .all(taskId,requestId);
 return calls.length>0&&calls.every(c=>c.status==="succeeded");
}
function sourceDrafts(db,{taskId,turn,turnMessageId}){
 // Resolve provenance from server-side model_command_started receipts. A
 // completed model reply with an absent/mismatched binding is NOT a source.
 const bound=assistantModelCommandTurns(db,taskId);
 const turns=db.prepare("SELECT seq,payload_json FROM assistant_task_events WHERE task_id=? AND kind='user_turn' AND seq<=? ORDER BY seq DESC LIMIT 160")
  .all(taskId,turn.seq);
 const byTurn=new Map();
 for(const row of turns){
  let item;
  try{item=JSON.parse(row.payload_json)}catch{continue}
  if(goodId(item?.messageId)&&item.contextPolicy&&!byTurn.has(item.messageId))
   byTurn.set(item.messageId,{...item,seq:row.seq});
 }
 const rows=db.prepare("SELECT request_id,payload_digest,response_json,status,created_at FROM assistant_task_commands WHERE task_id=? AND command_kind='model_infer' ORDER BY created_at DESC,rowid DESC LIMIT 80").all(taskId);
 const started=db.prepare("SELECT seq FROM assistant_task_events WHERE task_id=? AND kind='model_command_started' AND json_extract(payload_json,'$.requestId')=? ORDER BY seq DESC LIMIT 1");
 const results=[];
 let seenCurrent=false;
 for(const row of rows){
  const boundTurnId=bound(row),srcTurn=byTurn.get(boundTurnId);
  if(!boundTurnId||!srcTurn||!mayRepeatTurn(turn.contextPolicy,srcTurn.contextPolicy))continue;
  if(srcTurn.seq>turn.seq)continue;
  const startSeq=started.get(taskId,row.request_id)?.seq;
  if(!Number.isInteger(startSeq))continue;
  // A source from an older user turn cannot retroactively become history if
  // its Provider call actually began after this revision turn was recorded.
  if(boundTurnId!==turnMessageId&&startSeq>=turn.seq)continue;
  if(boundTurnId===turnMessageId&&startSeq<=turn.seq)continue;
  // Previously pinned materials may contain private source references not
  // disclosed by a later unpinned revision; fail closed for those drafts.
  if(boundTurnId!==turnMessageId&&hasSelectedAssistantCreativeMaterials(db,taskId,boundTurnId))continue;
  if(boundTurnId===turnMessageId)seenCurrent=true;
  // When current revision has an ambiguous call, do not fall back to an old
  // completed result. This is a hard safety boundary on auto review.
  if(boundTurnId===turnMessageId&&row.status!=="completed")
   fail("assistant_story_review_model_unresolved");
  if(row.status!=="completed"||!verifiedCalls(db,taskId,row.request_id))continue;
  const actions=completedActions(row);
  if(!actions){
   if(boundTurnId===turnMessageId)fail("assistant_story_review_revision_missing");
   continue;
  }
  const draft={requestId:row.request_id,turnMessageId:boundTurnId,
   responseDigest:digest(row.response_json),ir:extractStoryEventIR(actions,{catalog})};
  if(boundTurnId===turnMessageId){
   // If this revision turn has multiple completed commands, the most recent
   // wins. The caller cannot nominate a previous result by request ID.
   if(!results.some(r=>r.turnMessageId===turnMessageId))results.unshift(draft);
  }else if(results.length===1&&results[0].turnMessageId===turnMessageId){
   // Only a prior user turn is a valid base, not a second answer for this turn.
   results.push(draft);
   break;
  }
 }
 if(!seenCurrent||results[0]?.turnMessageId!==turnMessageId)
  fail("assistant_story_review_revision_missing");
 if(results.length!==2)fail("assistant_story_review_source_missing");
 return {revision:results[0],source:results[1]};
}
const projected=e=>({
 id:e.id,label:e.label,shotIndex:e.source.shotIndex,
 actor:e.actor,target:e.target,action:e.action,
 transition:e.transition,temporal:e.temporal,
 bodyDigest:e.source.bodyDigest,evidenceDigest:e.source.evidenceDigest,
 provenance:"ai_draft_unconfirmed",userConfirmed:false
});
function decisions(db,taskId,snapshotDigest){
 const rows=db.prepare("SELECT payload_json FROM assistant_task_events WHERE task_id=? AND kind='story_event_review_decided' ORDER BY seq DESC LIMIT 300").all(taskId).reverse();
 const result=new Map();
 for(const row of rows){
  let x;try{x=JSON.parse(row.payload_json)}catch{continue}
  if(x?.snapshotDigest===snapshotDigest&&goodId(x.eventId)&&
   ["acknowledge_candidate","request_revision"].includes(x.decision))
   result.set(x.eventId,{eventId:x.eventId,decision:x.decision,requestId:x.requestId});
 }
 return [...result.values()];
}
/** GET review: read-only and reconstructable from current project/Task/model
 * evidence. A snapshot is never model-controlled, and has no execution grant.
 */
export function inspectAssistantStoryEventReview(db,{projectId,taskId,turnMessageId}){
 const {project,task}=validateOwnership(db,projectId,taskId);
 const turn=currentTurn(db,taskId,turnMessageId);
 if(hasSelectedAssistantCreativeMaterials(db,taskId,turnMessageId))
  fail("assistant_story_review_source_pinned");
 const {source,revision}=sourceDrafts(db,{taskId,turn,turnMessageId});
 const changes=compareStoryEventIR(source.ir,revision.ir,{catalog});
 let semanticRevision=0;
 try{semanticRevision=JSON.parse(task.constraints_json)?.semantic?.revision??0}
 catch{fail("assistant_story_review_invalid_source")}
 const snapshotDigest=digest({version:1,projectId,taskId,turnMessageId,
  turnSeq:turn.seq,contextPolicy:turn.contextPolicy,
  projectRevision:project.revision,activePlanVersion:task.active_plan_version,
  semanticRevision,catalogDigest,
  sourceRequestId:source.requestId,sourceResponseDigest:source.responseDigest,
  revisionRequestId:revision.requestId,revisionResponseDigest:revision.responseDigest});
 const reviewed=decisions(db,taskId,snapshotDigest);
 const reviewedMap=new Map(reviewed.map(x=>[x.eventId,x.decision]));
 const sourceEvents=changes.sourceEvents.map(projected);
 const revisionEvents=changes.revisionEvents.map(projected);
 const comparison=sourceEvents.map(event=>({
  eventId:event.id,label:event.label,sourceShotIndex:event.shotIndex,
  revisionShotIndex:revisionEvents.find(x=>x.id===event.id)?.shotIndex??null,
  detected:revisionEvents.some(x=>x.id===event.id),
  warnings:changes.warnings.filter(x=>x.id===event.id).map(x=>x.code),
  decision:reviewedMap.get(event.id)??"pending"
 }));
 const pending=comparison.some(x=>x.decision==="pending");
 return {version:1,kind:"story_event_editorial_review",taskId,turnMessageId,
  snapshotDigest,projectRevision:project.revision,
  activePlanVersion:task.active_plan_version,
  semanticRevision,source:{requestId:source.requestId,digest:source.responseDigest},
  revision:{requestId:revision.requestId,digest:revision.responseDigest},
  catalogDigest,sourceEvents,revisionEvents,comparison,
  warnings:changes.warnings.map(x=>({id:x.id,code:x.code,afterEventId:x.afterEventId??null})),
  reviewed,reviewStatus:sourceEvents.length===0?"no_source_candidates":
   pending?"pending":"recorded_only",
  sourceType:"unconfirmed_ai_storyboard",userConfirmed:false,
  semanticReview:"pending",canvasExecutionAuthorized:false,taskCompletionAuthorized:false};
}
/** Explicit single-user editorial decision; does not accept any source body,
 * claimed event IR, plan, or Canvas actions from the browser.
 */
export function decideAssistantStoryEventReview(db,{projectId,taskId,turnMessageId,
 requestId,snapshotDigest,eventId,decision,confirmed}){
 if(![projectId,taskId,turnMessageId,requestId,eventId].every(goodId)||
  !goodDigest(snapshotDigest)||!["acknowledge_candidate","request_revision"].includes(decision)||
  confirmed!==true)fail("assistant_story_review_invalid",400);
 const payload={projectId,taskId,turnMessageId,snapshotDigest,eventId,decision,confirmed};
 return writeTransaction(db,()=>{
  const task=validateOwnership(db,projectId,taskId).task;
  const signature=digest({kind:"story_event_review_decision",payload});
  const prior=db.prepare("SELECT command_kind,payload_digest,status,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?").get(projectId,requestId);
  if(prior){
   if(prior.command_kind!=="story_event_review_decision"||prior.payload_digest!==signature||
    prior.status!=="completed")fail("assistant_task_command_conflict");
   const cached=JSON.parse(prior.response_json);
   let current=false;
   try{current=inspectAssistantStoryEventReview(db,{projectId,taskId,turnMessageId}).snapshotDigest===snapshotDigest}
   catch{current=false}
   return {...cached,existing:true,current};
  }
  if(task.read_only||task.cancel_requested_at!==null||
   ["completed","cancelled","cancelling"].includes(task.status))
   fail("assistant_task_not_editable");
  const preview=inspectAssistantStoryEventReview(db,{projectId,taskId,turnMessageId});
  if(preview.snapshotDigest!==snapshotDigest)fail("assistant_story_review_snapshot_stale");
  if(!preview.comparison.some(x=>x.eventId===eventId))
   fail("assistant_story_review_event_unknown");
  // Only the original request ID may replay an existing decision. A new
  // request ID must never silently reuse a decision without its own audit.
  if(preview.reviewed.some(x=>x.eventId===eventId))
   fail("assistant_story_review_decision_conflict");
  const record={requestId,turnMessageId,snapshotDigest,eventId,decision,
   sourceRequestId:preview.source.requestId,
   revisionRequestId:preview.revision.requestId,
   projectRevision:preview.projectRevision,createdAt:Date.now(),
   sourceType:"unconfirmed_ai_storyboard",userConfirmed:false,
   canvasExecutionAuthorized:false,taskCompletionAuthorized:false};
  db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,'story_event_review_decided',?,?)")
   .run(taskId,stableJson(record),Date.now());
  const response={eventId,decision,snapshotDigest,current:true,
   userConfirmed:false,canvasExecutionAuthorized:false,taskCompletionAuthorized:false};
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,'story_event_review_decision',?,'completed',?,?)")
   .run(projectId,requestId,taskId,signature,stableJson(response),Date.now());
  return {...response,existing:false};
 });
}
