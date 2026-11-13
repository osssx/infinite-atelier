import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn,observeAssistantTask,
 addAssistantTaskStep,getAssistantTask,linkAssistantTaskToChat,listAssistantTasks} from "./assistant-tasks.mjs";
import {buildAssistantTaskProviderContext} from "./assistant-task-context.mjs";
import {exportAssistantTaskArchive} from "./assistant-task-archive.mjs";

const projectId="summary-test-project";
const basePolicy={includeContext:false,scope:"selection",includedIds:[]};
function setup(db){
 initializeSchema(db);
 createProject(db,{id:projectId,document:{title:"Project",nodes:[{
  id:"private-node",type:"text",title:"PRIVATE_NODE_TITLE",metadata:{content:"PRIVATE_NODE_BODY"}
 }],connections:[]}});
 const task=createAssistantTask(db,{projectId,chatSessionId:"chat-a",
  rootMessageId:"root-user",originalRequest:"原始任务：连续制作二十个分镜",requestId:"create-root",
  contextPolicy:basePolicy});
 return task.task.id;
}
function get(db,taskId){return getAssistantTask(db,{projectId,taskId}).task}
test("P3 fact summary persists 28 turns through cross-chat resume and SQLite restart without reading old client transcript",()=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-task-facts-")),file=join(dir,"task.db");
 let db=new DatabaseSync(file);
 try{
  const taskId=setup(db);
  for(let i=1;i<=28;i++){
   const turn=appendAssistantTaskTurn(db,{projectId,taskId,
    requestId:"req-turn-"+i,messageId:"msg-"+i,text:"用户第"+i+"轮：继续保持分镜风格",
    contextPolicy:basePolicy});
   assert.equal(turn.task.summary.userTurns.total,i);
   assert.equal(turn.task.summary.source,"server_derived");
   assert.equal(turn.task.summary.activePlanVersion,1);
  }
  const linked=linkAssistantTaskToChat(db,{projectId,taskId,requestId:"link-new-chat",chatSessionId:"chat-b"});
  assert.equal(linked.task.chatSessionIds.includes("chat-b"),true);
  const first=get(db,taskId),firstText=JSON.stringify(first.summary);
  assert.equal(first.summary.userTurns.total,28);
  assert.equal(first.summary.userTurns.recent.length,20);
  assert.equal(first.summary.userTurns.recent[0].messageId,"msg-9");
  assert.equal(first.summary.userTurns.recent.at(-1).messageId,"msg-28");
  assert.equal(first.lastSeq,first.summary.sourceLastSeq);
  assert.ok(Buffer.byteLength(firstText)<12000);
  assert.equal(first.summary.execution.currentPlan.trustedSteps,0);
  assert.equal(first.originalRequest,"原始任务：连续制作二十个分镜");
  assert.deepEqual(JSON.parse(db.prepare("SELECT summary_json FROM assistant_tasks WHERE id=?").get(taskId).summary_json),first.summary);
  db.close();db=new DatabaseSync(file);initializeSchema(db);
  const tasks=listAssistantTasks(db,{projectId,chatSessionId:"chat-b"}).tasks;
  assert.equal(tasks.length,1);
  assert.equal(tasks[0].id,taskId);
  const restored=get(db,taskId);
  assert.equal(restored.summary.userTurns.total,28);
  assert.equal(restored.summary.sourceLastSeq,restored.lastSeq);
  assert.deepEqual(restored.summary,first.summary);
  const provider=buildAssistantTaskProviderContext({task:restored,document:{nodes:[],connections:[]}});
  assert.match(provider,/原始任务：连续制作二十个分镜/);
  assert.match(provider,/累计用户续写轮次：28/);
  assert.match(provider,/用户第9轮/);
  assert.match(provider,/用户第28轮/);
  assert.doesNotMatch(provider,/PRIVATE_NODE_BODY|PRIVATE_NODE_TITLE/);
 }finally{db.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:80})}
});
test("P3 task facts distinguish trusted Step receipts from client-reported success and avoid raw canvas content",()=>{
 const db=new DatabaseSync(":memory:");
 try{
  const taskId=setup(db);
  addAssistantTaskStep(db,{projectId,taskId,kind:"canvas_mutation",ordinal:0,
   expectedPlanVersion:1,stepId:"trusted-canvas",action:{type:"create_node"}});
  addAssistantTaskStep(db,{projectId,taskId,kind:"model_job",ordinal:1,
   expectedPlanVersion:1,stepId:"untrusted-model",action:{type:"run_model"}});
  addAssistantTaskStep(db,{projectId,taskId,kind:"materialize",ordinal:2,
   expectedPlanVersion:1,stepId:"trusted-materialization",action:{artifactIds:[]}});
  db.prepare("UPDATE assistant_task_steps SET status='succeeded',receipt_trust='server_committed',result_json=? WHERE id='trusted-canvas'")
   .run(JSON.stringify({applied:2,nodes:["private-node"]}));
  db.prepare("UPDATE assistant_task_steps SET status='succeeded',receipt_trust='client_reported',result_json=? WHERE id='untrusted-model'")
   .run(JSON.stringify({artifactIds:["forged-result"],jobId:"fake-job"}));
  db.prepare("UPDATE assistant_task_steps SET status='succeeded',receipt_trust='server_committed',result_json=? WHERE id='trusted-materialization'")
   .run(JSON.stringify({bindings:[{artifactId:"cas-1",nodeId:"private-node"}]}));
  observeAssistantTask(db,{projectId,taskId,requestId:"claim",kind:"reply",
   preview:"任务全部完成，Job fake-job 已成功，secret=private-token"});
  const task=get(db,taskId),plan=task.summary.execution.currentPlan;
  assert.equal(plan.stepCount,3);
  assert.equal(plan.trustedSteps,2);
  assert.equal(plan.unverifiedSuccess,1);
  assert.equal(plan.trustedByKind.model_job,0);
  assert.equal(plan.trustedByKind.materialize,1);
  assert.equal(plan.materializedBindings,1);
  assert.equal(plan.confirmedArtifacts,0);
  assert.equal(plan.appliedCanvasActions,2);
  const context=buildAssistantTaskProviderContext({task,document:{nodes:[],connections:[]}});
  assert.match(context,/后端可信成功回执：2/);
  assert.match(context,/未可信确认的成功状态：1/);
  for(const forbidden of ["forged-result","fake-job","private-token","PRIVATE_NODE_BODY","private-node","任务全部完成"])
   assert.equal(context.includes(forbidden),false,forbidden);
  const oldId=task.summary.sourceLastSeq;
  const next=get(db,taskId);
  assert.equal(next.summary.sourceLastSeq,oldId);
  assert.deepEqual(next.summary,task.summary);
 }finally{db.close()}
});
test("P3 old-plan receipts remain historical and never satisfy a revised plan",()=>{
 const db=new DatabaseSync(":memory:");
 try{
  const taskId=setup(db);
  addAssistantTaskStep(db,{projectId,taskId,stepId:"old-step",kind:"model_job",
   ordinal:0,expectedPlanVersion:1,action:{type:"run_node",nodeId:"private-node"}});
  db.prepare("UPDATE assistant_task_steps SET status='succeeded',receipt_trust='server_committed',result_json=? WHERE id='old-step'")
   .run(JSON.stringify({artifactIds:["old-artifact"]}));
  assert.equal(get(db,taskId).summary.execution.currentPlan.trustedSteps,1);
  db.prepare("UPDATE assistant_tasks SET active_plan_version=2,status='planning' WHERE id=?").run(taskId);
  db.prepare("UPDATE assistant_task_steps SET superseded_at=? WHERE id='old-step'").run(Date.now());
  addAssistantTaskStep(db,{projectId,taskId,stepId:"new-step",kind:"model_job",
   ordinal:0,expectedPlanVersion:2,action:{type:"run_node",nodeId:"private-node"}});
  const task=get(db,taskId),facts=task.summary;
  assert.equal(facts.activePlanVersion,2);
  assert.equal(facts.execution.historicalTrustedReceipts,1);
  assert.equal(facts.execution.currentPlan.trustedSteps,0);
  assert.equal(facts.execution.currentPlan.stages.pending,1);
  const context=buildAssistantTaskProviderContext({task,document:{nodes:[],connections:[]}});
  assert.match(context,/当前计划步骤：1；后端可信成功回执：0/);
  assert.match(context,/旧计划历史可信回执：1/);
  assert.doesNotMatch(context,/old-artifact/);
 }finally{db.close()}
});

