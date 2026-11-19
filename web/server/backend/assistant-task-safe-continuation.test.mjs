import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync,backup} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createAssistantTask,cancelAssistantTask} from "./assistant-tasks.mjs";
import {fingerprintSource} from "./repository.mjs";
import {registerAssistantRunSequence,getAssistantRunSequence} from "./assistant-task-run-sequences.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep,reconcileAssistantExternalTask}
 from "./assistant-task-external-jobs.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {continueAssistantTaskSafely} from "./assistant-task-safe-continuation.mjs";
import {buildApp} from "./app.mjs";
import {replanAssistantTaskSafely} from "./assistant-task-safe-replan.mjs";
import {zipSync,strToU8} from "fflate";
import {planAssistantSkillStep,reserveAssistantSkillRun,settleAssistantSkillRun,
 recoverAssistantSkillTasksAtStartup} from "./assistant-task-skills.mjs";
const node=id=>({id,type:"text",title:id,position:{x:0,y:0},width:300,
 height:200,metadata:{content:"Prompt for "+id}});
const document={nodes:["first","second","third","fourth"].map(node),connections:[]};
const branch=[
 {type:"run_node",nodeId:"first",mode:"text"},
 {type:"run_node",nodeId:"second",mode:"text",when:{sourceIndex:0,kind:"text",op:"gte",count:1}},
 {type:"run_node",nodeId:"third",mode:"text",when:{sourceIndex:0,kind:"text",op:"lt",count:1}}
];
function fixture(t,actions=branch){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>db.close());
 createProject(db,{id:"p",document});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",
  rootMessageId:"root",originalRequest:"安全顺序生成",requestId:"create"}).task;
 const base={projectId:"p",taskId:task.id};
 const seq=registerAssistantRunSequence(db,{...base,requestId:"freeze-seq",
  sourceMessageId:"root",expectedPlanVersion:1,expectedProjectRevision:1,actions});
 let materialNo=0;
 function plan(index,dependsOn=[]){
  const target=actions[index].nodeId;
  return planAssistantExternalJobStep(db,{...base,requestId:"plan-"+index,
   kind:"model_job",expectedPlanVersion:1,expectedProjectRevision:getProject(db,"p").revision,
   job:{targetNodeId:target,sourceNodeFingerprint:fingerprintSource(getProject(db,"p").document,target),
    executionMode:"poll",snapshot:{adapterKind:"model",task:{kind:"text",model:"mock",prompt:target}}},
   runSequenceId:seq.sequenceId,runIndex:index,dependsOn});
 }
 function enqueue(step,index){
  decideAssistantTaskStep(db,{...base,stepId:step.stepId,requestId:"approve-"+index,
   expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve"});
  return enqueueAssistantExternalJobStep(db,{...base,stepId:step.stepId,
   requestId:"enqueue-"+index,expectedPlanVersion:1,actionDigest:step.actionDigest});
 }
 function complete(job,index){
  db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(job.jobId);
  const blobId="blob-"+index,artifactId="artifact-"+index,sha=String(index+1).repeat(64);
  db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,4,'text/plain',?,'ready')")
   .run(blobId,sha,"test/"+blobId);
  db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) "+
   "VALUES(?,?,NULL,?,?,'text','text/plain',?,'{}')")
   .run(artifactId,job.jobId,"text-"+index,blobId,sha);
  // First reconcile inserts the durable materialize Step.
  reconcileAssistantExternalTask(db,base);
  const target=actions[index].nodeId;
  db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES(?,?,?,'p','materialized',?)")
   .run("mat-"+index,job.jobId,artifactId,target);
  materialNo++;
  return artifactId;
 }
 const advance=(requestId="advance",extra={})=>continueAssistantTaskSafely(db,{...base,
  requestId,expectedPlanVersion:1,...extra});
 return {db,base,seq,plan,enqueue,complete,advance};
}
const count=(db,table)=>db.prepare("SELECT COUNT(*) n FROM "+table).get().n;

