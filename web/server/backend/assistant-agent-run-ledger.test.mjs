import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn} from "./assistant-tasks.mjs";
import {beginAssistantModelCommand,createAssistantModelObserver,
 completeAssistantModelCommand,failAssistantModelCommand,recoverAssistantModelCallsAtStartup} from "./assistant-model-calls.mjs";
import {agentReadRunId,listAssistantAgentRuns,inspectAssistantAgentRun,
 readAgentRunOwnership} from "./assistant-agent-run-ledger.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {buildApp} from "./app.mjs";

const secret="隐藏画布文本，禁止外发的测试剧本内容。".repeat(10);
const policy={includeContext:true,scope:"selection",includedIds:["selected"]};
const text="请查找画布里的角色节点并概括文本内容";
const dataNode=(id,title,content)=>({id,type:"text",title,position:{x:0,y:0},
 width:320,height:200,metadata:{content}});
function fixture(t,{file=false}={}){
 let path,folder;
 if(file){folder=mkdtempSync(join(tmpdir(),"p42b-"));path=join(folder,"db.sqlite");}
 const db=new DatabaseSync(path??":memory:");initializeSchema(db);
 t.after(()=>{db.close();if(folder)rmSync(folder,{recursive:true,force:true})});
 createProject(db,{id:"p",document:{nodes:[
  dataNode("selected","小兔角色卡","小兔穿蓝色斗篷，乐于帮助同伴。"),
  dataNode("secret","私密剧本",secret)
 ],connections:[]}});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat1",
  rootMessageId:"root",originalRequest:"检查角色信息",requestId:"create-task"}).task;
 appendAssistantTaskTurn(db,{projectId:"p",taskId:task.id,requestId:"turn",
  messageId:"current",text,contextPolicy:policy});
 const requestId="p42b-request";
 const payload={agentReadTools:true,task:{taskId:task.id,turnMessageId:"current",requestId},
  provider:"openai_compatible",model:"mock",canvasActions:false};
 const start=(id=requestId)=>beginAssistantModelCommand(db,{projectId:"p",taskId:task.id,
  requestId:id,requestPayload:{...payload,task:{...payload.task,requestId:id}}});
 const observer=(id=requestId)=>createAssistantModelObserver(db,{projectId:"p",taskId:task.id,
  requestId:id,provider:"openai_compatible",model:"mock"});
 const runs=()=>listAssistantAgentRuns(db,{projectId:"p",taskId:task.id});
 const inspect=(runId=agentReadRunId("p",task.id,requestId),opts={})=>
  inspectAssistantAgentRun(db,{projectId:"p",taskId:task.id,runId,...opts});
 return {db,path,task,requestId,payload,start,observer,runs,inspect};
}
const modelResponse=(message)=>({choices:[{message:{role:"assistant",content:message},
 finish_reason:"stop"}]});
