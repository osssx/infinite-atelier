import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn} from "./assistant-tasks.mjs";
import {beginAssistantModelCommand,createAssistantModelObserver,
 completeAssistantModelCommand,failAssistantModelCommand} from "./assistant-model-calls.mjs";
import {agentReadRunId,inspectAssistantAgentRun,isAgentReadCommand,listAssistantAgentRuns} from "./assistant-agent-run-ledger.mjs";
import {exportAssistantTaskArchive,importAssistantTaskArchive} from "./assistant-task-archive.mjs";
import {replanAssistantTaskSafely} from "./assistant-task-safe-replan.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep,
 commitAssistantCanvasAttempt} from "./assistant-task-canvas-executor.mjs";
import {decideAssistantTaskStep,claimAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {agentCanvasStepForRun} from "./assistant-agent-step-coordinator.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";

const actions=[{type:"create_text",ref:"rabbit",title:"小兔角色卡",
 content:"蓝色斗篷的小兔嘟嘟十分勇敢，喜欢帮助森林里的朋友。"}];
const node={id:"original",type:"text",title:"原节点",position:{x:0,y:0},
 width:320,height:200,metadata:{content:"已有故事"}};
function fixture(t,{initial=false}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:{nodes:[node],connections:[]}});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",
  rootMessageId:"root",originalRequest:"创建兔子角色卡",requestId:"create"}).task;
 appendAssistantTaskTurn(db,{projectId:"p",taskId:task.id,requestId:"turn",
  messageId:"turn-current",text:"查看画布节点并创建兔子角色卡",
  contextPolicy:{includeContext:true,scope:"selection",includedIds:["original"]}});
 const requestId="agent-model",runId=agentReadRunId("p",task.id,requestId);
 const start=()=>beginAssistantModelCommand(db,{projectId:"p",taskId:task.id,requestId,
  requestPayload:{agentReadTools:true,task:{taskId:task.id,turnMessageId:"turn-current",requestId}}});
 const complete=(decisions=actions)=>{
  const observer=createAssistantModelObserver(db,{projectId:"p",taskId:task.id,requestId,
   provider:"openai_compatible",model:"mock"});
  const callId=observer.start({kind:"initial",requestDigest:"1".repeat(64)});
  observer.success(callId,{choices:[{message:{role:"assistant",content:JSON.stringify({answer:"准备完毕",actions:decisions})},
   finish_reason:"stop"}]});
  completeAssistantModelCommand(db,{projectId:"p",taskId:task.id,requestId,
   response:{model:"mock",answer:"已经规划角色卡",actions:decisions,agentRunId:runId}});
 };
 if(initial){start();complete();}
 const plan=(opts={})=>planAssistantCanvasStep(db,{projectId:"p",taskId:task.id,
  requestId:"step-plan",expectedPlanVersion:1,expectedProjectRevision:getProject(db,"p").revision,
  actions,center:{x:280,y:240},agentRunId:runId,...opts});
 const decide=(step,decision="approve",opts={})=>decideAssistantTaskStep(db,{
  projectId:"p",taskId:task.id,stepId:step.stepId,requestId:"decision",
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision,...opts});
 const execute=(step,opts={})=>executeAssistantCanvasStep(db,{
  projectId:"p",taskId:task.id,stepId:step.stepId,
  requestId:"execute",expectedPlanVersion:1,actionDigest:step.actionDigest,...opts});
 return {db,task,requestId,runId,start,complete,plan,decide,execute};
}
test("P4.2c completed Run freezes exact model actions into a waiting-approval Step",t=>{
 const f=fixture(t,{initial:true});
 assert.equal(SCHEMA_VERSION,33);
 const step=f.plan();
 assert.equal(step.status,"waiting_approval");
 assert.equal(step.agentRunId,f.runId);
 assert.equal(getProject(f.db,"p").revision,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,0);
 const frozen=f.db.prepare("SELECT action_json,action_digest,preconditions_json FROM assistant_task_steps WHERE id=?").get(step.stepId);
 const action=JSON.parse(frozen.action_json),pre=JSON.parse(frozen.preconditions_json);
 assert.equal(action.agentRunId,f.runId);
 assert.equal(pre.agentRunBinding.runId,f.runId);
 assert.equal(pre.agentRunBinding.actionsDigest,action.agentActionsDigest);
 assert.ok(/^[a-f0-9]{64}$/.test(pre.agentRunBinding.responseDigest));
 assert.equal(agentCanvasStepForRun(f.db,{taskId:f.task.id,runId:f.runId}).status,"waiting_approval");
 const transcript=inspectAssistantAgentRun(f.db,{projectId:"p",taskId:f.task.id,runId:f.runId});
 assert.ok(transcript.transcript.some(e=>e.type==="agent_step_bound"&&e.data.stepId===step.stepId));
 assert.ok(!JSON.stringify(transcript).includes(actions[0].content),"no private model output in Run transcript");
 assert.equal(f.plan().existing,true);
});
test("P4.2c user approval, Claim and trusted graph receipt retain the Run identity",t=>{
 const f=fixture(t,{initial:true}),step=f.plan();
 const approved=f.decide(step);
 assert.equal(approved.status,"ready");
 assert.equal(agentCanvasStepForRun(f.db,{taskId:f.task.id,runId:f.runId}).approval,"approved");
 assert.equal(getProject(f.db,"p").revision,1);
 const applied=f.execute(step);
 assert.equal(applied.status,"succeeded");
 assert.equal(applied.receipt.applied,1);
 assert.equal(getProject(f.db,"p").revision,2);
 assert.equal(getProject(f.db,"p").document.nodes.length,2);
 const current=agentCanvasStepForRun(f.db,{taskId:f.task.id,runId:f.runId});
 assert.equal(current.status,"succeeded");
 assert.equal(current.receiptTrusted,true);
 const transcript=inspectAssistantAgentRun(f.db,{projectId:"p",taskId:f.task.id,runId:f.runId});
 for(const kind of ["agent_step_approved","agent_step_claimed","agent_step_committed"])
  assert.ok(transcript.transcript.some(e=>e.type===kind),kind);
 assert.equal(f.execute(step).existing,true);
 assert.equal(getProject(f.db,"p").revision,2,"replay cannot create duplicate nodes");
});
test("P4.2c denial blocks Step and leaves graph untouched",t=>{
 const f=fixture(t,{initial:true}),step=f.plan();
 const denied=f.decide(step,"reject");
 assert.equal(denied.status,"blocked");
 assert.equal(getProject(f.db,"p").revision,1);
 assert.equal(agentCanvasStepForRun(f.db,{taskId:f.task.id,runId:f.runId}).approval,"rejected");
 assert.throws(()=>f.execute(step));
 assert.equal(getProject(f.db,"p").document.nodes.length,1);
 assert.ok(inspectAssistantAgentRun(f.db,{projectId:"p",taskId:f.task.id,runId:f.runId})
  .transcript.some(e=>e.type==="agent_step_rejected"));
});
test("P4.2c rejects a Run with no completed ModelCommand and never creates Step",t=>{
 const f=fixture(t);
 f.start();
 assert.throws(()=>f.plan(),{code:"assistant_agent_run_not_completed"});
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
});
test("P4.2c rejects changed or partial proposed actions",t=>{
 const f=fixture(t,{initial:true});
 assert.throws(()=>f.plan({actions:[{...actions[0],content:"伪造的内容"}]}),
  {code:"assistant_agent_proposal_changed"});
 assert.throws(()=>f.plan({actions:[]}));
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
});
test("P4.2c another Task's Run cannot be bound",t=>{
 const f=fixture(t,{initial:true});
 assert.throws(()=>f.plan({agentRunId:"ar_"+("0".repeat(40))}),
  {code:"assistant_agent_run_not_completed"});
});
test("P4.2c duplicated Run binding with changed request is not a second Step",t=>{
 const f=fixture(t,{initial:true}),step=f.plan();
 assert.throws(()=>f.plan({requestId:"other-plan"}));
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,1);
 assert.equal(agentCanvasStepForRun(f.db,{taskId:f.task.id,runId:f.runId}).stepId,step.stepId);
});
test("P4.2c later user turn invalidates unplanned Run before Step freeze",t=>{
 const f=fixture(t,{initial:true});
 appendAssistantTaskTurn(f.db,{projectId:"p",taskId:f.task.id,requestId:"another-turn",
  messageId:"new-turn",text:"撤销先前的角色卡设定",
  contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}});
 assert.throws(()=>f.plan(),{code:"assistant_agent_run_turn_stale"});
});

