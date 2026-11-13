import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {fingerprintSource} from "./repository.mjs";
import {createAssistantTask,cancelAssistantTask,getAssistantTask} from "./assistant-tasks.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep,
 reconcileAssistantExternalTask,recoverAssistantExternalTasksAtStartup} from "./assistant-task-external-jobs.mjs";

const doc={nodes:[{id:"source",type:"text",title:"输入",
 position:{x:0,y:0},width:340,height:240,metadata:{content:"hi"}}],connections:[]};
function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:doc});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"生成图片并落图",requestId:"task-created"}).task;
 return {db,projectId:"p",taskId:task.id};
}
function job(ctx,kind="model_job"){
 return {targetNodeId:"source",sourceNodeFingerprint:fingerprintSource(doc,"source"),
  executionMode:"poll",snapshot:kind==="comfy_workflow"?
   {adapterKind:"comfy",instanceId:"comfy-local",workflowId:"fixture"}:
   {adapterKind:"model",task:{kind:"text"},model:"mock"}};
}
function plan(ctx,opts={}){
 const {kind="model_job",requestId="plan",finalizeTask=true}=opts;
 return planAssistantExternalJobStep(ctx.db,{projectId:ctx.projectId,taskId:ctx.taskId,
  requestId,kind,expectedPlanVersion:1,expectedProjectRevision:1,
  job:job(ctx,kind),finalizeTask});
}
const approve=(ctx,step)=>decideAssistantTaskStep(ctx.db,{
 projectId:ctx.projectId,taskId:ctx.taskId,stepId:step.stepId,
 requestId:"approval-"+step.stepId,expectedPlanVersion:step.planVersion,
 actionDigest:step.actionDigest,decision:"approve"});
const enqueue=(ctx,step,opts={})=>enqueueAssistantExternalJobStep(ctx.db,{
 projectId:ctx.projectId,taskId:ctx.taskId,stepId:step.stepId,
 requestId:"enqueue-"+step.stepId,expectedPlanVersion:step.planVersion,
 actionDigest:step.actionDigest,...opts});
function artifact(ctx,jobId,{status=null,withNode=false}={}){
 const blobId="b-"+Math.random().toString(16).slice(2,8);
 ctx.db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,'16','text/plain',?,'ready')")
  .run(blobId,"b".repeat(64),"fixture/"+blobId);
 const artifactId="artifact-"+blobId;
 ctx.db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) VALUES(?,?,NULL,? ,?,'text','text/plain',?,'{}')")
  .run(artifactId,jobId,"output",blobId,"b".repeat(64));
 if(status){
  ctx.db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES(?,?,?,?,?,?)")
   .run("material-"+blobId,jobId,artifactId,ctx.projectId,status,withNode?"output-node":null);
 }
 if(withNode){
  const next=getProject(ctx.db,"p").document;
  next.nodes.push({id:"output-node",type:"text",title:"生成结果",position:{x:450,y:0},
   width:340,height:240,metadata:{content:"generated"}});
  ctx.db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id=?")
   .run(JSON.stringify(next),ctx.projectId);
 }
 return artifactId;
}
const setJob=(ctx,jobId,status)=>ctx.db.prepare("UPDATE jobs SET status=?,updated_at=? WHERE id=?").run(status,Date.now(),jobId);
const count=(ctx,table)=>ctx.db.prepare("SELECT COUNT(*) AS n FROM "+table).get().n;

