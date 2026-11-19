import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync,backup} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {zipSync,strToU8} from "fflate";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createProject,getProject,saveSingleUserCanvas} from "./projects.mjs";
import {createAssistantTask,cancelAssistantTask} from "./assistant-tasks.mjs";
import {fingerprintSource,appendArtifact} from "./repository.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {registerAssistantRunSequence,getAssistantRunSequence} from "./assistant-task-run-sequences.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep,reconcileAssistantExternalTask,recoverAssistantExternalTasksAtStartup} from "./assistant-task-external-jobs.mjs";
import {inspectAssistantTaskRecovery,replanAssistantTaskSafely} from "./assistant-task-safe-replan.mjs";
import {planAssistantSkillStep,executeAssistantSkillStep} from "./assistant-task-skills.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {createCanvasMaterializer} from "./canvas-materializer.mjs";
import {createAssistantTaskContinuationEvents} from "./assistant-task-continuation-events.mjs";
import {createLocalBackend} from "./runtime.mjs";

const node=id=>({id,type:"text",title:id,position:{x:0,y:0},width:320,height:220,
 metadata:{content:"",prompt:"请写一个动画故事："+id}});
const doc={nodes:[node("first"),node("second"),node("third")],connections:[]};
const count=(db,table)=>db.prepare("SELECT COUNT(*) n FROM "+table).get().n;
function fixture(t,{sequence=true,autoJob=true,autoMaterialize=true,prepare=async()=>{},actions=[
 {type:"run_node",nodeId:"first",mode:"text"},
 {type:"run_node",nodeId:"second",mode:"text"}
]}={}){
 const dir=mkdtempSync(join(tmpdir(),"atelier-p44b-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const blobStore=createBlobStore({db,dataDir:dir});
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 createProject(db,{id:"p",document:doc});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"u",
  originalRequest:"按顺序生成两段文本",requestId:"task-create"}).task;
 const base={projectId:"p",taskId:task.id};
 const seq=sequence?registerAssistantRunSequence(db,{...base,requestId:"seq-create",
  sourceMessageId:"u",expectedPlanVersion:1,expectedProjectRevision:1,
  actions}):null;
 const planned=planAssistantExternalJobStep(db,{...base,requestId:"plan-one",
  kind:"model_job",expectedPlanVersion:1,expectedProjectRevision:1,
  job:{targetNodeId:"first",sourceNodeFingerprint:fingerprintSource(doc,"first"),
   executionMode:"poll",snapshot:{adapterKind:"model",provider:"openai",
    task:{kind:"text",model:"mock",prompt:"请生成动画开场"}}},
  ...(seq?{runSequenceId:seq.sequenceId,runIndex:0}:{})});
 decideAssistantTaskStep(db,{...base,stepId:planned.stepId,requestId:"approve-one",
  expectedPlanVersion:1,actionDigest:planned.actionDigest,decision:"approve"});
 const queued=enqueueAssistantExternalJobStep(db,{...base,stepId:planned.stepId,
  requestId:"enqueue-one",expectedPlanVersion:1,actionDigest:planned.actionDigest});
 const errors=[];
 const events=createAssistantTaskContinuationEvents({db,onError:e=>errors.push(e)});
 let submits=0;
 const coordinator=createJobCoordinator({db,
  adapters:{model:{
   prepare,
   async submit(){submits++;return {kind:"accepted",remoteTaskId:"remote-1"}},
   async poll(){return {kind:"completed",receipt:{remoteTaskId:"remote-1"}}},
   async collect({job}){
    const blob=await blobStore.put([Buffer.from("这是生成的可信儿童动画故事开场")],{mime:"text/plain"});
    appendArtifact(db,{id:"generated-text-one",jobId:job.id,portId:"text",
     itemKey:"0",blobId:blob.blobId,kind:"text",mime:"text/plain",sha256:blob.sha256,
     metadata:{modelGeneration:{kind:"text"}}});
   }
  }},
  onTerminalCommitted:jobId=>{if(autoJob){events.notifyJob(jobId);events.drain()}}
 });
 coordinator.recoverAtStartup();
 const materializer=createCanvasMaterializer({db,blobStore,
  onSettled:result=>{if(autoMaterialize){events.notifyMaterialization(result.artifactId);events.drain()}}});
 return {db,base,task,seq,planned,queued,events,coordinator,materializer,errors,
  submits:()=>submits};
}
async function finish(f){
 assert.equal(await f.coordinator.tick(),1);
 assert.equal(await f.coordinator.tick(),1);
 assert.equal(f.submits(),1);
 assert.equal(f.db.prepare("SELECT status FROM jobs").get().status,"succeeded");
}

