import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {createProject,patchProject,getProject} from "./projects.mjs";
import {createAssistantTask,addAssistantTaskStep,getAssistantTask} from "./assistant-tasks.mjs";
import {deterministicAssistantRefs,prepareAssistantTaskStep,decideAssistantTaskStep,
 claimAssistantTaskStep,verifyAssistantTaskClaim,releaseUnsubmittedAssistantTaskClaim,
 reviseAssistantTaskPlan} from "./assistant-task-step-gate.mjs";
const doc={nodes:[{id:"existing",type:"text",title:"已有节点"}],connections:[]};
async function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 createProject(db,{id:"p-step",document:doc});
 const task=createAssistantTask(db,{projectId:"p-step",requestId:"task-1",
  chatSessionId:"chat",rootMessageId:"root",originalRequest:"创建节点并连接"}).task;
 const app=buildApp({db,authorize:()=>true});
 t.after(async()=>{await app.close();db.close()});
 return {db,taskId:task.id,app,projectId:"p-step",revision:1};
}
function seed(fx,{stepId="step-a",ordinal=0,dependsOn=[],kind="canvas_mutation"}={}){
 const {db,projectId,taskId}=fx;
 const planVersionNow=getAssistantTask(db,{projectId,taskId}).task.activePlanVersion;
 const task=addAssistantTaskStep(db,{projectId,taskId,expectedPlanVersion:planVersionNow,stepId,kind,ordinal,dependsOn,
  action:{type:"create_node",ref:stepId,nodeType:"text",title:"新节点"}});
 const planVersion=task.activePlanVersion,actionDigest=task.steps.find(item=>item.id===stepId).actionDigest;
 return {projectId,taskId,stepId,planVersion,actionDigest};
}
function freeze(fx,step,newNodes=["new"],newConnections=["link"]){
 return prepareAssistantTaskStep(fx.db,{projectId:step.projectId,taskId:step.taskId,
  stepId:step.stepId,expectedPlanVersion:step.planVersion,
  expectedProjectRevision:getProject(fx.db,step.projectId).revision,newNodes,newConnections});
}
function approve(fx,step,requestId="approve-a",decision="approve"){
 return decideAssistantTaskStep(fx.db,{...step,requestId,expectedPlanVersion:step.planVersion,decision});
}
function claim(fx,step){
 return claimAssistantTaskStep(fx.db,{projectId:step.projectId,taskId:step.taskId,
  stepId:step.stepId,expectedPlanVersion:step.planVersion});
}
test("P1a frozen action requires backend approval and unique reservation; no external execution",async t=>{
 const fx=await setup(t),step=seed(fx);
 const prepared=freeze(fx,step);
 assert.equal(prepared.status,"waiting_approval");
 assert.equal(prepared.executionStarted,false);
 assert.match(prepared.preconditions.refs.nodes.new,/^task-node-/);
 assert.match(prepared.preconditions.refs.connections.link,/^task-edge-/);
 assert.deepEqual(prepared.preconditions.refs,
  deterministicAssistantRefs({taskId:fx.taskId,stepId:step.stepId,newNodes:["new"],newConnections:["link"]}));
 assert.throws(()=>claim(fx,step),{code:"assistant_step_already_claimed"});
 assert.throws(()=>approve(fx,{...step,actionDigest:"f".repeat(64)}),{code:"assistant_step_action_changed"});
 assert.equal(approve(fx,step).status,"ready");
 assert.equal(approve(fx,step).existing,true);
 assert.throws(()=>approve(fx,step,"different-request","reject"),{code:"assistant_step_approval_conflict"});
 const first=claim(fx,step);
 assert.equal(first.executionStarted,false);
 assert.match(first.executionKey,/^[0-9a-f]{64}$/);
 assert.equal(first.attemptNo,1);
 assert.equal(first.frozenSnapshot.actionDigest,step.actionDigest);
 assert.deepEqual(first.frozenSnapshot.preconditions.refs,prepared.preconditions.refs);
 assert.throws(()=>claim(fx,step),{code:"assistant_step_already_claimed"});
 assert.equal(verifyAssistantTaskClaim(fx.db,{projectId:fx.projectId,taskId:fx.taskId,
  stepId:step.stepId,planVersion:1,attemptId:first.attemptId,leaseOwner:first.leaseOwner}).executionStarted,false);
 assert.throws(()=>verifyAssistantTaskClaim(fx.db,{projectId:fx.projectId,taskId:fx.taskId,
  stepId:step.stepId,planVersion:1,attemptId:first.attemptId,leaseOwner:"wrong-owner"}),{code:"assistant_step_lease_invalid"});
 const attempt=fx.db.prepare("SELECT status,submitted_at,submit_marker,frozen_snapshot_json FROM assistant_task_attempts").get();
 assert.equal(attempt.status,"prepared");
 assert.equal(attempt.submitted_at,null);assert.equal(attempt.submit_marker,null);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM skill_script_runs").get().n,0);
 const events=getAssistantTask(fx.db,{projectId:fx.projectId,taskId:fx.taskId}).task;
 assert.equal(events.steps[0].receiptTrust,"none");
 assert.equal(events.steps[0].status,"running");
});
test("P1a step claim has deterministic new attempt identity after safe unsubmitted release",async t=>{
 const fx=await setup(t),step=seed(fx);freeze(fx,step);approve(fx,step);
 const first=claim(fx,step);
 assert.throws(()=>releaseUnsubmittedAssistantTaskClaim(fx.db,{projectId:fx.projectId,
  taskId:fx.taskId,stepId:step.stepId,planVersion:1,attemptId:first.attemptId,leaseOwner:"fake-owner"}),
  {code:"assistant_step_lease_invalid"});
 assert.deepEqual(releaseUnsubmittedAssistantTaskClaim(fx.db,{projectId:fx.projectId,taskId:fx.taskId,
  stepId:step.stepId,planVersion:1,attemptId:first.attemptId,leaseOwner:first.leaseOwner}),
  {released:true,executionStarted:false});
 const second=claim(fx,step);
 assert.equal(second.attemptNo,2);
 assert.notEqual(second.executionKey,first.executionKey);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,2);
 assert.equal(fx.db.prepare("SELECT status FROM assistant_task_attempts WHERE id=?").get(first.attemptId).status,
  "released_pre_submit");
});
test("P1a invalid approval or modified graph refuses claim and leaves no Attempt",async t=>{
 const fx=await setup(t),step=seed(fx);freeze(fx,step);
 const api=await fx.app.inject({method:"POST",url:"/api/v1/projects/p-step/assistant/tasks/"+fx.taskId+
  "/steps/"+step.stepId+"/approval",payload:{requestId:"approval-api",
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve"}});
 assert.equal(api.statusCode,200,api.body);
 assert.equal(api.json().status,"ready");
 const repeated=await fx.app.inject({method:"POST",url:"/api/v1/projects/p-step/assistant/tasks/"+fx.taskId+
  "/steps/"+step.stepId+"/approval",payload:{requestId:"approval-api",
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve"}});
 assert.equal(repeated.json().existing,true);
 patchProject(fx.db,{id:fx.projectId,expectedRevision:1,
  document:{...doc,nodes:[...doc.nodes,{id:"other",type:"text"}]}});
 assert.throws(()=>claim(fx,step),{code:"assistant_step_source_changed"});
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,0);
 assert.throws(()=>approve(fx,step,"approve-after-edit"),{code:"assistant_step_source_changed"});
 const mutated=fx.db.prepare("SELECT action_json FROM assistant_task_steps WHERE id=?").get(step.stepId);
 fx.db.prepare("UPDATE assistant_task_steps SET action_json=? WHERE id=?")
  .run(mutated.action_json.replace("新节点","篡改后的节点"),step.stepId);
 assert.throws(()=>claim(fx,step),{code:"assistant_step_action_changed"});
});
test("P1a plan revision invalidates frozen approval and old claimant's writeback",async t=>{
 const fx=await setup(t),step=seed(fx);freeze(fx,step);approve(fx,step);
 const old=claim(fx,step);
 const next=reviseAssistantTaskPlan(fx.db,{projectId:fx.projectId,taskId:fx.taskId,expectedPlanVersion:1});
 assert.equal(next.activePlanVersion,2);
 assert.throws(()=>claim(fx,step),{code:"assistant_step_plan_conflict"});
 assert.throws(()=>verifyAssistantTaskClaim(fx.db,{projectId:fx.projectId,taskId:fx.taskId,
  stepId:step.stepId,planVersion:1,attemptId:old.attemptId,leaseOwner:old.leaseOwner}),
  {code:"assistant_step_plan_conflict"});
 assert.throws(()=>approve(fx,step,"old-approval"),{code:"assistant_step_plan_conflict"});
 const fresh=seed(fx,{stepId:"step-new"});
 assert.equal(fresh.planVersion,2);freeze(fx,fresh);approve(fx,fresh,"approve-next");
 const newer=claim(fx,fresh);
 assert.equal(newer.planVersion,2);
 assert.notEqual(old.executionKey,newer.executionKey);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,2);
});
test("P1a dependencies require server committed receipt; client report cannot satisfy",async t=>{
 const fx=await setup(t),first=seed(fx,{stepId:"first",ordinal:0});
 const follow=seed(fx,{stepId:"follow",ordinal:1,dependsOn:["first"]});
 freeze(fx,first);freeze(fx,follow);approve(fx,follow,"approve-follow");
 assert.throws(()=>claim(fx,follow),{code:"assistant_step_dependency_unverified"});
 fx.db.prepare("UPDATE assistant_task_steps SET status='succeeded',receipt_trust='client_reported' WHERE id='first'").run();
 assert.throws(()=>claim(fx,follow),{code:"assistant_step_dependency_unverified"});
 fx.db.prepare("UPDATE assistant_task_steps SET receipt_trust='server_committed' WHERE id='first'").run();
 assert.equal(claim(fx,follow).executionStarted,false);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
});
test("P1a claim refuses Skill/Job until their explicit P2 authorization and materialization contracts",async t=>{
 const fx=await setup(t);
 for(const kind of ["skill_script","comfy_workflow","model_job"]){
  const step=seed(fx,{stepId:"s-"+kind,ordinal:fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,kind});
  freeze(fx,step,[],[]);approve(fx,step,"ok-"+kind);
  assert.throws(()=>claim(fx,step),{code:"assistant_step_kind_not_ready"});
 }
});
test("P1a simultaneous claim attempts select exactly one lease and the expired holder cannot write",async t=>{
 const fx=await setup(t),step=seed(fx);freeze(fx,step);approve(fx,step);
 const contenders=await Promise.allSettled([Promise.resolve().then(()=>claim(fx,step)),
  Promise.resolve().then(()=>claim(fx,step))]);
 assert.equal(contenders.filter(item=>item.status==="fulfilled").length,1);
 assert.equal(contenders.filter(item=>item.status==="rejected").length,1);
 const first=contenders.find(item=>item.status==="fulfilled").value;
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,1);
 fx.db.prepare("UPDATE assistant_task_steps SET lease_expires_at=0 WHERE id=?").run(step.stepId);
 assert.throws(()=>verifyAssistantTaskClaim(fx.db,{projectId:fx.projectId,taskId:fx.taskId,
  stepId:step.stepId,planVersion:1,attemptId:first.attemptId,leaseOwner:first.leaseOwner}),
  {code:"assistant_step_lease_invalid"});
 assert.throws(()=>releaseUnsubmittedAssistantTaskClaim(fx.db,{projectId:fx.projectId,taskId:fx.taskId,
  stepId:step.stepId,planVersion:1,attemptId:first.attemptId,leaseOwner:first.leaseOwner}),
  {code:"assistant_step_lease_invalid"});
 assert.throws(()=>claim(fx,step),{code:"assistant_step_already_claimed"});
});
test("P1a a prepared claimant loses authority after graph changes; old planner cannot append to revised plan",async t=>{
 const fx=await setup(t),step=seed(fx);freeze(fx,step);approve(fx,step);
 const attempt=claim(fx,step);
 patchProject(fx.db,{id:fx.projectId,expectedRevision:1,document:{
  ...doc,nodes:[...doc.nodes,{id:"graph-changed",type:"text"}]}});
 assert.throws(()=>verifyAssistantTaskClaim(fx.db,{projectId:fx.projectId,taskId:fx.taskId,
  stepId:step.stepId,planVersion:1,attemptId:attempt.attemptId,leaseOwner:attempt.leaseOwner}),
  {code:"assistant_step_source_changed"});
 const revised=reviseAssistantTaskPlan(fx.db,{projectId:fx.projectId,taskId:fx.taskId,expectedPlanVersion:1});
 assert.equal(revised.activePlanVersion,2);
 assert.throws(()=>addAssistantTaskStep(fx.db,{projectId:fx.projectId,taskId:fx.taskId,
  expectedPlanVersion:1,stepId:"old-plan-extra",kind:"canvas_mutation",
  ordinal:7,action:{type:"delete_node",targetId:"existing"}}),{code:"assistant_step_plan_conflict"});
});
test("P1a explicit refusal is durable and cannot be overwritten by an approval request",async t=>{
 const fx=await setup(t),step=seed(fx);freeze(fx,step);
 assert.equal(approve(fx,step,"reject-it","reject").status,"blocked");
 assert.throws(()=>claim(fx,step),{code:"assistant_task_not_editable"});
 assert.throws(()=>approve(fx,step,"later-approval","approve"),{code:"assistant_task_not_editable"});
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,0);
});

test("P1a blocked, failed and reconciliation Tasks cannot claim a Step; deleted projects cannot replan",async t=>{
 const fx=await setup(t),step=seed(fx);freeze(fx,step);approve(fx,step);
 for(const status of ["blocked","failed","needs_reconcile","waiting_external"]){
  fx.db.prepare("UPDATE assistant_tasks SET status=? WHERE id=?").run(status,fx.taskId);
  assert.throws(()=>claim(fx,step),{code:"assistant_task_not_editable"});
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,0);
 }
 fx.db.prepare("UPDATE assistant_tasks SET status='ready' WHERE id=?").run(fx.taskId);
 assert.equal(claim(fx,step).executionStarted,false);
 fx.db.prepare("UPDATE projects SET deleted_at=? WHERE id=?").run(Date.now(),fx.projectId);
 assert.throws(()=>reviseAssistantTaskPlan(fx.db,{projectId:fx.projectId,taskId:fx.taskId,
  expectedPlanVersion:1}),{code:"assistant_task_not_found"});
});

test("P1a rejects malformed alias plan, stale preconditions, and dependency cycles before approval",async t=>{
 const fx=await setup(t),step=seed(fx);
 assert.throws(()=>freeze(fx,step,["same","same"],[]),{code:"assistant_step_invalid"});
 assert.throws(()=>prepareAssistantTaskStep(fx.db,{...step,expectedPlanVersion:1,
  expectedProjectRevision:2}),{code:"assistant_step_source_changed"});
 const dangling=seed(fx,{stepId:"dangling",ordinal:1,dependsOn:["missing"]});
 assert.throws(()=>freeze(fx,dangling),{code:"assistant_step_dependency_invalid"});
 const late=seed(fx,{stepId:"late",ordinal:2,dependsOn:["dangling"]});
 // A valid pending dependency can be frozen, but is never considered completed.
 freeze(fx,late);approve(fx,late,"approve-late");
 assert.throws(()=>claim(fx,late),{code:"assistant_step_dependency_unverified"});
});
