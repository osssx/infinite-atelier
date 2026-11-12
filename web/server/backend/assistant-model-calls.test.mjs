import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {createAssistantTask,appendAssistantTaskTurn} from "./assistant-tasks.mjs";
import {beginAssistantModelCommand,createAssistantModelObserver,
 completeAssistantModelCommand,listAssistantModelCalls,recoverAssistantModelCallsAtStartup} from "./assistant-model-calls.mjs";

const credential="private-test-provider-key";
const vault={
 get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
 withSecretVersion:(_version,cb)=>cb(Buffer.from(credential))
};
const answer=text=>new Response(JSON.stringify({choices:[{message:{content:text},finish_reason:"stop"}]}),
 {status:200,headers:{"content-type":"application/json"}});
const secret="SECRET_CANVAS_NODE_TEXT_DO_NOT_SEND";
const doc={nodes:[
 {id:"visible",type:"text",title:"展示节点",metadata:{content:"公开剧情内容"}},
 {id:"private",type:"text",title:"隐私节点",metadata:{content:secret}}
],connections:[]};
async function fixture(t,network,{includeContext=false,scope="selection",includedIds=[]}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const service=createAssistantChatService({vault,retryDelayMs:0,compatibleUpstreamCall:network});
 const app=buildApp({db,authorize:()=>true,assistantChat:service});
 t.after(async()=>{await app.close();db.close();});
 const call=async(method,url,payload)=>{
  const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});
  return {status:response.statusCode,body:response.json()};
 };
 const projectId="p-model";
 assert.equal((await call("POST","/api/v1/projects",{id:projectId,document:doc})).status,201);
 const task=createAssistantTask(db,{projectId,chatSessionId:"chat-a",rootMessageId:"root-msg",
  requestId:"create-task",originalRequest:"请完成已有节点的创作任务",
  contextPolicy:{includeContext,scope,includedIds}});
 const taskId=task.task.id,base="/api/v1/projects/"+projectId;
 appendAssistantTaskTurn(db,{projectId,taskId,requestId:"turn-initial",messageId:"source-turn",text:"继续",
  contextPolicy:{includeContext,scope,includedIds}});
 const payload=(requestId="model-request",text="继续")=>({
  channelId:"channel-a",provider:"openai_compatible",model:"demo",baseUrl:"http://localhost:8080/v1",
  canvasActions:false,task:{taskId,turnMessageId:"source-turn",requestId},
  messages:[{role:"user",content:"过期历史："+secret},
   {role:"assistant",content:"缓存中的私有内容："+secret},
   {role:"user",content:text}]
 });
 return {db,app,call,taskId,base,payload};
}
test("P0b task model calls persist before POST, replay same command, and only send selected context",async t=>{
 let calls=0,body;
 const fx=await fixture(t,async(_url,options)=>{
  calls++;body=JSON.parse(options.body);
  return answer("任务提示已收到");
 },{includeContext:true,scope:"selection",includedIds:["visible"]});
 assert.equal(SCHEMA_VERSION,25);
 const path=fx.base+"/assistant/chat",req=fx.payload();
 const first=await fx.call("POST",path,req);
 assert.equal(first.status,200,JSON.stringify(first.body));
 assert.equal(first.body.answer,"任务提示已收到");
 const combined=JSON.stringify(body);
 assert.match(combined,/公开剧情内容|展示节点/);
 assert.match(combined,/原始任务要求/);
 assert.doesNotMatch(combined,/SECRET_CANVAS_NODE_TEXT_DO_NOT_SEND|隐私节点|过期历史/);
 const repeated=await fx.call("POST",path,req);
 assert.equal(repeated.status,200);
 assert.deepEqual(repeated.body,first.body);
 assert.equal(calls,1,"same command must not result in a second upstream POST");
 const altered=await fx.call("POST",path,{...req,messages:[{role:"user",content:"换掉指令"}]});
 assert.equal(altered.status,409);
 assert.equal(altered.body.code,"assistant_task_command_conflict");
 const row=fx.db.prepare("SELECT status,call_kind,submit_marker,request_digest FROM assistant_model_calls").get();
 assert.equal(row.status,"succeeded");assert.equal(row.call_kind,"initial");
 assert.ok(row.submit_marker&&row.request_digest.length===64);
 assert.equal(fx.db.prepare("SELECT status FROM assistant_task_commands WHERE request_id='model-request'").get().status,"completed");
 assert.doesNotMatch(JSON.stringify(listAssistantModelCalls(fx.db,{projectId:"p-model",taskId:fx.taskId})),/private-test-provider-key|SECRET_CANVAS/);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
});
test("P0b concurrent duplicate commands cannot start a second upstream call",async t=>{
 let release=()=>{},entered=()=>{},calls=0;
 const arrived=new Promise(resolve=>{entered=resolve});
 const gate=new Promise(resolve=>{release=resolve});
 const fx=await fixture(t,async()=>{
  calls++;entered();await gate;return answer("一致的回复");
 });
 const body=fx.payload("same-concurrent"),path=fx.base+"/assistant/chat";
 const firstPromise=fx.call("POST",path,body);
 await arrived;
 const second=await fx.call("POST",path,body);
 assert.equal(second.status,409);
 assert.equal(second.body.code,"assistant_model_call_in_progress");
 assert.equal(calls,1);
 release();
 const first=await firstPromise;
 assert.equal(first.status,200,JSON.stringify(first.body));
 assert.equal((await fx.call("POST",path,body)).body.answer,"一致的回复");
 assert.equal(calls,1);
});
test("P0b duplicate result remains readable after cancellation without a fresh provider POST",async t=>{
 let calls=0;
 const fx=await fixture(t,async()=>{calls++;return answer("已有结果");});
 const payload=fx.payload("saved-before-cancel"),path=fx.base+"/assistant/chat";
 assert.equal((await fx.call("POST",path,payload)).status,200);
 assert.equal((await fx.call("POST",fx.base+"/assistant/tasks/"+fx.taskId+"/cancel",{requestId:"cancel-now"})).status,200);
 const replay=await fx.call("POST",path,payload);
 assert.equal(replay.status,200,JSON.stringify(replay.body));
 assert.equal(replay.body.answer,"已有结果");
 assert.equal(calls,1);
 const newRequest=await fx.call("POST",path,fx.payload("new-after-cancel"));
 assert.equal(newRequest.status,409);
 assert.equal(newRequest.body.code,"assistant_task_not_editable");
 assert.equal(calls,1);
});

