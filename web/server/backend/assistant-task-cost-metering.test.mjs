import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync,backup} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {createAssistantTask} from "./assistant-tasks.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep} from "./assistant-task-external-jobs.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {fingerprintSource} from "./repository.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createOpenAiModelAdapter} from "./openai-model-adapter.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {buildApp} from "./app.mjs";
import {compatEndpointFingerprint} from "./openai-compat-endpoints.mjs";
import {getAssistantTaskCostReport,normalizeAssistantTokenUsage,recordAssistantModelUsage}
 from "./assistant-task-cost-metering.mjs";
const doc={nodes:[{id:"input",type:"text",title:"Prompt",position:{x:0,y:0},
 width:250,height:120,metadata:{content:"Say hello"}}],connections:[]};
const count=(db,table)=>db.prepare("SELECT COUNT(*) n FROM "+table).get().n;
function fixture(t,{provider="openai",stream=false,usage={prompt_tokens:11,completion_tokens:7,total_tokens:18},
 upstreamStatus=200,upstreamError=false,incompleteStream=false}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const dir=mkdtempSync(join(tmpdir(),"atelier-cost-metering-"));
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const projectId="project-usage";createProject(db,{id:projectId,document:doc});
 const task=createAssistantTask(db,{projectId,chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"生成文本并记录用量",requestId:"task-new"}).task;
 const base={projectId,taskId:task.id};
 const vault=createCredentialVault({db,protector:{protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)}});
 const chan=vault.create({id:"usage-channel",provider,displayName:"Usage test",
  apiKey:"not-a-real-key"});
 const snap={adapterKind:"model",provider,channelId:chan.id,secretVersionRef:chan.keyVersion,
  ...(provider==="openai_compatible"?{
   endpointBaseUrl:"http://127.0.0.1:9988/v1",
   endpointFingerprint:compatEndpointFingerprint("http://127.0.0.1:9988/v1")}:{}),
  task:{kind:"text",model:"test-model",prompt:"Say hello",stream}};

 const planned=planAssistantExternalJobStep(db,{...base,requestId:"freeze",
  kind:"model_job",expectedPlanVersion:1,expectedProjectRevision:1,
  job:{targetNodeId:"input",sourceNodeFingerprint:fingerprintSource(doc,"input"),
   executionMode:"immediate",snapshot:snap}});
 decideAssistantTaskStep(db,{...base,stepId:planned.stepId,requestId:"approval",
  expectedPlanVersion:1,actionDigest:planned.actionDigest,decision:"approve"});
 const queued=enqueueAssistantExternalJobStep(db,{...base,stepId:planned.stepId,requestId:"enqueue",
  expectedPlanVersion:1,actionDigest:planned.actionDigest});
 let remoteCalls=0;
 const upstream=async()=>{
  remoteCalls++;
  if(upstreamError)throw Error("socket_lost_after_possible_accept");
  if(stream){
   const frames=[
    {choices:[{delta:{content:"Hello"},finish_reason:null}]},
    {choices:[{delta:{content:" world"},finish_reason:"stop"}]},
    ...(usage===null?[]:[{choices:[],usage}])
   ];
   const s=frames.map(v=>"data: "+JSON.stringify(v)+"\n\n").join("")+
    (incompleteStream?"":"data: [DONE]\n\n");
   return new Response(s,{status:upstreamStatus,headers:{"content-type":"text/event-stream"}});
  }
  return new Response(JSON.stringify({choices:[{message:{content:"Hello world"}}],
   ...(usage===null?{}:{usage})}),{status:upstreamStatus});
 };
 const adapter=createOpenAiModelAdapter({db,blobStore:createBlobStore({dataDir:dir,db}),
  vault,upstreamCall:upstream,compatibleUpstreamCall:upstream});
 const coordinator=createJobCoordinator({db,adapters:{model:adapter}});
 return {db,base,task,queued,coordinator,report:()=>getAssistantTaskCostReport(db,base),
  calls:()=>remoteCalls,dir};
}
test("P4.4d token counters validate integers, totals and upper bounds without estimating",()=>{
 assert.equal(SCHEMA_VERSION,32);
 assert.deepEqual(normalizeAssistantTokenUsage({prompt_tokens:11,completion_tokens:7,total_tokens:18}),
  {inputTokens:11,outputTokens:7,totalTokens:18});
 // A nonempty successful completion cannot have a valid zero-token usage
 // receipt; never accept a convenient "free" counter as settled evidence.
 assert.equal(normalizeAssistantTokenUsage({prompt_tokens:0,completion_tokens:0,total_tokens:0}),null);
 for(const bad of [null,undefined,["bad"],{prompt_tokens:"11",completion_tokens:7,total_tokens:18},
  {prompt_tokens:11,completion_tokens:-7,total_tokens:4},
  {prompt_tokens:11,completion_tokens:7,total_tokens:19},
  {prompt_tokens:NaN,completion_tokens:0,total_tokens:0},
  {prompt_tokens:1e15,completion_tokens:1,total_tokens:1e15+1},
  {input_tokens:11,output_tokens:7,total_tokens:18},
  {prompt_tokens:0.5,completion_tokens:2,total_tokens:2.5}])
  assert.equal(normalizeAssistantTokenUsage(bad),null);
});
test("P4.4d real model adapter persists only validated counters, Task report is read-only",async t=>{
 const f=fixture(t);
 assert.equal(f.report().summary.notSubmittedJobCount,1);
 assert.equal(f.report().summary.totalSettledAmountMicros,null);
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.calls(),1);
 const job=f.db.prepare("SELECT status FROM jobs WHERE id=?").get(f.queued.jobId);
 assert.equal(job.status,"succeeded");
 const report=f.report();
 assert.equal(report.jobs.length,1);
 assert.equal(report.jobs[0].metering,"upstream_reported");
 assert.deepEqual(report.summary.upstreamReportedTokens,{inputTokens:11,outputTokens:7,totalTokens:18});
 assert.equal(report.summary.reportedJobCount,1);
 assert.equal(report.monetary.hardCapSupported,false);
 assert.equal(report.monetary.settledAmountMicros,null);
 assert.equal(report.jobs[0].amountMicros,null);
 const row=f.db.prepare("SELECT payload_json FROM job_events WHERE kind='model_usage_reported'").get();
 assert.deepEqual(JSON.parse(row.payload_json),{
  version:1,source:"upstream_response",inputTokens:11,outputTokens:7,totalTokens:18});
 assert.ok(!row.payload_json.includes("not-a-real-key"));
 const replay=recordAssistantModelUsage(f.db,{jobId:f.queued.jobId,
  usage:{prompt_tokens:11,completion_tokens:7,total_tokens:18,secret:"discard"}});
 assert.equal(replay.existing,true);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM job_events WHERE kind='model_usage_reported'").get().n,1);
});
test("P4.4d missing usage remains unknown, never interpreted as zero bill",async t=>{
 const f=fixture(t,{usage:null});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs").get().status,"succeeded");
 assert.equal(f.report().jobs[0].metering,"usage_unavailable");
 assert.equal(f.report().summary.reportedJobCount,0);
 assert.equal(f.report().summary.unavailableJobCount,1);
 assert.equal(f.report().summary.totalSettledAmountMicros,null);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM job_events WHERE kind='model_usage_reported'").get().n,0);
});
test("P4.4d invalid upstream counters are audited without raw fields or a fake bill",async t=>{
 const f=fixture(t,{usage:{prompt_tokens:9,completion_tokens:8,total_tokens:999,
  secret:"SENSITIVE_MODEL_PAYLOAD"}});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs").get().status,"succeeded");
 assert.equal(f.report().jobs[0].metering,"usage_unavailable");
 assert.equal(f.report().summary.reportedJobCount,0);
 assert.equal(f.report().summary.totalSettledAmountMicros,null);
 const row=f.db.prepare("SELECT payload_json FROM job_events WHERE kind='model_usage_unusable'").get();
 assert.ok(row);
 assert.equal(row.payload_json.includes("SENSITIVE_MODEL_PAYLOAD"),false);
});
test("P4.4d SSE usage last frame is counted only after fully completed text stream",async t=>{
 const f=fixture(t,{stream:true,usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs").get().status,"succeeded");
 assert.deepEqual(f.report().summary.upstreamReportedTokens,{inputTokens:2,outputTokens:3,totalTokens:5});
});
test("P4.4d uncertain upstream submit never turns into zero bill nor auto-resubmits",async t=>{
 const f=fixture(t,{upstreamError:true});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs").get().status,"submission_unknown");
 assert.equal(f.report().summary.billingUnverifiedJobCount,1);
 assert.equal(f.report().summary.totalSettledAmountMicros,null);
 const again=createJobCoordinator({db:f.db,adapters:{model:createOpenAiModelAdapter({
  db:f.db,blobStore:createBlobStore({dataDir:f.dir,db:f.db}),vault:{
   withSecretVersion(){throw Error("should-not-be-used");}
  },upstreamCall:()=>{throw Error("must not retry")}})}});
 again.recoverAtStartup();await again.tick();
 assert.equal(f.calls(),1);
});
test("P4.4d repeated and forged receipts cannot increase totals",async t=>{
 const f=fixture(t);f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.throws(()=>recordAssistantModelUsage(f.db,{jobId:f.queued.jobId,
  usage:{prompt_tokens:999,completion_tokens:1,total_tokens:1000}}),{
  code:"assistant_usage_conflicting_receipt"});
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(f.report().summary.upstreamReportedTokens.totalTokens,18);
});
test("P4.4d Task-specific report cannot read another project or Task usage",async t=>{
 const f=fixture(t);f.coordinator.recoverAtStartup();await f.coordinator.tick();
 const other=createAssistantTask(f.db,{projectId:f.base.projectId,chatSessionId:"other",
  rootMessageId:"other-root",originalRequest:"隔离",requestId:"other"}).task;
 assert.equal(getAssistantTaskCostReport(f.db,{projectId:f.base.projectId,taskId:other.id}).summary.jobCount,0);
 assert.throws(()=>getAssistantTaskCostReport(f.db,{projectId:"wrong",taskId:f.task.id}),{
  code:"assistant_task_not_found"});
});
test("P4.4d HTTP exposes only read-only metering; no route for fake usage, price or settlement",async t=>{
 const f=fixture(t);f.coordinator.recoverAtStartup();await f.coordinator.tick();
 const app=buildApp({db:f.db,authorize:async()=>true});t.after(()=>app.close());
 const uri="/api/v1/projects/"+f.base.projectId+"/assistant/tasks/"+f.task.id+"/cost-report";
 const response=await app.inject({method:"GET",url:uri});
 assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().summary.reportedJobCount,1);
 assert.equal(response.json().monetary.hardCapSupported,false);
 const denied=await app.inject({method:"POST",url:uri,payload:{costMicros:0,totalTokens:999}});
 assert.equal(denied.statusCode,404);
 assert.equal(f.report().summary.upstreamReportedTokens.totalTokens,18);
});

test("P4.4d compatible-provider reports tokens but cannot claim verified USD billing",async t=>{
 const f=fixture(t,{provider:"openai_compatible",
  usage:{prompt_tokens:2,completion_tokens:4,total_tokens:6}});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs").get().status,"succeeded");
 assert.deepEqual(f.report().summary.upstreamReportedTokens,{
  inputTokens:2,outputTokens:4,totalTokens:6});
 assert.equal(f.report().jobs[0].provider,"openai_compatible");
 assert.equal(f.report().monetary.hardCapSupported,false);
});
test("P4.4d streaming without usage does not fabricate or infer tokens from text length",async t=>{
 const f=fixture(t,{stream:true,usage:null});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs").get().status,"succeeded");
 assert.equal(f.report().summary.unavailableJobCount,1);
 assert.equal(f.report().summary.upstreamReportedTokens.totalTokens,0);
 assert.equal(f.report().summary.totalSettledAmountMicros,null);
});

test("P4.4d Assistant reasoning calls are explicitly outside the Job token subtotal",async t=>{
 const f=fixture(t);
 const started=Date.now();
 f.db.prepare("INSERT INTO assistant_model_calls(id,project_id,task_id,request_id,call_index,call_kind,provider,model,request_digest,status,submit_marker,started_at) "+
  "VALUES(?,?,?,?,0,'initial','openai','model-x',?,'succeeded','sent',?)")
  .run("inference-call","project-usage",f.task.id,"task-new","f".repeat(64),started);
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 const result=f.report();
 assert.equal(result.summary.jobCount,1);
 assert.equal(result.summary.assistantInferenceCallCount,1);
 assert.equal(result.summary.assistantInferenceUsageUnavailableCount,1);
 assert.equal(result.summary.upstreamReportedTokens.totalTokens,18);
 assert.equal(result.summary.totalSettledAmountMicros,null);
});

test("P4.4d truncated SSE usage never creates an attested token receipt",async t=>{
 const f=fixture(t,{stream:true,incompleteStream:true,
  usage:{prompt_tokens:3,completion_tokens:5,total_tokens:8}});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs").get().status,"submission_unknown");
 assert.equal(f.report().summary.billingUnverifiedJobCount,1);
 assert.equal(f.report().summary.reportedJobCount,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM job_events WHERE kind='model_usage_reported'").get().n,0);
 assert.equal(f.report().summary.totalSettledAmountMicros,null);
});
test("P4.4d two SQLite connections cannot record duplicate usage or inflate Task totals",async t=>{
 const f=fixture(t);f.coordinator.recoverAtStartup();await f.coordinator.tick();
 const folder=mkdtempSync(join(tmpdir(),"atelier-cost-ledger-race-")),path=join(folder,"shared.db");
 await backup(f.db,path);
 const left=new DatabaseSync(path),right=new DatabaseSync(path);
 t.after(()=>{left.close();right.close();rmSync(folder,{recursive:true,force:true})});
 const args={jobId:f.queued.jobId,
  usage:{prompt_tokens:11,completion_tokens:7,total_tokens:18}};
 const [first,second]=await Promise.all([
  Promise.resolve().then(()=>recordAssistantModelUsage(left,args)),
  Promise.resolve().then(()=>recordAssistantModelUsage(right,args))
 ]);
 assert.equal(first.existing,true);
 assert.equal(second.existing,true);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM job_events WHERE kind='model_usage_reported'").get().n,1);
 assert.equal(getAssistantTaskCostReport(left,f.base).summary.upstreamReportedTokens.totalTokens,18);
});