test("P4.4a cached hints revalidate branch evidence and report missing evidence",t=>{
 const f=fixture(t),step=f.plan(0),job=f.enqueue(step,0);f.complete(job,0);
 assert.equal(f.advance("cached").next.index,1);
 f.db.prepare("UPDATE blobs SET status='missing' WHERE id='blob-0'").run();
 const replay=f.advance("cached");
 assert.equal(replay.next,null);assert.equal(replay.requiresApproval,false);
 assert.equal(replay.sequenceState,"awaiting_verified_branch_evidence");
 assert.equal(replay.requiresManualReview,true);
 const fresh=f.advance("fresh");
 assert.equal(fresh.reason,"awaiting_verified_branch_evidence");
 assert.equal(fresh.requiresManualReview,true);
});

test("P4.4a final CAS detects evidence changes without Task or graph revision changes",t=>{
 const f=fixture(t),step=f.plan(0),job=f.enqueue(step,0);f.complete(job,0);
 f.advance("materialized");
 assert.throws(()=>f.advance("lost-before-commit",{beforeCommandCommit:()=>{
  f.db.prepare("UPDATE blobs SET status='missing' WHERE id='blob-0'").run();
 }}),{code:"assistant_safe_continue_state_changed"});
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE request_id='lost-before-commit'").get().n,0);
});

test("P4.4a a repaired blocked materialization resumes without reviving a refused Step",t=>{
 const f=fixture(t),step=f.plan(0),job=f.enqueue(step,0);f.complete(job,0);
 f.db.prepare("UPDATE materializations SET status='blocked'").run();
 assert.equal(f.advance("blocked").taskStatus,"blocked");
 f.db.prepare("UPDATE materializations SET status='materialized'").run();
 const fixed=f.advance("fixed");
 assert.equal(fixed.taskStatus,"ready");assert.equal(fixed.next.index,1);
 assert.equal(count(f.db,"jobs"),1);
 const denied=fixture(t),pending=denied.plan(0);
 decideAssistantTaskStep(denied.db,{...denied.base,stepId:pending.stepId,requestId:"reject",
  expectedPlanVersion:1,actionDigest:pending.actionDigest,decision:"reject"});
 assert.equal(denied.advance().reason,"task_requires_replan");
 assert.equal(count(denied.db,"jobs"),0);
});

test("P4.4a approved queued intent and completed replay do not demand another approval",t=>{
 const f=fixture(t),pending=f.plan(0);
 decideAssistantTaskStep(f.db,{...f.base,stepId:pending.stepId,requestId:"approved-only",
  expectedPlanVersion:1,actionDigest:pending.actionDigest,decision:"approve"});
 const ready=f.advance();assert.equal(ready.requiresApproval,false);
 assert.equal(ready.reason,"approved_step_ready");assert.equal(ready.requiresManualReview,false);
 const completed=fixture(t),first=completed.plan(0),job=completed.enqueue(first,0);completed.complete(job,0);
 completed.advance("next");
 const mat=completed.db.prepare("SELECT id FROM assistant_task_steps WHERE kind='materialize'").get().id;
 const second=completed.plan(1,[mat]),secondJob=completed.enqueue(second,1);completed.complete(secondJob,1);
 const result=completed.advance("finished");assert.equal(result.taskStatus,"completed");
 const replay=completed.advance("finished");
 assert.deepEqual({...replay,existing:false},result);
 assert.equal(replay.requiresManualReview,false);
});

test("P4.4a a checkpoint committed by another client is not claimed by both responses",t=>{
 const f=fixture(t,[branch[0],{...branch[1],when:{...branch[1].when,kind:"image"}},
  {...branch[2],when:{...branch[2].when,kind:"image"}}]);
 const first=f.plan(0),job=f.enqueue(first,0);f.complete(job,0);
 const exec=f.db.exec.bind(f.db);let transactions=0,other;
 f.db.exec=sql=>{
  if(sql==="BEGIN IMMEDIATE"&&++transactions===2){f.db.exec=exec;other=f.advance("client-B");}
  return exec(sql);
 };
 const result=f.advance("client-A");f.db.exec=exec;
 assert.equal(other.checkpoints.length,1);assert.equal(result.checkpoints.length,0);
 assert.equal(count(f.db,"assistant_task_run_branch_skips"),1);
});

