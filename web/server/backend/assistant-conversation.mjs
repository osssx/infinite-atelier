import {createHash} from "node:crypto";
import {assertNoRawCredentials,stableJson,writeTransaction} from "./repository.mjs";
import {mayRepeatTurn,safe,stripAssistantGraphAnnotations} from "./assistant-task-context.mjs";
import {describeAssistantReadableCanvasNode} from "./assistant-agent-read-tools.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const digest=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const emptyPolicy={includeContext:false,scope:"selection",includedIds:[]};
const MAX_MESSAGES=20,MAX_BYTES=96*1024;
export const MAX_CANVAS_CHAT_SESSIONS=500,MAX_CANVAS_CHAT_SNAPSHOT_BYTES=4*1024*1024;
const CHECKPOINT_VERSION=1,CHECKPOINT_GROUP=8,CHECKPOINT_ENTRIES=16;
const CHECKPOINT_BYTES=8*1024-1700;
const SAFE_SKILL_FALLBACK_CODES=new Set(["assistant_skill_catalog_changed","assistant_skill_unavailable",
 "assistant_skill_context_too_large"]);
const redactDurableText=value=>value.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_-]{16,}/gi,"[敏感值省略]")
 .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,"$1[凭据省略]")
 .replace(/data:(?:image|video|audio)\/[^\s]+/gi,"[媒体数据省略]");
export function sanitizeConversationReply(response){
 return {...response,
  ...(typeof response.answer==="string"?{answer:redactDurableText(response.answer)}:{})};
}
export function ordinaryConversationPolicy(value,visual,project){
 const media=visual?.images??[];
 const requested=value?.includeContext===true?value:emptyPolicy;
 const includedIds=requested.includeContext?requested.includedIds:[];
 const nodes=new Set(project.document.nodes.map(node=>node.id));
 if(includedIds.some(id=>!nodes.has(id)))throw fail("assistant_task_context_not_authorized",403);
 return {...requested,includedIds,revision:project.revision,...(media.length?{opaque:true}:{})};
}

export function recoverConversationRequests(db){
 db.exec(`UPDATE assistant_conversation_requests SET state='failed'
  WHERE state='needs_reconcile' AND error_code IN (
   'assistant_actions_invalid','assistant_actions_missing','assistant_creative_content_incomplete')`);
 db.exec(`UPDATE assistant_conversation_requests
  SET state=CASE state WHEN 'submitting' THEN 'needs_reconcile' ELSE 'failed' END,
  error_code=CASE state WHEN 'submitting' THEN 'assistant_model_call_unknown' ELSE 'assistant_stream_interrupted' END
  WHERE state IN ('pending','submitting')`);
}

export function findConversationRequest(db,{projectId,chatSessionId,turnId,requestId,requestPayload}){
 assertConversation(db,projectId,chatSessionId);
 const row=db.prepare(`SELECT r.state,r.digest,r.response_json,r.error_code
 FROM assistant_conversation_turns t JOIN assistant_conversation_requests r ON r.turn_seq=t.seq
 WHERE t.project_id=? AND t.session_id=? AND t.turn_id=? AND r.request_id=?`)
  .get(projectId,chatSessionId,turnId,requestId);
 if(row&&requestPayload&&row.digest!==digest(requestPayload))throw fail("assistant_conversation_request_conflict");
 return row?{state:row.state,response:row.response_json?JSON.parse(row.response_json):null,errorCode:row.error_code}:null;
}

