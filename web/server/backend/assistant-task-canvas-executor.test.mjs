import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createAssistantTask,getAssistantTask,cancelAssistantTask} from "./assistant-tasks.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep,
 recoverAssistantCanvasTasksAtStartup} from "./assistant-task-canvas-executor.mjs";

const node={id:"original",type:"text",title:"原节点",position:{x:0,y:0},width:340,height:240,
 metadata:{content:"初始内容",status:"success",fontSize:14}};
const origin={title:"新画布",nodes:[node],connections:[]};
function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:origin});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"创作故事",requestId:"root-task"}).task;
 const ids={db,projectId:"p",taskId:task.id};
 return ids;
}
function plan(ctx,{requestId="plan",actions=[
 {type:"create_text",ref:"story",title:"故事",content:"Hello"},
 {type:"connect",from:"original",to:"story"}],dependsOn=[],finalizeTask=false}={}){
 return planAssistantCanvasStep(ctx.db,{projectId:ctx.projectId,taskId:ctx.taskId,requestId,
  expectedPlanVersion:1,expectedProjectRevision:getProject(ctx.db,ctx.projectId).revision,
  actions,center:{x:320,y:240},dependsOn,finalizeTask});
}
const approve=(ctx,step,requestId="approve")=>decideAssistantTaskStep(ctx.db,{
 projectId:ctx.projectId,taskId:ctx.taskId,stepId:step.stepId,expectedPlanVersion:1,
 actionDigest:step.actionDigest,decision:"approve",requestId});
const execute=(ctx,step,opts={})=>executeAssistantCanvasStep(ctx.db,{
 projectId:ctx.projectId,taskId:ctx.taskId,stepId:step.stepId,expectedPlanVersion:1,
 actionDigest:step.actionDigest,requestId:"execute-"+step.stepId,...opts});

test("P1b canvas graph, Step receipt and Attempt commit atomically, replay never duplicates nodes",t=>{
 const ctx=setup(t),candidate=plan(ctx);
 assert.equal(candidate.status,"waiting_approval");
 assert.equal(getProject(ctx.db,"p").revision,1);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,0);
 assert.equal(planAssistantCanvasStep(ctx.db,{projectId:"p",taskId:ctx.taskId,requestId:"plan",
  expectedPlanVersion:1,expectedProjectRevision:1,
  actions:[{type:"create_text",ref:"story",title:"故事",content:"Hello"},
   {type:"connect",from:"original",to:"story"}],center:{x:320,y:240},dependsOn:[],finalizeTask:false}).existing,true);
 assert.equal(approve(ctx,candidate).status,"ready");
 const first=execute(ctx,candidate);
 assert.equal(first.status,"succeeded");
 assert.equal(first.project.revision,2);
 assert.equal(first.receipt.applied,2);
 assert.equal(first.receipt.projectRevision,2);
 assert.equal(first.project.document.nodes.length,2);
 assert.equal(first.project.document.nodes[1].id,candidate.preconditions.refs.nodes.story);
 assert.equal(first.project.document.connections[0].id,candidate.preconditions.refs.connections.edge_1);
 const step=ctx.db.prepare("SELECT status,receipt_trust,receipt_json FROM assistant_task_steps WHERE id=?").get(candidate.stepId);
 assert.equal(step.status,"succeeded");assert.equal(step.receipt_trust,"server_committed");
 assert.deepEqual(JSON.parse(step.receipt_json),first.receipt);
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_attempts").get().status,"succeeded");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_tasks").get().status,"ready");
 const projectEvents=ctx.db.prepare("SELECT revision FROM project_events WHERE project_id='p'").all();
 assert.deepEqual(projectEvents.map(row=>row.revision),[1,2]);
 const duplicate=execute(ctx,candidate);
 assert.equal(duplicate.existing,true);
 assert.deepEqual(duplicate.receipt,first.receipt);
 assert.equal(getProject(ctx.db,"p").revision,2);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,1);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='step_graph_committed'").get().n,1);
});
test("P1b simulated crash after claim leaves no graph write and recovers a prepared local attempt",t=>{
 const ctx=setup(t),candidate=plan(ctx);approve(ctx,candidate);
 assert.throws(()=>execute(ctx,candidate,{afterClaim:()=>{throw Error("simulated_crash")}}),/simulated_crash/);
 assert.equal(getProject(ctx.db,"p").revision,1);
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_steps").get().status,"running");
 assert.deepEqual(recoverAssistantCanvasTasksAtStartup(ctx.db),{released:1,unknown:0});
 assert.deepEqual(recoverAssistantCanvasTasksAtStartup(ctx.db),{released:0,unknown:0});
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_steps").get().status,"ready");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_attempts").get().status,"released_pre_submit");
 assert.equal(execute(ctx,candidate).project.revision,2);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,2);
});
test("P1b graph updated before receipt, then fault throws => entire transaction rolls back",t=>{
 const ctx=setup(t),candidate=plan(ctx);approve(ctx,candidate);
 assert.throws(()=>execute(ctx,candidate,{beforeReceipt:()=>{throw Error("crash_in_tx")}}),/crash_in_tx/);
 assert.equal(getProject(ctx.db,"p").revision,1);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM project_events").get().n,1);
 assert.equal(ctx.db.prepare("SELECT receipt_trust FROM assistant_task_steps").get().receipt_trust,"none");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_attempts").get().status,"prepared");
 assert.equal(recoverAssistantCanvasTasksAtStartup(ctx.db).released,1);
 assert.equal(execute(ctx,candidate).project.revision,2);
});
test("P1b dependent Step references server receipt not model invented IDs",t=>{
 const ctx=setup(t),first=plan(ctx);approve(ctx,first);
 execute(ctx,first);
 const second=plan(ctx,{requestId:"second-plan",actions:[
  {type:"create_text",ref:"next",title:"后续",content:"第二幕"},
  {type:"connect",from:first.stepId+":story",to:"next"}],
  dependsOn:[first.stepId],finalizeTask:true});
 approve(ctx,second,"approve-second");
 const result=execute(ctx,second);
 assert.equal(result.project.revision,3);
 assert.equal(result.project.document.nodes.length,3);
 assert.equal(result.project.document.connections.length,2);
 assert.equal(result.project.document.connections[1].fromNodeId,first.preconditions.refs.nodes.story);
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_tasks").get().status,"completed");
});
test("P1b planner rejects unsupported external actions, wrong approval, stale graph and duplicate request content",t=>{
 const ctx=setup(t);
 assert.throws(()=>plan(ctx,{actions:[{type:"run_workflow",nodeId:"original"}]}),{code:"assistant_canvas_action_unsupported"});
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
 const candidate=plan(ctx);
 assert.throws(()=>execute(ctx,candidate),{code:"assistant_step_already_claimed"});
 assert.throws(()=>plan(ctx,{requestId:"plan",actions:[{type:"set_text",nodeId:"original",content:"改"}]}),
  {code:"assistant_task_command_conflict"});
 approve(ctx,candidate);
 ctx.db.prepare("UPDATE projects SET revision=revision+1 WHERE id='p'").run();
 assert.throws(()=>execute(ctx,candidate),{code:"assistant_step_source_changed"});
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,0);
});
test("P1b cancelled task is never implicitly restarted; committed receipt remains durable",t=>{
 const ctx=setup(t),candidate=plan(ctx);approve(ctx,candidate);
 cancelAssistantTask(ctx.db,{projectId:"p",taskId:ctx.taskId,requestId:"stop"});
 assert.throws(()=>execute(ctx,candidate),{code:"assistant_task_not_editable"});
 assert.equal(getProject(ctx.db,"p").revision,1);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,0);
});

