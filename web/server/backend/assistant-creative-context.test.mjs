import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn} from "./assistant-tasks.mjs";
import {discoverAssistantCreativeCharacters,resolveAuthorizedCreativeCharacters,
 formatAssistantCreativeSources} from "./assistant-creative-context.mjs";
import {registerAssistantTextDeliverable,verifyAssistantTextDeliverable} from "./assistant-task-deliverables.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep} from "./assistant-task-canvas-executor.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {beginAssistantModelCommand,completeAssistantModelCommand} from "./assistant-model-calls.mjs";
import {loadAssistantTaskCreativeHistory} from "./assistant-task-context.mjs";

const originalCast=["小兔嘟嘟","兔妈妈","小龟慢慢"];
const storyAnswer="这是兔子儿童动画的故事，主要角色有（主角小兔嘟嘟、兔妈妈、好友小龟慢慢）。"+
 "小兔嘟嘟戴着蓝色围巾，活泼勇敢；兔妈妈穿紫色围裙，温暖耐心；小龟慢慢背着绿色书包，细心可靠。";
const basePolicy={includeContext:false,scope:"selection",includedIds:[]};
const selected=(ids)=>({includeContext:true,scope:"selection",includedIds:ids});
const node=(id,title,content)=>({id,type:"text",title,position:{x:0,y:0},
 width:340,height:240,metadata:{content}});
function fixture(t,{priorPolicy=basePolicy,currentPolicy=basePolicy,document={nodes:[],connections:[]}}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document});
 const taskId=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",
  rootMessageId:"root",originalRequest:"创作一部兔子儿童动画短片",requestId:"create-task"}).task.id;
 const append=(messageId,text,contextPolicy=basePolicy)=>appendAssistantTaskTurn(db,{
  projectId:"p",taskId,requestId:"append-"+messageId,messageId,text,contextPolicy});
 append("story","先设计三个角色",priorPolicy);
 const model=(requestId,answer=storyAnswer,actions=[],turnMessageId="story")=>{
  beginAssistantModelCommand(db,{projectId:"p",taskId,requestId,
   requestPayload:{task:{turnMessageId}}});
  completeAssistantModelCommand(db,{projectId:"p",taskId,requestId,response:{answer,actions}});
 };
 model("story-model-initial");
 append("current","为每个角色生成角色卡提示词文本节点",currentPolicy);
 const context=()=>discoverAssistantCreativeCharacters(db,{projectId:"p",taskId,turnMessageId:"current"});
 const selectedCharacters=()=>context().groups[0].characters.map((c,i)=>({
  ref:"role_"+(i+1),title:c.title,sourceRef:c.sourceRef,sourceDigest:c.sourceDigest,
  ...(c.sourceNodeId?{sourceNodeId:c.sourceNodeId}:{})
 }));
 const requireCards=(characters=selectedCharacters())=>registerAssistantTextDeliverable(db,{
  projectId:"p",taskId,requestId:"require",sourceTurnMessageId:"current",characters,confirmed:true});
 return {db,taskId,model,append,context,selectedCharacters,requireCards};
}

test("P4.1 model answer cast is discovered but is explicitly labelled unconfirmed draft",t=>{
 const f=fixture(t);
 const result=f.context();
 assert.equal(result.groups.length,1);
 assert.equal(result.groups[0].provenance,"model_draft");
 assert.deepEqual(result.groups[0].characters.map(c=>c.title),originalCast);
 assert.ok(result.groups[0].characters.every(c=>/^[a-f0-9]{64}$/.test(c.sourceDigest)));
 assert.match(result.groups[0].characters[0].excerpt,/蓝色围巾/);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='deliverable_required'").get().n,0,
  "read-only discovery cannot approve model candidates");
});

test("P4.1 arbitrary request IDs retain the actual source turn",t=>{
 const f=fixture(t);
 f.model("independent-uuid",storyAnswer);
 assert.equal(f.context().groups.filter(g=>g.provenance==="model_draft").length,2);
 assert.ok(f.context().groups.every(g=>g.characters[0].sourceMessageId==="story"));
});