test("P4.2b stable Run ID, no Schema migration and only Task-backed runs",t=>{
 const f=fixture(t);
 assert.equal(SCHEMA_VERSION,32);
 assert.equal(f.runs().runs.length,0);
 const id=agentReadRunId("p",f.task.id,f.requestId);
 assert.equal(id,agentReadRunId("p",f.task.id,f.requestId));
 assert.match(id,/^ar_[a-f0-9]{40}$/);
 f.db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,'agent_run_started',?,?)")
  .run(f.task.id,JSON.stringify({runId:"ar_forged",requestId:"forged"}),Date.now());
 assert.equal(f.runs().runs.length,0,"forged event cannot create a valid Run");
 f.start();
 assert.equal(f.runs().runs[0].runId,id);
 assert.equal(f.runs().runs[0].status,"planning");
 assert.deepEqual(f.inspect().transcript.map(e=>e.type),["agent_run_started"]);
 assert.equal(f.inspect().run.completesTask,false);
});
test("P4.2b model response and Run completion are transacted with canonical command",t=>{
 const f=fixture(t);f.start();
 const o=f.observer(),callId=o.start({kind:"initial",requestDigest:"a".repeat(64)});
 const response=modelResponse(secret);
 o.success(callId,response);
 let run=f.inspect();
 assert.equal(run.run.status,"reading");
 assert.equal(run.modelCalls.length,1);
 assert.ok(run.transcript.some(e=>e.type==="agent_run_model_received"&&
  e.data.resultDigest.length===64));
 assert.ok(!JSON.stringify(run).includes(secret),"transcript only stores trusted metadata/digests");
 completeAssistantModelCommand(f.db,{projectId:"p",taskId:f.task.id,requestId:f.requestId,
  response:{model:"mock",answer:"角色已查阅"}});
 run=f.inspect();
 assert.equal(run.run.status,"completed");
 assert.equal(run.run.recovery,"cached_result_only");
 assert.equal(run.run.modelPosts,1);
 assert.equal(run.run.completesTask,false);
 assert.ok(run.transcript.some(e=>e.type==="agent_run_completed"));
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks WHERE id=?").get(f.task.id).status,"planning");
});
test("P4.2b Run transcript is seq-paginated with no unapproved raw model data",t=>{
 const f=fixture(t);f.start();
 const o=f.observer(),id=o.start({kind:"initial",requestDigest:"a".repeat(64)});
 o.success(id,modelResponse(secret));
 completeAssistantModelCommand(f.db,{projectId:"p",taskId:f.task.id,requestId:f.requestId,
  response:{answer:"最终文本"}});
 const one=f.inspect(undefined,{limit:1});
 assert.equal(one.transcript.length,1);
 assert.equal(one.hasMore,true);
 const two=f.inspect(undefined,{limit:20,afterSeq:one.nextAfterSeq});
 assert.ok(two.transcript.length>=2);
 assert.ok(two.transcript.every(e=>e.seq>one.nextAfterSeq));
 assert.ok(!JSON.stringify([...one.transcript,...two.transcript]).includes(secret));
});
test("P4.2b a fault inserting completed Run rolls back ModelCommand completion",t=>{
 const f=fixture(t);f.start();
 const o=f.observer(),id=o.start({kind:"initial",requestDigest:"b".repeat(64)});
 o.success(id,modelResponse("已经收到"));
 f.db.exec(`CREATE TEMP TRIGGER reject_run_complete BEFORE INSERT ON assistant_task_events
 WHEN NEW.kind='agent_run_completed' BEGIN SELECT RAISE(ABORT,'fault_run_complete'); END`);
 assert.throws(()=>completeAssistantModelCommand(f.db,{projectId:"p",
  taskId:f.task.id,requestId:f.requestId,response:{answer:"回复成功"}}),/fault_run_complete/);
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_commands WHERE request_id=?").get(f.requestId).status,"in_progress");
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='model_command_completed'").get().n,0);
 assert.equal(f.inspect().run.status,"reading");
 f.db.exec("DROP TRIGGER reject_run_complete");
});
test("P4.2b model received event failure rolls back ModelCall success",t=>{
 const f=fixture(t);f.start();
 const o=f.observer(),id=o.start({kind:"initial",requestDigest:"c".repeat(64)});
 f.db.exec(`CREATE TEMP TRIGGER reject_received BEFORE INSERT ON assistant_task_events
 WHEN NEW.kind='agent_run_model_received' BEGIN SELECT RAISE(ABORT,'fault_received'); END`);
 assert.throws(()=>o.success(id,modelResponse("收到")),/fault_received/);
 assert.equal(f.db.prepare("SELECT status FROM assistant_model_calls WHERE id=?").get(id).status,"submitting");
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='model_call_succeeded'").get().n,0);
 f.db.exec("DROP TRIGGER reject_received");
});
test("P4.2b ambiguous model POST never auto-replays and blocks new Task inference",t=>{
 const f=fixture(t);f.start();
 const o=f.observer(),id=o.start({kind:"initial",requestDigest:"d".repeat(64)});
 o.failure(id,"assistant_upstream_timeout",true);
 failAssistantModelCommand(f.db,{projectId:"p",taskId:f.task.id,requestId:f.requestId});
 assert.equal(f.inspect().run.status,"needs_reconcile");
 assert.equal(f.inspect().run.recovery,"manual_reconciliation_required");
 assert.equal(f.inspect().run.unknownModelPosts,1);
 assert.throws(()=>f.start("other-request"),{code:"assistant_agent_run_needs_reconcile"});
 assert.throws(()=>f.start(),{code:"assistant_model_call_unknown"});
});
test("P4.2b model succeeded but command not saved: startup blocks replay conservatively",t=>{
 const f=fixture(t);f.start();
 const o=f.observer(),id=o.start({kind:"initial",requestDigest:"e".repeat(64)});
 o.success(id,modelResponse("收到"));
 const recovery=recoverAssistantModelCallsAtStartup(f.db);
 assert.equal(recovery.commandsMarkedUnknown,1);
 assert.equal(f.inspect().run.status,"needs_reconcile");
 assert.ok(f.inspect().transcript.some(e=>e.type==="agent_run_needs_reconcile"));
 assert.throws(()=>f.start("other-request"),{code:"assistant_agent_run_needs_reconcile"});
});
test("P4.2b crash while submitting marks ModelCall and Run unknown, no duplicate inference",t=>{
 const f=fixture(t);f.start();
 f.observer().start({kind:"initial",requestDigest:"a".repeat(64)});
 const recovered=recoverAssistantModelCallsAtStartup(f.db);
 assert.equal(recovered.callsMarkedUnknown,1);
 assert.equal(f.inspect().run.status,"needs_reconcile");
 assert.throws(()=>f.start("new-request"),{code:"assistant_agent_run_needs_reconcile"});
});
test("P4.2b pre-submit failures release command and permit same stable identity",t=>{
 const f=fixture(t);f.start();
 failAssistantModelCommand(f.db,{projectId:"p",taskId:f.task.id,requestId:f.requestId});
 assert.equal(f.runs().runs.length,0);
 f.start();
 assert.equal(f.runs().runs.length,1);
 assert.equal(f.runs().runs[0].runId,agentReadRunId("p",f.task.id,f.requestId));
});
test("P4.2b second SQLite connection cannot acquire a live Task Run",t=>{
 const f=fixture(t,{file:true});const db2=new DatabaseSync(f.path);
 try{
  initializeSchema(db2);
  f.start();
  const otherPayload={...f.payload,task:{...f.payload.task,requestId:"other-tab"}};
  assert.throws(()=>beginAssistantModelCommand(db2,{projectId:"p",taskId:f.task.id,
   requestId:"other-tab",requestPayload:otherPayload}),{code:"assistant_agent_read_busy"});
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls").get().n,0);
 }finally{db2.close()}
});
test("P4.2b persisted Run is visible from a fresh SQLite connection",t=>{
 const f=fixture(t,{file:true});f.start();
 const db2=new DatabaseSync(f.path);
 try{
  initializeSchema(db2);
  const run=listAssistantAgentRuns(db2,{projectId:"p",taskId:f.task.id}).runs[0];
  assert.equal(run.runId,agentReadRunId("p",f.task.id,f.requestId));
  assert.equal(run.status,"planning");
 }finally{db2.close()}
});
test("P4.2b archives can display transcript but cannot authorize execution",t=>{
 const f=fixture(t);f.start();
 f.db.prepare("UPDATE assistant_tasks SET read_only=1 WHERE id=?").run(f.task.id);
 assert.equal(f.inspect().run.readOnly,true);
 assert.throws(()=>f.start("new-request"),{code:"assistant_task_not_editable"});
});
test("P4.2b HTTP Run list/detail is Task-specific, paged and cache-safe",async t=>{
 const f=fixture(t);
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_v,cb)=>cb(Buffer.from("mock-key"))};
 let posts=0;
 const chat=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  posts++;return new Response(JSON.stringify(modelResponse("已检查小兔角色卡")),{status:200});
 }});
 const app=buildApp({db:f.db,assistantChat:chat,authorize:()=>true});t.after(()=>app.close());
 const target="/api/v1/projects/p/assistant/tasks/"+f.task.id;
 const sent={channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
  model:"mock",canvasActions:false,agentReadTools:true,messages:[{role:"user",content:text}],
  task:{taskId:f.task.id,turnMessageId:"current",requestId:f.requestId}};
 const response=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:sent});
 assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().agentRunId,agentReadRunId("p",f.task.id,f.requestId));
 assert.equal(posts,1);
 const list=await app.inject({method:"GET",url:target+"/agent-runs"});
 assert.equal(list.statusCode,200,list.body);
 assert.equal(list.json().runs[0].status,"completed");
 const detail=await app.inject({method:"GET",url:target+"/agent-runs/"+response.json().agentRunId+"?limit=1"});
 assert.equal(detail.statusCode,200,detail.body);
 assert.equal(detail.json().hasMore,true);
 const next=await app.inject({method:"GET",url:target+"/agent-runs/"+response.json().agentRunId+
  "?afterSeq="+detail.json().nextAfterSeq});
 assert.equal(next.statusCode,200,next.body);
 assert.ok(!JSON.stringify(next.json()).includes(secret));
 assert.equal((await app.inject({method:"GET",url:target+"/agent-runs/ar_invalid"})).statusCode,404);
 const replay=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:sent});
 assert.equal(replay.statusCode,200);assert.equal(posts,1);
});

