/** Portable Task history. Import only into read-only Task tables: never restore
 * executable commands, provider calls, Job/run associations, or active sequences.
 */
import {randomUUID} from "node:crypto";
import {stableJson,assertNoRawCredentials} from "./repository.mjs";
import {deriveAssistantTaskFacts} from "./assistant-task-facts.mjs";
const invalid=()=>Object.assign(Error("archive_invalid_task_history"),{statusCode:422,code:"archive_invalid_task_history"});
const id=v=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const array=(v,max)=>Array.isArray(v)&&v.length<=max;
const number=v=>Number.isSafeInteger(v)&&v>=0;
const statuses=new Set(["planning","ready","waiting_approval","running","waiting_external","blocked","needs_reconcile","cancelling","failed","completed","cancelled"]);
const kinds=new Set(["canvas_mutation","skill_script","model_job","comfy_workflow","wait_external","materialize","clarification"]);
const stepStates=new Set(["pending","ready","waiting_approval","submitting","running","waiting_external","succeeded","failed","skipped","blocked","needs_reconcile"]);
const pack=row=>Object.fromEntries(Object.entries(row).map(([k,v])=>
 [k,k.endsWith("_json")&&typeof v==="string"?JSON.parse(v):v]));
const json=value=>stableJson(value??{});
export function exportAssistantTaskArchive(db,projectId){
 const tasks=db.prepare("SELECT * FROM assistant_tasks WHERE project_id=? ORDER BY created_at,id").all(projectId);
 const result={format:1,tasks:tasks.map(task=>({
  task:pack({...task,summary_json:task.read_only?task.summary_json:
    stableJson(deriveAssistantTaskFacts(db,task))}),
  steps:db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? ORDER BY plan_version,ordinal").all(task.id).map(pack),
  attempts:db.prepare("SELECT * FROM assistant_task_attempts WHERE task_id=? ORDER BY created_at,id").all(task.id).map(pack),
  events:db.prepare("SELECT * FROM assistant_task_events WHERE task_id=? ORDER BY seq").all(task.id).map(pack),
  links:db.prepare("SELECT chat_session_id,linked_at FROM assistant_task_chat_links WHERE task_id=? ORDER BY linked_at").all(task.id),
  commands:db.prepare("SELECT request_id,command_kind,payload_digest,status,created_at FROM assistant_task_commands WHERE project_id=? AND task_id=? ORDER BY created_at").all(projectId,task.id),
  modelCalls:db.prepare("SELECT id,request_id,call_kind,parent_call_id,provider,model,request_digest,status,started_at,finished_at,error_code FROM assistant_model_calls WHERE task_id=? ORDER BY started_at,id").all(task.id),
  runSequences:db.prepare("SELECT id,plan_version,source_message_id,actions_json,intent_digest,status,created_at FROM assistant_task_run_sequences WHERE task_id=? ORDER BY created_at,id").all(task.id).map(pack)
 }))};
 return validateAssistantTaskArchive(result);
}
export function validateAssistantTaskArchive(value){
 if(!value||value.format!==1||!array(value.tasks,80))throw invalid();
 const seenTasks=new Set(),seenSteps=new Set(),seenAttempts=new Set(),roots=new Set();
 let stepCount=0,eventCount=0;
 for(const part of value.tasks){
  if(!part?.task||!array(part.steps,400)||!array(part.attempts,600)||
   !array(part.events,2000)||!array(part.links,100)||!array(part.commands,1000)||
   !array(part.modelCalls,1000)||!array(part.runSequences,200))throw invalid();
  const t=part.task;
  if(!id(t.id)||seenTasks.has(t.id)||!id(t.project_id)||!id(t.chat_session_id)||
   !id(t.root_message_id)||!statuses.has(t.status)||!number(t.active_plan_version)||
   t.active_plan_version<1||typeof t.original_request!=="string"||t.original_request.length>8000||
   !number(t.created_at)||!number(t.updated_at))throw invalid();
  const root=t.chat_session_id+":"+t.root_message_id;
  if(roots.has(root))throw invalid();
  roots.add(root);seenTasks.add(t.id);
  for(const r of [t,...part.steps,...part.attempts,...part.events])
   for(const [k,v] of Object.entries(r))
    if(k.endsWith("_json")&&(v===null||typeof v!=="object"))throw invalid();
  const local=new Set(),ordinals=new Set(),eventSeq=new Set();
  for(const step of part.steps){
   const ordinal=step.plan_version+":"+step.ordinal;
   if(!id(step.id)||seenSteps.has(step.id)||step.task_id!==t.id||
    !kinds.has(step.kind)||!stepStates.has(step.status)||
    !number(step.plan_version)||step.plan_version<1||!number(step.ordinal)||
    !["none","client_reported","server_committed"].includes(step.receipt_trust)||
    !Array.isArray(step.depends_on_json)||ordinals.has(ordinal))throw invalid();
   seenSteps.add(step.id);local.add(step.id);ordinals.add(ordinal);
  }
  for(const step of part.steps)
   if(step.depends_on_json.some(ref=>!local.has(ref)))throw invalid();
  for(const attempt of part.attempts){
   if(!id(attempt.id)||seenAttempts.has(attempt.id)||attempt.task_id!==t.id||
    !local.has(attempt.step_id)||!number(attempt.attempt_no)||attempt.attempt_no<1||
    !number(attempt.created_at))throw invalid();
   seenAttempts.add(attempt.id);
  }
  for(const event of part.events){
   if(!number(event.seq)||eventSeq.has(event.seq)||event.task_id!==t.id||
     (event.step_id!==null&&!local.has(event.step_id))||
     typeof event.kind!=="string"||!number(event.created_at))throw invalid();
   eventSeq.add(event.seq);
  }
  for(const link of part.links)if(!id(link.chat_session_id)||!number(link.linked_at))throw invalid();
  for(const command of part.commands)if(!id(command.request_id)||!number(command.created_at))throw invalid();
  for(const call of part.modelCalls)if(!id(call.id)||!number(call.started_at))throw invalid();
  for(const seq of part.runSequences)if(!id(seq.id)||!number(seq.created_at)||!Array.isArray(seq.actions_json))throw invalid();
  stepCount+=part.steps.length;eventCount+=part.events.length;
  if(stepCount>3000||eventCount>10000)throw invalid();
 }
 assertNoRawCredentials(value);
 return value;
}
/** This function must be invoked inside the new project's write transaction. */
export function importAssistantTaskArchive(db,projectId,history){
 validateAssistantTaskArchive(history);
 const insertEvent=db.prepare("INSERT INTO assistant_task_events(task_id,step_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)");
 const now=Date.now();
 for(const part of history.tasks){
  const t=part.task,taskId=randomUUID(),steps=new Map();
  db.prepare("INSERT INTO assistant_tasks(id,project_id,chat_session_id,root_message_id,status,active_step_id,active_plan_version,original_request,goal_json,constraints_json,summary_json,context_policy_json,cancel_requested_at,read_only,created_at,updated_at,finished_at) VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?,?,1,?,?,?)")
   .run(taskId,projectId,t.chat_session_id,t.root_message_id,t.status,t.active_plan_version,
    t.original_request,json(t.goal_json),json(t.constraints_json),json(t.summary_json),
    json(t.context_policy_json),t.cancel_requested_at??null,t.created_at,t.updated_at,t.finished_at??null);
  for(const step of part.steps)steps.set(step.id,randomUUID());
  for(const step of part.steps){
   db.prepare("INSERT INTO assistant_task_steps(id,task_id,plan_version,ordinal,kind,status,required,depends_on_json,action_json,action_digest,preconditions_json,approval_json,receipt_json,receipt_trust,result_json,error_code,superseded_at,lease_owner,lease_expires_at,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)")
    .run(steps.get(step.id),taskId,step.plan_version,step.ordinal,step.kind,step.status,
     step.required?1:0,json(step.depends_on_json.map(ref=>steps.get(ref))),json(step.action_json),
     step.action_digest,json(step.preconditions_json),json(step.approval_json),
     json(step.receipt_json),step.receipt_trust,json(step.result_json),step.error_code??null,
     step.superseded_at??null,step.attempt_count??0,step.created_at,step.updated_at);
  }
  for(const a of part.attempts){
   const audit={archived:true,sourceStatus:a.status,sourceAttemptId:a.id,
    sourceExecutionKey:a.execution_key,sourceExternalKind:a.external_kind??null,
    sourceExternalId:a.external_id??null,sourceSubmitMarker:a.submit_marker??null,
    sourceSubmittedAt:a.submitted_at??null,sourceFrozenSnapshot:a.frozen_snapshot_json,
    sourceEvidence:a.evidence_json};
   db.prepare("INSERT INTO assistant_task_attempts(id,task_id,step_id,attempt_no,project_id,execution_key,action_digest,request_fingerprint,frozen_snapshot_json,status,external_kind,external_id,submit_marker,submitted_at,lease_owner,evidence_json,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,'archived',NULL,NULL,NULL,NULL,NULL,?,?,?)")
    .run(randomUUID(),taskId,steps.get(a.step_id),a.attempt_no,projectId,
     "archive-"+randomUUID(),a.action_digest,a.request_fingerprint,
     json({archiveOnly:true}),json(audit),a.created_at,a.finished_at??now);
  }
  for(const e of part.events)
   insertEvent.run(taskId,e.step_id?steps.get(e.step_id):null,e.kind,json(e.payload_json),e.created_at);
  for(const c of part.commands)insertEvent.run(taskId,null,"archived_command",json(c),c.created_at);
  for(const c of part.modelCalls)insertEvent.run(taskId,null,"archived_model_call",json(c),c.started_at);
  for(const seq of part.runSequences)insertEvent.run(taskId,null,"archived_run_sequence",json(seq),seq.created_at);
  for(const link of part.links)if(link.chat_session_id!==t.chat_session_id)
   db.prepare("INSERT OR IGNORE INTO assistant_task_chat_links(task_id,project_id,chat_session_id,linked_at) VALUES(?,?,?,?)")
    .run(taskId,projectId,link.chat_session_id,link.linked_at);
  insertEvent.run(taskId,null,"task_archive_imported",json({sourceTaskId:t.id,sourceProjectId:t.project_id,
   readOnly:true,externalExecutionRestored:false}),now);
 }
 return history.tasks.length;
}