test("P2a approval and one local enqueue transaction bind Job, Attempt and Step",t=>{
 const ctx=setup(t),step=plan(ctx);
 assert.equal(step.status,"waiting_approval");
 assert.equal(count(ctx,"jobs"),0);
 assert.equal(plan(ctx).stepId,step.stepId);
 assert.throws(()=>enqueue(ctx,step),{code:"assistant_step_already_claimed"});
 assert.equal(count(ctx,"jobs"),0);
 approve(ctx,step);
 const first=enqueue(ctx,step);
 assert.equal(first.status,"waiting_external");
 assert.equal(count(ctx,"jobs"),1);
 assert.equal(count(ctx,"assistant_task_attempts"),1);
 assert.equal(ctx.db.prepare("SELECT status FROM jobs").get().status,"queued");
 const attempt=ctx.db.prepare("SELECT * FROM assistant_task_attempts").get();
 assert.equal(attempt.external_id,first.jobId);
 assert.equal(attempt.external_kind,"job");
 assert.equal(attempt.submit_marker,"job_queued_atomic");
 assert.equal(ctx.db.prepare("SELECT idempotency_key FROM jobs").get().idempotency_key,attempt.execution_key);
 assert.equal(ctx.db.prepare("SELECT receipt_trust,status FROM assistant_task_steps").get().receipt_trust,"none");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_tasks").get().status,"waiting_external");
 assert.equal(enqueue(ctx,step).jobId,first.jobId);
 assert.equal(enqueue(ctx,step,{requestId:"new-enqueue-key"}).jobId,first.jobId);
 assert.equal(count(ctx,"jobs"),1);
 assert.equal(count(ctx,"assistant_task_attempts"),1);
 assert.throws(()=>enqueue(ctx,step,{requestId:"enqueue-"+step.stepId,actionDigest:"f".repeat(64)}),
  {code:"assistant_task_command_conflict"});
});
test("P2a fault after job insert before Task link rolls back all rows and leaves step re-executable",t=>{
 const ctx=setup(t),step=plan(ctx);approve(ctx,step);
 assert.throws(()=>enqueue(ctx,step,{beforeLink:()=>{throw Error("failure_after_job_insert")}}),/failure_after_job_insert/);
 assert.equal(count(ctx,"jobs"),0);
 assert.equal(count(ctx,"assistant_task_attempts"),0);
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_steps").get().status,"ready");
 assert.equal(enqueue(ctx,step).status,"waiting_external");
 assert.equal(count(ctx,"jobs"),1);
});
test("P2a success requires distinct trusted materialization before completing Task",t=>{
 const ctx=setup(t),step=plan(ctx),approved=approve(ctx,step),result=enqueue(ctx,step);
 assert.equal(approved.status,"ready");
 assert.deepEqual(reconcileAssistantExternalTask(ctx.db,ctx).advanced,0);
 assert.equal(recoverAssistantExternalTasksAtStartup(ctx.db).advanced,0);
 setJob(ctx,result.jobId,"succeeded");
 assert.equal(reconcileAssistantExternalTask(ctx.db,ctx).advanced,1);
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(step.stepId).status,"needs_reconcile");
 assert.equal(count(ctx,"assistant_task_steps"),1);
 artifact(ctx,result.jobId,{status:"retry"});
 assert.ok(reconcileAssistantExternalTask(ctx.db,ctx).advanced>=1);
 const gen=ctx.db.prepare("SELECT status,receipt_trust FROM assistant_task_steps WHERE id=?").get(step.stepId);
 assert.equal(gen.status,"succeeded");
 assert.equal(gen.receipt_trust,"server_committed");
 const mat=ctx.db.prepare("SELECT * FROM assistant_task_steps WHERE kind='materialize'").get();
 assert.equal(mat.status,"waiting_external");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_tasks").get().status,"waiting_external");
 assert.equal(reconcileAssistantExternalTask(ctx.db,ctx).advanced,0);
 // The materializer, not the Task Executor, commits the artifact node.
 ctx.db.prepare("UPDATE materializations SET status='materialized',node_id='output-node'").run();
 const next=getProject(ctx.db,"p").document;
 next.nodes.push({id:"output-node",type:"text",title:"落盘",position:{x:450,y:0},width:340,height:240,metadata:{content:"hello"}});
 ctx.db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'").run(JSON.stringify(next));
 assert.equal(recoverAssistantExternalTasksAtStartup(ctx.db).advanced,1);
 assert.equal(ctx.db.prepare("SELECT status,receipt_trust FROM assistant_task_steps WHERE kind='materialize'").get().receipt_trust,"server_committed");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_tasks").get().status,"completed");
 assert.equal(reconcileAssistantExternalTask(ctx.db,ctx).advanced,0);
 assert.equal(count(ctx,"jobs"),1);
});
test("P2a submission_unknown is evidence-only; no duplicate job after startup",t=>{
 const ctx=setup(t),step=plan(ctx);approve(ctx,step);
 const first=enqueue(ctx,step);
 setJob(ctx,first.jobId,"submission_unknown");
 assert.equal(recoverAssistantExternalTasksAtStartup(ctx.db).advanced,1);
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_tasks").get().status,"needs_reconcile");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_attempts").get().status,"needs_reconcile");
 assert.equal(recoverAssistantExternalTasksAtStartup(ctx.db).advanced,1);
 assert.equal(count(ctx,"jobs"),1);
 assert.throws(()=>enqueue(ctx,step,{requestId:"retry-separate"}),{code:"assistant_task_not_editable"});
});
test("P2a cancellation after enqueue does not mark external Job cancelled; late outcome is audited",t=>{
 const ctx=setup(t),step=plan(ctx);approve(ctx,step);
 const first=enqueue(ctx,step);
 assert.equal(cancelAssistantTask(ctx.db,{...ctx,requestId:"cancel"}).task.status,"cancelling");
 assert.equal(ctx.db.prepare("SELECT status FROM jobs").get().status,"queued");
 setJob(ctx,first.jobId,"succeeded");
 artifact(ctx,first.jobId);
 assert.equal(reconcileAssistantExternalTask(ctx.db,ctx).advanced,1);
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_tasks").get().status,"cancelled");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(step.stepId).status,"succeeded");
 assert.equal(count(ctx,"assistant_task_steps"),1);
 assert.equal(count(ctx,"jobs"),1);
});