test("P0b model transport rejection after upstream receives POST is ambiguous; no retry",async t=>{
 let calls=0;
 const fx=await fixture(t,async()=>{
  calls++;throw Object.assign(Error("accepted-but-reply-lost"),{code:"ECONNRESET"});
 });
 const req=fx.payload(),path=fx.base+"/assistant/chat";
 const response=await fx.call("POST",path,req);
 assert.equal(response.status,409,JSON.stringify(response.body));
 assert.equal(response.body.code,"assistant_model_call_unknown");
 assert.equal(calls,1);
 assert.equal(fx.db.prepare("SELECT status FROM assistant_model_calls").get().status,"needs_reconcile");
 assert.equal(fx.db.prepare("SELECT status FROM assistant_task_commands WHERE request_id=?").get(req.task.requestId).status,"needs_reconcile");
 assert.equal((await fx.call("POST",path,req)).status,409);
 assert.equal(calls,1);
 const callList=await fx.call("GET",fx.base+"/assistant/tasks/"+fx.taskId+"/model-calls");
 assert.equal(callList.status,200);
 assert.equal(callList.body.calls.length,1);
 assert.equal(callList.body.calls[0].status,"needs_reconcile");
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls").get().n,1);
});
test("P0b upstream 500 is unresolved and never transport-retried",async t=>{
 let calls=0;
 const fx=await fixture(t,async()=>{calls++;return new Response("server error",{status:500});});
 const result=await fx.call("POST",fx.base+"/assistant/chat",fx.payload("gateway-500"));
 assert.equal(result.status,409,JSON.stringify(result.body));
 assert.equal(result.body.code,"assistant_model_call_unknown");
 assert.equal(calls,1);
 assert.equal(fx.db.prepare("SELECT status FROM assistant_model_calls").get().status,"needs_reconcile");
});
test("P0b gateway timeout is not automatically retried for linked tasks",async t=>{
 let count=0;
 const fx=await fixture(t,async()=>{count++;return new Response("Timeout",{status:504});});
 const result=await fx.call("POST",fx.base+"/assistant/chat",fx.payload());
 assert.equal(result.status,409);
 assert.equal(result.body.code,"assistant_model_call_unknown");
 assert.equal(count,1);
});
test("P0b no context uses only goal/current request; overview shows titles but not node bodies",async t=>{
 const captured=[];
 const fx=await fixture(t,async(_url,options)=>{
  captured.push(JSON.stringify(JSON.parse(options.body)));
  return answer("已回复");
 });
 const path=fx.base+"/assistant/chat";
 assert.equal((await fx.call("POST",path,fx.payload("closed"))).status,200);
 assert.doesNotMatch(captured[0],/公开剧情内容|隐私节点|展示节点|SECRET_CANVAS/);
 appendAssistantTaskTurn(fx.db,{projectId:"p-model",taskId:fx.taskId,requestId:"turn-overview",
  messageId:"overview-turn",text:"继续",contextPolicy:{includeContext:true,scope:"overview",includedIds:[]}});
 const overview=fx.payload("overview");overview.task.turnMessageId="overview-turn";
 assert.equal((await fx.call("POST",path,overview)).status,200);
 assert.match(captured[1],/展示节点/);
 assert.doesNotMatch(captured[1],/公开剧情内容|SECRET_CANVAS/);
});
test("P0b a later tab changing Task defaults cannot expand a frozen turn's provider scope",async t=>{
 let outbound="";
 const fx=await fixture(t,async(_url,options)=>{outbound=options.body;return answer("已收到");},
  {includeContext:false,scope:"selection",includedIds:[]});
 fx.db.prepare("UPDATE assistant_tasks SET context_policy_json=? WHERE id=?")
  .run(JSON.stringify({includeContext:true,scope:"overview",includedIds:[]}),fx.taskId);
 const result=await fx.call("POST",fx.base+"/assistant/chat",fx.payload("frozen-policy"));
 assert.equal(result.status,200,JSON.stringify(result.body));
 assert.doesNotMatch(outbound,/展示节点|隐私节点|公开剧情内容|SECRET_CANVAS/);
 const callBefore=fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls").get().n;
 const missing=fx.payload("missing-turn");missing.task.turnMessageId="not-registered";
 const denied=await fx.call("POST",fx.base+"/assistant/chat",missing);
 assert.equal(denied.status,409);
 assert.equal(denied.body.code,"assistant_task_turn_not_found");
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls").get().n,callBefore);
});