test("P4.4b cancellation during preparation remains safely unsubmitted",async t=>{
 let ready,release;
 const entered=new Promise(resolve=>{ready=resolve}),gate=new Promise(resolve=>{release=resolve});
 const f=fixture(t,{prepare:async()=>{ready();await gate;}});
 const pending=f.coordinator.tick();await entered;
 const jobId=f.queued.jobId;
 const before=f.db.prepare("SELECT status,submission_started_at FROM jobs WHERE id=?").get(jobId);
 assert.equal(before.status,"preparing");assert.equal(before.submission_started_at,null);
 await f.coordinator.cancel(jobId);release();await pending;
 assert.equal(f.submits(),0);
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks").get().status,"failed");
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(f.planned.stepId).status,"failed");
 assert.equal(inspectAssistantTaskRecovery(f.db,f.base).canReplan,true);
});

test("P4.4b legacy failed local-stop receipts cannot authorize replan and are fenced at startup",t=>{
 const f=fixture(t,{autoJob:false});const jobId=f.queued.jobId;
 // Persisted shape from older versions: local stop was recorded as failure.
 f.db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(jobId);
 f.db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,'job_local_wait_stopped',?,?)")
  .run(jobId,JSON.stringify({remoteCancelled:false,submissionMayHaveOccurred:true}),Date.now());
 f.db.prepare("UPDATE assistant_task_steps SET status='failed',receipt_trust='none' WHERE id=?").run(f.planned.stepId);
 f.db.prepare("UPDATE assistant_task_attempts SET status='failed' WHERE step_id=?").run(f.planned.stepId);
 f.db.prepare("UPDATE assistant_tasks SET status='failed',active_step_id=NULL WHERE id=?").run(f.task.id);
 assert.equal(inspectAssistantTaskRecovery(f.db,f.base).reason,"job_remote_cancel_unconfirmed");
 assert.throws(()=>replanAssistantTaskSafely(f.db,{...f.base,requestId:"forbidden-replan",
  expectedPlanVersion:1,expectedProjectRevision:1}),{code:"assistant_task_replan_blocked"});
 assert.equal(recoverAssistantExternalTasksAtStartup(f.db).advanced,1);
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks").get().status,"needs_reconcile");
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_attempts WHERE step_id=?").get(f.planned.stepId).status,"needs_reconcile");
 assert.equal(f.submits(),0);
});