test("P2a blocked materialization can recover from original artifacts without recreating Job",t=>{
 const ctx=setup(t),step=plan(ctx);approve(ctx,step);
 const queued=enqueue(ctx,step);setJob(ctx,queued.jobId,"succeeded");
 artifact(ctx,queued.jobId,{status:"blocked"});
 reconcileAssistantExternalTask(ctx.db,ctx);
 const mat=ctx.db.prepare("SELECT status FROM assistant_task_steps WHERE kind='materialize'").get();
 assert.equal(mat.status,"blocked");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_tasks").get().status,"blocked");
 ctx.db.prepare("UPDATE materializations SET status='retry'").run();
 assert.equal(reconcileAssistantExternalTask(ctx.db,ctx).advanced,1);
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_steps WHERE kind='materialize'").get().status,"waiting_external");
 ctx.db.prepare("UPDATE materializations SET status='materialized',node_id='output-node'").run();
 const graph=getProject(ctx.db,"p").document;
 graph.nodes.push({id:"output-node",type:"text",title:"恢复落图",position:{x:0,y:0},
  width:340,height:240,metadata:{content:"ok"}});
 ctx.db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'").run(JSON.stringify(graph));
 reconcileAssistantExternalTask(ctx.db,ctx);
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_tasks").get().status,"completed");
 assert.equal(count(ctx,"jobs"),1);
});
test("P2a cancelling during materialization prevents downstream and does not fake provider cancellation",t=>{
 const ctx=setup(t),step=plan(ctx);approve(ctx,step);
 const queued=enqueue(ctx,step);setJob(ctx,queued.jobId,"succeeded");
 artifact(ctx,queued.jobId,{status:"retry"});
 reconcileAssistantExternalTask(ctx.db,ctx);
 const cancelled=cancelAssistantTask(ctx.db,{projectId:"p",taskId:ctx.taskId,requestId:"cancel-while-materializing"});
 assert.equal(cancelled.task.status,"cancelled");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_steps WHERE kind='materialize'").get().status,"blocked");
 assert.equal(ctx.db.prepare("SELECT status FROM jobs").get().status,"succeeded");
 assert.equal(recoverAssistantExternalTasksAtStartup(ctx.db).advanced,0);
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_tasks").get().status,"cancelled");
});
test("P2a model vs Comfy job kinds are distinct and invalid snapshot is rejected",t=>{
 const ctx=setup(t);
 assert.throws(()=>planAssistantExternalJobStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  requestId:"bad",kind:"model_job",expectedPlanVersion:1,expectedProjectRevision:1,
  job:job(ctx,"comfy_workflow")}),{code:"assistant_external_invalid"});
 const planned=plan(ctx,{kind:"comfy_workflow"});
 assert.equal(planned.kind,"comfy_workflow");
 approve(ctx,planned);
 assert.equal(enqueue(ctx,planned).status,"waiting_external");
 assert.equal(ctx.db.prepare("SELECT snapshot_json FROM jobs").get().snapshot_json.includes('"adapterKind":"comfy"'),true);
});
