import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {fingerprintSource} from "./repository.mjs";
import {createAssistantTask,getAssistantTask} from "./assistant-tasks.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep,reconcileAssistantExternalTask} from "./assistant-task-external-jobs.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {inspectAssistantTaskRecovery,replanAssistantTaskSafely} from "./assistant-task-safe-replan.mjs";
import {registerAssistantRunSequence} from "./assistant-task-run-sequences.mjs";
const doc={nodes:[{id:"source",type:"text",title:"Source",position:{x:0,y:0},
 width:340,height:240,metadata:{content:"a rose"}},
 {id:"target",type:"text",title:"Target",position:{x:380,y:0},width:340,height:240,metadata:{content:"after"}}],connections:[]};
function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:doc});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"生成文本",requestId:"create"}).task;
 return {db,projectId:"p",taskId:task.id};
}
function step(ctx,requestId="plan",sequence){
 return planAssistantExternalJobStep(ctx.db,{...ctx,requestId,kind:"model_job",
  expectedPlanVersion:1,expectedProjectRevision:1,
  ...(sequence?{runSequenceId:sequence.sequenceId,runIndex:0}:{}),
  job:{targetNodeId:"source",sourceNodeFingerprint:fingerprintSource(doc,"source"),
   executionMode:"poll",snapshot:{adapterKind:"model",task:{kind:"text",model:"fixture",prompt:"rose"}}}});
}
const replan=(ctx,requestId="replan")=>replanAssistantTaskSafely(ctx.db,{
 projectId:ctx.projectId,taskId:ctx.taskId,requestId,
 expectedPlanVersion:1,expectedProjectRevision:1});
test("P3c rejected approval can safely replan but never silently enqueue",t=>{
 const ctx=setup(t),first=step(ctx);
 assert.equal(inspectAssistantTaskRecovery(ctx.db,ctx).canReplan,false);
 decideAssistantTaskStep(ctx.db,{...ctx,stepId:first.stepId,requestId:"reject",
  expectedPlanVersion:1,actionDigest:first.actionDigest,decision:"reject"});
 assert.equal(inspectAssistantTaskRecovery(ctx.db,ctx).canReplan,true);
 const revised=replan(ctx);
 assert.equal(revised.activePlanVersion,2);
 assert.equal(revised.executionStarted,false);
 assert.equal(replan(ctx).existing,true);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
 assert.equal(getAssistantTask(ctx.db,ctx).task.status,"planning");
 assert.equal(getAssistantTask(ctx.db,ctx).task.activePlanVersion,2);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='safe_replan_authorized'").get().n,1);
 assert.throws(()=>replan(ctx,"other-request"),{code:"assistant_step_plan_conflict"});
 assert.throws(()=>enqueueAssistantExternalJobStep(ctx.db,{...ctx,stepId:first.stepId,
  requestId:"stale",expectedPlanVersion:1,actionDigest:first.actionDigest}));
});
test("P3c confirmed failure with no artifacts may replan, retaining original Job as evidence",t=>{
 const ctx=setup(t),first=step(ctx);
 decideAssistantTaskStep(ctx.db,{...ctx,stepId:first.stepId,requestId:"approve",
  expectedPlanVersion:1,actionDigest:first.actionDigest,decision:"approve"});
 const queued=enqueueAssistantExternalJobStep(ctx.db,{...ctx,stepId:first.stepId,
  requestId:"enqueue",expectedPlanVersion:1,actionDigest:first.actionDigest});
 ctx.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(queued.jobId);
 reconcileAssistantExternalTask(ctx.db,ctx);
 const before=inspectAssistantTaskRecovery(ctx.db,ctx);
 assert.equal(before.canReplan,true);
 assert.equal(before.failedJobs,1);
 assert.equal(replan(ctx).activePlanVersion,2);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(ctx.db.prepare("SELECT status FROM jobs WHERE id=?").get(queued.jobId).status,"failed");
});
test("P3c unknown provider result and successful-but-unmaterialized output prohibit replanning",t=>{
 const ctx=setup(t),first=step(ctx);
 decideAssistantTaskStep(ctx.db,{...ctx,stepId:first.stepId,requestId:"approve",
  expectedPlanVersion:1,actionDigest:first.actionDigest,decision:"approve"});
 const queued=enqueueAssistantExternalJobStep(ctx.db,{...ctx,stepId:first.stepId,
  requestId:"enqueue",expectedPlanVersion:1,actionDigest:first.actionDigest});
 ctx.db.prepare("UPDATE jobs SET status='submission_unknown' WHERE id=?").run(queued.jobId);
 reconcileAssistantExternalTask(ctx.db,ctx);
 assert.equal(inspectAssistantTaskRecovery(ctx.db,ctx).canReplan,false);
 assert.throws(()=>replan(ctx),/assistant_task_replan_blocked/);
 ctx.db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(queued.jobId);
 // A succeeded Job with no confirmed artifact is not a failure/retry signal.
 reconcileAssistantExternalTask(ctx.db,ctx);
 assert.equal(inspectAssistantTaskRecovery(ctx.db,ctx).canReplan,false);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
});
test("P3c replan abandons old frozen sequence without creating a new Job",t=>{
 const ctx=setup(t);
 const run=registerAssistantRunSequence(ctx.db,{...ctx,requestId:"run",sourceMessageId:"message",
  expectedPlanVersion:1,expectedProjectRevision:1,
  actions:[{type:"run_node",nodeId:"source",mode:"text"},
   {type:"run_node",nodeId:"target",mode:"text"}]});
 const frozen=step(ctx,"first-sequence-step",run);
 decideAssistantTaskStep(ctx.db,{...ctx,stepId:frozen.stepId,requestId:"reject-sequence",
  expectedPlanVersion:1,actionDigest:frozen.actionDigest,decision:"reject"});
 assert.equal(replan(ctx).activePlanVersion,2);
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_run_sequences WHERE id=?").get(run.sequenceId).status,"cancelled");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
});