test("P4.4b startup catch-up recognizes restored graph and CAS evidence",async t=>{
 for(const lost of ["node","blob"]){
  const f=fixture(t,{autoMaterialize:false,actions:[
   {type:"run_node",nodeId:"first",mode:"text"},
   {type:"run_node",nodeId:"second",mode:"text",when:{sourceIndex:0,kind:"image",op:"gte",count:1}},
   {type:"run_node",nodeId:"third",mode:"text",when:{sourceIndex:0,kind:"image",op:"lt",count:1}}
  ]});
  await finish(f);await f.materializer.runOnce();reconcileAssistantExternalTask(f.db,f.base);
  const saved=getProject(f.db,"p");
  const material=f.db.prepare("SELECT node_id,artifact_id FROM materializations WHERE status='materialized'").get();
  if(lost==="node")saveSingleUserCanvas(f.db,{id:"p",expectedRevision:saved.revision,
   document:{...saved.document,nodes:saved.document.nodes.filter(n=>n.id!==material.node_id),connections:[]}});
  else f.db.prepare("UPDATE blobs SET status='missing' WHERE id=(SELECT blob_id FROM artifacts WHERE id=?)").run(material.artifact_id);
  const replay=createAssistantTaskContinuationEvents({db:f.db});
  assert.equal(replay.catchUp().handled[0].reason,"awaiting_verified_branch_evidence");
  if(lost==="node")saveSingleUserCanvas(f.db,{id:"p",expectedRevision:getProject(f.db,"p").revision,document:saved.document});
  else f.db.prepare("UPDATE blobs SET status='ready' WHERE id=(SELECT blob_id FROM artifacts WHERE id=?)").run(material.artifact_id);
  const restored=replay.catchUp();
  assert.equal(restored.handled[0].checkpoints,1);
  assert.equal(count(f.db,"assistant_task_run_branch_skips"),1);
  assert.equal(f.submits(),1);
 }
});
test("P4.4b Job terminal -> trusted Task receipt -> materialization -> Run ready, no second paid Job",async t=>{
 const f=fixture(t);
 assert.ok(SCHEMA_VERSION>=33);
 assert.equal(f.events.notifyJob(f.queued.jobId),true);
 assert.equal(f.events.drain().handled.length,0,"queued Job is not a terminal receipt");
 await finish(f);
 let task=f.db.prepare("SELECT status FROM assistant_tasks").get();
 assert.equal(task.status,"waiting_external");
 assert.equal(f.db.prepare("SELECT status,receipt_trust FROM assistant_task_steps WHERE id=?")
  .get(f.planned.stepId).receipt_trust,"server_committed");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps WHERE kind='materialize'").get().n,1);
 const completed=await f.materializer.runOnce();
 assert.equal(completed[0].status,"materialized");
 task=f.db.prepare("SELECT status FROM assistant_tasks").get();
 assert.equal(task.status,"ready");
 const next=getAssistantRunSequence(f.db,f.base);
 assert.equal(next.state,"ready");assert.equal(next.next.index,1);
 assert.equal(count(f.db,"jobs"),1);assert.equal(count(f.db,"assistant_task_attempts"),1);
 assert.equal(f.submits(),1);
 const recorded=f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='external_continuation_progress'").get().n;
 assert.ok(recorded>=2);
 f.events.notifyMaterialization("generated-text-one");
 assert.equal(f.events.drain().handled[0]?.checkpoints,0);
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(f.errors.length,0,JSON.stringify(f.errors));
});
test("P4.4b crash between terminal persist and notification: startup reads missing Job receipt",async t=>{
 const f=fixture(t,{autoJob:false});await finish(f);
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?")
  .get(f.planned.stepId).status,"waiting_external");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps WHERE kind='materialize'").get().n,0);
 const restarted=createAssistantTaskContinuationEvents({db:f.db});
 const result=restarted.catchUp();
 assert.ok(result.scanned>=1);
 assert.equal(f.db.prepare("SELECT receipt_trust FROM assistant_task_steps WHERE id=?").get(f.planned.stepId).receipt_trust,"server_committed");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps WHERE kind='materialize'").get().n,1);
 assert.equal(f.submits(),1);
});
test("P4.4b new materialization evidence after earlier boot bypasses stale startup command",async t=>{
 const f=fixture(t,{autoJob:false,autoMaterialize:false});await finish(f);
 const restart=createAssistantTaskContinuationEvents({db:f.db});
 assert.ok(restart.catchUp().scanned>=1);
 const before=restart.catchUp();
 assert.ok(before.scanned>=1);
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks").get().status,"waiting_external");
 const material=await f.materializer.runOnce();
 assert.equal(material[0].status,"materialized");
 // No post-commit notification was delivered; authoritative CAS was saved.
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks").get().status,"waiting_external");
 const after=restart.catchUp();
 assert.ok(after.scanned>=1);
 const step=f.db.prepare("SELECT status,receipt_trust FROM assistant_task_steps WHERE kind='materialize'").get();
 assert.equal(step.status,"succeeded");
 assert.equal(step.receipt_trust,"server_committed");
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks").get().status,"ready");
 assert.equal(f.submits(),1);
});
test("P4.4b ignored spoofed, queued, archived or cancelled signals do not authorize paid execution",t=>{
 const f=fixture(t);
 assert.equal(f.events.notifyJob("nonexistent"),true);
 assert.equal(f.events.notifyMaterialization("arbitrary-artifact"),true);
 assert.equal(f.events.notifySkill("arbitrary-skill"),true);
 assert.equal(f.events.drain().handled.length,0);
 assert.equal(f.events.notifyJob(f.queued.jobId),true);
 assert.equal(f.events.drain().handled.length,0);
 f.db.prepare("UPDATE assistant_tasks SET read_only=1 WHERE id=?").run(f.task.id);
 f.db.prepare("UPDATE jobs SET status='submission_unknown' WHERE id=?").run(f.queued.jobId);
 f.events.notifyJob(f.queued.jobId);
 assert.equal(f.events.drain().handled.length,0);
 f.db.prepare("UPDATE assistant_tasks SET read_only=0").run();
 cancelAssistantTask(f.db,{...f.base,requestId:"cancel"});
 f.events.notifyJob(f.queued.jobId);
 assert.equal(f.events.drain().handled.length,0);
 assert.equal(count(f.db,"jobs"),1);assert.equal(f.submits(),0);
});
test("P4.4b terminal notification callback errors never roll back a completed Job",async t=>{
 const f=fixture(t);
 const bad=createJobCoordinator({db:f.db,adapters:{model:{
  prepare:async()=>{},submit:async()=>({kind:"accepted",remoteTaskId:"remote-err"}),
  poll:async()=>({kind:"failed"})
 }},onTerminalCommitted:()=>{throw Error("notification_broken")}});
 // The queued Task Job is claimed only once by this coordinator.
 bad.recoverAtStartup();
 assert.equal(await bad.tick(),1);
 assert.equal(await bad.tick(),1);
 assert.equal(f.db.prepare("SELECT status FROM jobs").get().status,"failed");
 assert.equal(count(f.db,"jobs"),1);
});