test("P4.4a a stale-plan request cannot reconcile the newer plan inside its first transaction",t=>{
 const f=fixture(t),old=f.plan(0),oldJob=f.enqueue(old,0);
 const exec=f.db.exec.bind(f.db);let newer;
 f.db.exec=sql=>{
  if(sql==="BEGIN IMMEDIATE"){
   f.db.exec=exec;
   f.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(oldJob.jobId);
   reconcileAssistantExternalTask(f.db,f.base);
   replanAssistantTaskSafely(f.db,{...f.base,requestId:"replan",expectedPlanVersion:1,expectedProjectRevision:1});
   const step=planAssistantExternalJobStep(f.db,{...f.base,requestId:"new-plan",kind:"model_job",
    expectedPlanVersion:2,expectedProjectRevision:1,job:{targetNodeId:"first",
     sourceNodeFingerprint:fingerprintSource(getProject(f.db,"p").document,"first"),executionMode:"poll",
     snapshot:{adapterKind:"model",task:{kind:"text",model:"mock",prompt:"new"}}}});
   decideAssistantTaskStep(f.db,{...f.base,stepId:step.stepId,requestId:"new-approval",
    expectedPlanVersion:2,actionDigest:step.actionDigest,decision:"approve"});
   newer=enqueueAssistantExternalJobStep(f.db,{...f.base,stepId:step.stepId,requestId:"new-enqueue",
    expectedPlanVersion:2,actionDigest:step.actionDigest});
   f.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(newer.jobId);
  }
  return exec(sql);
 };
 assert.throws(()=>f.advance("old-request"),{code:"assistant_step_plan_conflict"});f.db.exec=exec;
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks WHERE id=?").get(f.base.taskId).status,"waiting_external");
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps WHERE plan_version=2 AND kind='model_job'").get().status,"waiting_external");
});

