/** P4.2b: event-sourced, read-only Run projection (Schema v32). */
import {createHash} from "node:crypto";
import {stableJson} from "./repository.mjs";
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const id=v=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const digest=v=>createHash("sha256").update(stableJson(v)).digest("hex");
export function agentReadRunId(projectId,taskId,requestId){
 if(![projectId,taskId,requestId].every(id))throw fail("assistant_agent_run_invalid",400);
 return "ar_"+digest({projectId,taskId,requestId}).slice(0,40);
}
export function recordAgentRunEventInTransaction(db,{taskId,kind,data}){
 if(!id(taskId)||!kind.startsWith("agent_run_"))throw fail("assistant_agent_run_invalid",400);
 db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
  .run(taskId,kind,stableJson(data),Date.now());
}
export function readAgentRunOwnership(db,taskId){
 return db.prepare(`SELECT c.status,c.request_id FROM assistant_task_commands c
  WHERE c.task_id=? AND c.command_kind='model_infer'
   AND c.status IN ('in_progress','needs_reconcile')
   AND EXISTS(SELECT 1 FROM assistant_task_events e
    WHERE e.task_id=c.task_id AND e.kind='model_command_started'
    AND json_extract(e.payload_json,'$.requestId')=c.request_id
    AND json_extract(e.payload_json,'$.agentReadTools')=1)
  ORDER BY c.created_at DESC LIMIT 1`).get(taskId)??null;
}
export function isAgentReadCommand(db,taskId,requestId){
 return !!db.prepare(`SELECT 1 FROM assistant_task_events
  WHERE task_id=? AND kind='model_command_started'
   AND json_extract(payload_json,'$.requestId')=?
   AND json_extract(payload_json,'$.agentReadTools')=1 LIMIT 1`).get(taskId,requestId);
}
export function assertAgentRunOwner(db,{projectId,taskId,requestId}){
 const row=db.prepare(`SELECT status FROM assistant_task_commands
  WHERE project_id=? AND task_id=? AND request_id=? AND command_kind='model_infer'`)
  .get(projectId,taskId,requestId);
 if(row?.status!=="in_progress"||!isAgentReadCommand(db,taskId,requestId))
  throw fail("assistant_agent_run_not_active",409);
}
function taskScope(db,projectId,taskId){
 if(!id(projectId)||!id(taskId))throw fail("assistant_agent_run_invalid",400);
 const task=db.prepare("SELECT id,read_only FROM assistant_tasks WHERE project_id=? AND id=?").get(projectId,taskId);
 if(!task)throw fail("assistant_task_not_found",404);
 return task;
}
function sourceRuns(db,projectId,taskId,limit){
 return db.prepare(`SELECT c.request_id,c.status,c.created_at,
    MIN(e.seq) AS start_seq,json_extract(e.payload_json,'$.turnMessageId') AS turn_message_id
  FROM assistant_task_commands c JOIN assistant_task_events e ON e.task_id=c.task_id
   AND e.kind='model_command_started'
   AND json_extract(e.payload_json,'$.requestId')=c.request_id
   AND json_extract(e.payload_json,'$.agentReadTools')=1
  WHERE c.project_id=? AND c.task_id=? AND c.command_kind='model_infer'
  GROUP BY c.request_id ORDER BY c.created_at DESC,start_seq DESC LIMIT ?`)
  .all(projectId,taskId,limit);
}
function compactRun(db,projectId,taskId,row,readOnly){
 const requestId=row.request_id;
 const counts=db.prepare(`SELECT status,COUNT(*) AS n FROM assistant_model_calls
  WHERE project_id=? AND task_id=? AND request_id=? GROUP BY status`)
  .all(projectId,taskId,requestId);
 const calls=Object.fromEntries(counts.map(r=>[r.status,r.n]));
 const rounds=db.prepare(`SELECT COUNT(*) AS n FROM assistant_task_events
  WHERE task_id=? AND kind='agent_read_round_planned'
    AND json_extract(payload_json,'$.requestId')=?`).get(taskId,requestId).n;
 const reads=db.prepare(`SELECT COUNT(*) AS n FROM assistant_task_events
  WHERE task_id=? AND kind='agent_read_tool_completed'
    AND json_extract(payload_json,'$.requestId')=?`).get(taskId,requestId).n;
 const total=Object.values(calls).reduce((a,b)=>a+b,0);
 const status=row.status==="completed"?"completed":
  row.status==="needs_reconcile"?"needs_reconcile":
  row.status==="in_progress"?(total?"reading":"planning"):"blocked";
 return {runId:agentReadRunId(projectId,taskId,requestId),taskId,requestId,
  turnMessageId:row.turn_message_id??null,readOnly:Boolean(readOnly),status,
  rounds,readToolCalls:reads,modelPosts:total,
  unknownModelPosts:(calls.submitting??0)+(calls.needs_reconcile??0),
  createdAt:row.created_at,completesTask:false,
  recovery:status==="completed"?"cached_result_only":
   status==="needs_reconcile"?"manual_reconciliation_required":
   status==="blocked"?"blocked":"no_automatic_resume"};
}
export function listAssistantAgentRuns(db,{projectId,taskId,limit=20}){
 const task=taskScope(db,projectId,taskId);
 if(!Number.isInteger(limit)||limit<1||limit>50)throw fail("assistant_agent_run_invalid",400);
 return {runs:sourceRuns(db,projectId,taskId,limit).map(row=>
  compactRun(db,projectId,taskId,row,task.read_only))};
}
const EVENTS=["agent_run_started","agent_read_round_planned","agent_run_model_received",
 "agent_read_tool_completed","agent_run_completed","agent_run_needs_reconcile",
 "agent_run_preflight_released"];
