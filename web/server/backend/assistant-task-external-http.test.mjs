import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {fingerprintSource} from "./repository.mjs";

const document={nodes:[{id:"source",type:"text",title:"Prompt",
 position:{x:0,y:0},width:340,height:240,metadata:{content:"prompt"}}],connections:[]};
async function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const app=buildApp({db,authorize:()=>true});
 t.after(async()=>{await app.close();db.close()});
 const call=async(method,url,payload)=>{
  const r=await app.inject({method,url,...(payload!==undefined?{payload}:{})});
  return {status:r.statusCode,body:r.json()};
 };
 const created=await call("POST","/api/v1/projects",{id:"project",document});
 assert.equal(created.status,201);
 const project="/api/v1/projects/project";
 const task=(await call("POST",project+"/assistant/tasks",{
  requestId:"create",chatSessionId:"chat",rootMessageId:"root",originalRequest:"生成并落图"}));
 assert.equal(task.status,201);
 return {db,call,project,taskId:task.body.task.id,base:project+"/assistant/tasks/"+task.body.task.id};
}
test("P2a HTTP frozen plan → user approval → one Job enqueue → read-only reconcile",async t=>{
 const fx=await setup(t),url=fx.base+"/external-jobs";
 const body={requestId:"job-plan",kind:"model_job",expectedPlanVersion:1,expectedProjectRevision:1,
  job:{targetNodeId:"source",sourceNodeFingerprint:fingerprintSource(document,"source"),
   executionMode:"poll",snapshot:{adapterKind:"model",task:{kind:"text"},model:"mock"}},finalizeTask:true};
 const planned=await fx.call("POST",url,body);
 assert.equal(planned.status,200,JSON.stringify(planned.body));
 assert.equal(planned.body.kind,"model_job");
 assert.equal((await fx.call("POST",url,body)).body.stepId,planned.body.stepId);
 const step=fx.base+"/steps/"+planned.body.stepId;
 const invalid=await fx.call("POST",step+"/enqueue",{requestId:"enqueue",expectedPlanVersion:1,
  actionDigest:planned.body.actionDigest});
 assert.equal(invalid.status,409);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
 const approved=await fx.call("POST",step+"/approval",{
  requestId:"approval",expectedPlanVersion:1,actionDigest:planned.body.actionDigest,decision:"approve"});
 assert.equal(approved.status,200);
 const queued=await fx.call("POST",step+"/enqueue",{
  requestId:"enqueue",expectedPlanVersion:1,actionDigest:planned.body.actionDigest});
 assert.equal(queued.status,200,JSON.stringify(queued.body));
 assert.ok(queued.body.jobId);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal((await fx.call("POST",step+"/enqueue",{
  requestId:"enqueue",expectedPlanVersion:1,actionDigest:planned.body.actionDigest})).body.jobId,queued.body.jobId);
 const current=await fx.call("GET",fx.base);
 assert.equal(current.body.task.status,"waiting_external");
 assert.equal(current.body.task.recoveryMode,"job_observation");
 assert.equal(current.body.task.steps[0].result.jobId,queued.body.jobId);
 assert.equal(current.body.task.steps[0].approvalDecision,"approved");
 assert.equal(current.body.task.steps[0].action.job.targetNodeId,"source");
 const reconciled=await fx.call("POST",fx.base+"/reconcile",{});
 assert.equal(reconciled.status,200);
 assert.equal(reconciled.body.advanced,0);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 const crossProject=await fx.call("POST","/api/v1/projects/another/assistant/tasks/"+fx.taskId+"/reconcile",{});
 assert.equal(crossProject.status,404);
});
test("P2a HTTP rejects mismatched provider kind and credentials before any Job",async t=>{
 const fx=await setup(t);
 const result=await fx.call("POST",fx.base+"/external-jobs",{
  requestId:"invalid-snapshot",kind:"model_job",expectedPlanVersion:1,expectedProjectRevision:1,
  job:{targetNodeId:"source",sourceNodeFingerprint:fingerprintSource(document,"source"),
   executionMode:"poll",snapshot:{adapterKind:"model",apiKey:"raw-secret"}}});
 assert.equal(result.status,400);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
});