test("P4.2c reusing a message ID cannot authorize the old Run for a new Turn",t=>{
 for(const phase of ["plan","approve","claim"]){
  const f=fixture(t,{initial:true});
  const step=phase!=="plan"?f.plan():null;
  if(phase==="claim")f.decide(step);
  appendAssistantTaskTurn(f.db,{projectId:"p",taskId:f.task.id,requestId:"reused-turn",
   messageId:"turn-current",text:"撤销之前的授权，不再创建角色卡",
   contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}});
  if(phase==="plan")assert.throws(()=>f.plan(),{code:"assistant_agent_run_turn_stale"});
  else if(phase==="approve"){
   assert.throws(()=>f.decide(step),{code:"assistant_agent_run_turn_stale"});
   assert.equal(f.decide(step,"reject").status,"blocked");
  }else assert.throws(()=>f.execute(step),{code:"assistant_agent_run_turn_stale"});
  assert.equal(getProject(f.db,"p").revision,1);
 }
});

test("P4.2c model output changed before freeze cannot replace the completed Run decision",t=>{
 const f=fixture(t,{initial:true});
 const forged=[{...actions[0],content:"被替换的提案内容，不是完成时记录的模型决策。"}];
 const row=f.db.prepare("SELECT response_json FROM assistant_task_commands WHERE request_id=?").get(f.requestId);
 f.db.prepare("UPDATE assistant_task_commands SET response_json=? WHERE request_id=?")
  .run(JSON.stringify({...JSON.parse(row.response_json),actions:forged}),f.requestId);
 assert.throws(()=>f.plan({actions:forged}),{code:"assistant_agent_proposal_changed"});
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps").get().n,0);
});