export function inspectAssistantAgentRun(db,{projectId,taskId,runId,afterSeq=0,limit=50}){
 const task=taskScope(db,projectId,taskId);
 if(!id(runId)||!Number.isInteger(afterSeq)||afterSeq<0||
  !Number.isInteger(limit)||limit<1||limit>100)throw fail("assistant_agent_run_invalid",400);
 const rows=sourceRuns(db,projectId,taskId,200);
 const row=rows.find(v=>agentReadRunId(projectId,taskId,v.request_id)===runId);
 if(!row)throw fail("assistant_agent_run_not_found",404);
 const run=compactRun(db,projectId,taskId,row,task.read_only);
 const events=db.prepare(`SELECT seq,kind,payload_json,created_at FROM assistant_task_events
  WHERE task_id=? AND seq>? AND kind IN (`+EVENTS.map(() => "?").join(",")+`)
   AND json_extract(payload_json,'$.requestId')=? ORDER BY seq LIMIT ?`)
  .all(taskId,afterSeq,...EVENTS,run.requestId,limit+1);
 const transcript=events.slice(0,limit).map(e=>{
  const data=JSON.parse(e.payload_json);
  const fields=["round","callId","callIndex","name","argsDigest","resultDigest",
   "resultBytes","sourceRevision","errorCode","requestDigest","turnMessageId","status"];
  return {seq:e.seq,type:e.kind,createdAt:e.created_at,
   data:Object.fromEntries(fields.filter(k=>Object.hasOwn(data,k)).map(k=>[k,data[k]]))};
 });
 const modelCalls=db.prepare(`SELECT id,call_index,call_kind,parent_call_id,status,
   started_at,finished_at,error_code FROM assistant_model_calls
  WHERE project_id=? AND task_id=? AND request_id=? ORDER BY call_index`)
  .all(projectId,taskId,run.requestId).map(r=>({
   id:r.id,index:r.call_index,kind:r.call_kind,parentCallId:r.parent_call_id,
   status:r.status,startedAt:r.started_at,finishedAt:r.finished_at,errorCode:r.error_code
  }));
 return {run,transcript,modelCalls,nextAfterSeq:transcript.at(-1)?.seq??afterSeq,
  hasMore:events.length>limit};
}