test("P4.4b Skill postsettlement event observes trusted run but cannot launch a second process",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:doc});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"通过 Skill 生成文本",requestId:"create"}).task;
 const base={projectId:"p",taskId:task.id},version="abcdef123456";
 const sourceArchiveBase64=Buffer.from(zipSync({
  "SKILL.md":strToU8("---\nname: Event Fixture\ndescription: local test\n---\n"),
  "scripts/run.js":strToU8('console.log("done")')})).toString("base64");
 const registry={list:()=>({skills:[{id:"fixture-skill",enabled:true,versions:[version]}]}),
  get:()=>({package:{manifest:{hash:version+"0".repeat(52)},sourceArchiveBase64}})};
 const planned=planAssistantSkillStep(db,{...base,requestId:"plan",
  expectedPlanVersion:1,expectedProjectRevision:1,skillRegistry:registry,
  proposal:{skill_id:"fixture-skill",version,script_path:"scripts/run.js",
   args:[],input_files:{},output_files:[]}});
 decideAssistantTaskStep(db,{...base,stepId:planned.stepId,
  requestId:"approve",expectedPlanVersion:1,actionDigest:planned.actionDigest,
  decision:"approve"});
 const events=createAssistantTaskContinuationEvents({db});
 const callbacks=[];
 let launched=0;
 const command={db,skillRegistry:registry,...base,stepId:planned.stepId,requestId:"execute",
  expectedPlanVersion:1,actionDigest:planned.actionDigest};
 const first=await executeAssistantSkillStep({...command,
  runner:async()=>{launched++;return {status:"completed",exit_code:0,artifacts:[],log_blobs:{}}},
  onSettled:(runId,status)=>{
   events.notifySkill(runId);
   callbacks.push({runId,status,runStatus:db.prepare("SELECT status FROM skill_script_runs WHERE id=?").get(runId).status,
    result:events.drain()});
  }});
 assert.equal(first.status,"completed");
 assert.equal(callbacks.length,1);
 assert.equal(callbacks[0].runId,first.run_id);
 assert.equal(callbacks[0].runStatus,"completed");
 assert.equal(callbacks[0].result.handled.length,1);
 assert.equal(callbacks[0].result.handled[0].taskStatus,"ready");
 assert.equal(launched,1);
 assert.equal(db.prepare("SELECT status,receipt_trust FROM assistant_task_steps WHERE id=?")
  .get(planned.stepId).receipt_trust,"server_committed");
 assert.equal(count(db,"skill_script_runs"),1);
 assert.equal((await executeAssistantSkillStep({...command,
  runner:async()=>{launched++;throw Error("unexpected_rerun")}})).shouldLaunch,false);
 assert.equal(launched,1);
 assert.equal(count(db,"jobs"),0);
});
test("P4.4b Skill failure remains failed without retry or generating new Step",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:doc});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"Skill fails",requestId:"create"}).task;
 const base={projectId:"p",taskId:task.id},version="abcdef123456";
 const archive=Buffer.from(zipSync({
  "SKILL.md":strToU8("---\nname: Event Fixture\ndescription: local test\n---\n"),
  "scripts/run.js":strToU8('console.log("done")')})).toString("base64");
 const registry={list:()=>({skills:[{id:"fixture-skill",enabled:true,versions:[version]}]}),
  get:()=>({package:{manifest:{hash:version+"0".repeat(52)},sourceArchiveBase64:archive}})};
 const step=planAssistantSkillStep(db,{...base,requestId:"plan",
  expectedPlanVersion:1,expectedProjectRevision:1,skillRegistry:registry,
  proposal:{skill_id:"fixture-skill",version,script_path:"scripts/run.js",
   args:[],input_files:{},output_files:[]}});
 decideAssistantTaskStep(db,{...base,stepId:step.stepId,requestId:"approve",
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve"});
 const events=createAssistantTaskContinuationEvents({db});
 let launched=0,notified=0,notificationResult;
 const cmd={db,skillRegistry:registry,...base,stepId:step.stepId,requestId:"run",
  expectedPlanVersion:1,actionDigest:step.actionDigest,
  onSettled:runId=>{notified++;events.notifySkill(runId);notificationResult=events.drain()}};
 await assert.rejects(executeAssistantSkillStep({...cmd,runner:async()=>{
  launched++;throw Object.assign(Error("failed"),{code:"mock_skill_failure"})}}),
  {code:"mock_skill_failure"});
 assert.equal(notified,1);
 assert.equal(notificationResult.handled.length,0);
 assert.equal(db.prepare("SELECT status FROM assistant_tasks").get().status,"failed");
 assert.equal(count(db,"skill_script_runs"),1);assert.equal(launched,1);
 assert.equal((await executeAssistantSkillStep({...cmd,runner:async()=>{
  launched++;throw Error("unexpected_rerun")}})).shouldLaunch,false);
 assert.equal(launched,1);assert.equal(count(db,"jobs"),0);
});

