import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn,linkAssistantTaskToChat} from "./assistant-tasks.mjs";
import {beginAssistantModelCommand,completeAssistantModelCommand} from "./assistant-model-calls.mjs";
import {discoverAssistantCreativeMaterials,selectAssistantCreativeMaterials,
 loadSelectedAssistantCreativeMaterials,formatSelectedAssistantCreativeMaterials} from "./assistant-creative-materials.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";

const policy={includeContext:false,scope:"selection",includedIds:[]};
const selection=ids=>({includeContext:true,scope:"selection",includedIds:ids});
const longStory="小兔嘟嘟与小龟慢慢在森林参加寻星大赛，遇到困难后相互帮助并一起发现友谊的意义。";
const forestScene="清晨的森林广场，有高大树木、柔和阳光、木质舞台与缤纷气球，小动物们正在排队。";
const cartoonStyle="柔和水彩质感、清晰圆润轮廓、温暖柔光、低饱和绿色与黄色配色、儿童动画三头身比例。";
const node=(id,title,content)=>({id,type:"text",title,position:{x:0,y:0},
 width:320,height:260,metadata:{content}});
function fixture(t,{oldPolicy=policy,newPolicy=policy,withCanvas=false}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 const document={nodes:withCanvas?[
  node("story-node","故事梗概",longStory),node("scene-node","森林场景设定",forestScene),
  node("style-node","美术风格",cartoonStyle),
  node("secret","私密风格","公司内部私有关键词、绝对不可向外泄漏的隐藏提示词。")
 ]:[],connections:[]};
 createProject(db,{id:"p",document});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat-first",
  rootMessageId:"root",originalRequest:"构思儿童动画",requestId:"create-task"}).task;
 const add=(messageId,text,contextPolicy=policy)=>
  appendAssistantTaskTurn(db,{projectId:"p",taskId:task.id,requestId:"turn-"+messageId,
   messageId,text,contextPolicy});
 add("story","故事梗概："+longStory,oldPolicy);
 add("scene","场景设定："+forestScene,oldPolicy);
 add("style","美术风格："+cartoonStyle,oldPolicy);
 const mock=(requestId,turnMessageId,answer)=>{
  beginAssistantModelCommand(db,{projectId:"p",taskId:task.id,requestId,
   requestPayload:{task:{turnMessageId}}});
  completeAssistantModelCommand(db,{projectId:"p",taskId:task.id,requestId,response:{answer,actions:[]}});
 };
 mock("model-first","style","美术风格："+cartoonStyle);
 add("current","请参考之前的故事梗概、场景设定和美术风格，继续创作分镜",newPolicy);
 const discover=turnMessageId=>discoverAssistantCreativeMaterials(db,{projectId:"p",taskId:task.id,
  turnMessageId:turnMessageId??"current"});
 const choose=(references,extras={})=>selectAssistantCreativeMaterials(db,{
  projectId:"p",taskId:task.id,turnMessageId:"current",requestId:"select",
  references,confirmed:true,...extras});
 return {db,task,add,mock,discover,choose,document};
}
const refs=materials=>materials.map(m=>({kind:m.kind,sourceRef:m.sourceRef,sourceDigest:m.sourceDigest}));

test("P4.1b enumerates story, scene and style as separate typed, sourced records",t=>{
 const f=fixture(t),found=f.discover();
 assert.equal(found.truncated,false);
 const statements=found.materials.filter(m=>m.provenance==="user_statement");
 assert.deepEqual(statements.map(m=>m.kind).sort(),["scene","story","style"]);
 assert.ok(statements.every(m=>m.sourceRef.startsWith("creative_")));
 assert.ok(statements.every(m=>/^[a-f0-9]{64}$/.test(m.sourceDigest)));
 assert.ok(found.materials.some(m=>m.provenance==="model_draft"&&m.kind==="style"));
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='creative_sources_selected'").get().n,0);
});

