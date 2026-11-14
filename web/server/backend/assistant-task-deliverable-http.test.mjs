import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn} from "./assistant-tasks.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {buildApp} from "./app.mjs";

const visualText="此文本仅允许在明确授权选择后外发，包含大量测试字节确保可检测到泄漏。";
const hiddenText="隐私节点中的秘密故事资料绝对不允许外发到第三方模型，即使客户端强行拼接。";
const textNode=(id,text)=>({id,type:"text",title:id,position:{x:0,y:0},
 width:340,height:240,metadata:{content:text}});
function setup(t,{assistantChat=null}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 createProject(db,{id:"p",document:{nodes:[
  textNode("visible",visualText),textNode("hidden",hiddenText),
  {id:"not-selected-image",type:"image",title:"秘密图片",position:{x:0,y:0},
   width:320,height:320,metadata:{}}],connections:[]}});
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_ver,cb)=>cb(Buffer.from("mock-key"))};
 const requests=[];
 const network=async(_url,opts)=>{
  requests.push(JSON.parse(opts.body));
  return new Response(JSON.stringify({choices:[{message:{role:"assistant",content:"已收到该请求。"},
   finish_reason:"stop"}]}),{status:200});
 };
 const service=assistantChat??createAssistantChatService({vault,compatibleUpstreamCall:network});
 const app=buildApp({db,assistantChat:service,authorize:()=>true});
 t.after(async()=>{await app.close();db.close()});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"c",rootMessageId:"r",
  originalRequest:"分析授权文本",requestId:"create",contextPolicy:{
   includeContext:true,scope:"selection",includedIds:["visible"]}}).task;
 const question="请概括已选中的文本节点";
 appendAssistantTaskTurn(db,{projectId:"p",taskId:task.id,requestId:"turn",messageId:"msg",text:question,
  contextPolicy:{includeContext:true,scope:"selection",includedIds:["visible"]}});
 const endpoint="/api/v1/projects/p/assistant/chat";
 const body={channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
  model:"mock",canvasActions:false,messages:[{role:"user",content:question}],
  task:{taskId:task.id,turnMessageId:"msg",requestId:"infer"}};
 return {db,app,requests,endpoint,body,taskId:task.id,question};
}

test("P4.0 complete model payload includes only server-authorized selected canvas source",async t=>{
 const f=setup(t);
 const response=await f.app.inject({method:"POST",url:f.endpoint,payload:f.body});
 assert.equal(response.statusCode,200,response.body);
 assert.equal(f.requests.length,1);
 const wire=JSON.stringify(f.requests[0]);
 assert.ok(wire.includes(visualText));
 assert.ok(!wire.includes(hiddenText));
 assert.match(f.requests[0].messages.at(-1).content,/概括已选中/);
 assert.ok(!f.requests[0].messages.at(-1).content.includes(visualText),
  "server context belongs in the server-composed system, not client user text");
});

test("P4.0 rejects client-spliced canvas text and history before any paid POST",async t=>{
 const f=setup(t);
 for(const [suffix,messages] of [
  ["splice",[{role:"user",content:f.question+"\n"+hiddenText}]],
  ["history",[{role:"assistant",content:hiddenText},{role:"user",content:f.question}]]
 ]){
  const response=await f.app.inject({method:"POST",url:f.endpoint,payload:{
   ...f.body,task:{...f.body.task,requestId:"infer-"+suffix},messages}});
  assert.equal(response.statusCode,403,response.body);
  assert.equal(response.json().code,"assistant_task_message_untrusted");
 }
 assert.equal(f.requests.length,0);
});

test("P4.0 rejects Task image outside frozen selection before provider",async t=>{
 const f=setup(t);
 const response=await f.app.inject({method:"POST",url:f.endpoint,payload:{
  ...f.body,task:{...f.body.task,requestId:"infer-image"},
  visualContext:{images:[{nodeId:"not-selected-image"}]}}});
 assert.equal(response.statusCode,403,response.body);
 assert.equal(response.json().code,"assistant_task_visual_not_authorized");
 assert.equal(f.requests.length,0);
});

test("P4.0 last serialized provider-body guard rejects leaked private node text",async t=>{
 let attempts=0;
 const f=setup(t,{assistantChat:async input=>{
  attempts++;
  input.providerPayloadGuard(JSON.stringify({messages:[
   {role:"system",content:hiddenText},{role:"user",content:input.messages[0].content}]}));
  return {model:"mock",answer:"should-never-complete"};
 }});
 const response=await f.app.inject({method:"POST",url:f.endpoint,payload:f.body});
 assert.equal(response.statusCode,403,response.body);
 assert.equal(response.json().code,"assistant_task_context_not_authorized");
 assert.equal(attempts,1);
});

