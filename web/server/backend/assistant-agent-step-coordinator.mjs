/** P4.2c: immutable Agent Run -> frozen Canvas Step binding.
 * Read-only Agent decisions never write Graphs without user approval.
 */
import {createHash} from "node:crypto";
import {stableJson} from "./repository.mjs";
import {agentReadRunId,isAgentReadCommand} from "./assistant-agent-run-ledger.mjs";
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const identity=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const graphActions=response=>{
 if(!Array.isArray(response?.actions)||response.actions.length>16||
  response.actions.some(a=>!a||typeof a!=="object"))throw fail("assistant_agent_proposal_invalid");
 const actions=response.actions.filter(a=>a.type!=="run_node"&&a.type!=="run_workflow");
 if(!actions.length)throw fail("assistant_agent_proposal_missing");
 return actions;
};
function verifiedDecision(db,{projectId,taskId,runId,command,live=true}){
 if(command?.status!=="completed"||!isAgentReadCommand(db,taskId,command.request_id)||
  agentReadRunId(projectId,taskId,command.request_id)!==runId)
  throw fail("assistant_agent_run_not_completed");
 let response;
 try{response=JSON.parse(command.response_json)}catch{throw fail("assistant_agent_proposal_invalid")}
 if(response.agentRunId!==runId)throw fail("assistant_agent_proposal_changed");
 const completed=db.prepare(`SELECT payload_json FROM assistant_task_events
  WHERE task_id=? AND kind='agent_run_completed'
   AND json_extract(payload_json,'$.requestId')=? AND json_extract(payload_json,'$.runId')=?
  ORDER BY seq DESC LIMIT 1`).get(taskId,command.request_id,runId);
 if(!completed||JSON.parse(completed.payload_json).resultDigest!==digest(response))
  throw fail("assistant_agent_proposal_changed");
 const posts=db.prepare(`SELECT COUNT(*) AS n FROM assistant_model_calls
  WHERE project_id=? AND task_id=? AND request_id=? AND status='succeeded'`)
  .get(projectId,taskId,command.request_id).n;
 if(posts<1)throw fail("assistant_agent_run_unverified");
 const started=db.prepare(`SELECT seq,json_extract(payload_json,'$.turnMessageId') AS turnMessageId,
  json_extract(payload_json,'$.sourceRevision') AS sourceRevision
  FROM assistant_task_events WHERE task_id=? AND kind='model_command_started'
   AND json_extract(payload_json,'$.requestId')=? AND json_extract(payload_json,'$.requestDigest')=?
   AND json_extract(payload_json,'$.agentReadTools')=1 ORDER BY seq DESC LIMIT 1`)
  .get(taskId,command.request_id,command.payload_digest);
 const source=started?db.prepare(`SELECT seq FROM assistant_task_events WHERE task_id=? AND kind='user_turn'
  AND seq<? AND json_extract(payload_json,'$.messageId')=? ORDER BY seq DESC LIMIT 1`)
  .get(taskId,started.seq,started.turnMessageId):null;
 const latest=db.prepare(`SELECT seq FROM assistant_task_events
  WHERE task_id=? AND kind='user_turn' ORDER BY seq DESC LIMIT 1`).get(taskId);
 // Message IDs are client supplied and may be reused; only the original
 // event preceding this exact command can establish its authorization.
 if(!source||live&&source.seq!==latest?.seq)throw fail("assistant_agent_run_turn_stale");
 const checkpoint=started?db.prepare(`SELECT json_extract(payload_json,'$.sourceRevision') AS revision
  FROM assistant_task_events WHERE task_id=? AND seq>? AND kind='agent_read_round_planned'
  AND json_extract(payload_json,'$.requestId')=? ORDER BY seq DESC LIMIT 1`)
  .get(taskId,started.seq,command.request_id):null;
 const revision=started?.sourceRevision??checkpoint?.revision;
 if(live&&(!Number.isSafeInteger(revision)||db.prepare("SELECT revision FROM projects WHERE id=?")
  .get(projectId)?.revision!==revision))throw fail("assistant_agent_run_source_changed");
 return {response,modelCalls:posts};
}
export function freezeAssistantAgentCanvasBinding(db,{
 projectId,taskId,runId,actions,expectedPlanVersion
}){
 if(!identity(runId)||!Array.isArray(actions)||!Number.isSafeInteger(expectedPlanVersion)||
  expectedPlanVersion<1)throw fail("assistant_agent_proposal_invalid",400);
 const completed=db.prepare(`SELECT json_extract(payload_json,'$.requestId') AS requestId
  FROM assistant_task_events WHERE task_id=? AND kind='agent_run_completed'
  AND json_extract(payload_json,'$.runId')=? ORDER BY seq DESC LIMIT 1`).get(taskId,runId);
 const command=completed?db.prepare(`SELECT request_id,status,payload_digest,response_json FROM assistant_task_commands
  WHERE project_id=? AND task_id=? AND request_id=? AND command_kind='model_infer'`)
  .get(projectId,taskId,completed.requestId):null;
 const {response,modelCalls}=verifiedDecision(db,{projectId,taskId,runId,command});
 const proposed=graphActions(response);
 if(digest(proposed)!==digest(actions))throw fail("assistant_agent_proposal_changed");
 if(db.prepare(`SELECT 1 FROM assistant_task_steps WHERE task_id=?
   AND json_extract(preconditions_json,'$.agentRunBinding.runId')=? LIMIT 1`)
  .get(taskId,runId))throw fail("assistant_agent_run_already_bound");
 return {runId,requestId:command.request_id,planVersion:expectedPlanVersion,
  responseDigest:digest(response),actionsDigest:digest(proposed),modelCalls};
}
export function assertAssistantAgentCanvasBinding(db,{
 projectId,taskId,action,preconditions,expectedPlanVersion
}){
 const binding=preconditions?.agentRunBinding;
 if(!binding){
  if(action?.agentRunId!==undefined)throw fail("assistant_agent_proposal_changed");
  return null;
 }
 if(!identity(action?.agentRunId)||action.agentRunId!==binding.runId||
  binding.planVersion!==expectedPlanVersion||
  action.agentOutputDigest!==binding.responseDigest||
  action.agentActionsDigest!==binding.actionsDigest)
  throw fail("assistant_agent_proposal_changed");
 const command=db.prepare(`SELECT request_id,status,payload_digest,response_json FROM assistant_task_commands
  WHERE project_id=? AND task_id=? AND request_id=? AND command_kind='model_infer'`)
  .get(projectId,taskId,binding.requestId);
 const {response}=verifiedDecision(db,{projectId,taskId,runId:binding.runId,command});
 if(digest(response)!==binding.responseDigest||
  digest(graphActions(response))!==binding.actionsDigest||
  digest(action.actions)!==binding.actionsDigest)
  throw fail("assistant_agent_proposal_changed");
 return binding;
}
export function agentCanvasStepForRun(db,{taskId,runId}){
 const rows=db.prepare(`SELECT id,status,plan_version,action_json,action_digest,
  preconditions_json,approval_json,receipt_json,receipt_trust,superseded_at
  FROM assistant_task_steps WHERE task_id=?
   AND json_extract(preconditions_json,'$.agentRunBinding.runId')=?
  ORDER BY created_at DESC LIMIT 2`).all(taskId,runId);
 if(rows.length!==1)return null;
 const step=rows[0],action=JSON.parse(step.action_json),pre=JSON.parse(step.preconditions_json),
  approval=JSON.parse(step.approval_json),receipt=JSON.parse(step.receipt_json);
 const archived=!!db.prepare("SELECT read_only FROM assistant_tasks WHERE id=?").get(taskId)?.read_only;
 let intact=digest(action)===step.action_digest&&
  action.agentRunId===runId&&pre.agentRunBinding?.runId===runId&&
  pre.agentRunBinding?.planVersion===step.plan_version&&
  Array.isArray(action.actions)&&digest(action.actions)===pre.agentRunBinding?.actionsDigest&&
  action.agentOutputDigest===pre.agentRunBinding?.responseDigest&&
  action.agentActionsDigest===pre.agentRunBinding?.actionsDigest;
 if(intact&&!archived){
  try{
   const projectId=db.prepare("SELECT project_id FROM assistant_tasks WHERE id=?").get(taskId)?.project_id;
   const command=db.prepare("SELECT request_id,status,payload_digest,response_json FROM assistant_task_commands WHERE project_id=? AND task_id=? AND request_id=?")
    .get(projectId,taskId,pre.agentRunBinding.requestId);
   const {response}=verifiedDecision(db,{projectId,taskId,runId,command,live:false});
   intact=digest(response)===pre.agentRunBinding.responseDigest&&
    digest(graphActions(response))===pre.agentRunBinding.actionsDigest;
  }catch{intact=false;}
 }
 const attempt=db.prepare("SELECT status,evidence_json,action_digest FROM assistant_task_attempts WHERE task_id=? AND step_id=? AND id=?")
  .get(taskId,step.id,receipt.attemptId??"");
 const committed=db.prepare("SELECT payload_json FROM assistant_task_events WHERE task_id=? AND step_id=? AND kind='agent_step_committed' ORDER BY seq DESC LIMIT 1")
  .get(taskId,step.id);
 const receiptIntact=attempt?.status==="succeeded"&&attempt.action_digest===step.action_digest&&
  JSON.parse(attempt.evidence_json).receiptDigest===digest(receipt)&&
  !!committed&&JSON.parse(committed.payload_json).receiptDigest===digest(receipt)&&
  approval.decision==="approved"&&approval.actionDigest===step.action_digest&&
  approval.planVersion===step.plan_version&&approval.projectRevision===pre.projectRevision;
 return {stepId:step.id,planVersion:step.plan_version,status:step.status,
  actionDigest:step.action_digest,approval:approval.decision??null,
  receiptTrusted:!archived&&step.status==="succeeded"&&step.receipt_trust==="server_committed"&&
   receipt.actionDigest===step.action_digest&&intact&&receiptIntact,
  historicalOnly:archived,superseded:step.superseded_at!==null,bindingIntact:intact};
}