test("P4.4a Job success without trusted materialization never advances sequence or issues a second Job",t=>{
 const f=fixture(t);assert.ok(SCHEMA_VERSION>=33);
 const step=f.plan(0),job=f.enqueue(step,0);
 f.db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(job.jobId);
 f.db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES('b1',?,4,'text/plain','a','ready')")
  .run("a".repeat(64));
 f.db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) "+
  "VALUES('a1',?,NULL,'item','b1','text','text/plain',?,'{}')").run(job.jobId,"a".repeat(64));
 const advanced=f.advance();
 assert.equal(advanced.executionStarted,false);
 assert.equal(advanced.reason,"awaiting_verified_materialization");
 assert.equal(advanced.checkpoints.length,0);
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(count(f.db,"assistant_task_attempts"),1);
 assert.equal(getAssistantRunSequence(f.db,f.base).state,"awaiting_materialization");
});
test("P4.4a durable materialization makes next paid step available but never enqueues it",t=>{
 const f=fixture(t),step=f.plan(0),job=f.enqueue(step,0);
 f.complete(job,0);
 const first=f.advance();
 assert.equal(first.reconciledJobs,1);
 assert.equal(first.sequenceState,"ready");
 assert.equal(first.next.index,1);
 assert.equal(first.requiresApproval,true);
 assert.equal(first.executionStarted,false);
 assert.equal(first.checkpoints.length,0);
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(f.advance().existing,true);
 assert.equal(count(f.db,"jobs"),1);
 assert.throws(()=>f.advance("advance",{expectedPlanVersion:2}),{
  code:"assistant_step_plan_conflict"});
});
test("P4.4a a false branch is skipped using server materialization evidence; the next branch requires approval",t=>{
 const f=fixture(t,[
  {type:"run_node",nodeId:"first",mode:"text"},
  {type:"run_node",nodeId:"second",mode:"text",when:{sourceIndex:0,kind:"image",op:"gte",count:1}},
  {type:"run_node",nodeId:"third",mode:"text",when:{sourceIndex:0,kind:"image",op:"lt",count:1}}
 ]);
 const first=f.plan(0),job=f.enqueue(first,0);f.complete(job,0);
 const result=f.advance();
 assert.deepEqual(result.checkpoints.map(x=>x.kind),["skip"]);
 assert.equal(result.checkpoints[0].index,1);
 assert.equal(result.sequenceState,"ready");
 assert.equal(result.next.index,2);
 assert.equal(result.requiresApproval,true);
 assert.equal(count(f.db,"assistant_task_run_branch_skips"),1);
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(f.advance("retry").checkpoints.length,0);
 assert.equal(count(f.db,"assistant_task_run_branch_skips"),1);
});
test("P4.4a Join checkpoint is auto-committed only after upstream Job+Materialization+Skip receipts",t=>{
 const actions=[...branch,
  {type:"run_node",nodeId:"fourth",mode:"text",join:{indices:[0,1,2]}}];
 const f=fixture(t,actions),first=f.plan(0),job=f.enqueue(first,0);f.complete(job,0);
 assert.equal(f.advance("first-check").next.index,1);
 const second=f.plan(1,[f.db.prepare("SELECT id FROM assistant_task_steps WHERE kind='materialize' ORDER BY ordinal DESC LIMIT 1").get().id]);
 const secondJob=f.enqueue(second,1);f.complete(secondJob,1);
 const advance=f.advance("join-step");
 assert.deepEqual(advance.checkpoints.map(c=>c.kind),["skip","join"]);
 assert.equal(advance.sequenceState,"ready");
 assert.equal(advance.next.index,3);
 assert.equal(count(f.db,"assistant_task_run_branch_skips"),1);
 assert.equal(count(f.db,"assistant_task_run_joins"),1);
 assert.equal(count(f.db,"jobs"),2,"Join must not automatically enqueue final paid Job");
 assert.equal(f.advance("fresh").checkpoints.length,0);
});
test("P4.4a crash after durable skip recovers without duplicated receipts or paid work",t=>{
 const actions=[
  {type:"run_node",nodeId:"first",mode:"text"},
  {type:"run_node",nodeId:"second",mode:"text",when:{sourceIndex:0,kind:"image",op:"gte",count:1}},
  {type:"run_node",nodeId:"third",mode:"text",when:{sourceIndex:0,kind:"image",op:"lt",count:1}}
 ];
 const f=fixture(t,actions),first=f.plan(0),job=f.enqueue(first,0);f.complete(job,0);
 assert.throws(()=>f.advance("crash",{afterCheckpoint:()=>{throw Error("crash_after_checkpoint")}}),
  /crash_after_checkpoint/);
 assert.equal(count(f.db,"assistant_task_run_branch_skips"),1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE command_kind='safe_continuation' AND request_id='crash'").get().n,0,
  "no final continuation command after injected crash");
 const next=f.advance("crash");
 assert.equal(next.sequenceState,"ready");
 assert.equal(next.next.index,2);
 assert.equal(count(f.db,"assistant_task_run_branch_skips"),1);
 assert.equal(count(f.db,"jobs"),1);
});
test("P4.4a unknown job submission blocks continuation without retry",t=>{
 const f=fixture(t),step=f.plan(0),job=f.enqueue(step,0);
 f.db.prepare("UPDATE jobs SET status='submission_unknown' WHERE id=?").run(job.jobId);
 const result=f.advance();
 assert.equal(result.taskStatus,"needs_reconcile");
 assert.equal(result.reason,"unknown_external_result");
 assert.equal(result.next,null);
 assert.equal(result.executionStarted,false);
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(count(f.db,"assistant_task_attempts"),1);
});
test("P4.4a refused/cancelled Task cannot auto-progress",t=>{
 const f=fixture(t);cancelAssistantTask(f.db,{...f.base,requestId:"cancel-it"});
 const response=f.advance();
 assert.equal(response.reason,"task_cancelled");
 assert.equal(response.checkpoints.length,0);
 assert.equal(count(f.db,"jobs"),0);
});
test("P4.4a historical ZIP Task never reconciles or grants new continuation authority",t=>{
 const f=fixture(t);
 f.db.prepare("UPDATE assistant_tasks SET read_only=1 WHERE id=?").run(f.base.taskId);
 f.db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,'run_branch_skipped',?,?)")
  .run(f.base.taskId,JSON.stringify({fake:true}),Date.now());
 assert.throws(()=>f.advance(),{code:"assistant_task_not_editable"});
 assert.equal(count(f.db,"jobs"),0);
 assert.equal(count(f.db,"assistant_task_run_branch_skips"),0);
});
test("P4.4a HTTP action returns bounded checkpoint projection; no additional provider/Skill launch",async t=>{
 const f=fixture(t),first=f.plan(0),job=f.enqueue(first,0);f.complete(job,0);
 const app=buildApp({db:f.db,authorize:()=>true});t.after(()=>app.close());
 const endpoint="/api/v1/projects/p/assistant/tasks/"+f.base.taskId+"/continue-safe";
 const res=await app.inject({method:"POST",url:endpoint,
  payload:{requestId:"http-advance",expectedPlanVersion:1}});
 assert.equal(res.statusCode,200,res.body);
 assert.equal(res.json().sequenceState,"ready");
 assert.equal(res.json().executionStarted,false);
 assert.equal(res.json().requiresApproval,true);
 assert.equal(res.headers["cache-control"],"no-store");
 assert.equal(count(f.db,"jobs"),1);
 const replay=await app.inject({method:"POST",url:endpoint,
  payload:{requestId:"http-advance",expectedPlanVersion:1}});
 assert.equal(replay.json().existing,true);
});
test("P4.4a archive remains read-only after SQLite backup and restart",async t=>{
 const f=fixture(t);
 const dir=mkdtempSync(join(tmpdir(),"atelier-p44a-"));
 const file=join(dir,"fixture.db");await backup(f.db,file);
 const fresh=new DatabaseSync(file);t.after(()=>{fresh.close();rmSync(dir,{recursive:true,force:true})});
 const result=continueAssistantTaskSafely(fresh,{...f.base,requestId:"restart-safe",expectedPlanVersion:1});
 assert.equal(result.sequenceState,"ready");
 assert.equal(result.next.index,0);
 assert.equal(result.executionStarted,false);
 assert.equal(count(fresh,"jobs"),0);
});

function skillFixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",
  rootMessageId:"root",originalRequest:"可信 Skill 结果",requestId:"create"}).task;
 const source=Buffer.from(zipSync({
  "SKILL.md":strToU8("---\nname: Safe Test\ndescription: no GPU\n---\n"),
  "scripts/run.js":strToU8('console.log("ok")')})).toString("base64");
 const registry={list:()=>({skills:[{id:"test-skill",enabled:true,versions:["abcdef123456"]}]}),
  get:()=>({package:{manifest:{hash:"abcdef123456"+"0".repeat(52)},sourceArchiveBase64:source}})};
 const base={projectId:"p",taskId:task.id};
 const step=planAssistantSkillStep(db,{...base,requestId:"skill-plan",
  expectedPlanVersion:1,expectedProjectRevision:1,skillRegistry:registry,
  proposal:{skill_id:"test-skill",version:"abcdef123456",script_path:"scripts/run.js",
   args:[],input_files:{},output_files:[]}});
 decideAssistantTaskStep(db,{...base,stepId:step.stepId,requestId:"skill-approve",
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve"});
 const reserve=()=>reserveAssistantSkillRun(db,{...base,stepId:step.stepId,
  expectedPlanVersion:1,actionDigest:step.actionDigest,requestId:"skill-run"});
 return {db,base,step,reserve};
}
test("P4.4a Skill reservation remains single-use and unknown result never respawns its script",t=>{
 const f=skillFixture(t),reserved=f.reserve();
 assert.equal(reserved.shouldLaunch,true);
 const before=continueAssistantTaskSafely(f.db,{...f.base,requestId:"skill-check-1",
  expectedPlanVersion:1});
 assert.equal(before.reason,"unknown_external_result");
 assert.equal(before.steps[0].kind,"skill_script");
 assert.equal(before.steps[0].attemptStatus,"submitting");
 assert.equal(before.executionStarted,false);
 const recovered=recoverAssistantSkillTasksAtStartup(f.db);
 assert.equal(recovered.unknown,1);
 const next=continueAssistantTaskSafely(f.db,{...f.base,requestId:"skill-check-2",
  expectedPlanVersion:1});
 assert.equal(next.reason,"unknown_external_result");
 assert.equal(next.taskStatus,"needs_reconcile");
 assert.equal(count(f.db,"skill_script_runs"),1);
 assert.equal(count(f.db,"assistant_task_attempts"),1);
 assert.equal(f.reserve().shouldLaunch,false);
});
test("P4.4a settled Skill result is observed, never re-executed by safe continuation",t=>{
 const f=skillFixture(t),reserved=f.reserve();
 const settled=settleAssistantSkillRun(f.db,{...f.base,stepId:f.step.stepId,
  runId:reserved.runId,result:{status:"completed",exit_code:0,artifacts:[],log_blobs:{}}});
 assert.equal(settled.success,true);
 const first=continueAssistantTaskSafely(f.db,{...f.base,requestId:"read-settled",
  expectedPlanVersion:1});
 assert.equal(first.taskStatus,"ready");
 assert.equal(first.steps[0].receiptTrusted,true);
 assert.equal(first.executionStarted,false);
 assert.equal(first.checkpoints.length,0);
 assert.equal(count(f.db,"skill_script_runs"),1);
 assert.equal(count(f.db,"assistant_task_attempts"),1);
});
test("P4.4a Comfy Job requires durable materialization, never duplicates its queued job",t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"c",
  rootMessageId:"root",originalRequest:"Comfy 生成并落图",requestId:"create"}).task;
 const base={projectId:"p",taskId:task.id};
 const step=planAssistantExternalJobStep(db,{...base,requestId:"comfy-plan",kind:"comfy_workflow",
  expectedPlanVersion:1,expectedProjectRevision:1,
  job:{targetNodeId:"first",sourceNodeFingerprint:fingerprintSource(document,"first"),
   executionMode:"poll",snapshot:{adapterKind:"comfy",instanceId:"comfy-local",workflowId:"fixture"}}});
 decideAssistantTaskStep(db,{...base,stepId:step.stepId,requestId:"approve",
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve"});
 const job=enqueueAssistantExternalJobStep(db,{...base,stepId:step.stepId,requestId:"enqueue",
  expectedPlanVersion:1,actionDigest:step.actionDigest});
 db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(job.jobId);
 db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES('comfy-blob',?,8,'image/png','local/comfy','ready')")
  .run("e".repeat(64));
 db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) "+
  "VALUES('comfy-artifact',?,NULL,'image-0','comfy-blob','image','image/png',?,'{}')")
  .run(job.jobId,"e".repeat(64));
 const pending=continueAssistantTaskSafely(db,{...base,requestId:"pending-comfy",expectedPlanVersion:1});
 assert.equal(pending.reason,"awaiting_verified_materialization");
 assert.equal(count(db,"jobs"),1);
 db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) "+
  "VALUES('mat-comfy',?,'comfy-artifact','p','materialized','first')").run(job.jobId);
 const finished=continueAssistantTaskSafely(db,{...base,requestId:"committed-comfy",expectedPlanVersion:1});
 assert.equal(finished.taskStatus,"ready");
 assert.equal(finished.steps.filter(s=>s.kind==="comfy_workflow"&&s.receiptTrusted).length,1);
 assert.equal(finished.steps.filter(s=>s.kind==="materialize"&&s.receiptTrusted).length,1);
 assert.equal(count(db,"jobs"),1);
 assert.equal(count(db,"assistant_task_attempts"),1);
});
test("P4.4a concurrent SQLite clients share checkpoint authority and never duplicate skips",async t=>{
 const actions=[
  {type:"run_node",nodeId:"first",mode:"text"},
  {type:"run_node",nodeId:"second",mode:"text",when:{sourceIndex:0,kind:"image",op:"gte",count:1}},
  {type:"run_node",nodeId:"third",mode:"text",when:{sourceIndex:0,kind:"image",op:"lt",count:1}}
 ];
 const f=fixture(t,actions),first=f.plan(0),job=f.enqueue(first,0);f.complete(job,0);
 const dir=mkdtempSync(join(tmpdir(),"atelier-p44a-race-"));
 const file=join(dir,"shared.db");await backup(f.db,file);
 const left=new DatabaseSync(file),right=new DatabaseSync(file);
 t.after(()=>{left.close();right.close();rmSync(dir,{recursive:true,force:true})});
 const args={...f.base,expectedPlanVersion:1,requestId:"same-click"};
 const results=await Promise.all([
  Promise.resolve().then(()=>continueAssistantTaskSafely(left,args)),
  Promise.resolve().then(()=>continueAssistantTaskSafely(right,args))
 ]);
 assert.equal(results.filter(x=>x.existing===false).length,1);
 assert.equal(results.filter(x=>x.existing===true).length,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM assistant_task_run_branch_skips").get().n,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM jobs").get().n,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE command_kind='safe_continuation'").get().n,1);
});