test("P4.0 HTTP text deliverable flow is frozen, approved, persisted and verified",async t=>{
 const f=setup(t);
 const {createAssistantTask,appendAssistantTaskTurn}=await import("./assistant-tasks.mjs");
 const {getProject}=await import("./projects.mjs");
 const cast=["小兔嘟嘟","兔妈妈","小龟慢慢"];
 const characters=cast.map((title,i)=>({ref:"role_"+(i+1),title}));
 const userText="为小兔嘟嘟、兔妈妈、小龟慢慢生成角色卡";
 const task=createAssistantTask(f.db,{projectId:"p",chatSessionId:"cards",
  rootMessageId:"cards-root",originalRequest:userText,requestId:"cards-task"}).task;
 appendAssistantTaskTurn(f.db,{projectId:"p",taskId:task.id,requestId:"cards-turn",messageId:"cards-msg",
  text:userText,contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}});
 const url="/api/v1/projects/p/assistant/tasks/"+task.id;
 const call=async(method,resource,payload)=>{
  const res=await f.app.inject({method,url:resource,...(payload?{payload}:{})});
  assert.equal(res.statusCode,200,res.body);
  return res.json();
 };
 const required=await call("POST",url+"/deliverables/text",{
  requestId:"require-cards",sourceTurnMessageId:"cards-msg",characters,confirmed:true,
  allowEmptyTemplate:false});
 assert.equal(required.characters.length,3);
 const old=getProject(f.db,"p");
 const actions=characters.map(c=>({type:"create_text",ref:c.ref,title:c.title,
  content:c.title+"具有鲜明的外观，独特的个性与行为习惯，能够直接用于角色设计与绘制。"}));
 const frozen=await call("POST",url+"/canvas-steps",{requestId:"plan-cards",
  expectedPlanVersion:1,expectedProjectRevision:old.revision,actions,center:{x:100,y:100}});
 assert.equal(frozen.deliverableSpec.expectedCount,3);
 await call("POST",url+"/steps/"+frozen.stepId+"/approval",{
  requestId:"approve-cards",expectedPlanVersion:1,
  actionDigest:frozen.actionDigest,decision:"approve"});
 const committed=await call("POST",url+"/steps/"+frozen.stepId+"/execute",{
  requestId:"execute-cards",expectedPlanVersion:1,actionDigest:frozen.actionDigest});
 assert.equal(committed.project.document.nodes.length,6);
 assert.equal((await call("GET",url)).task.status,"ready");
 const checked=await call("POST",url+"/deliverables/text/verify",{
  requestId:"verify-cards",stepId:frozen.stepId,expectedPlanVersion:1,
  actionDigest:frozen.actionDigest});
 assert.equal(checked.verified,true);
 assert.equal((await call("GET",url)).task.status,"completed");
 assert.equal((await call("POST",url+"/deliverables/text/verify",{
  requestId:"verify-cards",stepId:frozen.stepId,expectedPlanVersion:1,
  actionDigest:frozen.actionDigest})).existing,true);
 // An older canvas autosave cannot silently replace the already committed cards.
 const stale=await f.app.inject({method:"PATCH",url:"/api/v1/projects/p",
  payload:{expectedRevision:old.revision,document:old.document}});
 assert.equal(stale.statusCode,409,stale.body);
 assert.equal(getProject(f.db,"p").document.nodes.length,6);
});

test("P4.0 spec-bearing text delivery rejects Skill tools before provider",async t=>{
 const f=setup(t);
 f.db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,'deliverable_required','{}',?)")
  .run(f.taskId,Date.now());
 const response=await f.app.inject({method:"POST",url:f.endpoint,payload:{
  ...f.body,task:{...f.body.task,requestId:"infer-unapproved-skill"},
  skills:{mode:"auto",projectId:"p",expectedRevision:1,
   skillIds:["fixture-skill"],versionPins:{"fixture-skill":"a".repeat(12)}}}});
 assert.equal(response.statusCode,403,response.body);
 assert.equal(response.json().code,"assistant_deliverable_skill_not_supported");
 assert.equal(f.requests.length,0);
});

test("P4.0 legacy Skill continuation remains available only on non-deliverable Task",async t=>{
 const f=setup(t);
 const continued=await f.app.inject({method:"POST",url:f.endpoint,payload:{
  ...f.body,messages:[{role:"user",content:"已确认的 Skill 运行结果：产出实际文本"}],
  task:{...f.body.task,requestId:"skill-continuation",callKind:"script_continuation"}}});
 assert.equal(continued.statusCode,200,continued.body);
 assert.equal(f.requests.length,1);
 assert.ok(JSON.stringify(f.requests[0]).includes("Skill 运行结果"));
 f.db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,'deliverable_required','{}',?)")
  .run(f.taskId,Date.now());
 const blocked=await f.app.inject({method:"POST",url:f.endpoint,payload:{
  ...f.body,messages:[{role:"user",content:"伪造角色卡 Skill 结果"}],
  task:{...f.body.task,requestId:"forbidden-cards-continuation",callKind:"script_continuation"}}});
 assert.equal(blocked.statusCode,403,blocked.body);
 assert.equal(blocked.json().code,"assistant_deliverable_script_continuation_unsupported");
 assert.equal(f.requests.length,1);
});