test("P4.2b a preflight release event failure rolls back command deletion",t=>{
 const f=fixture(t);f.start();
 f.db.exec("CREATE TEMP TRIGGER reject_release BEFORE INSERT ON assistant_task_events "+
  "WHEN NEW.kind='agent_run_preflight_released' BEGIN SELECT RAISE(ABORT,'fault_release'); END");
 assert.throws(()=>failAssistantModelCommand(f.db,{projectId:"p",
  taskId:f.task.id,requestId:f.requestId}),/fault_release/);
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_commands WHERE request_id=?")
  .get(f.requestId).status,"in_progress");
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='agent_run_preflight_released'").get().n,0);
 f.db.exec("DROP TRIGGER reject_release");
 failAssistantModelCommand(f.db,{projectId:"p",taskId:f.task.id,requestId:f.requestId});
 assert.equal(f.runs().runs.length,0);
});
test("P4.2b unknown HTTP model POST blocks a different request ID before Provider",async t=>{
 const f=fixture(t);
 let posts=0;
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_v,cb)=>cb(Buffer.from("mock-key"))};
 const chat=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  posts++;throw new Error("simulated_network_drop_after_submission");
 }});
 const app=buildApp({db:f.db,assistantChat:chat,authorize:()=>true});t.after(()=>app.close());
 const base={channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
  model:"mock",canvasActions:false,agentReadTools:true,
  messages:[{role:"user",content:text}]};
 const url="/api/v1/projects/p/assistant/chat";
 const one=await app.inject({method:"POST",url,payload:{...base,
  task:{taskId:f.task.id,turnMessageId:"current",requestId:"first-unknown"}}});
 assert.equal(one.statusCode,409,one.body);
 assert.equal(one.json().code,"assistant_model_call_unknown");
 const two=await app.inject({method:"POST",url,payload:{...base,
  task:{taskId:f.task.id,turnMessageId:"current",requestId:"second-different"}}});
 assert.equal(two.statusCode,409,two.body);
 assert.equal(two.json().code,"assistant_agent_run_needs_reconcile");
 assert.equal(posts,1,"unknown first POST must not be implicitly reissued with another identity");
});

test("P4.2b actual POST budget also includes format repair rounds",t=>{
 const f=fixture(t);f.start();
 const o=f.observer();
 for(let i=0;i<3;i++){
  const callId=o.start({kind:i===2?"format_repair":"initial",
   requestDigest:String(i).repeat(64)});
  o.success(callId,modelResponse("模型完成第 "+i+" 次请求"));
 }
 assert.throws(()=>o.start({kind:"format_repair",requestDigest:"f".repeat(64)}),{
  code:"assistant_agent_model_budget_exceeded"});
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls WHERE request_id=?")
  .get(f.requestId).n,3);
 assert.equal(f.inspect().run.modelPosts,3);
});
