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
export function freezeAssistantAgentCanvasBinding(db,{
 projectId,taskId,runId,actions,expectedPlanVersion
}){
 if(!identity(runId)||!Array.isArray(actions)||!Number.isSafeInteger(expectedPlanVersion)||
  expectedPlanVersion<1)throw fail("assistant_agent_proposal_invalid",400);
 const command=db.prepare(`SELECT request_id,status,response_json FROM assistant_task_commands
  WHERE project_id=? AND task_id=? AND command_kind='model_infer'
   AND status='completed' ORDER BY created_at DESC`).all(projectId,taskId)
  .find(row=>agentReadRunId(projectId,taskId,row.request_id)===runId&&
   isAgentReadCommand(db,taskId,row.request_id));
 if(!command)throw fail("assistant_agent_run_not_completed");
 let response;
 try{response=JSON.parse(command.response_json)}catch{throw fail("assistant_agent_proposal_invalid")}
 const proposed=graphActions(response);
 if(digest(proposed)!==digest(actions))throw fail("assistant_agent_proposal_changed");
 const posts=db.prepare(`SELECT COUNT(*) AS n FROM assistant_model_calls
  WHERE project_id=? AND task_id=? AND request_id=? AND status='succeeded'`)
  .get(projectId,taskId,command.request_id).n;
 if(posts<1)throw fail("assistant_agent_run_unverified");
 const latest=db.prepare(`SELECT json_extract(payload_json,'$.messageId') AS messageId
  FROM assistant_task_events WHERE task_id=? AND kind='user_turn' ORDER BY seq DESC LIMIT 1`).get(taskId);
 const source=db.prepare(`SELECT json_extract(payload_json,'$.turnMessageId') AS turnMessageId
  FROM assistant_task_events WHERE task_id=? AND kind='model_command_started'
   AND json_extract(payload_json,'$.requestId')=? AND json_extract(payload_json,'$.agentReadTools')=1
   ORDER BY seq DESC LIMIT 1`).get(taskId,command.request_id);
 if(!source?.turnMessageId||source.turnMessageId!==latest?.messageId)
  throw fail("assistant_agent_run_turn_stale");
 if(db.prepare(`SELECT 1 FROM assistant_task_steps WHERE task_id=?
   AND json_extract(preconditions_json,'$.agentRunBinding.runId')=? LIMIT 1`)
  .get(taskId,runId))throw fail("assistant_agent_run_already_bound");
 return {runId,requestId:command.request_id,planVersion:expectedPlanVersion,
  responseDigest:digest(response),actionsDigest:digest(proposed),modelCalls:posts};
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
 const command=db.prepare(`SELECT status,response_json FROM assistant_task_commands
  WHERE project_id=? AND task_id=? AND request_id=? AND command_kind='model_infer'`)
  .get(projectId,taskId,binding.requestId);
 if(command?.status!=="completed"||!isAgentReadCommand(db,taskId,binding.requestId)||
  agentReadRunId(projectId,taskId,binding.requestId)!==binding.runId)
  throw fail("assistant_agent_run_not_completed");
 let response;
 try{response=JSON.parse(command.response_json)}catch{throw fail("assistant_agent_proposal_invalid")}
 if(digest(response)!==binding.responseDigest||
  digest(graphActions(response))!==binding.actionsDigest||
  digest(action.actions)!==binding.actionsDigest)
  throw fail("assistant_agent_proposal_changed");
 if(db.prepare(`SELECT COUNT(*) AS n FROM assistant_model_calls
  WHERE project_id=? AND task_id=? AND request_id=? AND status='succeeded'`)
  .get(projectId,taskId,binding.requestId).n<1)
  throw fail("assistant_agent_run_unverified");
 // A later user Turn can revoke the scope of read data used for this decision.
 // The frozen Step may still be rejected, but cannot be newly approved/claimed.
 const source=db.prepare(`SELECT json_extract(payload_json,'$.turnMessageId') AS turnMessageId
  FROM assistant_task_events WHERE task_id=? AND kind='model_command_started'
  AND json_extract(payload_json,'$.requestId')=? AND json_extract(payload_json,'$.agentReadTools')=1
  ORDER BY seq DESC LIMIT 1`).get(taskId,binding.requestId);
 const latest=db.prepare(`SELECT json_extract(payload_json,'$.messageId') AS messageId
  FROM assistant_task_events WHERE task_id=? AND kind='user_turn' ORDER BY seq DESC LIMIT 1`)
  .get(taskId);
 if(!source?.turnMessageId||source.turnMessageId!==latest?.messageId)
  throw fail("assistant_agent_run_turn_stale");
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
 const intact=digest(action)===step.action_digest&&
  action.agentRunId===runId&&pre.agentRunBinding?.runId===runId&&
  action.agentOutputDigest===pre.agentRunBinding?.responseDigest&&
  action.agentActionsDigest===pre.agentRunBinding?.actionsDigest;
 return {stepId:step.id,planVersion:step.plan_version,status:step.status,
  actionDigest:step.action_digest,approval:approval.decision??null,
  receiptTrusted:!archived&&step.status==="succeeded"&&step.receipt_trust==="server_committed"&&
   receipt.actionDigest===step.action_digest&&intact,
  historicalOnly:archived,superseded:step.superseded_at!==null,bindingIntact:intact};
}