test("P4.4b production runtime wires terminal and Materializer callbacks without paid follow-up",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-p44b-runtime-"));
 let runtime,submits=0;
 const adapter={
  async prepare(){},
  async submit(){submits++;return {kind:"accepted",remoteTaskId:"remote-runtime"}},
  async poll(){return {kind:"completed",receipt:{remoteTaskId:"remote-runtime"}}},
  async collect({job}){
   const blob=await runtime.blobStore.put([Buffer.from("生成的完整文本")],{mime:"text/plain"});
   appendArtifact(runtime.db,{id:"runtime-output",jobId:job.id,portId:"text",itemKey:"0",
    blobId:blob.blobId,kind:"text",mime:"text/plain",sha256:blob.sha256,
    metadata:{modelGeneration:{kind:"text"}}});
  }
 };
 runtime=createLocalBackend({dataDir:dir,adapters:{model:adapter},
  autoDispatch:false,autoLocalSession:true});
 t.after(async()=>{await runtime.close();rmSync(dir,{recursive:true,force:true})});
 const db=runtime.db;createProject(db,{id:"p",document:doc});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"c",rootMessageId:"u",
  originalRequest:"连续生成两段文本",requestId:"task"}).task;
 const base={projectId:"p",taskId:task.id};
 const sequence=registerAssistantRunSequence(db,{...base,requestId:"sequence",
  sourceMessageId:"u",expectedPlanVersion:1,expectedProjectRevision:1,
  actions:[{type:"run_node",nodeId:"first",mode:"text"},
   {type:"run_node",nodeId:"second",mode:"text"}]});
 const step=planAssistantExternalJobStep(db,{...base,requestId:"planned",
  kind:"model_job",expectedPlanVersion:1,expectedProjectRevision:1,
  job:{targetNodeId:"first",sourceNodeFingerprint:fingerprintSource(doc,"first"),
   executionMode:"poll",snapshot:{adapterKind:"model",provider:"openai",
    task:{kind:"text",model:"mock",prompt:"开场"}}},
  runSequenceId:sequence.sequenceId,runIndex:0});
 decideAssistantTaskStep(db,{...base,stepId:step.stepId,requestId:"approve",
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve"});
 enqueueAssistantExternalJobStep(db,{...base,stepId:step.stepId,requestId:"enqueue",
  expectedPlanVersion:1,actionDigest:step.actionDigest});
 assert.equal(await runtime.coordinator.tick(),1);
 assert.equal(await runtime.coordinator.tick(),1);
 // The actual runtime onTerminalCommitted handler has already reconciled
 // the Job and produced the single pending materialize Step.
 assert.equal(db.prepare("SELECT COUNT(*) n FROM assistant_task_steps WHERE kind='materialize'").get().n,1);
 assert.equal(db.prepare("SELECT status FROM assistant_tasks").get().status,"waiting_external");
 const outputs=await runtime.materializer.runOnce();
 assert.equal(outputs[0].status,"materialized");
 assert.equal(db.prepare("SELECT status FROM assistant_tasks").get().status,"ready");
 assert.equal(getAssistantRunSequence(db,base).next.index,1);
 assert.equal(count(db,"jobs"),1);
 assert.equal(count(db,"assistant_task_attempts"),1);
 assert.equal(submits,1);
});

