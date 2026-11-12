import {createHash,randomUUID} from "node:crypto";
import {assertNoRawCredentials,stableJson,writeTransaction} from "./repository.mjs";

const fail=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const id=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const text=(x,max)=>typeof x==="string"&&x.trim().length>0&&x.length<=max;
const json=(value,max=16000)=>{
 assertNoRawCredentials(value);
 const data=stableJson(value);
 if(Buffer.byteLength(data)>max)throw fail("assistant_task_payload_too_large",413);
 return data;
};
const hash=x=>createHash("sha256").update(stableJson(x)).digest("hex");
function active(db,projectId){
 if(!id(projectId))throw fail("assistant_task_invalid");
 if(!db.prepare("SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId))
  throw fail("project_not_found",404);
}
function mustTask(db,projectId,taskId){
 if(!id(taskId))throw fail("assistant_task_invalid");
 const row=db.prepare("SELECT * FROM assistant_tasks WHERE project_id=? AND id=?").get(projectId,taskId);
 if(!row)throw fail("assistant_task_not_found",404);
 return row;
}
function view(row){
 return {id:row.id,projectId:row.project_id,chatSessionId:row.chat_session_id,rootMessageId:row.root_message_id,
 status:row.status,activePlanVersion:row.active_plan_version,activeStepId:row.active_step_id,
 originalRequest:row.original_request,goal:JSON.parse(row.goal_json),summary:JSON.parse(row.summary_json),
 contextPolicy:JSON.parse(row.context_policy_json),readOnly:!!row.read_only,
 cancelRequestedAt:row.cancel_requested_at,createdAt:row.created_at,updatedAt:row.updated_at,
 finishedAt:row.finished_at,recoveryMode:"guidance_only"};
}
const stepView=row=>({id:row.id,taskId:row.task_id,planVersion:row.plan_version,
 ordinal:row.ordinal,kind:row.kind,status:row.status,required:!!row.required,
 dependsOn:JSON.parse(row.depends_on_json),actionDigest:row.action_digest,
 receiptTrust:row.receipt_trust,result:JSON.parse(row.result_json),errorCode:row.error_code});
function snapshot(db,projectId,taskId){
 const row=mustTask(db,projectId,taskId);
 const steps=db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? ORDER BY plan_version,ordinal").all(taskId).map(stepView);
 const lastSeq=db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM assistant_task_events WHERE task_id=?").get(taskId).n;
 const last=db.prepare("SELECT kind,payload_json FROM assistant_task_events WHERE task_id=? AND kind IN ('client_reported_error','client_reported_reply') ORDER BY seq DESC LIMIT 1").get(taskId);
 return {...view(row),steps,lastSeq,lastError:last?.kind==="client_reported_error"?JSON.parse(last.payload_json).preview:null};
}
function event(db,taskId,kind,payload,stepId=null,at=Date.now()){
 db.prepare("INSERT INTO assistant_task_events(task_id,step_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)")
  .run(taskId,stepId,kind,json(payload,8000),at);
}
function command(db,{projectId,requestId,kind,payload},action){
 if(!id(requestId))throw fail("assistant_task_invalid");
 const signature=hash({kind,payload});
 return writeTransaction(db,()=>{
  active(db,projectId);
  const found=db.prepare("SELECT payload_digest,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?").get(projectId,requestId);
  if(found){
   if(found.payload_digest!==signature)throw fail("assistant_task_command_conflict",409);
   return {...JSON.parse(found.response_json),existing:true};
  }
  const response=action();
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,?,?,'completed',?,?)")
   .run(projectId,requestId,response.task?.id??null,kind,signature,json(response,64000),Date.now());
  return {...response,existing:response.existing===true};
 });
}
function policy(value){
 if(value===undefined)return {includeContext:false,scope:"selection",includedIds:[]};
 if(!value||typeof value!=="object"||Array.isArray(value)||
 Object.keys(value).some(k=>!["includeContext","scope","includedIds"].includes(k))||
 typeof value.includeContext!=="boolean"||!["selection","overview"].includes(value.scope)||
 !Array.isArray(value.includedIds)||value.includedIds.length>12||
 value.includedIds.some(n=>typeof n!=="string"||n.length>128))throw fail("assistant_task_invalid");
 return {includeContext:value.includeContext,scope:value.scope,includedIds:[...new Set(value.includedIds)]};
}
export function createAssistantTask(db,{projectId,chatSessionId,rootMessageId,originalRequest,requestId,contextPolicy}){
 if(!id(chatSessionId)||!id(rootMessageId)||!text(originalRequest,8000))throw fail("assistant_task_invalid");
 const contextPolicyValue=policy(contextPolicy);
 return command(db,{projectId,requestId,kind:"create",payload:{chatSessionId,rootMessageId,originalRequest,contextPolicyValue}},()=>{
  const prior=db.prepare("SELECT id,original_request FROM assistant_tasks WHERE project_id=? AND chat_session_id=? AND root_message_id=?").get(projectId,chatSessionId,rootMessageId);
  if(prior){
   if(prior.original_request!==originalRequest)throw fail("assistant_task_command_conflict",409);
   return {task:snapshot(db,projectId,prior.id),existing:true};
  }
  const taskId=randomUUID(),at=Date.now();
  db.prepare("INSERT INTO assistant_tasks(id,project_id,chat_session_id,root_message_id,status,active_plan_version,original_request,goal_json,constraints_json,summary_json,context_policy_json,read_only,created_at,updated_at) VALUES(?,?,?,?,'planning',1,?,?,?,?,?,0,?,?)")
   .run(taskId,projectId,chatSessionId,rootMessageId,originalRequest,
    json({description:originalRequest}),"{}","{}",json(contextPolicyValue),at,at);
  event(db,taskId,"task_created",{rootMessageId,mode:"guidance_only"},null,at);
  return {task:snapshot(db,projectId,taskId)};
 });
}
export function listAssistantTasks(db,{projectId,chatSessionId,limit=50}){
 active(db,projectId);
 if(!id(chatSessionId)||!Number.isInteger(limit)||limit<1||limit>100)throw fail("assistant_task_invalid");
 return {tasks:db.prepare("SELECT * FROM assistant_tasks WHERE project_id=? AND chat_session_id=? ORDER BY updated_at DESC,id DESC LIMIT ?").all(projectId,chatSessionId,limit).map(view)};
}
export function getAssistantTask(db,{projectId,taskId}){
 active(db,projectId);db.exec("BEGIN");
 try{
  const task=snapshot(db,projectId,taskId);
  db.exec("COMMIT");return {task};
 }catch(e){db.exec("ROLLBACK");throw e}
}
export function appendAssistantTaskTurn(db,{projectId,taskId,requestId,text:message,messageId,contextPolicy}){
 if(!text(message,8000)||!id(messageId))throw fail("assistant_task_invalid");
 const contextPolicyValue=contextPolicy===undefined?undefined:policy(contextPolicy);
 return command(db,{projectId,requestId,kind:"turn",payload:{taskId,message,messageId,...(contextPolicyValue?{contextPolicyValue}:{})}},()=>{
  const row=mustTask(db,projectId,taskId);
  if(row.cancel_requested_at!==null||row.read_only)throw fail("assistant_task_not_editable",409);
  const at=Date.now();
  if(contextPolicyValue)db.prepare("UPDATE assistant_tasks SET context_policy_json=?,updated_at=? WHERE id=?")
   .run(json(contextPolicyValue),at,taskId);
  else db.prepare("UPDATE assistant_tasks SET updated_at=? WHERE id=?").run(at,taskId);
  event(db,taskId,"user_turn",{messageId,preview:message.slice(0,160),requestDigest:hash(message),
   contextPolicy:contextPolicyValue??JSON.parse(row.context_policy_json)},null,at);
  return {task:snapshot(db,projectId,taskId)};
 });
}

/** Recover exactly the provider visibility agreed for this user turn.
 * Later changes to assistant_tasks.context_policy_json cannot widen it.
 */
export function getAssistantTaskTurnPolicy(db,{projectId,taskId,messageId}){
 active(db,projectId);mustTask(db,projectId,taskId);
 if(!id(messageId))throw fail("assistant_task_invalid");
 const row=db.prepare("SELECT payload_json FROM assistant_task_events WHERE task_id=? AND kind='user_turn' AND json_extract(payload_json,'$.messageId')=? ORDER BY seq DESC LIMIT 1")
  .get(taskId,messageId);
 if(!row)throw fail("assistant_task_turn_not_found",409);
 const value=JSON.parse(row.payload_json).contextPolicy;
 if(!value)throw fail("assistant_task_context_invalid",409);
 return policy(value);
}

export function observeAssistantTask(db,{projectId,taskId,requestId,kind,preview}){
 if(!["reply","error"].includes(kind)||!text(preview,1800))throw fail("assistant_task_invalid");
 return command(db,{projectId,requestId,kind:"observe",payload:{taskId,kind,preview}},()=>{
  const row=mustTask(db,projectId,taskId);
  if(row.read_only)throw fail("assistant_task_not_editable",409);
  const at=Date.now();
  db.prepare("UPDATE assistant_tasks SET updated_at=? WHERE id=?").run(at,taskId);
  event(db,taskId,"client_reported_"+kind,{preview,receiptTrust:"client_reported"},null,at);
  return {task:snapshot(db,projectId,taskId)};
 });
}
export function guideAssistantTaskResume(db,{projectId,taskId,requestId}){
 return command(db,{projectId,requestId,kind:"guidance_resume",payload:{taskId}},()=>{
  const row=mustTask(db,projectId,taskId);
  if(row.read_only||row.cancel_requested_at!==null)throw fail("assistant_task_not_editable",409);
  event(db,taskId,"guidance_resume_requested",{executionStarted:false});
  return {task:snapshot(db,projectId,taskId),executionStarted:false};
 });
}
export function cancelAssistantTask(db,{projectId,taskId,requestId}){
 return command(db,{projectId,requestId,kind:"cancel",payload:{taskId}},()=>{
  const row=mustTask(db,projectId,taskId);
  if(row.read_only)throw fail("assistant_task_not_editable",409);
  if(!row.cancel_requested_at){
   const at=Date.now();
   db.prepare("UPDATE assistant_tasks SET cancel_requested_at=?,status='cancelled',updated_at=?,finished_at=? WHERE id=?")
    .run(at,at,at,taskId);
   event(db,taskId,"task_cancelled",{executionStarted:false},null,at);
  }
  return {task:snapshot(db,projectId,taskId),executionStarted:false};
 });
}
export function listAssistantTaskEvents(db,{projectId,taskId,afterSeq=0,limit=100}){
 active(db,projectId);mustTask(db,projectId,taskId);
 if(!Number.isSafeInteger(afterSeq)||afterSeq<0||!Number.isInteger(limit)||limit<1||limit>200)throw fail("assistant_task_invalid");
 const rows=db.prepare("SELECT seq,step_id,kind,payload_json,created_at FROM assistant_task_events WHERE task_id=? AND seq>? ORDER BY seq ASC LIMIT ?").all(taskId,afterSeq,limit+1);
 const events=rows.slice(0,limit).map(row=>({seq:row.seq,stepId:row.step_id,kind:row.kind,payload:JSON.parse(row.payload_json),createdAt:row.created_at}));
 return {events,nextSeq:events.at(-1)?.seq??afterSeq,hasMore:rows.length>limit};
}
/** Internal P0a planner entry: pending only, never executes or asserts success. */
export function addAssistantTaskStep(db,{projectId,taskId,expectedPlanVersion,stepId=randomUUID(),kind,ordinal,action={},dependsOn=[],required=true}){
 const allowed=["canvas_mutation","skill_script","model_job","comfy_workflow","wait_external","materialize","clarification"];
 if(!id(stepId)||!Number.isSafeInteger(expectedPlanVersion)||expectedPlanVersion<1||
  !allowed.includes(kind)||!Number.isSafeInteger(ordinal)||ordinal<0||
 !Array.isArray(dependsOn)||dependsOn.some(n=>!id(n))||typeof required!=="boolean")throw fail("assistant_task_invalid");
 return writeTransaction(db,()=>{
  active(db,projectId);
  const row=mustTask(db,projectId,taskId);
  if(row.read_only||row.cancel_requested_at!==null)throw fail("assistant_task_not_editable",409);
  if(row.active_plan_version!==expectedPlanVersion)throw fail("assistant_step_plan_conflict",409);
  const frozen=json(action,12000),actionDigest=hash(action),at=Date.now();
  db.prepare("INSERT INTO assistant_task_steps(id,task_id,plan_version,ordinal,kind,status,required,depends_on_json,action_json,action_digest,preconditions_json,approval_json,receipt_json,receipt_trust,result_json,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?,?,?,'{}','{}','{}','none','{}',?,?)")
  .run(stepId,taskId,row.active_plan_version,ordinal,kind,required?1:0,json(dependsOn),frozen,actionDigest,at,at);
  event(db,taskId,"step_planned",{stepId,kind,actionDigest},stepId,at);
  return snapshot(db,projectId,taskId);
 });
}