function assertActiveProject(db,projectId){
 if(!db.prepare("SELECT id FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId))
  throw fail("assistant_conversation_not_found",404);
}
function assertConversation(db,projectId,chatSessionId){
 assertActiveProject(db,projectId);
 if(db.prepare("SELECT 1 FROM assistant_conversation_deletions WHERE project_id=? AND session_id=?").get(projectId,chatSessionId))
  throw fail("assistant_conversation_not_found",404);
}

export function assertConversationTaskTurn(db,{projectId,chatSessionId,taskId,turnId}){
 const row=db.prepare(`
 SELECT t.chat_session_id,e.payload_json FROM assistant_tasks t
 JOIN assistant_task_events e ON e.task_id=t.id
 WHERE t.project_id=? AND t.id=? AND e.kind='user_turn' AND json_extract(e.payload_json,'$.messageId')=?
 ORDER BY e.seq DESC LIMIT 1`).get(projectId,taskId,turnId);
 if(!row||(JSON.parse(row.payload_json).chatSessionId??row.chat_session_id)!==chatSessionId)
  throw fail("assistant_history_quote_scope",403);
}

/** Freeze the history boundary by reserving a turn sequence before inference. */
export function beginConversationRequest(db,{projectId,chatSessionId,turnId,requestId,taskId=null,
 userText,requestPayload,continuation=false,policy=emptyPolicy}){
 if(typeof userText!=="string"||!userText.trim()||Buffer.byteLength(userText)>MAX_BYTES)
  throw fail("assistant_context_budget_insufficient",413);
 const storedUserText=redactDurableText(userText);
 const requestDigest=digest(requestPayload);
 return writeTransaction(db,()=>{
  assertConversation(db,projectId,chatSessionId);
  const turn=db.prepare("SELECT seq,user_text,task_id FROM assistant_conversation_turns WHERE project_id=? AND session_id=? AND turn_id=?")
   .get(projectId,chatSessionId,turnId);
  if(turn&&(turn.task_id!==taskId||!continuation&&turn.user_text!==storedUserText))
   throw fail("assistant_conversation_request_conflict");
  if(turn){
   const old=db.prepare("SELECT digest,state,response_json,error_code FROM assistant_conversation_requests WHERE turn_seq=? AND request_id=?").get(turn.seq,requestId);
   if(old){
    if(old.digest!==requestDigest)throw fail("assistant_conversation_request_conflict");
    if(old.state==="completed")return {cached:true,response:JSON.parse(old.response_json)};
    if(old.state==="pending"||old.state==="submitting")throw fail("assistant_conversation_busy");
    if(old.state==="needs_reconcile")throw fail("assistant_model_call_unknown");
    throw fail(old.error_code??"assistant_failed");
   }
   const latest=db.prepare("SELECT state,final,response_json,error_code FROM assistant_conversation_requests WHERE turn_seq=? ORDER BY rowid DESC LIMIT 1").get(turn.seq);
   const canContinue=continuation&&latest?.state==="completed"&&!latest.final&&
    JSON.parse(latest.response_json).skillScriptProposal;
   const canFallback=!continuation&&requestId===turnId+"-model-skill-fallback"&&latest?.state==="failed"&&
    SAFE_SKILL_FALLBACK_CODES.has(latest.error_code);
   if(latest&&!canContinue&&!canFallback)throw fail("assistant_conversation_request_conflict");
  }
  const active=db.prepare(`
   SELECT 1 FROM assistant_conversation_requests r JOIN assistant_conversation_turns t ON t.seq=r.turn_seq
   WHERE t.project_id=? AND t.session_id=? AND r.state IN ('pending','submitting') LIMIT 1`).get(projectId,chatSessionId);
  if(active)throw fail("assistant_conversation_busy");
  if(continuation&&(!turn||db.prepare("SELECT MAX(seq) AS seq FROM assistant_conversation_turns WHERE project_id=? AND session_id=?")
   .get(projectId,chatSessionId).seq!==turn.seq))throw fail("assistant_conversation_request_conflict");
  if(!turn&&!db.prepare("SELECT 1 FROM assistant_conversation_turns WHERE project_id=? AND session_id=? LIMIT 1")
   .get(projectId,chatSessionId)){
   const snapshot=db.prepare("SELECT sessions_json FROM project_chats WHERE project_id=?").get(projectId);
   const ids=new Set(JSON.parse(snapshot?.sessions_json??"[]").map(session=>session.id));
   for(const row of db.prepare("SELECT DISTINCT session_id FROM assistant_conversation_turns WHERE project_id=?").all(projectId))
    ids.add(row.session_id);
   ids.add(chatSessionId);
   if(ids.size>MAX_CANVAS_CHAT_SESSIONS)throw fail("assistant_conversation_limit");
  }
  const seq=turn?.seq??Number(db.prepare("INSERT INTO assistant_conversation_turns(project_id,session_id,turn_id,user_text,task_id,created_at) VALUES(?,?,?,?,?,?)")
   .run(projectId,chatSessionId,turnId,storedUserText,taskId,Date.now()).lastInsertRowid);
  db.prepare("INSERT INTO assistant_conversation_requests(turn_seq,request_id,digest,state,policy_json) VALUES(?,?,?,'pending',?)")
   .run(seq,requestId,requestDigest,stableJson(policy));
  return {seq,requestId,projectId,chatSessionId};
 });
}

export function startConversationSubmission(db,request,policy){
 return writeTransaction(db,()=>{
  assertConversation(db,request.projectId,request.chatSessionId);
  const row=db.prepare("UPDATE assistant_conversation_requests SET state='submitting',policy_json=? WHERE turn_seq=? AND request_id=? AND state IN ('pending','submitting')")
   .run(stableJson(policy),request.seq,request.requestId);
  if(!row.changes)throw fail("assistant_conversation_request_conflict");
 });
}

/** Caller may already own the Task command transaction. */
export function completeConversationRequestInTransaction(db,request,response,toolRefs=[]){
 assertConversation(db,request.projectId,request.chatSessionId);
 assertNoRawCredentials(response);
 const serialized=JSON.stringify(sanitizeConversationReply(response));
 if(Buffer.byteLength(serialized)>1024*1024)throw fail("assistant_model_result_too_large",413);
 const final=response.skillScriptProposal?0:1;
 if(final)db.prepare("UPDATE assistant_conversation_requests SET final=0 WHERE turn_seq=?").run(request.seq);
 if(!db.prepare("UPDATE assistant_conversation_requests SET state='completed',final=?,response_json=? WHERE turn_seq=? AND request_id=? AND state IN ('submitting','pending')")
  .run(final,serialized,request.seq,request.requestId).changes)throw fail("assistant_conversation_request_conflict");
 const insert=db.prepare("INSERT INTO assistant_conversation_tool_refs(turn_seq,request_id,call_id,kind,node_ids_json) VALUES(?,?,?,?,?)");
 for(const ref of toolRefs)insert.run(request.seq,request.requestId,ref.callId,ref.kind,stableJson(ref.nodeIds));
}

export function completeConversationRequest(db,request,response){
 return writeTransaction(db,()=>completeConversationRequestInTransaction(db,request,response));
}

export function failConversationRequest(db,request,errorCode){
 const knownFormatFailure=["assistant_actions_invalid","assistant_actions_missing","assistant_creative_content_incomplete"].includes(errorCode);
 return db.prepare(`UPDATE assistant_conversation_requests SET state=CASE WHEN state='submitting' AND ?=0 THEN 'needs_reconcile' ELSE 'failed' END,error_code=?
 WHERE turn_seq=? AND request_id=? AND state IN ('pending','submitting') RETURNING state`)
  .get(Number(knownFormatFailure),errorCode,request.seq,request.requestId)?.state;
}

export function removeConversationInTransaction(db,projectId,chatSessionId){
 db.prepare("INSERT OR IGNORE INTO assistant_conversation_deletions(project_id,session_id) VALUES(?,?)").run(projectId,chatSessionId);
 db.prepare("DELETE FROM assistant_conversation_checkpoints WHERE project_id=? AND session_id=?").run(projectId,chatSessionId);
 db.prepare("DELETE FROM assistant_conversation_turns WHERE project_id=? AND session_id=?").run(projectId,chatSessionId);
}

export function removeConversation(db,projectId,chatSessionId){
 return writeTransaction(db,()=>{
  assertActiveProject(db,projectId);
  removeConversationInTransaction(db,projectId,chatSessionId);
  const snapshot=db.prepare("SELECT sessions_json,active_chat_id FROM project_chats WHERE project_id=?").get(projectId);
  if(snapshot){
   const sessions=JSON.parse(snapshot.sessions_json);
   const retained=sessions.filter(session=>session.id!==chatSessionId);
   if(retained.length!==sessions.length){
    // The tombstone also filters stale PUTs, so this redaction does not
    // invalidate another tab's expected revision for unrelated chat edits.
    db.prepare("UPDATE project_chats SET sessions_json=?,active_chat_id=?,updated_at=? WHERE project_id=?")
     .run(stableJson(retained),snapshot.active_chat_id===chatSessionId?null:snapshot.active_chat_id,Date.now(),projectId);
   }
  }
  return {deleted:true};
 });
}

export function filterConversationSnapshot(db,projectId,snapshot){
 const deleted=new Set(db.prepare("SELECT session_id FROM assistant_conversation_deletions WHERE project_id=?").all(projectId).map(row=>row.session_id));
 return {...snapshot,sessions:snapshot.sessions.filter(session=>!deleted.has(session.id)),
  activeChatId:deleted.has(snapshot.activeChatId)?null:snapshot.activeChatId};
}

export function overlayConversationCatalog(db,projectId,snapshot){
 const filtered=filterConversationSnapshot(db,projectId,snapshot);
 const sessions=filtered.sessions;
 const known=new Set(sessions.map(session=>session.id));
 let snapshotBytes=Buffer.byteLength(stableJson(sessions));
 const managed=db.prepare(`SELECT session_id,MIN(created_at) AS created_at,MAX(created_at) AS updated_at
  FROM assistant_conversation_turns WHERE project_id=? GROUP BY session_id ORDER BY updated_at DESC,MAX(seq) DESC`).all(projectId);
 for(const row of managed){
  if(sessions.length>=MAX_CANVAS_CHAT_SESSIONS)break;
  if(known.has(row.session_id))continue;
  const first=db.prepare("SELECT user_text FROM assistant_conversation_turns WHERE project_id=? AND session_id=? ORDER BY seq LIMIT 1")
   .get(projectId,row.session_id);
  const recovered={id:row.session_id,title:first.user_text.slice(0,36),messages:[],
   createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};
  const bytes=Buffer.byteLength(stableJson(recovered))+(sessions.length?1:0);
  if(snapshotBytes+bytes>MAX_CANVAS_CHAT_SNAPSHOT_BYTES)continue;
  sessions.push(recovered);
  snapshotBytes+=bytes;
 }
 // Only infer a selection from recovered turns before the first chat save.
 // A saved null is the explicit selection of a new, blank conversation.
 const recoverSelection=snapshot.revision===1&&snapshot.sessions.length===0;
 const activeChatId=filtered.activeChatId??(recoverSelection?sessions[0]?.id:null)??null;
 return {...snapshot,sessions,activeChatId};
}

export function listConversationTurns(db,{projectId,chatSessionId,before=Number.MAX_SAFE_INTEGER,limit=25}){
 assertConversation(db,projectId,chatSessionId);
 const rows=db.prepare("SELECT seq,turn_id,user_text FROM assistant_conversation_turns WHERE project_id=? AND session_id=? AND seq<? ORDER BY seq DESC LIMIT ?")
  .all(projectId,chatSessionId,before,limit+1);
 const more=rows.length>limit;
 const requests=db.prepare("SELECT request_id,state,final,response_json,error_code FROM assistant_conversation_requests WHERE turn_seq=? ORDER BY rowid DESC");
 const turns=rows.slice(0,limit).map(row=>{
  const calls=requests.all(row.seq),final=calls.find(call=>call.final);
  const response=final?JSON.parse(final.response_json):null;
  const status=calls[0]?.state==="completed"&&!final?"awaiting_followup":calls[0]?.state??"failed";
  return {turnId:row.turn_id,userText:row.user_text,status,
   ...(response?{answer:response.actions?.length?
    "助手已提出画布操作。此处没有可核验的执行结果，请查看画布或 Task 记录。":response.answer}:{}),
   ...(calls[0]?.error_code?{errorCode:calls[0].error_code}:{})};
 });
 return {turns:turns.reverse(),nextBefore:more?rows[limit-1].seq:null};
}

function canRepeat(current,prior,project){
 if(prior.opaque||!mayRepeatTurn(current,prior))return false;
 if(!prior.includeContext)return true;
 if(prior.revision!==project.revision)return false;
 if(prior.scope==="overview")
  return prior.includedIds.every(id=>current.includedIds.includes(id));
 const nodes=new Set(project.document.nodes.map(node=>node.id));
 return prior.includedIds.every(id=>nodes.has(id));
}

export function resolveConversationToolReferences(db,conversation,{taskId,policy,project}){
 if(!taskId||!policy.includeContext||policy.scope!=="selection")return "";
 const allowed=new Set(policy.includedIds.slice(0,12));
 const nodes=new Map(project.document.nodes.map(node=>[node.id,node]));
 const entries=db.prepare(`SELECT refs.node_ids_json FROM assistant_conversation_tool_refs refs
  JOIN assistant_conversation_turns turns ON turns.seq=refs.turn_seq
  JOIN assistant_conversation_requests requests ON requests.turn_seq=refs.turn_seq AND requests.request_id=refs.request_id
  WHERE turns.project_id=? AND turns.session_id=? AND turns.task_id=? AND turns.seq<?
   AND refs.kind='canvas.read_nodes' AND requests.state='completed'
  ORDER BY turns.seq DESC,refs.call_id LIMIT 12`).all(conversation.projectId,conversation.chatSessionId,taskId,conversation.seq);
 const already=new Set(),lines=[];
 let size=0;
 for(const entry of entries){
  const ids=JSON.parse(entry.node_ids_json);
  if(!ids.every(id=>allowed.has(id)&&nodes.has(id)))continue;
  for(const id of ids){
   if(already.has(id))continue;
   const line=JSON.stringify(describeAssistantReadableCanvasNode(nodes.get(id)));
   size+=Buffer.byteLength(line)+1;
   if(size>1500)return lines.join("\n");
   already.add(id);
   lines.push(line);
  }
 }
 return lines.join("\n");
}

function validatedCheckpointEntries(db,conversation,entries,through){
 if(!Array.isArray(entries)||entries.length>CHECKPOINT_ENTRIES)return null;
 const load=db.prepare("SELECT user_text FROM assistant_conversation_turns WHERE seq=? AND project_id=? AND session_id=?");
 const validated=[];
 for(const entry of entries){
  if(!Number.isSafeInteger(entry?.seq)||entry.seq>through||
   entry.draft!==undefined&&(typeof entry.draft!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(entry.draft)))return null;
  const row=load.get(entry.seq,conversation.projectId,conversation.chatSessionId);
  if(!row||digest(row.user_text)!==entry.digest)return null;
  validated.push({...entry,text:safe(row.user_text,160)});
 }
 return validated;
}

function chooseCheckpointEntries(entries){
 return entries.length<=CHECKPOINT_ENTRIES?entries:
  [...entries.slice(0,CHECKPOINT_ENTRIES/2),...entries.slice(-CHECKPOINT_ENTRIES/2)];
}

function renderCheckpointEntries(db,entries,policy,project){
 const drafts=[],userText=[];
 const findDraft=db.prepare(`SELECT policy_json,response_json FROM assistant_conversation_requests
  WHERE turn_seq=? AND request_id=? AND final=1 AND state='completed'`);
 for(const entry of entries){
  userText.push("用户曾说："+JSON.stringify(entry.text));
  if(!entry.draft)continue;
  const row=findDraft.get(entry.seq,entry.draft);
  if(!row||!canRepeat(policy,JSON.parse(row.policy_json),project))continue;
  const draft=JSON.parse(row.response_json).answer;
  if(typeof draft==="string"&&draft.length>=60)drafts.push("未确认的旧草案："+JSON.stringify(safe(draft,300)));
 }
 const parts=[];
 let bytes=0;
 for(const line of [...userText,...drafts.slice(-2)]){
  const size=Buffer.byteLength(line)+1;
  if(bytes+size>CHECKPOINT_BYTES)break;
  parts.push(line);bytes+=size;
 }
 return parts.join("\n");
}

/** Store immutable sources. User statement excerpts remain distinct from
 * derived model drafts, whose canvas permission is checked on every render.
 * Confirmed Task goals and constraints are read live from the Task projection. */
function compactConversationPrefix(db,conversation,before,policy,project,onDiagnostic,{policyKey="explicit_user_text",force=false}={}){
 const {projectId,chatSessionId}=conversation;
 const prior=db.prepare(`SELECT through_seq,entries_json FROM assistant_conversation_checkpoints
  WHERE project_id=? AND session_id=? AND policy_key=? AND version=? AND through_seq<?
  ORDER BY through_seq DESC LIMIT 1`).get(projectId,chatSessionId,policyKey,CHECKPOINT_VERSION,before);
 let validated=null;
 if(prior){
  try{validated=validatedCheckpointEntries(db,conversation,JSON.parse(prior.entries_json),prior.through_seq);}
  catch{validated=null;}
  if(!validated)onDiagnostic?.("checkpoint_invalid");
 }
 const last=db.prepare(`SELECT seq FROM assistant_conversation_turns WHERE project_id=? AND session_id=? AND seq<?
  ORDER BY seq DESC LIMIT 1`).get(projectId,chatSessionId,before);
 if(!last)return "";
 const lower=validated?prior.through_seq:0;
 const count=db.prepare(`SELECT COUNT(*) AS count FROM assistant_conversation_turns
  WHERE project_id=? AND session_id=? AND seq>? AND seq<=?`).get(projectId,chatSessionId,lower,last.seq).count;
 if(count===0||!force&&count<CHECKPOINT_GROUP)
  return renderCheckpointEntries(db,validated??[],policy,project);
 const scope=[projectId,chatSessionId,lower,last.seq];
 const select=(order,limit)=>db.prepare(`SELECT t.seq,t.user_text,r.request_id AS draft
  FROM assistant_conversation_turns t LEFT JOIN assistant_conversation_requests r ON r.turn_seq=t.seq AND r.final=1
  WHERE t.project_id=? AND t.session_id=? AND t.seq>? AND t.seq<=? ORDER BY t.seq ${order} LIMIT ?`)
  .all(...scope,limit);
 const edge=count<=CHECKPOINT_ENTRIES?select("ASC",CHECKPOINT_ENTRIES):
  [...select("ASC",CHECKPOINT_ENTRIES/2),...select("DESC",CHECKPOINT_ENTRIES/2).reverse()];
 const next=chooseCheckpointEntries([...(validated??[]),...edge.map(row=>({seq:row.seq,digest:digest(row.user_text),
  text:safe(row.user_text,160),draft:row.draft}))]);
 // The captured prefix is immutable and this write is a single SQLite
 // statement. On failure, continue with the verified source excerpts.
 try{
  db.prepare(`INSERT INTO assistant_conversation_checkpoints(project_id,session_id,policy_key,through_seq,version,entries_json)
   VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,session_id,policy_key,through_seq,version)
   DO UPDATE SET entries_json=excluded.entries_json`).run(projectId,chatSessionId,policyKey,last.seq,CHECKPOINT_VERSION,
    stableJson(next.map(({seq,digest,draft})=>({seq,digest,...(draft?{draft}:{})}))));
 }catch{onDiagnostic?.("checkpoint_write_failed");}
 return renderCheckpointEntries(db,next,policy,project);
}

export function buildConversationMessages(db,conversation,{current,policy,project,restrict=false,onDiagnostic,
 retainedHistoryMode=null,reservedBytes=0}){
 if(reservedBytes&&Buffer.byteLength(current.content)+reservedBytes>MAX_BYTES)
  throw fail("assistant_context_budget_insufficient",413);
 if(restrict)return {messages:[current],policy:{...policy,opaque:true},compactedHistory:""};
 const policyKey=retainedHistoryMode? "retained:"+digest({
  mode:retainedHistoryMode,includeContext:policy.includeContext,scope:policy.scope,
  includedIds:[...new Set(policy.includedIds??[])].sort()
 }):null;
 const boundary=policyKey?db.prepare(`SELECT through_seq FROM assistant_conversation_checkpoints
  WHERE project_id=? AND session_id=? AND policy_key=? AND version=? AND through_seq<?
  ORDER BY through_seq DESC LIMIT 1`).get(conversation.projectId,conversation.chatSessionId,policyKey,CHECKPOINT_VERSION,conversation.seq):null;
 const history=db.prepare(`
 SELECT t.seq,t.user_text,r.policy_json,r.response_json
 FROM assistant_conversation_turns t LEFT JOIN assistant_conversation_requests r ON r.turn_seq=t.seq AND r.final=1
 WHERE t.project_id=? AND t.session_id=? AND t.seq<? AND t.seq>? ORDER BY t.seq DESC LIMIT 40`)
  .all(conversation.projectId,conversation.chatSessionId,conversation.seq,boundary?.through_seq??0);
 const groups=[];
 let bytes=Buffer.byteLength(current.content)+reservedBytes,count=1,overflow=false;
 const derivedPolicy=stripAssistantGraphAnnotations(current.content)===current.content?{...policy}:{...policy,opaque:true};
 for(const row of history){
  const prior=row.policy_json?JSON.parse(row.policy_json):null;
  const answer=prior&&canRepeat(policy,prior,project)?JSON.parse(row.response_json).answer:null;
  const group=[{role:"user",content:stripAssistantGraphAnnotations(row.user_text)}];
  if(typeof answer==="string"&&answer.trim())group.push({role:"assistant",content:redactDurableText(answer)});
  const size=group.reduce((sum,entry)=>sum+Buffer.byteLength(entry.content),0);
  if(count+group.length>MAX_MESSAGES||bytes+size>MAX_BYTES){
   overflow=true;
   break;
  }
  groups.push({seq:row.seq,group,size});
  bytes+=size;
  count+=group.length;
 }
 if(policyKey&&overflow){
  while(groups.length&&(count>Math.floor(MAX_MESSAGES*.75)||bytes>Math.floor(MAX_BYTES*.75))){
   const removed=groups.pop();
   count-=removed.group.length;
   bytes-=removed.size;
  }
 }
 const oldest=groups.at(-1)?.seq??conversation.seq;
 const before=policyKey&&!overflow?(boundary?.through_seq??0)+1:oldest;
 const compactedHistory=before>1?compactConversationPrefix(db,conversation,before,policy,project,onDiagnostic,
  policyKey?{policyKey,force:overflow||Boolean(boundary)}:undefined):"";
 return {messages:[...groups.reverse().flatMap(entry=>entry.group),current],policy:derivedPolicy,compactedHistory};
}