test("P4.4a cached positive state cannot authorize after archive, cancellation, unknown state",t=>{
 const f=fixture(t);
 const initially=f.advance("cached-before-revocation");
 assert.equal(initially.requiresApproval,true);
 f.db.prepare("UPDATE assistant_tasks SET read_only=1 WHERE id=?").run(f.base.taskId);
 assert.throws(()=>f.advance("cached-before-revocation"),{code:"assistant_task_not_editable"});
 f.db.prepare("UPDATE assistant_tasks SET read_only=0,status='cancelled',cancel_requested_at=? WHERE id=?")
  .run(Date.now(),f.base.taskId);
 const afterCancel=f.advance("cached-before-revocation");
 assert.equal(afterCancel.existing,true);
 assert.equal(afterCancel.next,null);
 assert.equal(afterCancel.requiresApproval,false);
 assert.equal(afterCancel.reason,"task_cancelled");
 f.db.prepare("UPDATE assistant_tasks SET status='needs_reconcile',cancel_requested_at=NULL WHERE id=?")
  .run(f.base.taskId);
 const afterUnknown=f.advance("cached-before-revocation");
 assert.equal(afterUnknown.next,null);
 assert.equal(afterUnknown.requiresApproval,false);
 assert.equal(afterUnknown.reason,"unknown_external_result");
});
test("P4.4a different clients and request IDs cannot duplicate trusted branch checkpoint",async t=>{
 const actions=[
  {type:"run_node",nodeId:"first",mode:"text"},
  {type:"run_node",nodeId:"second",mode:"text",when:{sourceIndex:0,kind:"image",op:"gte",count:1}},
  {type:"run_node",nodeId:"third",mode:"text",when:{sourceIndex:0,kind:"image",op:"lt",count:1}}
 ];
 const f=fixture(t,actions),first=f.plan(0),job=f.enqueue(first,0);f.complete(job,0);
 const dir=mkdtempSync(join(tmpdir(),"atelier-p44a-race-distinct-"));
 const file=join(dir,"shared.db");await backup(f.db,file);
 const left=new DatabaseSync(file),right=new DatabaseSync(file);
 t.after(()=>{left.close();right.close();rmSync(dir,{recursive:true,force:true})});
 const args={...f.base,expectedPlanVersion:1};
 const outcomes=await Promise.all([
  Promise.resolve().then(()=>continueAssistantTaskSafely(left,{...args,requestId:"client-A"})),
  Promise.resolve().then(()=>continueAssistantTaskSafely(right,{...args,requestId:"client-B"}))
 ]);
 assert.equal(outcomes.flatMap(x=>x.checkpoints).length,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM assistant_task_run_branch_skips").get().n,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM jobs").get().n,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE command_kind='run_branch_skip'").get().n,1);
});