test("P4.2c a Run cannot freeze decisions against a newer graph revision",t=>{
 const f=fixture(t,{initial:true});
 f.db.prepare("UPDATE projects SET revision=revision+1,document_json=json_set(document_json,'$.nodes[0].metadata.content','另一客户端刚保存的新正文') WHERE id='p'").run();
 assert.throws(()=>f.plan(),{code:"assistant_agent_run_source_changed"});
 assert.equal(getProject(f.db,"p").document.nodes[0].metadata.content,"另一客户端刚保存的新正文");
});

test("P4.2c safe preflight retries bind to the new revision and command mode",t=>{
 for(const agent of [true,false]){
  const f=fixture(t);f.start();
  failAssistantModelCommand(f.db,{projectId:"p",taskId:f.task.id,requestId:f.requestId});
  f.db.prepare("UPDATE projects SET revision=revision+1 WHERE id='p'").run();
  if(agent)f.start();
  else beginAssistantModelCommand(f.db,{projectId:"p",taskId:f.task.id,requestId:f.requestId,
   requestPayload:{task:{taskId:f.task.id,turnMessageId:"turn-current",requestId:f.requestId}}});
  assert.equal(isAgentReadCommand(f.db,f.task.id,f.requestId),agent);
  f.complete();
  if(agent)assert.equal(f.plan().status,"waiting_approval");
  else{
   assert.throws(()=>f.plan(),{code:"assistant_agent_run_not_completed"});
   assert.deepEqual(listAssistantAgentRuns(f.db,{projectId:"p",taskId:f.task.id}).runs,[]);
  }
 }
});