test("P3 valid large 20-turn selection policies are safely pruned, not rejected",()=>{
 const db=new DatabaseSync(":memory:");
 try{
  const taskId=setup(db);
  const includedIds=Array.from({length:12},(_,index)=>
   ("private-reference-"+index+"-").padEnd(128,"x"));
  for(let i=1;i<=24;i++)appendAssistantTaskTurn(db,{projectId,taskId,
   requestId:"large-req-"+i,messageId:"large-msg-"+i,
   text:"持续第"+i+"轮历史文本",
   contextPolicy:{includeContext:true,scope:"selection",includedIds}});
  const task=get(db,taskId);
  assert.equal(task.summary.userTurns.total,24);
  assert.ok(task.summary.userTurns.recent.length<20);
  assert.ok(Buffer.byteLength(db.prepare("SELECT summary_json FROM assistant_tasks WHERE id=?").get(taskId).summary_json)<12000);
  const context=buildAssistantTaskProviderContext({task:{...task,contextPolicy:basePolicy},
   document:{nodes:[],connections:[]}});
  assert.match(context,/累计用户续写轮次：24/);
  assert.doesNotMatch(context,/持续第24轮历史文本/);
 }finally{db.close()}
});

test("P3 Task ZIP export contains fresh factual summary even before the next GET",()=>{
 const db=new DatabaseSync(":memory:");
 try{
  const taskId=setup(db);
  addAssistantTaskStep(db,{projectId,taskId,stepId:"finished-after-snapshot",
   kind:"canvas_mutation",ordinal:0,expectedPlanVersion:1,action:{type:"create_node"}});
  const before=JSON.parse(db.prepare("SELECT summary_json FROM assistant_tasks WHERE id=?").get(taskId).summary_json);
  assert.equal(before.execution.currentPlan.trustedSteps,0);
  db.prepare("UPDATE assistant_task_steps SET status='succeeded',receipt_trust='server_committed',result_json=? WHERE id=?")
   .run(JSON.stringify({applied:1}),"finished-after-snapshot");
  const archived=exportAssistantTaskArchive(db,projectId);
  assert.equal(archived.tasks[0].task.summary_json.execution.currentPlan.trustedSteps,1);
  assert.equal(archived.tasks[0].task.summary_json.execution.currentPlan.appliedCanvasActions,1);
  assert.deepEqual(JSON.parse(db.prepare("SELECT summary_json FROM assistant_tasks WHERE id=?").get(taskId).summary_json),before);
 }finally{db.close()}
});