test("P4.1 misleading request prefixes cannot widen the actual turn disclosure",t=>{
 const f=fixture(t,{priorPolicy:selected(["private"])});
 f.append("public","无画布资料的普通请求",basePolicy);
 f.model("public-model-spoof",storyAnswer,[],"story");
 f.append("later","为每个角色生成角色卡",basePolicy);
 assert.deepEqual(discoverAssistantCreativeCharacters(f.db,{projectId:"p",taskId:f.taskId,turnMessageId:"later"}).groups,[]);
 assert.deepEqual(loadAssistantTaskCreativeHistory(f.db,{taskId:f.taskId,currentTurnMessageId:"later",contextPolicy:basePolicy}),[]);
});

test("P4.1 legacy commands without recorded turn bindings cannot authorize sources",t=>{
 const f=fixture(t);
 f.db.prepare("DELETE FROM assistant_task_events WHERE task_id=? AND kind='model_command_started'").run(f.taskId);
 assert.deepEqual(f.context().groups,[]);
 assert.deepEqual(loadAssistantTaskCreativeHistory(f.db,{taskId:f.taskId,currentTurnMessageId:"current",contextPolicy:basePolicy}),[]);
});

test("P4.1 HTTP persists real source turns independently of request ID prefixes",async t=>{
 for(const privateSource of [false,true]){
  const f=fixture(t,{priorPolicy:privateSource?selected(["private"]):basePolicy});
  f.append("public","普通请求",basePolicy);
  const app=buildApp({db:f.db,authorize:()=>true,
   assistantChat:async()=>({model:"mock",answer:storyAnswer})});
  t.after(()=>app.close());
  const requestId=privateSource?"public-model-spoof":"independent-uuid";
  const response=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",
   payload:{channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
    model:"mock",canvasActions:false,messages:[{role:"user",content:"先设计三个角色"}],
    task:{taskId:f.taskId,turnMessageId:"story",requestId}}});
  assert.equal(response.statusCode,200,response.body);
  f.append("later","为每个角色生成角色卡",basePolicy);
  const result=discoverAssistantCreativeCharacters(f.db,{projectId:"p",taskId:f.taskId,turnMessageId:"later"});
  if(privateSource)assert.deepEqual(result.groups,[]);
  else assert.equal(result.groups.filter(g=>g.provenance==="model_draft").length,2);
 }
});

test("P4.1 source budget preserves every confirmed character and valid Unicode",()=>{
 for(const count of [3,5]){
  const candidates=Array.from({length:count},(_,i)=>({title:"角色"+i,sourceLabel:"当前选择的角色来源",
   provenance:"canvas_current",sourceRef:"creative_"+String(i).repeat(32),
   excerpt:"独特设定"+i+"汉😀\\\"".repeat(650)}));
  const formatted=formatAssistantCreativeSources(candidates);
  assert.ok(Buffer.byteLength(formatted)<=4000);
  assert.ok(!formatted.includes("\uFFFD"));
  for(const c of candidates){
   assert.ok(formatted.includes(c.title));
   assert.ok(formatted.includes(c.sourceRef));
   assert.ok(formatted.includes("独特设定"+c.title.slice(2)));
  }
 }
});