test("P4.2c revoked ready or graph-stale pending Steps can be rejected and replanned",t=>{
 for(const approved of [true,false]){
  const f=fixture(t,{initial:true}),step=f.plan();
  if(approved){
   f.decide(step);
   appendAssistantTaskTurn(f.db,{projectId:"p",taskId:f.task.id,requestId:"new-turn",
    messageId:"new-message",text:"撤销旧操作",contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}});
   assert.throws(()=>f.execute(step),{code:"assistant_agent_run_turn_stale"});
  }else f.db.prepare("UPDATE projects SET revision=revision+1 WHERE id='p'").run();
  assert.equal(f.decide(step,"reject",{requestId:"revoke"}).status,"blocked");
  const replanned=replanAssistantTaskSafely(f.db,{projectId:"p",taskId:f.task.id,
   requestId:"safe-replan",expectedPlanVersion:1,expectedProjectRevision:getProject(f.db,"p").revision});
  assert.ok(replanned);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts WHERE status='succeeded'").get().n,0);
 }
});

test("P4.2c trusted receipt projection validates Attempt evidence and remains historical across Turns",t=>{
 const f=fixture(t,{initial:true}),step=f.plan();f.decide(step);f.execute(step);
 appendAssistantTaskTurn(f.db,{projectId:"p",taskId:f.task.id,requestId:"later",
  messageId:"later",text:"继续讨论",contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}});
 assert.equal(agentCanvasStepForRun(f.db,{taskId:f.task.id,runId:f.runId}).receiptTrusted,true);
 f.db.prepare("UPDATE assistant_task_steps SET receipt_json=json_set(receipt_json,'$.applied',999) WHERE id=?").run(step.stepId);
 assert.equal(agentCanvasStepForRun(f.db,{taskId:f.task.id,runId:f.runId}).receiptTrusted,false);
});