test("P4.4a old-plan corrupted Job can never poison the active Task",t=>{
 const f=fixture(t),step=f.plan(0),job=f.enqueue(step,0);
 // Simulate a retained historical plan alongside a new, active one.
 f.db.prepare("UPDATE assistant_tasks SET active_plan_version=2,status='planning',active_step_id=NULL WHERE id=?")
  .run(f.base.taskId);
 f.db.prepare("UPDATE jobs SET request_fingerprint=? WHERE id=?").run("f".repeat(64),job.jobId);
 const safe=continueAssistantTaskSafely(f.db,{...f.base,requestId:"new-plan-check",expectedPlanVersion:2});
 assert.equal(safe.taskStatus,"planning");
 assert.equal(safe.sequenceState,"none");
 assert.equal(safe.executionStarted,false);
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks WHERE id=?").get(f.base.taskId).status,"planning");
 assert.equal(count(f.db,"jobs"),1);
});
test("P4.4a final branch skip cannot complete a Task with a durable deliverable requirement",t=>{
 const f=fixture(t,branch),first=f.plan(0),firstJob=f.enqueue(first,0);f.complete(firstJob,0);
 const result=f.advance("ready-second");
 assert.equal(result.sequenceState,"ready");
 const mat=f.db.prepare("SELECT id FROM assistant_task_steps WHERE kind='materialize' ORDER BY ordinal DESC LIMIT 1").get().id;
 const second=f.plan(1,[mat]),secondJob=f.enqueue(second,1);f.complete(secondJob,1);
 f.db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) "+
  "VALUES(?,'deliverable_required',?,?)").run(f.base.taskId,
  JSON.stringify({kind:"text_nodes",taskId:f.base.taskId}),Date.now());
 const final=f.advance("finish-with-spec");
 assert.equal(final.sequenceState,"completed");
 assert.equal(final.checkpoints.length,1);
 assert.equal(count(f.db,"assistant_task_run_branch_skips"),1);
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks WHERE id=?").get(f.base.taskId).status,"ready");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='task_completed'").get().n,0);
});

