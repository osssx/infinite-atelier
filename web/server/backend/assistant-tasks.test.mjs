import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {addAssistantTaskStep} from "./assistant-tasks.mjs";

async function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const app=buildApp({db,authorize:()=>true});
 t.after(async()=>{await app.close();db.close()});
 const call=async(method,url,payload)=>{
  const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});
  return {status:response.statusCode,body:response.json(),headers:response.headers};
 };
 assert.equal((await call("POST","/api/v1/projects",{
  id:"task-project",document:{nodes:[],connections:[]}
 })).status,201);
 const base="/api/v1/projects/task-project/assistant/tasks";
 return {db,call,base};
}
const create=(requestId="c1")=>({requestId,chatSessionId:"chat-1",
 rootMessageId:"msg-1",originalRequest:"创建三个节点"});
test("P0a task persists guidance-only state without claiming execution",async t=>{
 const {db,call,base}=await setup(t);
 assert.equal(SCHEMA_VERSION,24);
 const made=await call("POST",base,create());
 assert.equal(made.status,201,made.body);
 assert.equal(made.body.task.status,"planning");
 assert.equal(made.body.task.recoveryMode,"guidance_only");
 assert.deepEqual(made.body.task.steps,[]);
 const taskId=made.body.task.id;
 const again=await call("POST",base,create());
 assert.equal(again.status,200,again.body);
 assert.equal(again.body.task.id,taskId);
 assert.equal(again.body.existing,true);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events").get().n,1);
 const altered=await call("POST",base,{...create(),originalRequest:"不同内容"});
 assert.equal(altered.status,409);
 assert.equal(altered.body.code,"assistant_task_command_conflict");
 const changedRoot=await call("POST",base,{...create("different-command"),originalRequest:"新的根任务内容"});
 assert.equal(changedRoot.status,409);
 const sameRoot=(await call("POST",base,create("another-request-id")));
 assert.equal(sameRoot.status,200);
 assert.equal(sameRoot.body.task.id,taskId);
 const list=await call("GET",base+"?chatSessionId=chat-1");
 assert.equal(list.status,200);
 assert.equal(list.body.tasks.length,1);
 assert.equal((await call("GET",base+"?chatSessionId=other")).body.tasks.length,0);
 const detail=await call("GET",base+"/"+taskId);
 assert.equal(detail.body.task.lastSeq,1);
 assert.equal(detail.headers["cache-control"],"no-store");
});
test("P0a user turns, client observations and event cursors are idempotent",async t=>{
 const {db,call,base}=await setup(t);
 const taskId=(await call("POST",base,create())).body.task.id,path=base+"/"+taskId;
 const turn={requestId:"turn1",messageId:"user-turn1",text:"继续",
  contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}};
 const one=await call("POST",path+"/turns",turn);
 assert.equal(one.status,200,one.body);
 assert.equal(one.body.task.status,"planning");
 assert.equal(one.body.task.contextPolicy.includeContext,false);
 assert.equal((await call("POST",path+"/turns",turn)).body.existing,true);
 assert.equal((await call("POST",path+"/turns",{...turn,text:"修改"})).status,409);
 const failed=await call("POST",path+"/observations",
  {requestId:"err1",kind:"error",preview:"Skill 退出 9009"});
 assert.equal(failed.status,200);
 assert.equal(failed.body.task.lastError,"Skill 退出 9009");
 const success=await call("POST",path+"/observations",
  {requestId:"reply1",kind:"reply",preview:"已解释失败原因，尚未重跑"});
 assert.equal(success.status,200);
 assert.equal(success.body.task.lastError,null);
 assert.equal((await call("POST",path+"/resume",{requestId:"resume-1"})).body.executionStarted,false);
 assert.equal((await call("POST",path+"/resume",{requestId:"resume-1"})).body.existing,true);
 const events1=await call("GET",path+"/events?afterSeq=0&limit=2");
 assert.equal(events1.body.events.length,2);assert.equal(events1.body.hasMore,true);
 const events2=await call("GET",path+"/events?afterSeq="+events1.body.nextSeq+"&limit=10");
 assert.deepEqual(events2.body.events.map(item=>item.kind),
  ["client_reported_error","client_reported_reply","guidance_resume_requested"]);
 assert.equal(events2.body.hasMore,false);
 assert.equal((await call("GET",path)).body.task.lastSeq,5);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM skill_script_runs").get().n,0);
});
test("P0a only internal planner may add pending steps; cancellation prevents new turns and resume",async t=>{
 const {db,call,base}=await setup(t);
 const taskId=(await call("POST",base,create())).body.task.id;
 const task=addAssistantTaskStep(db,{projectId:"task-project",taskId,kind:"canvas_mutation",ordinal:0,
  action:{type:"create_node",ref:"planned"}});
 assert.equal(task.steps.length,1);
 assert.equal(task.steps[0].status,"pending");
 assert.equal(task.steps[0].receiptTrust,"none");
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,0);
 const path=base+"/"+taskId;
 const cancelled=await call("POST",path+"/cancel",{requestId:"cancel1"});
 assert.equal(cancelled.body.task.status,"cancelled");
 assert.equal((await call("POST",path+"/cancel",{requestId:"cancel2"})).body.task.status,"cancelled");
 assert.equal((await call("POST",path+"/turns",
  {requestId:"turn-after-cancel",messageId:"msg-later",text:"继续"})).status,409);
 assert.equal((await call("POST",path+"/resume",{requestId:"resume-cancelled"})).status,409);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
});
test("P0a project isolation, deleted projects and unknown context fields are handled safely",async t=>{
 const {call,base}=await setup(t);
 const made=(await call("POST",base,create())).body.task.id;
 const other=await call("POST","/api/v1/projects",{id:"another",document:{nodes:[],connections:[]}});
 assert.equal(other.status,201);
 assert.equal((await call("GET","/api/v1/projects/another/assistant/tasks/"+made)).status,404);
 const sanitized=await call("POST",base,{...create("bad"),
  contextPolicy:{includeContext:true,scope:"overview",includedIds:[],apiKey:"do-not-echo"}});
 // Fastify strips unknown keys before the repository can see them.
 assert.equal(sanitized.status,200);
 assert.equal(sanitized.body.task.contextPolicy.apiKey,undefined);
 assert.doesNotMatch(JSON.stringify(sanitized.body),/do-not-echo/);
 assert.equal((await call("GET",base+"/"+made+"/events?afterSeq=-3")).status,400);
 assert.equal((await call("DELETE","/api/v1/projects/task-project")).status,200);
 assert.equal((await call("GET",base+"/"+made)).status,404);
});
test("P0a read-only tasks remain queryable but never accept new commands",async t=>{
 const {db,call,base}=await setup(t);
 const id=(await call("POST",base,create())).body.task.id,path=base+"/"+id;
 db.prepare("UPDATE assistant_tasks SET read_only=1 WHERE id=?").run(id);
 assert.equal((await call("GET",path)).body.task.readOnly,true);
 assert.equal((await call("POST",path+"/turns",
  {requestId:"read-only-turn",messageId:"later",text:"继续"})).status,409);
 assert.equal((await call("POST",path+"/observations",
  {requestId:"read-only-observe",kind:"error",preview:"失败"})).status,409);
 assert.equal((await call("POST",path+"/resume",{requestId:"read-only-resume"})).status,409);
 assert.equal((await call("POST",path+"/cancel",{requestId:"read-only-cancel"})).status,409);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE task_id=?").get(id).n,1);
});

test("v23 to v24 restores task tables without changing existing projects or chat sessions",()=>{
 const db=new DatabaseSync(":memory:");
 try{
  initializeSchema(db);
  db.prepare("INSERT INTO projects(id,document_json,revision) VALUES('legacy','{}',4)").run();
  db.prepare("DELETE FROM schema_migrations WHERE version=24").run();
  for(const table of ["assistant_task_commands","assistant_task_events","assistant_task_attempts","assistant_task_steps","assistant_tasks"])
   db.exec("DROP TABLE "+table);
  db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(23,1)").run();
  initializeSchema(db);
  assert.equal(db.prepare("SELECT revision FROM projects WHERE id='legacy'").get().revision,4);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,24);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='assistant_tasks'").get());
 }finally{db.close()}
});