test("P3 prior selected-node text is never repeated when a subsequent turn freezes narrower disclosure",()=>{
 const db=new DatabaseSync(":memory:");
 try{
  const taskId=setup(db);
  appendAssistantTaskTurn(db,{projectId,taskId,requestId:"selected",messageId:"selected-msg",
   text:"PRIVATE_NODE_BODY old selected-node request",
   contextPolicy:{includeContext:true,scope:"selection",includedIds:["private-node"]}});
  appendAssistantTaskTurn(db,{projectId,taskId,requestId:"closed",messageId:"closed-msg",
   text:"新一轮只允许普通文本",contextPolicy:basePolicy});
  const task=get(db,taskId);
  const closed=buildAssistantTaskProviderContext({task,document:{nodes:[],connections:[]},
   currentTurnMessageId:"closed-msg"});
  assert.doesNotMatch(closed,/PRIVATE_NODE_BODY/);
  assert.match(closed,/原始任务：连续制作二十个分镜/);
  const allowed=buildAssistantTaskProviderContext({task:{...task,contextPolicy:{
   includeContext:true,scope:"selection",includedIds:["private-node"]}},
   document:{nodes:[],connections:[]},currentTurnMessageId:"closed-msg"});
  assert.match(allowed,/PRIVATE_NODE_BODY/);
 }finally{db.close()}
});
