import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {buildApp} from "./app.mjs";
const doc={nodes:[{id:"node",type:"text",title:"Text",position:{x:0,y:0},
 width:340,height:240,metadata:{content:"hello"}}],connections:[]};
async function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const app=buildApp({db,authorize:()=>true});
 t.after(async()=>{await app.close();db.close()});
 const call=async(method,url,payload)=>{
  const r=await app.inject({method,url,...(payload!==undefined?{payload}:{})});
  return {status:r.statusCode,body:r.json()};
 };
 assert.equal((await call("POST","/api/v1/projects",{id:"p",document:doc})).status,201);
 const first=(await call("POST","/api/v1/projects/p/assistant/tasks",{
  chatSessionId:"chat-one",rootMessageId:"root",requestId:"create",
  originalRequest:"持续执行工作流"})).body.task;
 return {db,call,taskId:first.id,base:"/api/v1/projects/p/assistant/tasks/"+first.id};
}
test("P3c SQLite v27 to v28 preserves existing tasks and adds chat links",()=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 try{
  db.prepare("UPDATE schema_migrations SET version=27 WHERE version=28").run();
  db.exec("DROP TABLE assistant_task_chat_links");
  initializeSchema(db);
  assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,28);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_task_chat_links'").get());
  initializeSchema(db); // repeat startup must not duplicate schema migration
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=28").get().n,1);
 }finally{db.close()}
});
test("P3c chat link requires explicit command; original chat remains unchanged and replay is idempotent",async t=>{
 const {db,call,taskId,base}=await fixture(t);
 assert.equal(SCHEMA_VERSION,28);
 const one=await call("GET","/api/v1/projects/p/assistant/tasks?chatSessionId=chat-one");
 assert.deepEqual(one.body.tasks[0].chatSessionIds,["chat-one"]);
 const before=await call("GET","/api/v1/projects/p/assistant/tasks?chatSessionId=chat-two");
 assert.equal(before.body.tasks.length,0);
 const options=await call("GET","/api/v1/projects/p/assistant/tasks?chatSessionId=chat-two&includeOther=true");
 assert.equal(options.body.tasks.length,1);
 assert.equal(options.body.tasks[0].chatSessionId,"chat-one");
 const linked=await call("POST",base+"/link-chat",{requestId:"link-one",chatSessionId:"chat-two"});
 assert.equal(linked.status,200,JSON.stringify(linked.body));
 assert.deepEqual(linked.body.task.chatSessionIds,["chat-one","chat-two"]);
 assert.equal((await call("POST",base+"/link-chat",{requestId:"link-one",chatSessionId:"chat-two"})).body.existing,true);
 const again=await call("POST",base+"/link-chat",{requestId:"link-new",chatSessionId:"chat-two"});
 assert.equal(again.status,200);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assistant_task_chat_links").get().n,1);
 assert.deepEqual((await call("GET","/api/v1/projects/p/assistant/tasks?chatSessionId=chat-two")).body.tasks.map(t=>t.id),[taskId]);
 assert.equal(db.prepare("SELECT chat_session_id FROM assistant_tasks WHERE id=?").get(taskId).chat_session_id,"chat-one");
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
 assert.equal((await call("POST",base+"/link-chat",{requestId:"link-one",chatSessionId:"another"})).status,409);
});
test("P3c HTTP safe recovery does not authorize an unknown Job or skip approval",async t=>{
 const {db,call,base}=await fixture(t);
 const recovery=await call("GET",base+"/recovery");
 assert.equal(recovery.status,200);
 assert.equal(recovery.body.canReplan,false);
 assert.equal((await call("POST",base+"/replan",{requestId:"attempt",
  expectedPlanVersion:1,expectedProjectRevision:1})).status,409);
 const plan=await call("POST",base+"/external-jobs",{requestId:"plan",
  expectedPlanVersion:1,expectedProjectRevision:1,kind:"model_job",
  job:{targetNodeId:"node",sourceNodeFingerprint:"placeholder",
   executionMode:"poll",snapshot:{adapterKind:"model",task:{kind:"text",model:"mock",prompt:"hi"}}}});
 assert.equal(plan.status,200);
 const reject=await call("POST",base+"/steps/"+plan.body.stepId+"/approval",{
  requestId:"reject",expectedPlanVersion:1,actionDigest:plan.body.actionDigest,decision:"reject"});
 assert.equal(reject.status,200);
 assert.equal((await call("GET",base+"/recovery")).body.canReplan,true);
 const revised=await call("POST",base+"/replan",{requestId:"safe-replan",expectedPlanVersion:1,
  expectedProjectRevision:1});
 assert.equal(revised.status,200,JSON.stringify(revised.body));
 assert.equal(revised.body.activePlanVersion,2);
 assert.equal((await call("POST",base+"/replan",{requestId:"safe-replan",expectedPlanVersion:1,
  expectedProjectRevision:1})).body.existing,true);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
 assert.equal((await call("GET",base)).body.task.status,"planning");
});