test("P4.2c real archive import exposes historical Run and remapped Step without execution authority",async t=>{
 const f=fixture(t,{initial:true}),step=f.plan();f.decide(step);f.execute(step);
 const archive=exportAssistantTaskArchive(f.db,"p");
 createProject(f.db,{id:"restored",document:getProject(f.db,"p").document});
 importAssistantTaskArchive(f.db,"restored",archive);
 const task=f.db.prepare("SELECT id FROM assistant_tasks WHERE project_id='restored'").get();
 const app=buildApp({db:f.db,authorize:()=>true});t.after(()=>app.close());
 const base="/api/v1/projects/restored/assistant/tasks/"+task.id;
 const list=await app.inject({method:"GET",url:base+"/agent-runs"});
 assert.equal(list.statusCode,200,list.body);
 assert.equal(list.json().runs[0].runId,f.runId);
 assert.equal(list.json().runs[0].recovery,"historical_only");
 const detail=await app.inject({method:"GET",url:base+"/agent-runs/"+f.runId});
 assert.equal(detail.statusCode,200,detail.body);
 const restored=detail.json();
 assert.equal(restored.agentStep.historicalOnly,true);
 assert.equal(restored.agentStep.receiptTrusted,false);
 assert.notEqual(restored.agentStep.stepId,step.stepId);
 assert.ok(restored.transcript.some(e=>e.type==="agent_step_committed"&&e.data.stepId===restored.agentStep.stepId));
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE project_id='restored'").get().n,0);
 const execute=await app.inject({method:"POST",url:base+"/steps/"+restored.agentStep.stepId+"/execute",
  payload:{requestId:"forbidden",expectedPlanVersion:1,actionDigest:step.actionDigest}});
 assert.equal(execute.statusCode,409,execute.body);
});
test("P4.2c tampered frozen Agent binding cannot pass approval or claim",t=>{
 const f=fixture(t,{initial:true}),step=f.plan();
 const frozen=f.db.prepare("SELECT preconditions_json FROM assistant_task_steps WHERE id=?").get(step.stepId);
 const altered=JSON.parse(frozen.preconditions_json);
 altered.agentRunBinding.responseDigest="a".repeat(64);
 f.db.prepare("UPDATE assistant_task_steps SET preconditions_json=? WHERE id=?")
  .run(JSON.stringify(altered),step.stepId);
 assert.throws(()=>f.decide(step),{code:"assistant_agent_proposal_changed"});
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(step.stepId).status,"waiting_approval");
});
test("P4.2c mutating stored model result after approval makes Claim fail closed",t=>{
 const f=fixture(t,{initial:true}),step=f.plan();f.decide(step);
 f.db.prepare("UPDATE assistant_task_commands SET response_json=? WHERE request_id=?")
  .run(JSON.stringify({actions:[{...actions[0],title:"非法编辑"}]}),f.requestId);
 assert.throws(()=>claimAssistantTaskStep(f.db,{projectId:"p",taskId:f.task.id,
  stepId:step.stepId,expectedPlanVersion:1}),{code:"assistant_agent_proposal_changed"});
 assert.equal(getProject(f.db,"p").revision,1);
});
test("P4.2c graph update and Agent trusted receipt event roll back together",t=>{
 const f=fixture(t,{initial:true}),step=f.plan();f.decide(step);
 f.db.exec(`CREATE TEMP TRIGGER reject_agent_commit BEFORE INSERT ON assistant_task_events
 WHEN NEW.kind='agent_step_committed' BEGIN SELECT RAISE(ABORT,'agent_receipt_fault'); END`);
 assert.throws(()=>f.execute(step),/agent_receipt_fault/);
 assert.equal(getProject(f.db,"p").revision,1);
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(step.stepId).status,"running");
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='agent_step_committed'").get().n,0);
 f.db.exec("DROP TRIGGER reject_agent_commit");
});
test("P4.2c HTTP Run detail exposes authoritative Step status but no hidden body",async t=>{
 const f=fixture(t,{initial:true}),step=f.plan();
 const app=buildApp({db:f.db,authorize:()=>true});t.after(()=>app.close());
 const endpoint="/api/v1/projects/p/assistant/tasks/"+f.task.id+"/agent-runs/"+f.runId;
 const pending=await app.inject({method:"GET",url:endpoint});
 assert.equal(pending.statusCode,200,pending.body);
 assert.equal(pending.json().agentStep.status,"waiting_approval");
 assert.ok(!pending.body.includes(actions[0].content));
 f.decide(step);f.execute(step);
 const committed=await app.inject({method:"GET",url:endpoint});
 assert.equal(committed.statusCode,200,committed.body);
 assert.equal(committed.json().agentStep.receiptTrusted,true);
 assert.equal(committed.json().run.completesTask,false);
});