test("P1b cancellation after prepared claim does not create graph and is restart stable",t=>{
 const ctx=setup(t),step=plan(ctx);approve(ctx,step);
 assert.throws(()=>execute(ctx,step,{afterClaim:()=>{throw Error("pause_at_claim")}}),/pause_at_claim/);
 const cancelled=cancelAssistantTask(ctx.db,{projectId:"p",taskId:ctx.taskId,requestId:"cancel-prepared"});
 assert.equal(cancelled.task.status,"cancelled");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_attempts").get().status,"cancelled_pre_submit");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_steps").get().status,"blocked");
 assert.equal(recoverAssistantCanvasTasksAtStartup(ctx.db).released,0);
 assert.equal(getProject(ctx.db,"p").revision,1);
 assert.throws(()=>execute(ctx,step),{code:"assistant_task_not_editable"});
});
test("P1b cancellation with unknown submitted evidence remains cancelling after startup",t=>{
 const ctx=setup(t),step=plan(ctx);approve(ctx,step);
 assert.throws(()=>execute(ctx,step,{afterClaim:()=>{throw Error("pause_submitted")}}),/pause_submitted/);
 ctx.db.prepare("UPDATE assistant_task_attempts SET status='submitting',submit_marker='submitted',submitted_at=1").run();
 const cancellation=cancelAssistantTask(ctx.db,{projectId:"p",taskId:ctx.taskId,requestId:"cancel-unknown"});
 assert.equal(cancellation.task.status,"cancelling");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_steps").get().status,"running");
 const recovered=recoverAssistantCanvasTasksAtStartup(ctx.db);
 assert.equal(recovered.unknown,1);
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_tasks").get().status,"cancelling");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_steps").get().status,"needs_reconcile");
 assert.equal(recoverAssistantCanvasTasksAtStartup(ctx.db).unknown,0);
 assert.equal(getProject(ctx.db,"p").revision,1);
});
test("P1b refuses a second unapproved plan until first Step resolves",t=>{
 const ctx=setup(t),pending=plan(ctx);
 assert.throws(()=>plan(ctx,{requestId:"other-plan",
  actions:[{type:"set_text",nodeId:"original",content:"other"}]}),{code:"assistant_step_already_planned"});
 approve(ctx,pending);execute(ctx,pending);
 const next=plan(ctx,{requestId:"other-plan",actions:[
  {type:"set_title",nodeId:"original",title:"Modified"}]});
 assert.equal(next.status,"waiting_approval");
});

test("P1b unknown submitted attempts are fenced into needs_reconcile rather than resubmitted",t=>{
 const ctx=setup(t),candidate=plan(ctx);approve(ctx,candidate);
 assert.throws(()=>execute(ctx,candidate,{afterClaim:()=>{throw Error("interrupt")}}),/interrupt/);
 ctx.db.prepare("UPDATE assistant_task_attempts SET status='submitting',submit_marker='unknown',submitted_at=1").run();
 assert.deepEqual(recoverAssistantCanvasTasksAtStartup(ctx.db),{released:0,unknown:1});
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_steps").get().status,"needs_reconcile");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_tasks").get().status,"needs_reconcile");
 assert.throws(()=>execute(ctx,candidate),{code:"assistant_task_not_editable"});
 assert.equal(getProject(ctx.db,"p").revision,1);
});