test("P4.1b selection is user-confirmed, idempotent, and injects no source until approved",t=>{
 const f=fixture(t),materials=f.discover().materials.filter(m=>m.provenance==="user_statement");
 assert.deepEqual(loadSelectedAssistantCreativeMaterials(f.db,{projectId:"p",taskId:f.task.id,
  turnMessageId:"current"}),[]);
 assert.equal(f.choose(refs(materials)).materials.length,3);
 assert.equal(f.choose(refs(materials)).existing,true);
 assert.deepEqual(loadSelectedAssistantCreativeMaterials(f.db,{projectId:"p",taskId:f.task.id,
  turnMessageId:"current"}).map(m=>m.kind).sort(),["scene","story","style"]);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='creative_sources_selected'").get().n,1);
 assert.throws(()=>f.choose(refs(materials.slice(0,1)),{requestId:"another"}),{
  code:"assistant_creative_selection_frozen"});
 const formatted=formatSelectedAssistantCreativeMaterials(materials);
 assert.ok(Buffer.byteLength(formatted,"utf8")<=3500);
 assert.match(formatted,/不是已执行证据/);
 assert.match(formatted,/寻星大赛/);
});

test("P4.1b a selected canvas source is allowed; its unselected neighbor never appears",t=>{
 const f=fixture(t,{withCanvas:true,newPolicy:selection(["scene-node","style-node"])});
 const sources=f.discover().materials.filter(m=>m.provenance==="canvas_current");
 assert.equal(sources.length,2);
 assert.deepEqual(sources.map(m=>m.kind).sort(),["scene","style"]);
 assert.ok(!JSON.stringify(f.discover()).includes("公司内部私有关键词"));
 assert.ok(!JSON.stringify(f.discover()).includes("私密风格"));
 f.choose(refs(sources));
 assert.equal(loadSelectedAssistantCreativeMaterials(f.db,{projectId:"p",taskId:f.task.id,
  turnMessageId:"current"}).length,2);
});

test("P4.1b old node disclosure is not widened by new restricted turn",t=>{
 const f=fixture(t,{withCanvas:true,oldPolicy:selection(["secret"]),newPolicy:policy});
 const found=f.discover().materials;
 assert.ok(!found.some(m=>m.sourceNodeId));
 assert.ok(!JSON.stringify(found).includes("公司内部私有关键词"));
 assert.throws(()=>f.choose([{kind:"style",sourceRef:"creative_fake",sourceDigest:"0".repeat(64)}]),{
  code:"assistant_creative_source_changed"});
});

test("P4.1b old more-permissive turn cannot be used as an active selection scope",t=>{
 const f=fixture(t,{withCanvas:true,oldPolicy:selection(["secret"]),newPolicy:policy});
 assert.throws(()=>f.discover("story"),{code:"assistant_creative_turn_stale"});
 assert.throws(()=>selectAssistantCreativeMaterials(f.db,{projectId:"p",taskId:f.task.id,
  turnMessageId:"style",requestId:"bad-old",confirmed:true,references:[{
   kind:"style",sourceRef:"creative_fake",sourceDigest:"f".repeat(64)}]}),{
  code:"assistant_creative_turn_stale"});
});

test("P4.1b same Task explicitly linked to a second Chat retains authorized materials",t=>{
 const f=fixture(t);
 const linked=linkAssistantTaskToChat(f.db,{projectId:"p",taskId:f.task.id,requestId:"link-second",
  chatSessionId:"chat-second"});
 assert.ok(linked.task.chatSessionIds.includes("chat-first"));
 assert.ok(linked.task.chatSessionIds.includes("chat-second"));
 f.add("second-chat","继续沿用之前的故事、场景和画风",policy);
 assert.deepEqual(f.discover("second-chat").materials.filter(m=>m.provenance==="user_statement")
  .map(m=>m.kind).sort(),["scene","story","style"]);
 // The previous request is no longer active once the newly linked Chat adds a Turn.
 assert.throws(()=>f.discover("current"),{code:"assistant_creative_turn_stale"});
});

test("P4.1b modified selection digest is rejected and cannot grant model reference",t=>{
 const f=fixture(t,{withCanvas:true,newPolicy:selection(["story-node"])});
 const source=f.discover().materials.find(m=>m.provenance==="canvas_current");
 assert.ok(source);
 assert.throws(()=>f.choose([{kind:source.kind,sourceRef:source.sourceRef,
  sourceDigest:"0".repeat(64)}]),{code:"assistant_creative_source_changed"});
 f.choose(refs([source]));
 const updated={...f.document,nodes:f.document.nodes.map(n=>n.id==="story-node"?
  {...n,metadata:{content:"故事已被其他人完全改写，不能按旧摘要继续生成。"}}:n)};
 f.db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'").run(JSON.stringify(updated));
 assert.throws(()=>loadSelectedAssistantCreativeMaterials(f.db,{projectId:"p",
  taskId:f.task.id,turnMessageId:"current"}),{code:"assistant_creative_source_changed"});
});

