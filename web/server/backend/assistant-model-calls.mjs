import {createHash,randomUUID} from "node:crypto";
import {stableJson,writeTransaction} from "./repository.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const identity=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const digest=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const outputJson=value=>{
 const data=JSON.stringify(value);
 if(typeof data!=="string"||Buffer.byteLength(data)>1024*1024)throw fail("assistant_model_result_too_large",413);
 return data;
};
const event=(db,taskId,kind,data)=>db.prepare(
 "INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,?,?,?)"
).run(taskId,kind,stableJson(data),Date.now());

/** The request identity is persisted before any upstream HTTP request.
 * No async work or model requests occur inside these SQLite transactions.
 */
export function beginAssistantModelCommand(db,{projectId,taskId,requestId,requestPayload}){
 if(!identity(projectId)||!identity(taskId)||!identity(requestId))throw fail("assistant_task_invalid",400);
 const requestDigest=digest({kind:"model_infer",taskId,requestPayload});
 return writeTransaction(db,()=>{
  const task=db.prepare("SELECT status,read_only,cancel_requested_at FROM assistant_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.project_id=? AND p.deleted_at IS NULL")
   .get(taskId,projectId);
  if(!task)throw fail("assistant_task_not_found",404);
  const old=db.prepare("SELECT command_kind,payload_digest,status,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?")
   .get(projectId,requestId);
  if(old){
   if(old.command_kind!=="model_infer"||old.payload_digest!==requestDigest)throw fail("assistant_task_command_conflict",409);
   if(old.status==="completed")return {cached:true,response:JSON.parse(old.response_json)};
   if(old.status==="in_progress")throw fail("assistant_model_call_in_progress",409);
   throw fail("assistant_model_call_unknown",409);
  }
  if(task.read_only||task.cancel_requested_at!==null||["completed","cancelled","cancelling"].includes(task.status))
   throw fail("assistant_task_not_editable",409);
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,'model_infer',?,'in_progress','{}',?)")
   .run(projectId,requestId,taskId,requestDigest,Date.now());
  event(db,taskId,"model_command_started",{requestId,requestDigest});
  return {cached:false};
 });
}
export function createAssistantModelObserver(db,{projectId,taskId,requestId,provider,model}){
 let previousCallId=null;
 const start=({kind,requestDigest})=>writeTransaction(db,()=>{
  const command=db.prepare("SELECT status,task_id FROM assistant_task_commands WHERE project_id=? AND request_id=?")
   .get(projectId,requestId);
  if(command?.status!=="in_progress"||command.task_id!==taskId)throw fail("assistant_model_call_not_active");
  const index=db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls WHERE project_id=? AND request_id=?")
   .get(projectId,requestId).n;
  const callId=randomUUID(),stamp=Date.now();
  db.prepare("INSERT INTO assistant_model_calls(id,project_id,task_id,request_id,call_index,call_kind,parent_call_id,provider,model,request_digest,status,submit_marker,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,'submitting',?,?)")
   .run(callId,projectId,taskId,requestId,index,kind,previousCallId,provider,model,requestDigest,randomUUID(),stamp);
  previousCallId=callId;
  event(db,taskId,"model_call_submitting",{callId,kind,index});
  return callId;
 });
 const finish=(callId,{status,resultDigest=null,errorCode=null})=>writeTransaction(db,()=>{
  const row=db.prepare("SELECT status FROM assistant_model_calls WHERE id=? AND project_id=? AND task_id=? AND request_id=?")
   .get(callId,projectId,taskId,requestId);
  if(!row||row.status!=="submitting")throw fail("assistant_model_call_not_active");
  db.prepare("UPDATE assistant_model_calls SET status=?,result_digest=?,error_code=?,finished_at=? WHERE id=?")
   .run(status,resultDigest,errorCode,Date.now(),callId);
  event(db,taskId,"model_call_"+status,{callId,...(errorCode?{errorCode}:{})});
 });
 return {
  start,
  success:(callId,result)=>finish(callId,{status:"succeeded",resultDigest:digest(result)}),
  failure:(callId,errorCode,unknown)=>finish(callId,{status:unknown?"needs_reconcile":"failed",
   errorCode:typeof errorCode==="string"&&errorCode.startsWith("assistant_")?errorCode:"assistant_upstream_unavailable"})
 };
}
export function completeAssistantModelCommand(db,{projectId,taskId,requestId,response}){
 const serialized=outputJson(response);
 return writeTransaction(db,()=>{
  const command=db.prepare("SELECT status FROM assistant_task_commands WHERE project_id=? AND request_id=? AND task_id=? AND command_kind='model_infer'")
   .get(projectId,requestId,taskId);
  if(command?.status!=="in_progress")throw fail("assistant_model_call_not_active");
  // Known tool incompatibility may produce a failed call before a legitimate
  // skill_fallback; only unknown results prohibit a successful completion.
  const unknown=db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls WHERE project_id=? AND request_id=? AND status IN ('submitting','needs_reconcile')")
   .get(projectId,requestId).n;
  if(unknown)throw fail("assistant_model_call_unknown");
  db.prepare("UPDATE assistant_task_commands SET status='completed',response_json=? WHERE project_id=? AND request_id=?")
   .run(serialized,projectId,requestId);
  event(db,taskId,"model_command_completed",{requestId,
   callCount:db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls WHERE project_id=? AND request_id=?").get(projectId,requestId).n});
  return response;
 });
}
/** A pre-submit failure has no side effects; otherwise ambiguous or partial
 * model results require an explicit new command identity, never auto-replay.
 */
export function failAssistantModelCommand(db,{projectId,taskId,requestId}){
 return writeTransaction(db,()=>{
  const command=db.prepare("SELECT status FROM assistant_task_commands WHERE project_id=? AND request_id=? AND task_id=? AND command_kind='model_infer'")
   .get(projectId,requestId,taskId);
  if(command?.status!=="in_progress")return;
  const count=db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls WHERE project_id=? AND request_id=?")
   .get(projectId,requestId).n;
  if(!count){
   db.prepare("DELETE FROM assistant_task_commands WHERE project_id=? AND request_id=?").run(projectId,requestId);
   return;
  }
  db.prepare("UPDATE assistant_task_commands SET status='needs_reconcile' WHERE project_id=? AND request_id=?")
   .run(projectId,requestId);
  event(db,taskId,"model_command_unresolved",{requestId,callCount:count});
 });
}

/** Called after acquiring the exclusive backend instance lock.
 * An already-submitted call with lost response is unknown, never auto-replayed.
 */
export function recoverAssistantModelCallsAtStartup(db){
 return writeTransaction(db,()=>{
  const now=Date.now();
  const active=db.prepare("SELECT id,task_id FROM assistant_model_calls WHERE status='submitting'").all();
  for(const row of active){
   db.prepare("UPDATE assistant_model_calls SET status='needs_reconcile',finished_at=?,error_code='assistant_model_call_unknown' WHERE id=? AND status='submitting'")
    .run(now,row.id);
   event(db,row.task_id,"model_call_needs_reconcile",{callId:row.id,recoveredAtStartup:true});
  }
  let unknownCommands=0,preflightCommands=0;
  for(const row of db.prepare("SELECT project_id,request_id,task_id FROM assistant_task_commands WHERE command_kind='model_infer' AND status='in_progress'").all()){
   const count=db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls WHERE project_id=? AND request_id=?")
    .get(row.project_id,row.request_id).n;
   if(!count){
    db.prepare("DELETE FROM assistant_task_commands WHERE project_id=? AND request_id=?")
     .run(row.project_id,row.request_id);
    preflightCommands++;
   }else{
    db.prepare("UPDATE assistant_task_commands SET status='needs_reconcile' WHERE project_id=? AND request_id=?")
     .run(row.project_id,row.request_id);
    event(db,row.task_id,"model_command_unresolved",{requestId:row.request_id,
     callCount:count,recoveredAtStartup:true});
    unknownCommands++;
   }
  }
  return {callsMarkedUnknown:active.length,commandsMarkedUnknown:unknownCommands,
   unsubmittedCommandsReleased:preflightCommands};
 });
}

export function listAssistantModelCalls(db,{projectId,taskId,limit=100}){
 if(!identity(projectId)||!identity(taskId)||!Number.isInteger(limit)||limit<1||limit>200)throw fail("assistant_task_invalid",400);
 const project=db.prepare("SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId);
 if(!project)throw fail("project_not_found",404);
 const task=db.prepare("SELECT 1 FROM assistant_tasks WHERE id=? AND project_id=?").get(taskId,projectId);
 if(!task)throw fail("assistant_task_not_found",404);
 return {calls:db.prepare("SELECT id,request_id,call_index,call_kind,parent_call_id,provider,model,status,started_at,finished_at,error_code FROM assistant_model_calls WHERE project_id=? AND task_id=? ORDER BY started_at DESC,call_index DESC LIMIT ?")
  .all(projectId,taskId,limit).map(row=>({id:row.id,requestId:row.request_id,
   index:row.call_index,kind:row.call_kind,parentCallId:row.parent_call_id,provider:row.provider,
   model:row.model,status:row.status,startedAt:row.started_at,finishedAt:row.finished_at,errorCode:row.error_code}))};
}
