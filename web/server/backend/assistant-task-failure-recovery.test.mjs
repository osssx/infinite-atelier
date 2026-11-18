import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync,backup} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {fingerprintSource} from "./repository.mjs";
import {createAssistantTask,getAssistantTask} from "./assistant-tasks.mjs";
import {registerAssistantRunSequence,getAssistantRunSequence} from "./assistant-task-run-sequences.mjs";
import {inspectAssistantRunFailureRecovery,confirmAssistantRunFailureRecovery} from "./assistant-task-failure-recovery.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep,reconcileAssistantExternalTask,
 recoverAssistantExternalTasksAtStartup} from "./assistant-task-external-jobs.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {buildApp} from "./app.mjs";
const node=id=>({id,type:"text",title:id,position:{x:0,y:0},width:300,height:200,metadata:{content:"Text "+id}});
const document={nodes:[node("first"),node("fallback"),node("third")],connections:[]};
const actions=[{type:"run_node",nodeId:"first",mode:"text"},
 {type:"run_node",nodeId:"fallback",mode:"text"}];
function setup(t,{mode="submitting",alternative=actions}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"先执行再安全备用",requestId:"new-task"}).task;
 const ctx={db,projectId:"p",taskId:task.id};
 const seq=registerAssistantRunSequence(db,{...ctx,requestId:"capture",
  sourceMessageId:"frozen-intent",expectedPlanVersion:1,expectedProjectRevision:1,
  actions:alternative});
 const plan=planAssistantExternalJobStep(db,{...ctx,requestId:"first-plan",
  kind:"model_job",expectedPlanVersion:1,expectedProjectRevision:1,
  job:{targetNodeId:"first",sourceNodeFingerprint:fingerprintSource(document,"first"),
   executionMode:"poll",snapshot:{adapterKind:"model",task:{kind:"text",model:"mock",prompt:"Text first"}}},
  runSequenceId:seq.sequenceId,runIndex:0,dependsOn:[]});
 decideAssistantTaskStep(db,{...ctx,stepId:plan.stepId,requestId:"approval-first",
  expectedPlanVersion:1,actionDigest:plan.actionDigest,decision:"approve"});
 const queued=enqueueAssistantExternalJobStep(db,{...ctx,stepId:plan.stepId,
  requestId:"enqueue-first",expectedPlanVersion:1,actionDigest:plan.actionDigest});
 if(mode!=="unknown"){
  const at=Date.now(),marker="fixture-submit-marker";
  const from=mode==="collecting"?"collecting":mode==="running"?"running":
   mode==="preparing"?"preparing":"submitting";
  const remote=mode==="running"||mode==="collecting"||mode==="reconciled"?"remote-verified":null;
  db.prepare("UPDATE jobs SET status='failed',submit_marker=?,submission_started_at=?,upstream_task_id=?,updated_at=? WHERE id=?")
   .run(mode==="preparing"?null:marker,mode==="preparing"?null:at,remote,at,queued.jobId);
  const event=mode==="reconciled"?
   {kind:"job_reconciliation_verified",payload:{verified:true,from:"submission_unknown",to:"failed",remoteTaskVerified:true}}:
   {kind:"job_status",payload:{from,to:"failed"}};
  db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
   .run(queued.jobId,event.kind,JSON.stringify(event.payload),at);
 }else{
  db.prepare("UPDATE jobs SET status='submission_unknown' WHERE id=?").run(queued.jobId);
 }
 reconcileAssistantExternalTask(db,ctx);
 return {ctx,seq,plan,jobId:queued.jobId};
}
const inspect=({ctx})=>inspectAssistantRunFailureRecovery(ctx.db,ctx);
function recover(fixture,requestId="confirm-fallback",overrides={}){
 const result=inspect(fixture);
 return confirmAssistantRunFailureRecovery(fixture.ctx.db,{...fixture.ctx,
  requestId,expectedPlanVersion:1,expectedProjectRevision:1,
  evidenceDigest:result.evidenceDigest??"0".repeat(64),...overrides});
}
function planFallback(fixture){
 const {ctx}=fixture,view=getAssistantRunSequence(ctx.db,ctx);
 assert.equal(view.state,"ready");
 assert.equal(view.next.index,0);
 const action=view.next.action;
 return planAssistantExternalJobStep(ctx.db,{...ctx,requestId:"fallback-freeze",
  expectedPlanVersion:2,expectedProjectRevision:1,kind:"model_job",dependsOn:[],
  job:{targetNodeId:action.nodeId,sourceNodeFingerprint:fingerprintSource(document,action.nodeId),
   executionMode:"poll",snapshot:{adapterKind:"model",task:{kind:"text",model:"mock",prompt:"Text fallback"}}},
  runSequenceId:view.sequence.id,runIndex:0});
}
function count(db,table){return db.prepare("SELECT COUNT(*) AS n FROM "+table).get().n}
test("P3c3d confirmed not accepted atomically freezes independent fallback; no Job before approval",t=>{
 const f=setup(t),{ctx,jobId}=f;
 assert.equal(SCHEMA_VERSION,33);
 assert.equal(getAssistantTask(ctx.db,ctx).task.status,"failed");
 const state=inspect(f);
 assert.equal(state.canRecover,true);
 assert.equal(state.failureReason,"provider_confirmed_not_accepted");
 assert.deepEqual(state.fallbackAction,actions[1]);
 assert.throws(()=>recover(f,"forged",{evidenceDigest:"0".repeat(64)}),{
  code:"assistant_task_run_failure_not_ready"});
 const recovered=recover(f);
 assert.equal(recovered.planVersion,2);
 assert.equal(recovered.executionStarted,false);
 assert.equal(count(ctx.db,"jobs"),1);
 assert.equal(count(ctx.db,"assistant_task_run_failovers"),1);
 assert.equal(recover(f,"confirm-fallback",{evidenceDigest:state.evidenceDigest}).existing,true);
 assert.equal(getAssistantTask(ctx.db,ctx).task.status,"planning");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(f.plan.stepId).status,"failed");
 assert.equal(ctx.db.prepare("SELECT status FROM assistant_task_run_sequences WHERE id=?").get(f.seq.sequenceId).status,"cancelled");
 const frozen=planFallback(f);
 assert.equal(count(ctx.db,"jobs"),1);
 assert.equal(JSON.parse(ctx.db.prepare("SELECT preconditions_json FROM assistant_task_steps WHERE id=?")
  .get(frozen.stepId).preconditions_json).failoverEvidenceDigest,state.evidenceDigest);
 decideAssistantTaskStep(ctx.db,{...ctx,stepId:frozen.stepId,requestId:"approve-fallback",
  expectedPlanVersion:2,actionDigest:frozen.actionDigest,decision:"approve"});
 assert.equal(count(ctx.db,"jobs"),1);
 const next=enqueueAssistantExternalJobStep(ctx.db,{...ctx,stepId:frozen.stepId,
  expectedPlanVersion:2,actionDigest:frozen.actionDigest,requestId:"enqueue-fallback"});
 assert.ok(next.jobId);
 assert.notEqual(next.jobId,jobId);
 assert.equal(count(ctx.db,"jobs"),2);
});
test("P3c3d authoritative pre-submit and remote failed proof accepted, collecting failure rejected",t=>{
 for(const mode of ["preparing","running","reconciled"]){
  const f=setup(t,{mode});
  assert.equal(inspect(f).canRecover,true,mode);
 }
 const collecting=setup(t,{mode:"collecting"});
 assert.equal(inspect(collecting).canRecover,false);
 assert.equal(inspect(collecting).reason,"job_failure_evidence_unverified");
 assert.equal(count(collecting.ctx.db,"assistant_task_run_failovers"),0);
});
test("P3c3d submission unknown and absent coordinator proof cannot be interpreted as definitive failed",t=>{
 const f=setup(t,{mode:"unknown"}),{ctx}=f;
 assert.equal(getAssistantTask(ctx.db,ctx).task.status,"needs_reconcile");
 assert.equal(inspect(f).canRecover,false);
 assert.throws(()=>recover(f),{code:"assistant_task_run_failure_not_ready"});
 assert.equal(count(ctx.db,"jobs"),1);
 const known=setup(t);
 known.ctx.db.prepare("DELETE FROM job_events WHERE job_id=?").run(known.jobId);
 assert.equal(inspect(known).canRecover,false);
 assert.throws(()=>recover(known),{code:"assistant_task_run_failure_not_ready"});
});
test("P3c3d partial artifact on failed Job forbids failover and duplicate paid submit",t=>{
 const f=setup(t),{ctx}=f;
 ctx.db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES('partial-blob',? ,8,'text/plain','partial.txt','ready')")
  .run("b".repeat(64));
 ctx.db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) VALUES('partial-artifact',?,NULL,'partial','partial-blob','text','text/plain',?,'{}')")
  .run(f.jobId,"b".repeat(64));
 assert.equal(inspect(f).canRecover,false);
 assert.equal(count(ctx.db,"jobs"),1);
});
test("P3c3d frozen failover proof is checked at paid enqueue, not only at planning",t=>{
 const f=setup(t),{ctx}=f,proof=inspect(f).evidenceDigest;
 recover(f);
 const frozen=planFallback(f);
 decideAssistantTaskStep(ctx.db,{...ctx,stepId:frozen.stepId,
  requestId:"approve-fallback",expectedPlanVersion:2,
  actionDigest:frozen.actionDigest,decision:"approve"});
 ctx.db.prepare("UPDATE jobs SET status='submission_unknown' WHERE id=?").run(f.jobId);
 assert.throws(()=>enqueueAssistantExternalJobStep(ctx.db,{...ctx,stepId:frozen.stepId,
  expectedPlanVersion:2,actionDigest:frozen.actionDigest,requestId:"broken-proof"}),
  {code:"assistant_task_run_failure_evidence_invalidated"});
 assert.equal(count(ctx.db,"jobs"),1);
 assert.equal(getAssistantRunSequence(ctx.db,ctx).state,"failover_evidence_invalidated");
 ctx.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(f.jobId);
 assert.equal(inspectAssistantRunFailureRecovery(ctx.db,ctx).canRecover,false); // already planning, no second recovery
 assert.equal(getAssistantRunSequence(ctx.db,ctx).state,"ready");
 assert.equal(JSON.parse(ctx.db.prepare("SELECT preconditions_json FROM assistant_task_steps WHERE id=?").get(frozen.stepId).preconditions_json).failoverEvidenceDigest,proof);
});
test("P3c3d tampered original frozen fallback does not pass paid Job enqueue",t=>{
 const f=setup(t),{ctx}=f;
 recover(f);
 const frozen=planFallback(f);
 decideAssistantTaskStep(ctx.db,{...ctx,stepId:frozen.stepId,
  requestId:"approve-original-fallback",expectedPlanVersion:2,
  actionDigest:frozen.actionDigest,decision:"approve"});
 ctx.db.prepare("UPDATE assistant_task_run_sequences SET actions_json=? WHERE id=?")
  .run(JSON.stringify([actions[0],{type:"run_node",nodeId:"third",mode:"text"}]),f.seq.sequenceId);
 assert.equal(getAssistantRunSequence(ctx.db,ctx).state,"failover_evidence_invalidated");
 assert.throws(()=>enqueueAssistantExternalJobStep(ctx.db,{...ctx,stepId:frozen.stepId,
  expectedPlanVersion:2,actionDigest:frozen.actionDigest,requestId:"altered-original"}),
  {code:"assistant_task_run_failure_evidence_invalidated"});
 assert.equal(count(ctx.db,"jobs"),1);
});
test("P3c3d HTTP safe failover confirmation is idempotent, and restarting SQLite cannot replay old Job",async t=>{
 const f=setup(t),{ctx}=f,app=buildApp({db:ctx.db,authorize:()=>true});
 t.after(async()=>app.close());
 const path="/api/v1/projects/p/assistant/tasks/"+ctx.taskId+"/run-sequences/failure-recovery";
 const listed=await app.inject({method:"GET",url:path});
 assert.equal(listed.statusCode,200);
 assert.equal(listed.json().canRecover,true);
 const payload={requestId:"http-failover",expectedPlanVersion:1,expectedProjectRevision:1,
  evidenceDigest:listed.json().evidenceDigest};
 assert.equal((await app.inject({method:"POST",url:path,payload:{...payload,evidenceDigest:"0".repeat(64)}})).statusCode,409);
 const confirmed=await app.inject({method:"POST",url:path,payload});
 assert.equal(confirmed.statusCode,200,confirmed.body);
 assert.equal(confirmed.json().executionStarted,false);
 assert.equal((await app.inject({method:"POST",url:path,payload})).json().existing,true);
 assert.equal(count(ctx.db,"jobs"),1);
 const dir=mkdtempSync(join(tmpdir(),"atelier-failure-")),file=join(dir,"fixture.db");
 let reopened;
 t.after(()=>{try{reopened?.close()}catch{};rmSync(dir,{recursive:true,force:true})});
 await backup(ctx.db,file);
 reopened=new DatabaseSync(file);initializeSchema(reopened);
 const view=getAssistantRunSequence(reopened,ctx);
 assert.equal(view.state,"ready");
 assert.equal(view.next.index,0);
 assert.equal(count(reopened,"jobs"),1);
 assert.equal(count(reopened,"assistant_task_run_failovers"),1);
 assert.equal(recoverAssistantExternalTasksAtStartup(reopened).advanced,0);
 assert.equal(count(reopened,"jobs"),1);
});
test("P3c3d no pre-frozen independent fallback leaves original Task failed",t=>{
 const conditional=[{type:"run_node",nodeId:"first",mode:"text"},
  {type:"run_node",nodeId:"fallback",mode:"text",
   when:{sourceIndex:0,kind:"text",op:"gte",count:1}},
  {type:"run_node",nodeId:"third",mode:"text",
   when:{sourceIndex:0,kind:"text",op:"lt",count:1}}];
 const f=setup(t,{alternative:conditional});
 assert.equal(inspect(f).canRecover,false);
 assert.equal(inspect(f).reason,"no_frozen_independent_fallback");
 assert.equal(count(f.ctx.db,"jobs"),1);
});