test("P4.1b model inference starts before selection => late approval fails",t=>{
 const f=fixture(t),materials=f.discover().materials.slice(0,1);
 beginAssistantModelCommand(f.db,{projectId:"p",taskId:f.task.id,requestId:"already-inference",
  requestPayload:{task:{turnMessageId:"current"}}});
 assert.throws(()=>f.choose(refs(materials)),{code:"assistant_creative_selection_too_late"});
});

test("P4.1b imported Task audit events never authorize new creative references",t=>{
 const f=fixture(t);
 const materials=f.discover().materials.slice(0,1);
 f.db.prepare("UPDATE assistant_tasks SET read_only=1 WHERE id=?").run(f.task.id);
 assert.throws(()=>f.choose(refs(materials)),{code:"assistant_task_not_editable"});
 f.db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,'creative_sources_selected',?,?)")
  .run(f.task.id,JSON.stringify({turnMessageId:"current",references:refs(materials)}),Date.now());
 assert.throws(()=>loadSelectedAssistantCreativeMaterials(f.db,{projectId:"p",taskId:f.task.id,
  turnMessageId:"current"}),{code:"assistant_creative_selection_untrusted"});
});

test("P4.1b large unicode source references preserve type, provenance and budget",()=>{
 for(const count of [1,4]){
  const materials=Array.from({length:count},(_,i)=>({
   kind:i%2?"scene":"style",title:"风格或场景"+i,provenance:"model_draft",
   sourceLabel:"用户确认之后引用的草稿",sourceRef:"creative_"+String(i).repeat(32),
   excerpt:"独特资料 😀 汉字 \" \\ \n".repeat(120)
  }));
  const formatted=formatSelectedAssistantCreativeMaterials(materials);
  assert.ok(Buffer.byteLength(formatted,"utf8")<=3500);
  assert.ok(!formatted.includes("\uFFFD"));
  for(const m of materials)assert.ok(formatted.includes(m.sourceRef));
 }
});

test("P4.1b HTTP discover, select and Mock Provider only transmit pinned sources",async t=>{
 const f=fixture(t,{withCanvas:true,newPolicy:selection(["scene-node","style-node"])});
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_v,cb)=>cb(Buffer.from("mock-secret"))};
 const bodies=[];
 const chat=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  bodies.push(JSON.parse(options.body));
  return new Response(JSON.stringify({choices:[{message:{role:"assistant",content:"参考资料已接收"},
   finish_reason:"stop"}]}),{status:200});
 }});
 const app=buildApp({db:f.db,assistantChat:chat,authorize:()=>true});t.after(()=>app.close());
 const base="/api/v1/projects/p/assistant/tasks/"+f.task.id;
 const found=await app.inject({method:"GET",url:base+"/creative-context/materials?turnMessageId=current"});
 assert.equal(found.statusCode,200,found.body);
 assert.ok(found.json().materials.length>=3);
 const chosen=found.json().materials.filter(m=>m.provenance==="canvas_current");
 const sel=await app.inject({method:"POST",url:base+"/creative-context/materials/select",payload:{
  requestId:"select-http",turnMessageId:"current",confirmed:true,references:refs(chosen)}});
 assert.equal(sel.statusCode,200,sel.body);
 const answer=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:{
  channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
  model:"mock",canvasActions:false,
  messages:[{role:"user",content:"请参考之前的故事梗概、场景设定和美术风格，继续创作分镜"}],
  task:{taskId:f.task.id,turnMessageId:"current",requestId:"current-model-initial"}
 }});
 assert.equal(answer.statusCode,200,answer.body);
 assert.equal(bodies.length,1);
 const payload=JSON.stringify(bodies[0]);
 assert.match(payload,/场景/);
 assert.match(payload,/水彩/);
 assert.doesNotMatch(payload,/公司内部私有关键词/);
 assert.doesNotMatch(payload,/寻星大赛/, "story not explicitly selected by the user must not be included");
});

