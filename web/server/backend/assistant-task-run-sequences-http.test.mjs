import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {fingerprintSource} from "./repository.mjs";

const doc={nodes:[
 {id:"first",type:"text",title:"A",position:{x:0,y:0},width:340,height:240,metadata:{content:"one"}},
 {id:"second",type:"text",title:"B",position:{x:400,y:0},width:340,height:240,metadata:{content:"two"}}
],connections:[]};
async function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const app=buildApp({db,authorize:()=>true});
 t.after(async()=>{await app.close();db.close()});
 const call=async(method,url,payload)=>{
  const r=await app.inject({method,url,...(payload!==undefined?{payload}:{})});
  return {status:r.statusCode,body:r.json()};
 };
 const created=await call("POST","/api/v1/projects",{id:"p",document:doc});
 assert.equal(created.status,201);
 const createdTask=await call("POST","/api/v1/projects/p/assistant/tasks",{
  requestId:"task-created",chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"依次生成 A 与 B"});
 assert.equal(createdTask.status,201);
 return {db,call,base:"/api/v1/projects/p/assistant/tasks/"+createdTask.body.task.id};
}
test("P3b HTTP run-sequence freeze and replay are read-only until first paid Job is separately approved",async t=>{
 const fx=await fixture(t),url=fx.base+"/run-sequences";
 const actions=[{type:"run_node",nodeId:"first",mode:"text"},
  {type:"run_node",nodeId:"second",mode:"text"}];
 const before=await fx.call("GET",url);
 assert.equal(before.status,200);assert.equal(before.body.state,"none");
 const body={requestId:"sequence-plan",sourceMessageId:"user-turn",expectedPlanVersion:1,
  expectedProjectRevision:1,actions};
 const result=await fx.call("POST",url,body);
 assert.equal(result.status,200,JSON.stringify(result.body));
 const repeated=await fx.call("POST",url,body);
 assert.equal(repeated.status,200);assert.equal(repeated.body.existing,true);
 assert.equal(repeated.body.sequenceId,result.body.sequenceId);
 const state=await fx.call("GET",url);
 assert.equal(state.status,200);
 assert.equal(state.body.next.index,0);
 assert.deepEqual(state.body.next.action,actions[0]);
 assert.deepEqual(state.body.next.dependsOn,[]);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
 const plainPlan={requestId:"bypass",kind:"model_job",expectedPlanVersion:1,
  expectedProjectRevision:1,job:{targetNodeId:"first",
   sourceNodeFingerprint:fingerprintSource(doc,"first"),executionMode:"poll",
   snapshot:{adapterKind:"model",task:{kind:"text",model:"demo",prompt:"one"}}}};
 const bypass=await fx.call("POST",fx.base+"/external-jobs",plainPlan);
 assert.equal(bypass.status,409,JSON.stringify(bypass.body));
 const skip=await fx.call("POST",fx.base+"/external-jobs",{
  ...plainPlan,requestId:"skip",runSequenceId:result.body.sequenceId,runIndex:1});
 assert.equal(skip.status,409);
 const planned=await fx.call("POST",fx.base+"/external-jobs",{
  ...plainPlan,requestId:"first-frozen",runSequenceId:result.body.sequenceId,runIndex:0});
 assert.equal(planned.status,200,JSON.stringify(planned.body));
 assert.equal(planned.body.kind,"model_job");
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
 const pending=await fx.call("GET",url);
 assert.equal(pending.body.state,"waiting_approval");
 const step=fx.base+"/steps/"+planned.body.stepId;
 const denyBeforeApprove=await fx.call("POST",step+"/enqueue",{requestId:"early",
  expectedPlanVersion:1,actionDigest:planned.body.actionDigest});
 assert.equal(denyBeforeApprove.status,409);
 const approved=await fx.call("POST",step+"/approval",{
  requestId:"user-approves-first",expectedPlanVersion:1,
  actionDigest:planned.body.actionDigest,decision:"approve"});
 assert.equal(approved.status,200);
 const queued=await fx.call("POST",step+"/enqueue",{
  requestId:"enqueue-first",expectedPlanVersion:1,actionDigest:planned.body.actionDigest});
 assert.equal(queued.status,200,JSON.stringify(queued.body));
 assert.ok(queued.body.jobId);
 assert.equal((await fx.call("POST",step+"/enqueue",{
  requestId:"enqueue-first",expectedPlanVersion:1,actionDigest:planned.body.actionDigest})).body.jobId,queued.body.jobId);
 assert.equal((await fx.call("GET",url)).body.state,"waiting_external");
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_run_sequences").get().n,1);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,1);
});