test("P4.4a plan revision between two checkpoint transactions cannot authorize new-plan work",t=>{
 const actions=[
  {type:"run_node",nodeId:"first",mode:"text"},
  {type:"run_node",nodeId:"second",mode:"text",when:{sourceIndex:0,kind:"image",op:"gte",count:1}},
  {type:"run_node",nodeId:"third",mode:"text",when:{sourceIndex:0,kind:"image",op:"lt",count:1}}
 ];
 const f=fixture(t,actions),first=f.plan(0),job=f.enqueue(first,0);f.complete(job,0);
 assert.throws(()=>f.advance("interleaved",{afterCheckpoint:()=>{
  f.db.prepare("UPDATE assistant_tasks SET active_plan_version=2,status='planning',active_step_id=NULL WHERE id=?")
   .run(f.base.taskId);
 }}),{code:"assistant_step_plan_conflict"});
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_run_branch_skips").get().n,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE command_kind='safe_continuation'").get().n,0);
 assert.equal(f.db.prepare("SELECT active_plan_version,status FROM assistant_tasks WHERE id=?").get(f.base.taskId).active_plan_version,2);
 assert.equal(count(f.db,"jobs"),1);
});

test("P4.4a final response CAS refuses graph revision changed just before persistence",t=>{
 const f=fixture(t);
 assert.throws(()=>f.advance("source-changed",{beforeCommandCommit:()=>{
  f.db.prepare("UPDATE projects SET revision=revision+1 WHERE id='p'").run();
 }}),{code:"assistant_safe_continue_state_changed"});
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE request_id='source-changed'").get().n,0);
 assert.equal(count(f.db,"jobs"),0);
});