test("P4.1b source changed after select => HTTP model fails before any provider POST",async t=>{
 const f=fixture(t,{withCanvas:true,newPolicy:selection(["style-node"])});
 const materials=f.discover().materials.filter(m=>m.provenance==="canvas_current");
 f.choose(refs(materials));
 const updated={...f.document,nodes:f.document.nodes.map(n=>n.id==="style-node"?
  {...n,metadata:{content:"完全重做的美术规范，旧摘要必须失效。"}}:n)};
 f.db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'").run(JSON.stringify(updated));
 let posts=0;
 const app=buildApp({db:f.db,assistantChat:async()=>{posts++;return {answer:"不应执行",model:"mock"}},
  authorize:()=>true});t.after(()=>app.close());
 const response=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:{
  channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
  model:"mock",canvasActions:false,
  messages:[{role:"user",content:"请参考之前的故事梗概、场景设定和美术风格，继续创作分镜"}],
  task:{taskId:f.task.id,turnMessageId:"current",requestId:"current-model-initial"}
 }});
 assert.equal(response.statusCode,409,response.body);
 assert.equal(response.json().code,"assistant_creative_source_changed");
 assert.equal(posts,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE command_kind='model_infer' AND request_id='current-model-initial'").get().n,0);
});

test("P4.1b pinning one source does not serialize other selected canvas nodes",async t=>{
 const f=fixture(t,{withCanvas:true,newPolicy:selection([
  "story-node","scene-node","style-node","secret"
 ])});
 const source=f.discover().materials.find(m=>m.provenance==="canvas_current"&&m.kind==="style");
 assert.ok(source);
 f.choose(refs([source]));
 const requests=[];
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_v,cb)=>cb(Buffer.from("mock-key"))};
 const assistantChat=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  requests.push(JSON.parse(options.body));
  return new Response(JSON.stringify({choices:[{message:{role:"assistant",content:"可以继续生成"},
   finish_reason:"stop"}]}),{status:200});
 }});
 const app=buildApp({db:f.db,assistantChat,authorize:()=>true});t.after(()=>app.close());
 const res=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:{
  channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
  model:"mock",canvasActions:false,
  messages:[{role:"user",content:"请参考之前的故事梗概、场景设定和美术风格，继续创作分镜"}],
  task:{taskId:f.task.id,turnMessageId:"current",requestId:"pin-one-request"}
 }});
 assert.equal(res.statusCode,200,res.body);
 assert.equal(requests.length,1);
 const wire=JSON.stringify(requests[0]);
 assert.ok(wire.includes(cartoonStyle));
 assert.ok(!wire.includes(forestScene));
 assert.ok(!wire.includes(longStory));
 assert.ok(!wire.includes("公司内部私有关键词"));
});

test("P4.1b final provider guard rechecks a source changed after model command reservation",async t=>{
 const f=fixture(t,{withCanvas:true,newPolicy:selection(["style-node"])});
 const source=f.discover().materials.filter(m=>m.provenance==="canvas_current");
 f.choose(refs(source));
 let attempted=0;
 const app=buildApp({db:f.db,authorize:()=>true,assistantChat:async input=>{
  attempted++;
  const next={...f.document,nodes:f.document.nodes.map(n=>n.id==="style-node"?
   {...n,metadata:{content:"创作风格在模型请求等待期间发生了修改，必须失效。"}}:n)};
  f.db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'").run(JSON.stringify(next));
  input.providerPayloadGuard(JSON.stringify({messages:[{role:"user",content:input.messages[0].content}]}));
  return {model:"mock",answer:"不能成功"};
 }});
 t.after(()=>app.close());
 const response=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:{
  channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
  model:"mock",canvasActions:false,
  messages:[{role:"user",content:"请参考之前的故事梗概、场景设定和美术风格，继续创作分镜"}],
  task:{taskId:f.task.id,turnMessageId:"current",requestId:"simulate-concurrent-change"}
 }});
 assert.equal(response.statusCode,409,response.body);
 assert.equal(response.json().code,"assistant_creative_source_changed");
 assert.equal(attempted,1);
});
