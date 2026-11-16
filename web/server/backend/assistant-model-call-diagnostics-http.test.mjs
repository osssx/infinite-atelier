import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {createProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn} from "./assistant-tasks.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {listAssistantModelCalls} from "./assistant-model-calls.mjs";

const key="sk-EXAMPLE_PRIVATE_TEST_TOKEN_123456789";
const canvasSecret="SECRET_NEIGHBOR_NODE_CONTENT_UNAUTHORIZED";
const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
 withSecretVersion:(_version,fn)=>fn(Buffer.from(key))};
let seq=0;
async function exercise(t,network,{requestTimeoutMs=1000}={}){
 const i=++seq,projectId="diag-project-"+i,db=new DatabaseSync(":memory:");
 initializeSchema(db);
 createProject(db,{id:projectId,document:{title:"diagnostic-test",nodes:[{
  id:"neighbor",type:"text",title:"private",metadata:{content:canvasSecret}
 }],connections:[]}});
 const task=createAssistantTask(db,{projectId,chatSessionId:"chat",
  rootMessageId:"root",requestId:"task",originalRequest:"continue quality review",
  contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}}).task;
 appendAssistantTaskTurn(db,{projectId,taskId:task.id,requestId:"turn",messageId:"current",
  text:"继续，不修改画布",contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}});
 let posts=0;
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(...args)=>{
  posts++;return network(...args)},maxRetries:0,requestTimeoutMs});
 const app=buildApp({db,authorize:()=>true,assistantChat:service});
 t.after(async()=>{await app.close();db.close()});
 const route="/api/v1/projects/"+projectId+"/assistant/chat";
 const payload={channelId:"online",provider:"openai_compatible",model:"test-model",
  baseUrl:"https://provider.example/v1",canvasActions:false,
  messages:[{role:"user",content:"继续，不修改画布"}],
  task:{taskId:task.id,turnMessageId:"current",requestId:"request"}};
 const first=await app.inject({method:"POST",url:route,payload});
 const audit=await app.inject({method:"GET",url:"/api/v1/projects/"+projectId+
  "/assistant/tasks/"+task.id+"/model-calls"});
 const calls=listAssistantModelCalls(db,{projectId,taskId:task.id}).calls;
 assert.equal(audit.statusCode,200,audit.body);
 assert.deepEqual(audit.json().calls,calls);
 const repeat=await app.inject({method:"POST",url:route,payload});
 return {first,audit,calls,repeat,posts,db,task};
}
const successfulAnswer=text=>new Response(JSON.stringify({choices:[{message:{content:text},finish_reason:"stop"}]}),
 {status:200});
const cases=[
 ["http_server_error",()=>new Response("private backend error",{status:503}),503,true],
 ["http_request_timeout",()=>new Response("slow gateway",{status:408}),408,true],
 ["http_rate_limited",()=>new Response("limit exceeded",{status:429}),429,false],
 ["http_auth_rejected",()=>new Response("bad token",{status:401}),401,false],
 ["http_client_rejected",()=>new Response("malformed request",{status:422}),422,false],
 ["response_parse_invalid",()=>new Response("{bad json",{status:200}),200,false],
 ["response_empty",()=>successfulAnswer(""),200,false],
 ["response_incomplete",()=>new Response(JSON.stringify({choices:[{finish_reason:"length",message:{content:"truncated"}}]}),{status:200}),200,false],
 ["transport_disconnected",()=>{const cause=Object.assign(Error("bad private URL"),{code:"ECONNRESET"});throw Object.assign(new TypeError("fetch failed "+key),{cause})},null,true],
 ["dns_resolution_failure",()=>{throw Object.assign(Error("private metadata target "+canvasSecret),{code:"ENOTFOUND"})},null,true]
];
for(const [category,network,status,uncertain] of cases){
 test("P4.9d real Task HTTP audit persists safe diagnostic: "+category,async t=>{
  const fx=await exercise(t,network);
  const expected=uncertain?"needs_reconcile":"failed";
  assert.equal(fx.posts,1);
  assert.equal(fx.calls.length,1);
  assert.equal(fx.calls[0].status,expected);
  assert.equal(fx.calls[0].diagnostic.category,category);
  assert.equal(fx.calls[0].diagnostic.httpStatus,status);
  assert.equal(fx.calls[0].diagnostic.phase,status===null?"await_response":"read_response");
  assert.equal(fx.first.statusCode,uncertain?409:502);
  assert.equal(fx.repeat.statusCode,409);
  assert.equal(fx.repeat.json().code,"assistant_model_call_unknown");
  assert.equal(fx.posts,1,"submitted requests must not be replayed automatically");
  const events=fx.db.prepare("SELECT payload_json FROM assistant_task_events WHERE task_id=? AND kind IN ('model_call_failed','model_call_needs_reconcile')").all(fx.task.id);
  assert.equal(events.length,1);
  assert.deepEqual(JSON.parse(events[0].payload_json).diagnostic,fx.calls[0].diagnostic);
  for(const serialized of [JSON.stringify(fx.calls),fx.audit.body,events[0].payload_json]){
   assert.doesNotMatch(serialized,/sk-EXAMPLE_PRIVATE_TEST_TOKEN|SECRET_NEIGHBOR|bad private URL|private metadata target|bad token|private backend error/);
  }
 });
}
test("P4.9d body timeout distinguishes read-response phase and never triggers another POST",async t=>{
 const stream=new ReadableStream({start(controller){
  controller.error(Object.assign(Error("opaque body read error"),{code:"UND_ERR_BODY_TIMEOUT"}));
 }});
 const fx=await exercise(t,()=>new Response(stream,{status:200}));
 assert.equal(fx.posts,1);
 assert.equal(fx.calls[0].status,"needs_reconcile");
 assert.equal(fx.calls[0].diagnostic.category,"response_body_timeout");
 assert.equal(fx.calls[0].diagnostic.phase,"read_response");
 assert.equal(fx.repeat.statusCode,409);
});
test("P4.9d real deadline abort is logged as unknown without a second outbound POST",async t=>{
 const fx=await exercise(t,(_url,{signal})=>new Promise((_resolve,reject)=>{
  signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
 }),{requestTimeoutMs:18});
 assert.equal(fx.posts,1);
 assert.equal(fx.calls[0].status,"needs_reconcile");
 assert.equal(fx.calls[0].diagnostic.category,"deadline_expired");
 assert.equal(fx.calls[0].diagnostic.phase,"await_response");
 assert.equal(fx.repeat.statusCode,409);
});
test("P4.9d non-Task success paths do not produce failure diagnostic events",async t=>{
 const fx=await exercise(t,()=>successfulAnswer("文本助手正常回应。"));
 assert.equal(fx.first.statusCode,200);
 assert.equal(fx.calls.length,1);
 assert.equal(fx.calls[0].status,"succeeded");
 assert.equal(fx.calls[0].diagnostic,undefined);
 assert.equal(fx.repeat.statusCode,200);
 assert.equal(fx.posts,1);
});