test("P4.2c full Mock Provider -> read tool -> plan -> approve -> commit via HTTP",async t=>{
 const f=fixture(t);const upstream=[];
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_v,cb)=>cb(Buffer.from("mock-key"))};
 const chat=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  const body=JSON.parse(options.body);upstream.push(body);
  const data=upstream.length===1?{choices:[{
   message:{role:"assistant",content:null,tool_calls:[
    {id:"read-map",type:"function",function:{name:"canvas_get_map",arguments:"{}"}}]},
   finish_reason:"tool_calls"}]}:
   {choices:[{message:{role:"assistant",content:JSON.stringify({
    answer:"已规划角色卡",actions})},finish_reason:"stop"}]};
  return new Response(JSON.stringify(data),{status:200});
 }});
 const app=buildApp({db:f.db,assistantChat:chat,authorize:()=>true});t.after(()=>app.close());
 const base="/api/v1/projects/p/assistant/tasks/"+f.task.id;
 const result=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",
  payload:{channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
   model:"mock",canvasActions:true,agentReadTools:true,
   messages:[{role:"user",content:"查看画布节点并创建兔子角色卡"}],
   task:{taskId:f.task.id,turnMessageId:"turn-current",requestId:f.requestId}}});
 assert.equal(result.statusCode,200,result.body);
 assert.equal(result.json().agentRunId,f.runId);
 assert.deepEqual(result.json().actions,actions);
 assert.equal(upstream.length,2);
 assert.ok(JSON.stringify(upstream[1]).includes("原节点"));
 const plan=await app.inject({method:"POST",url:base+"/canvas-steps",
  payload:{requestId:"http-canvas-plan",expectedPlanVersion:1,
   expectedProjectRevision:1,actions:result.json().actions,
   center:{x:280,y:240},agentRunId:result.json().agentRunId}});
 assert.equal(plan.statusCode,200,plan.body);
 assert.equal(plan.json().status,"waiting_approval");
 assert.equal(getProject(f.db,"p").revision,1);
 const stepId=plan.json().stepId,actionDigest=plan.json().actionDigest;
 const decision=await app.inject({method:"POST",url:base+"/steps/"+stepId+"/approval",
  payload:{requestId:"http-decision",expectedPlanVersion:1,actionDigest,decision:"approve"}});
 assert.equal(decision.statusCode,200,decision.body);
 const commit=await app.inject({method:"POST",url:base+"/steps/"+stepId+"/execute",
  payload:{requestId:"http-execute",expectedPlanVersion:1,actionDigest}});
 assert.equal(commit.statusCode,200,commit.body);
 assert.equal(commit.json().status,"succeeded");
 assert.equal(getProject(f.db,"p").revision,2);
 const detail=await app.inject({method:"GET",url:base+"/agent-runs/"+f.runId});
 assert.equal(detail.statusCode,200,detail.body);
 assert.equal(detail.json().agentStep.receiptTrusted,true);
 assert.equal(detail.json().run.completesTask,false);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_model_calls").get().n,2);
 assert.equal(upstream.length,2,"approved graph commit does not trigger another paid model POST");
});

test("P4.2c archived import shows history but cannot claim verified execution",t=>{
 const f=fixture(t,{initial:true}),step=f.plan();f.decide(step);f.execute(step);
 assert.equal(agentCanvasStepForRun(f.db,{taskId:f.task.id,runId:f.runId}).receiptTrusted,true);
 f.db.prepare("UPDATE assistant_tasks SET read_only=1 WHERE id=?").run(f.task.id);
 const archived=agentCanvasStepForRun(f.db,{taskId:f.task.id,runId:f.runId});
 assert.equal(archived.historicalOnly,true);
 assert.equal(archived.receiptTrusted,false);
 assert.throws(()=>f.plan({requestId:"different-plan"}));
});

test("P4.2c a newer Turn revokes still-unapproved Run, but explicit reject remains possible",t=>{
 const f=fixture(t,{initial:true}),step=f.plan();
 appendAssistantTaskTurn(f.db,{projectId:"p",taskId:f.task.id,
  requestId:"revocation-turn",messageId:"revocation-message",
  text:"新的指令撤销了此前画布资料的访问权限",
  contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}});
 assert.throws(()=>f.decide(step),{code:"assistant_agent_run_turn_stale"});
 const rejected=f.decide(step,"reject");
 assert.equal(rejected.status,"blocked");
 assert.equal(getProject(f.db,"p").revision,1);
 assert.equal(agentCanvasStepForRun(f.db,{taskId:f.task.id,runId:f.runId}).approval,"rejected");
});
test("P4.2c corrupted completed model output can still be rejected without Graph changes",t=>{
 const f=fixture(t,{initial:true}),step=f.plan();
 f.db.prepare("UPDATE assistant_task_commands SET response_json=? WHERE request_id=?")
  .run(JSON.stringify({actions:[{type:"delete_node",nodeId:"original"}]}),f.requestId);
 assert.throws(()=>f.decide(step),{code:"assistant_agent_proposal_changed"});
 assert.equal(f.decide(step,"reject").status,"blocked");
 assert.equal(getProject(f.db,"p").document.nodes.length,1);
});