test("P4.4b actual materialization event auto-skips trusted false branch, never runs next model",async t=>{
 const f=fixture(t,{actions:[
  {type:"run_node",nodeId:"first",mode:"text"},
  {type:"run_node",nodeId:"second",mode:"text",when:{sourceIndex:0,kind:"image",op:"gte",count:1}},
  {type:"run_node",nodeId:"third",mode:"text",when:{sourceIndex:0,kind:"image",op:"lt",count:1}}
 ]});await finish(f);
 const outputs=await f.materializer.runOnce();
 assert.equal(outputs[0].status,"materialized");
 const state=getAssistantRunSequence(f.db,f.base);
 assert.equal(state.state,"ready");
 assert.equal(state.next.index,2);
 assert.equal(state.branchSkips.length,1);
 assert.equal(state.branchSkips[0].index,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_run_branch_skips").get().n,1);
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks").get().status,"ready");
 assert.equal(count(f.db,"jobs"),1);assert.equal(f.submits(),1);
 f.events.notifyMaterialization("generated-text-one");
 f.events.drain();
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_run_branch_skips").get().n,1);
});
test("P4.4b unknown Job submit and superseded plan event do not create any new work",t=>{
 const f=fixture(t);
 f.db.prepare("UPDATE jobs SET status='submission_unknown' WHERE id=?").run(f.queued.jobId);
 f.events.notifyJob(f.queued.jobId);
 const unknown=f.events.drain();
 assert.equal(unknown.handled.length,1);
 assert.equal(unknown.handled[0].taskStatus,"needs_reconcile");
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks").get().status,"needs_reconcile");
 assert.equal(count(f.db,"jobs"),1);assert.equal(f.submits(),0);
 f.db.prepare("UPDATE assistant_tasks SET active_plan_version=2,status='planning',active_step_id=NULL WHERE id=?")
  .run(f.task.id);
 f.events.notifyJob(f.queued.jobId);
 assert.equal(f.events.drain().handled.length,0);
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks").get().status,"planning");
 assert.equal(count(f.db,"jobs"),1);
});

test("P4.4b two SQLite connections receiving one terminal signal write exactly one Job receipt and progress",async t=>{
 const f=fixture(t,{autoJob:false});await finish(f);
 const dir=mkdtempSync(join(tmpdir(),"atelier-p44b-race-")),file=join(dir,"shared.db");
 await backup(f.db,file);
 const left=new DatabaseSync(file),right=new DatabaseSync(file);
 t.after(()=>{left.close();right.close();rmSync(dir,{recursive:true,force:true})});
 const one=createAssistantTaskContinuationEvents({db:left});
 const two=createAssistantTaskContinuationEvents({db:right});
 one.notifyJob(f.queued.jobId);
 two.notifyJob(f.queued.jobId);
 const [l,r]=await Promise.all([
  Promise.resolve().then(()=>one.drain()),
  Promise.resolve().then(()=>two.drain())
 ]);
 assert.equal(l.handled.length,1);
 assert.equal(r.handled.length,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM assistant_task_steps WHERE kind='materialize'").get().n,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='external_continuation_progress'").get().n,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE command_kind='safe_continuation'").get().n,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM jobs").get().n,1);
 assert.equal(f.submits(),1);
});
test("P4.4b postcommit event lost before process restart is recovered from a file-backed SQLite backup",async t=>{
 const f=fixture(t,{autoJob:false});await finish(f);
 const dir=mkdtempSync(join(tmpdir(),"atelier-p44b-restart-")),file=join(dir,"restart.db");
 await backup(f.db,file);
 const opened=new DatabaseSync(file);
 t.after(()=>{opened.close();rmSync(dir,{recursive:true,force:true})});
 const resumed=createAssistantTaskContinuationEvents({db:opened});
 const restored=resumed.catchUp();
 assert.equal(restored.scanned,1);
 assert.equal(opened.prepare("SELECT receipt_trust FROM assistant_task_steps WHERE id=?")
  .get(f.planned.stepId).receipt_trust,"server_committed");
 assert.equal(opened.prepare("SELECT COUNT(*) n FROM assistant_task_steps WHERE kind='materialize'").get().n,1);
 assert.equal(opened.prepare("SELECT COUNT(*) n FROM jobs").get().n,1);
 assert.equal(f.submits(),1);
});