test("P0b format correction is a separately journaled model call, not a network retry",async t=>{
 let count=0;
 const fx=await fixture(t,async()=>{
  count++;
  return answer(count===1?"我将创建一个新节点，并连接现有节点。":
   JSON.stringify({answer:"已形成计划",actions:[
    {type:"create_node",ref:"new",nodeType:"text",title:"分镜",content:"第一幕"},
    {type:"connect",from:"visible",to:"new"}
   ]}));
 },{includeContext:true,scope:"selection",includedIds:["visible"]});
 const req=fx.payload("repair","创建一个分镜节点并连接到已有节点");
 req.canvasActions=true;
 const response=await fx.call("POST",fx.base+"/assistant/chat",req);
 assert.equal(response.status,200,JSON.stringify(response.body));
 assert.equal(response.body.formatRepairCount,1);
 assert.equal(count,2);
 const rows=fx.db.prepare("SELECT call_kind,status,call_index,parent_call_id FROM assistant_model_calls ORDER BY call_index").all();
 assert.deepEqual(rows.map(row=>row.call_kind),["initial","format_repair"]);
 assert.deepEqual(rows.map(row=>row.status),["succeeded","succeeded"]);
 assert.ok(rows[1].parent_call_id);
});
test("P0b legitimate read-only Skill rounds have separate identities",async t=>{
 const fx=await fixture(t,async()=>answer("unused"));
 const req=fx.payload("tool-round");
 beginAssistantModelCommand(fx.db,{projectId:"p-model",taskId:fx.taskId,requestId:"manual-tool",
  requestPayload:{taskId:fx.taskId,requestId:"manual-tool"}});
 const observer=createAssistantModelObserver(fx.db,{projectId:"p-model",taskId:fx.taskId,requestId:"manual-tool",
  provider:"openai_compatible",model:"demo"});
 const skill={id:"story",name:"编剧",description:"镜头知识",version:"a".repeat(12),
  skillMd:"先查资料",resources:{"references/a.md":"引用资料 A"},scripts:{}};
 const toolCall=(id,name,value)=>({id,type:"function",function:{name,arguments:JSON.stringify(value)}});
 let count=0;
 const assistant=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  count++;
  if(count===1)return new Response(JSON.stringify({choices:[{finish_reason:"tool_calls",
   message:{content:null,tool_calls:[toolCall("tool-1","search_skills",{query:"镜头"})]}}]}));
  return answer("已理解参考资料");
 }});
 const result=await assistant({channelId:"channel-a",provider:"openai_compatible",model:"demo",
  baseUrl:"http://localhost:8080/v1",messages:[{role:"user",content:"参考技能规划镜头"}],
  skillTools:[skill],callObserver:observer});
 assert.equal(result.answer,"已理解参考资料");
 assert.equal(count,2);
 const rows=fx.db.prepare("SELECT call_kind,status FROM assistant_model_calls WHERE request_id='manual-tool' ORDER BY call_index").all();
 assert.deepEqual(rows.map(row=>row.call_kind),["initial","skill_tool_round"]);
 assert.deepEqual(rows.map(row=>row.status),["succeeded","succeeded"]);
 completeAssistantModelCommand(fx.db,{projectId:"p-model",taskId:fx.taskId,
  requestId:"manual-tool",response:result});
});
test("P0b startup reconciliation never replays marked submissions and releases only pre-submit intents",async t=>{
 const fx=await fixture(t,async()=>answer("ok"));
 beginAssistantModelCommand(fx.db,{projectId:"p-model",taskId:fx.taskId,requestId:"crashed-after-marker",
  requestPayload:{case:"submitted"}});
 const observer=createAssistantModelObserver(fx.db,{projectId:"p-model",taskId:fx.taskId,
  requestId:"crashed-after-marker",provider:"openai_compatible",model:"demo"});
 observer.start({kind:"initial",requestDigest:"a".repeat(64)});
 beginAssistantModelCommand(fx.db,{projectId:"p-model",taskId:fx.taskId,requestId:"crashed-before-marker",
  requestPayload:{case:"preflight"}});
 const before=fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls WHERE status='submitting'").get().n;
 assert.equal(before,1);
 const recovered=recoverAssistantModelCallsAtStartup(fx.db);
 assert.deepEqual(recovered,{callsMarkedUnknown:1,commandsMarkedUnknown:1,unsubmittedCommandsReleased:1});
 assert.equal(fx.db.prepare("SELECT status FROM assistant_model_calls").get().status,"needs_reconcile");
 const cmd=fx.db.prepare("SELECT status FROM assistant_task_commands WHERE request_id='crashed-after-marker'").get();
 assert.equal(cmd.status,"needs_reconcile");
 assert.equal(fx.db.prepare("SELECT 1 FROM assistant_task_commands WHERE request_id='crashed-before-marker'").get(),undefined);
 assert.deepEqual(recoverAssistantModelCallsAtStartup(fx.db),{
  callsMarkedUnknown:0,commandsMarkedUnknown:0,unsubmittedCommandsReleased:0});
 assert.throws(()=>beginAssistantModelCommand(fx.db,{projectId:"p-model",taskId:fx.taskId,
  requestId:"crashed-after-marker",requestPayload:{case:"submitted"}}),{code:"assistant_model_call_unknown"});
});

test("P0b v24 to v25 migration preserves Task records and creates call audit table",()=>{
 const db=new DatabaseSync(":memory:");
 try{
  initializeSchema(db);
  db.prepare("INSERT INTO projects(id,document_json,revision) VALUES('legacy','{}',5)").run();
  db.exec("DROP TABLE assistant_model_calls");
  db.prepare("DELETE FROM schema_migrations WHERE version=25").run();
  db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(24,1)").run();
  initializeSchema(db);
  assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,25);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='assistant_model_calls'").get());
  assert.equal(db.prepare("SELECT revision FROM projects WHERE id='legacy'").get().revision,5);
 }finally{db.close()}
});