test("P4.1 approved source digest freezes 3 characters through real SQLite Canvas and Task verifier",t=>{
 const f=fixture(t),characters=f.selectedCharacters();
 const required=f.requireCards(characters);
 assert.deepEqual(required.characters,characters);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='deliverable_required'").get().n,1);
 const actions=characters.map(c=>({type:"create_text",ref:c.ref,title:c.title,
  content:c.title+"拥有鲜明外貌、性格、服饰与故事动机，能够指导一致性角色绘图。"}));
 const step=planAssistantCanvasStep(f.db,{projectId:"p",taskId:f.taskId,
  requestId:"plan",expectedPlanVersion:1,expectedProjectRevision:1,
  center:{x:0,y:0},actions,dependsOn:[]});
 assert.deepEqual(step.deliverableSpec.characters,characters);
 decideAssistantTaskStep(f.db,{projectId:"p",taskId:f.taskId,stepId:step.stepId,
  requestId:"approve",expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve"});
 const applied=executeAssistantCanvasStep(f.db,{projectId:"p",taskId:f.taskId,stepId:step.stepId,
  requestId:"execute",expectedPlanVersion:1,actionDigest:step.actionDigest});
 assert.equal(applied.project.document.nodes.length,3);
 assert.equal(verifyAssistantTextDeliverable(f.db,{projectId:"p",taskId:f.taskId,stepId:step.stepId,
  requestId:"verify",expectedPlanVersion:1,actionDigest:step.actionDigest}).verified,true);
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks WHERE id=?").get(f.taskId).status,"completed");
});

test("P4.1 unknown names and forged/deleted/stale source digests refuse specification",t=>{
 const f=fixture(t),characters=f.selectedCharacters();
 assert.throws(()=>f.requireCards(characters.map((c,i)=>i===0?{...c,title:"假冒角色"}:c)),
  {code:"assistant_creative_source_changed"});
 assert.throws(()=>f.requireCards(characters.map((c,i)=>i===0?{...c,sourceDigest:"0".repeat(64)}:c)),
  {code:"assistant_creative_source_changed"});
 assert.throws(()=>f.requireCards(characters.slice(0,2).map((c,i)=>i===0?
  {ref:c.ref,title:c.title}:c)),{code:"assistant_deliverable_source_partial"});
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='deliverable_required'").get().n,0);
 f.db.prepare("UPDATE assistant_task_commands SET response_json=? WHERE request_id='story-model-initial'")
  .run(JSON.stringify({answer:storyAnswer.replace("蓝色围巾","红色围巾"),actions:[]}));
 assert.throws(()=>f.requireCards(characters),{code:"assistant_creative_source_changed"});
});

test("P4.1 old selected-node information is blocked after new turn narrows scope",t=>{
 const f=fixture(t,{priorPolicy:selected(["private"]),currentPolicy:basePolicy});
 assert.deepEqual(f.context().groups,[]);
 assert.throws(()=>f.requireCards([{ref:"role_1",title:"小兔嘟嘟",sourceRef:"creative_fake",
  sourceDigest:"f".repeat(64)}]),{code:"assistant_creative_source_changed"});
});

test("P4.1 current selected nodes are available, but neighboring unselected canvas text is not",t=>{
 const f=fixture(t,{currentPolicy:selected(["a","b","c"]),document:{nodes:[
  node("a","小兔嘟嘟角色卡","姓名：小兔嘟嘟。蓝色围巾，乐观开朗，毛色雪白。"),
  node("b","兔妈妈角色卡","姓名：兔妈妈。紫色围裙，温暖耐心，毛色浅黄。"),
  node("c","小龟慢慢角色卡","姓名：小龟慢慢。绿色书包，谨慎善良，龟壳翠绿。"),
  node("secret","秘密角色卡","秘密：故事核心私人文本不可外发，角色名是秘密角色。")
 ],connections:[]}});
 const result=f.context();
 assert.equal(result.groups[0].provenance,"canvas_current");
 assert.deepEqual(result.groups[0].characters.map(c=>c.title),originalCast);
 assert.ok(!JSON.stringify(result).includes("秘密角色"));
 assert.ok(!JSON.stringify(result).includes("私人文本"));
 const chosen=f.selectedCharacters();
 assert.ok(chosen.every(c=>c.sourceNodeId));
 assert.equal(f.requireCards(chosen).characters.length,3);
});

test("P4.1 35 intervening turns do not erase an authorized creative source",t=>{
 const f=fixture(t);
 for(let i=0;i<35;i++)f.append("follow"+i,"继续分析这个故事第"+i+"轮",basePolicy);
 // Current Task turn remains frozen; index derives the original completed command.
 assert.deepEqual(f.context().groups[0].characters.map(c=>c.title),originalCast);
});

test("P4.1 provider gets the confirmed source excerpt, but not private neighbors or unauthorized node content",async t=>{
 const f=fixture(t,{document:{nodes:[
  node("private","秘密文本","请不准透露此私人角色设定，故事的秘密结局不可外发。")
 ],connections:[]}});
 const chosen=f.selectedCharacters();f.requireCards(chosen);
 const wire=[];
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_,cb)=>cb(Buffer.from("mock-key"))};
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_,opts)=>{
  wire.push(JSON.parse(opts.body));
  const answer=JSON.stringify({answer:"收到角色规格",actions:chosen.map(c=>({
   type:"create_text",ref:c.ref,title:c.title,content:c.title+
    "具有明确毛色、衣着、性格和故事动机，是适合儿童动画的原创角色。"}))});
  return new Response(JSON.stringify({choices:[{message:{role:"assistant",content:answer},finish_reason:"stop"}]}),
   {status:200});
 }});
 const app=buildApp({db:f.db,assistantChat:service,authorize:()=>true});t.after(()=>app.close());
 const request={channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
  model:"mock",canvasActions:true,messages:[{role:"user",content:"为每个角色生成角色卡提示词文本节点"}],
  task:{taskId:f.taskId,turnMessageId:"current",requestId:"current-model-initial"}};
 const res=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:request});
 assert.equal(res.statusCode,200,res.body);
 assert.equal(wire.length,1);
 const body=JSON.stringify(wire[0]);
 assert.match(body,/历史 AI 创作草案/);
 assert.match(body,/蓝色围巾/);
 assert.doesNotMatch(body,/秘密结局/);
});