test("P4.4b locally stopped waiting never grants remote cancel or Task replay",t=>{
 const f=fixture(t,{autoJob:false});
 const jobId=f.queued.jobId;
 f.db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(jobId);
 f.db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,'job_local_wait_stopped',?,?)")
  .run(jobId,JSON.stringify({remoteCancelled:false,submissionMayHaveOccurred:true}),Date.now());
 f.events.notifyJob(jobId);
 const first=f.events.drain();
 assert.equal(first.handled.length,1);
 assert.equal(first.handled[0].taskStatus,"needs_reconcile");
 const step=f.db.prepare("SELECT status,error_code,receipt_trust FROM assistant_task_steps WHERE id=?")
  .get(f.planned.stepId);
 assert.equal(step.status,"needs_reconcile");
 assert.equal(step.error_code,"assistant_external_remote_cancel_unconfirmed");
 assert.equal(step.receipt_trust,"none");
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_attempts WHERE step_id=?")
  .get(f.planned.stepId).status,"needs_reconcile");
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks WHERE id=?")
  .get(f.task.id).status,"needs_reconcile");
 const eventCount=f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='external_remote_cancel_unconfirmed'").get().n;
 assert.equal(eventCount,1);
 f.events.notifyJob(jobId);
 f.events.drain();
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='external_remote_cancel_unconfirmed'").get().n,1);
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(count(f.db,"assistant_task_attempts"),1);
 assert.equal(f.submits(),0);
});
test("P4.4b verified remote cancellation without local-wait marker remains a terminal failure",t=>{
 const f=fixture(t,{autoJob:false});
 const jobId=f.queued.jobId;
 f.db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(jobId);
 f.events.notifyJob(jobId);f.events.drain();
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks").get().status,"failed");
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(f.planned.stepId).status,"failed");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='external_remote_cancel_unconfirmed'").get().n,0);
 assert.equal(count(f.db,"jobs"),1);
});