test("P4.1 GET discovery only returns within Task frozen turn, rejects forged turn IDs",async t=>{
 const f=fixture(t);
 const app=buildApp({db:f.db,assistantChat:async()=>({model:"mock",answer:"noop"}),authorize:()=>true});
 t.after(()=>app.close());
 const base="/api/v1/projects/p/assistant/tasks/"+f.taskId;
 const ok=await app.inject({method:"GET",url:base+"/creative-context/characters?turnMessageId=current"});
 assert.equal(ok.statusCode,200,ok.body);
 assert.deepEqual(ok.json().groups[0].characters.map(c=>c.title),originalCast);
 const denied=await app.inject({method:"GET",url:base+"/creative-context/characters?turnMessageId=not-real"});
 assert.equal(denied.statusCode,409);
 const unknown=await app.inject({method:"GET",url:"/api/v1/projects/p/assistant/tasks/other/creative-context/characters?turnMessageId=current"});
 assert.equal(unknown.statusCode,404);
});

test("P4.1 earlier user enumerated cast is labelled user_statement, not a model success",t=>{
 const f=fixture(t);
 // Insert an explicit user cast before a new request: the new current must not
 // borrow names from any later turn.
 f.append("named","为小兔嘟嘟、兔妈妈、小龟慢慢生成角色卡提示词文本节点",basePolicy);
 f.append("current2","为每个角色生成角色卡",basePolicy);
 const discovered=discoverAssistantCreativeCharacters(f.db,{projectId:"p",taskId:f.taskId,turnMessageId:"current2"});
 assert.equal(discovered.groups[0].provenance,"user_statement");
 assert.deepEqual(discovered.groups[0].characters.map(c=>c.title),originalCast);
 assert.equal(f.context().groups[0].provenance,"model_draft",
  "the old current turn cannot reach a user message added later");
});

test("P4.1 >5 canvas characters never silently become a five-person deliverable",t=>{
 const all=[...originalCast,"兔爷爷","兔老师","熊同学"];
 const f=fixture(t,{currentPolicy:selected(all.map((_,i)=>"n"+i)),document:{
  nodes:all.map((title,i)=>node("n"+i,title+"角色卡","姓名："+title+"。服饰鲜明，性格清晰。")),connections:[]}});
 assert.ok(f.context().groups.every(g=>g.provenance!=="canvas_current"));
});

test("P4.1 changed historical draft after approval stops provider before POST",async t=>{
 const f=fixture(t),chosen=f.selectedCharacters();f.requireCards(chosen);
 f.db.prepare("UPDATE assistant_task_commands SET response_json=? WHERE request_id='story-model-initial'")
  .run(JSON.stringify({answer:storyAnswer.replace("蓝色围巾","黄金围巾"),actions:[]}));
 let called=0;
 const app=buildApp({db:f.db,assistantChat:async()=>{called++;return {model:"mock",answer:"noop"}},
  authorize:()=>true});t.after(()=>app.close());
 const response=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",
  payload:{channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
   model:"mock",canvasActions:true,messages:[{role:"user",content:"为每个角色生成角色卡提示词文本节点"}],
   task:{taskId:f.taskId,turnMessageId:"current",requestId:"current-model-initial"}}});
 assert.equal(response.statusCode,409,response.body);
 assert.equal(response.json().code,"assistant_creative_source_changed");
 assert.equal(called,0);
});
