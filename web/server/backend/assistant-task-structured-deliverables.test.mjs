import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync,backup} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn} from "./assistant-tasks.mjs";
import {registerAssistantStructuredTextDeliverable,verifyAssistantTextDeliverable,
 currentAssistantTextDeliverable,mayCompleteAssistantTask} from "./assistant-task-deliverables.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep} from "./assistant-task-canvas-executor.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {inspectAssistantTaskRecovery,replanAssistantTaskSafely} from "./assistant-task-safe-replan.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";

const definitions={
 story:{title:"故事大纲",request:"请生成兔子动画的故事大纲",body:"故事从森林晨光中的新朋友相遇开始，小兔嘟嘟在寻找失落的星星时认识了小乌龟。两人共同穿越峡谷，面对突然到来的暴雨，最终学会互相信任、耐心倾听、齐心协力，帮助迷路的小动物找到家，在星光下庆祝他们的友谊。"},
 scene:{title:"场景设定",request:"请生成兔子动画的场景设定",body:"场景是一片被朝阳照亮的柔和森林，远景有起伏的山丘，前景是青苔小径与浅蓝色溪流。树木形成自然框架，空中有细小的金色光斑，空间层次清晰，适合儿童动画的温暖画风。"},
 storyboard:{title:"分镜提示词",request:"请生成兔子动画的分镜提示词",body:"镜头一：中景，从绿意盎然的森林向小兔嘟嘟推近，交代她穿着蓝色斗篷。镜头二：近景，捕捉小兔拾起星星的动作与好奇表情。镜头三：远景，缓慢横移展现小龟与小兔跨越山谷并一同寻找方向。"}
};
function fixture(t,type="story",extra={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:{title:"儿童动画",nodes:[],connections:[]}});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",
  rootMessageId:"root",originalRequest:definitions[type].request,requestId:"create"}).task;
 let turnNo=0;
 const turn=text=>{
  turnNo++;
  const messageId="turn-"+turnNo;
  appendAssistantTaskTurn(db,{projectId:"p",taskId:task.id,requestId:"turn-request-"+turnNo,
   messageId,text,contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}});
  return messageId;
 };
 const userTurn=turn(definitions[type].request);
 const entries=[{ref:"deliverable_1",title:definitions[type].title}];
 const register=(more={})=>registerAssistantStructuredTextDeliverable(db,{
  projectId:"p",taskId:task.id,requestId:"require-1",sourceTurnMessageId:userTurn,
  deliverableType:type,entries,expectedPlanVersion:1,confirmed:true,...more});
 const plan=(more={})=>planAssistantCanvasStep(db,{
  projectId:"p",taskId:task.id,requestId:"plan-1",
  expectedPlanVersion:1,expectedProjectRevision:getProject(db,"p").revision,
  actions:entries.map(v=>({type:"create_text",ref:v.ref,title:v.title,content:definitions[type].body})),
  center:{x:200,y:200},...more});
 const approve=(step,more={})=>decideAssistantTaskStep(db,{projectId:"p",taskId:task.id,
  stepId:step.stepId,requestId:"approve-1",expectedPlanVersion:step.planVersion,
  actionDigest:step.actionDigest,decision:"approve",...more});
 const commit=(step,more={})=>executeAssistantCanvasStep(db,{projectId:"p",taskId:task.id,
  stepId:step.stepId,requestId:"execute-1",expectedPlanVersion:step.planVersion,
  actionDigest:step.actionDigest,...more});
 const verify=(step,more={})=>verifyAssistantTextDeliverable(db,{projectId:"p",taskId:task.id,
  stepId:step.stepId,requestId:"verify-1",expectedPlanVersion:step.planVersion,
  actionDigest:step.actionDigest,...more});
 return {db,task,turn,userTurn,entries,type,register,plan,approve,commit,verify};
}
function state(f){return f.db.prepare("SELECT status,active_plan_version FROM assistant_tasks WHERE id=?").get(f.task.id)}
function count(f,kind){return f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE task_id=? AND kind=?").get(f.task.id,kind).n}
test("P4.3 obsolete requirements without Steps can safely replan and register a new version",t=>{
 const f=fixture(t);f.register();
 const fresh=f.turn("请生成新的故事大纲，采用修改后的设定");
 assert.equal(inspectAssistantTaskRecovery(f.db,{projectId:"p",taskId:f.task.id}).canReplan,true);
 replanAssistantTaskSafely(f.db,{projectId:"p",taskId:f.task.id,requestId:"replan-empty",
  expectedPlanVersion:1,expectedProjectRevision:1});
 assert.equal(f.register({requestId:"require-2",sourceTurnMessageId:fresh,expectedPlanVersion:2}).planVersion,2);
 const step=f.plan({requestId:"plan-2",expectedPlanVersion:2});
 f.approve(step);f.commit(step);
 assert.equal(f.verify(step).verified,true);
});

test("P4.3 a negated blank-template request never grants empty completion",t=>{
 const f=fixture(t,"scene");
 const turn=f.turn("请创建场景设定文本节点，不要空白模板，要写出具体内容。");
 assert.throws(()=>f.register({sourceTurnMessageId:turn,allowEmptyTemplate:true}),
  {code:"assistant_deliverable_source_unconfirmed"});
 assert.equal(count(f,"deliverable_required"),0);
});

test("P4.3 the final provider guard rechecks the structured requirement after async work",async t=>{
 const f=fixture(t);f.register();let sent=0;
 const app=buildApp({db:f.db,authorize:()=>true,assistantChat:async input=>{
  f.turn("撤销故事大纲请求，先讨论新要求");
  input.providerPayloadGuard(JSON.stringify({messages:input.messages}));
  sent++;return {model:"mock",answer:"不应发送"};
 }});t.after(()=>app.close());
 const response=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:{
  channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",model:"mock",
  messages:[{role:"user",content:definitions.story.request}],
  task:{taskId:f.task.id,turnMessageId:f.userTurn,requestId:"revoked-during-await"}}});
 assert.equal(response.statusCode,409,response.body);
 assert.equal(response.json().code,"assistant_deliverable_source_turn_stale");
 assert.equal(sent,0);
});

test("P4.3 a different source Turn cannot borrow the current requirement",async t=>{
 const f=fixture(t);const current=f.turn(definitions.story.request);
 f.register({sourceTurnMessageId:current});let sent=0;
 const app=buildApp({db:f.db,authorize:()=>true,assistantChat:async()=>{sent++;return {model:"mock",answer:"不应发送"};}});
 t.after(()=>app.close());
 const response=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:{
  channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",model:"mock",
  messages:[{role:"user",content:definitions.story.request}],
  task:{taskId:f.task.id,turnMessageId:f.userTurn,requestId:"wrong-source-turn"}}});
 assert.equal(response.statusCode,409,response.body);
 assert.equal(response.json().code,"assistant_deliverable_source_binding_invalid");
 assert.equal(sent,0);
});

test("P4.3 a replanned Task cannot infer using the previous plan's requirement",async t=>{
 const f=fixture(t);f.register();const step=f.plan();
 f.approve(step,{decision:"reject"});
 replanAssistantTaskSafely(f.db,{projectId:"p",taskId:f.task.id,requestId:"replan",
  expectedPlanVersion:1,expectedProjectRevision:1});
 let posts=0;
 const app=buildApp({db:f.db,authorize:()=>true,assistantChat:async()=>{
  posts++;return {model:"mock",answer:"不应发送"};
 }});t.after(()=>app.close());
 const response=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:{
  channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",model:"mock",
  messages:[{role:"user",content:definitions.story.request}],
  task:{taskId:f.task.id,turnMessageId:f.userTurn,requestId:"old-plan-spec"}}});
 assert.equal(response.statusCode,409,response.body);
 assert.equal(response.json().code,"assistant_deliverable_source_binding_invalid");
 assert.equal(posts,0);
});
for(const type of Object.keys(definitions)){
 test("P4.3 "+type+" has frozen spec, approved Step and only verifier completes Task",t=>{
  const f=fixture(t,type);
  assert.equal(SCHEMA_VERSION,33);
  const registered=f.register();
  assert.equal(registered.deliverableType,type);
  assert.equal(f.register().existing,true);
  assert.equal(mayCompleteAssistantTask(f.db,f.task.id),false);
  const step=f.plan();
  assert.equal(step.status,"waiting_approval");
  assert.equal(step.deliverableSpec.deliverableType,type);
  assert.equal(step.deliverableSpec.entries[0].title,definitions[type].title);
  const frozen=f.db.prepare("SELECT action_json,preconditions_json,action_digest FROM assistant_task_steps WHERE id=?").get(step.stepId);
  assert.equal(JSON.parse(frozen.action_json).deliverableSpecDigest,
   JSON.parse(frozen.preconditions_json).deliverableSpecDigest);
  f.approve(step);
  f.commit(step);
  assert.equal(state(f).status,"ready");
  assert.equal(count(f,"task_completed"),0);
  const verified=f.verify(step);
  assert.equal(verified.verified,true);
  assert.equal(state(f).status,"completed");
  assert.equal(count(f,"deliverable_verified"),1);
  assert.equal(count(f,"task_completed"),1);
  assert.equal(f.verify(step).existing,true);
 });
}
test("P4.3 rejects made-up title, stale Turn, role-card downgrade, empty body and changed approved spec",t=>{
 const f=fixture(t,"story");
 assert.throws(()=>f.register({entries:[{ref:"n1",title:"没有被用户确认的神秘世界"}]}),
  {code:"assistant_deliverable_source_unconfirmed"});
 const later=f.turn("新指令：请调整故事内容");
 assert.throws(()=>f.register(),{code:"assistant_task_turn_not_current"});
 const required=f.register({requestId:"fresh",sourceTurnMessageId:later});
 assert.equal(required.existing,false);
 const short=[{type:"create_text",ref:"deliverable_1",title:"故事大纲",content:"一段短故事"}];
 assert.throws(()=>f.plan({actions:short}),{code:"assistant_deliverable_content_invalid"});
 const step=f.plan();
 const pre=JSON.parse(f.db.prepare("SELECT preconditions_json FROM assistant_task_steps WHERE id=?").get(step.stepId).preconditions_json);
 pre.deliverableSpec.entries[0].title="违规修改故事标题";
 f.db.prepare("UPDATE assistant_task_steps SET preconditions_json=? WHERE id=?").run(JSON.stringify(pre),step.stepId);
 assert.throws(()=>f.approve(step),{code:"assistant_deliverable_spec_changed"});
 assert.equal(state(f).status,"waiting_approval");
});
test("P4.3 incomplete structured source cannot grant a Template exception or a completion",t=>{
 const f=fixture(t,"scene");
 assert.throws(()=>f.register({allowEmptyTemplate:true}),{code:"assistant_deliverable_source_unconfirmed"});
 assert.equal(count(f,"deliverable_required"),0);
 const blankTurn=f.turn("请生成空白场景设定模板，不填正文");
 f.register({requestId:"blank-require",sourceTurnMessageId:blankTurn,allowEmptyTemplate:true});
 const step=f.plan({actions:[{type:"create_text",ref:"deliverable_1",title:"场景设定",content:""}]});
 f.approve(step);f.commit(step);
 assert.equal(f.verify(step).verified,true);
});
test("P4.3 failure blocks, public safe replan revises an entire requirement, old receipt kept",t=>{
 const f=fixture(t,"story");f.register();const old=f.plan();f.approve(old);f.commit(old);
 const original=getProject(f.db,"p"),doc=structuredClone(original.document);
 doc.nodes[0].metadata.content="已被人改写的空正文";
 f.db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id='p'")
  .run(JSON.stringify(doc),original.revision+1);
 const failed=f.verify(old);
 assert.equal(failed.verified,false);
 assert.equal(state(f).status,"blocked");
 assert.equal(count(f,"deliverable_verification_failed"),1);
 const recovery=inspectAssistantTaskRecovery(f.db,{projectId:"p",taskId:f.task.id});
 assert.equal(recovery.canReplan,true);
 const next=replanAssistantTaskSafely(f.db,{projectId:"p",taskId:f.task.id,
  requestId:"replan",expectedPlanVersion:1,expectedProjectRevision:original.revision+1});
 assert.equal(next.activePlanVersion,2);
 assert.equal(mayCompleteAssistantTask(f.db,f.task.id),false);
 const fresh=f.turn("请修订故事大纲，保持原设定并增加开端与结局");
 assert.throws(()=>f.register({requestId:"revision-missing-version",sourceTurnMessageId:fresh}),
  {code:"assistant_task_not_editable"});
 const revised=registerAssistantStructuredTextDeliverable(f.db,{projectId:"p",taskId:f.task.id,
  requestId:"revision-2",sourceTurnMessageId:fresh,deliverableType:"story",
  entries:[{ref:"new_story",title:"故事大纲"}],requiredFields:["开端","结局"],
  expectedPlanVersion:2,confirmed:true});
 assert.equal(revised.planVersion,2);
 assert.equal(count(f,"deliverable_required"),1);
 assert.equal(count(f,"deliverable_revised"),1);
 assert.equal(currentAssistantTextDeliverable(f.db,f.task.id).planVersion,2);
 const text="开端：阳光洒落森林，小兔发现一颗失去光芒的星星。她与小龟穿越蜿蜒山路，经历骤雨和迷路后，学会倾听并帮助朋友。结局：两位朋友带着星星回到山谷，小动物们一起在星空下庆祝重逢，留下勇敢与友谊的温暖故事。";
 const second=planAssistantCanvasStep(f.db,{projectId:"p",taskId:f.task.id,
  requestId:"plan-2",expectedPlanVersion:2,expectedProjectRevision:getProject(f.db,"p").revision,
  actions:[{type:"create_text",ref:"new_story",title:"故事大纲",content:text}],
  center:{x:350,y:250}});
 decideAssistantTaskStep(f.db,{projectId:"p",taskId:f.task.id,stepId:second.stepId,
  requestId:"approve-2",expectedPlanVersion:2,actionDigest:second.actionDigest,decision:"approve"});
 executeAssistantCanvasStep(f.db,{projectId:"p",taskId:f.task.id,stepId:second.stepId,
  requestId:"execute-2",expectedPlanVersion:2,actionDigest:second.actionDigest});
 const done=verifyAssistantTextDeliverable(f.db,{projectId:"p",taskId:f.task.id,
  stepId:second.stepId,requestId:"verify-2",expectedPlanVersion:2,actionDigest:second.actionDigest});
 assert.equal(done.verified,true);assert.equal(state(f).status,"completed");
 assert.equal(f.db.prepare("SELECT receipt_trust FROM assistant_task_steps WHERE id=?").get(old.stepId).receipt_trust,"server_committed");
 assert.equal(count(f,"task_completed"),1);
});
test("P4.3 reject attempt to register a revision without public safe replan",t=>{
 const f=fixture(t,"story");f.register();
 assert.throws(()=>f.register({requestId:"other",expectedPlanVersion:2}),
  {code:"assistant_task_not_editable"});
});
test("P4.3 failed verify and completion update roll back together, retry succeeds",t=>{
 const f=fixture(t,"story");f.register();const step=f.plan();f.approve(step);f.commit(step);
 assert.throws(()=>f.verify(step,{afterCompletionUpdate:()=>{throw Error("crash_after_task_cas")}}),
  /crash_after_task_cas/);
 assert.equal(state(f).status,"ready");assert.equal(count(f,"deliverable_verified"),0);
 assert.equal(f.verify(step).verified,true);assert.equal(state(f).status,"completed");
});
test("P4.3 ZIP read-only Task cannot verify or register fresh specs",t=>{
 const f=fixture(t,"story");f.register();const step=f.plan();f.approve(step);f.commit(step);
 f.db.prepare("UPDATE assistant_tasks SET read_only=1 WHERE id=?").run(f.task.id);
 f.db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,'deliverable_verified',?,?)")
  .run(f.task.id,JSON.stringify({verified:true,source:"altered_zip"}),Date.now());
 assert.throws(()=>f.verify(step),{code:"assistant_deliverable_not_verifiable"});
 assert.throws(()=>f.register({requestId:"new-require"}),{code:"assistant_task_not_editable"});
 assert.equal(state(f).status,"ready");
});
test("P4.3 HTTP structured text registration -> Canvas Step -> explicit verify, no Provider",async t=>{
 const f=fixture(t,"scene");
 const app=buildApp({db:f.db,authorize:()=>true});t.after(()=>app.close());
 const url="/api/v1/projects/p/assistant/tasks/"+f.task.id;
 async function post(path,payload){
  const response=await app.inject({method:"POST",url:url+path,payload});
  assert.equal(response.statusCode,200,response.body);return response.json();
 }
 const required=await post("/deliverables/structured-text",{
  requestId:"http-require",sourceTurnMessageId:f.userTurn,deliverableType:"scene",
  entries:f.entries,expectedPlanVersion:1,confirmed:true});
 assert.equal(required.entries.length,1);
 const step=await post("/canvas-steps",{requestId:"http-plan",expectedPlanVersion:1,
  expectedProjectRevision:1,actions:[{type:"create_text",ref:"deliverable_1",
   title:"场景设定",content:definitions.scene.body}],center:{x:200,y:200}});
 await post("/steps/"+step.stepId+"/approval",{requestId:"http-approve",
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve"});
 await post("/steps/"+step.stepId+"/execute",{requestId:"http-execute",
  expectedPlanVersion:1,actionDigest:step.actionDigest});
 assert.equal(state(f).status,"ready");
 const verified=await post("/deliverables/text/verify",{requestId:"http-verify",
  stepId:step.stepId,expectedPlanVersion:1,actionDigest:step.actionDigest});
 assert.equal(verified.verified,true);assert.equal(state(f).status,"completed");
});

test("P4.3 Mock Provider sees only the server-frozen typed spec before graph planning",async t=>{
 const f=fixture(t,"story");f.register();
 const upstream=[];
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_v,cb)=>cb(Buffer.from("mock-key"))};
 const chat=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  const body=JSON.parse(options.body);upstream.push(body);
  return new Response(JSON.stringify({choices:[{message:{role:"assistant",
   content:JSON.stringify({answer:"故事大纲已生成",actions:[{
    type:"create_text",ref:"deliverable_1",title:"故事大纲",
    content:definitions.story.body}]})},finish_reason:"stop"}]}),{status:200});
 }});
 const app=buildApp({db:f.db,assistantChat:chat,authorize:()=>true});
 t.after(()=>app.close());
 const url="/api/v1/projects/p/assistant/chat";
 const response=await app.inject({method:"POST",url,payload:{
  channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
  model:"mock",canvasActions:true,messages:[{role:"user",content:definitions.story.request}],
  task:{taskId:f.task.id,turnMessageId:f.userTurn,requestId:"model-story"}}});
 assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json().actions,[{
  type:"create_text",ref:"deliverable_1",title:"故事大纲",content:definitions.story.body}]);
 assert.equal(upstream.length,1);
 const serialized=JSON.stringify(upstream[0]);
 assert.ok(serialized.includes("故事大纲"));
 assert.ok(serialized.includes("minMeaningfulChars"));
 assert.ok(serialized.includes("deliverable_1"));
 assert.ok(!serialized.includes("API密钥"));
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps").get().n,0,
  "model result cannot modify graph without Step approval");
 assert.equal(state(f).status,"planning");
});

test("P4.3 new user Turn revokes pending structured Step and old approval",t=>{
 const f=fixture(t,"scene");f.register();const step=f.plan();
 f.turn("新请求：请不要再使用原始场景文字");
 assert.throws(()=>f.approve(step),{code:"assistant_deliverable_source_turn_stale"});
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(step.stepId).status,
  "waiting_approval");
 const refused=decideAssistantTaskStep(f.db,{projectId:"p",taskId:f.task.id,
  stepId:step.stepId,requestId:"refuse-source",
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"reject"});
 assert.equal(refused.status,"blocked");
 assert.equal(inspectAssistantTaskRecovery(f.db,{projectId:"p",taskId:f.task.id}).canReplan,true);
 assert.equal(getProject(f.db,"p").revision,1);
});
test("P4.3 approved structured Step can be safely rejected after revoked source or changed graph",t=>{
 const f=fixture(t,"story");f.register();const step=f.plan();f.approve(step);
 f.turn("新的用户指令：请更改故事设定");
 const doc=getProject(f.db,"p").document;
 f.db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'")
  .run(JSON.stringify({...doc,title:"画布被编辑"}));
 assert.throws(()=>f.commit(step),{code:"assistant_deliverable_source_turn_stale"});
 const rejected=decideAssistantTaskStep(f.db,{projectId:"p",taskId:f.task.id,
  stepId:step.stepId,requestId:"revoke-ready",
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"reject"});
 assert.equal(rejected.status,"blocked");
 assert.equal(inspectAssistantTaskRecovery(f.db,{projectId:"p",taskId:f.task.id}).canReplan,true);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,0);
});
test("P4.3 source Turn changed after graph receipt leads to blocked verification and safe replan",t=>{
 const f=fixture(t,"story");f.register();const step=f.plan();f.approve(step);f.commit(step);
 f.turn("补充指令：新的故事大纲必须加入一位新角色");
 const verified=f.verify(step);
 assert.equal(verified.verified,false);
 assert.equal(verified.reason,"assistant_deliverable_source_turn_stale");
 assert.equal(state(f).status,"blocked");
 assert.equal(count(f,"task_completed"),0);
 assert.equal(inspectAssistantTaskRecovery(f.db,{projectId:"p",taskId:f.task.id}).canReplan,true);
});

test("P4.3 verifier is the only completion path even when planner requests finalize",t=>{
 const f=fixture(t,"story");f.register();
 assert.throws(()=>f.plan({finalizeTask:true}),{code:"assistant_deliverable_plan_invalid"});
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps").get().n,0);
 assert.equal(state(f).status,"planning");
});
test("P4.3 changed required specification invalidates old graph approval",t=>{
 const f=fixture(t,"scene");f.register();const step=f.plan();
 const row=f.db.prepare("SELECT preconditions_json FROM assistant_task_steps WHERE id=?").get(step.stepId);
 const pre=JSON.parse(row.preconditions_json);
 pre.deliverableSpec.minMeaningfulChars=1;
 f.db.prepare("UPDATE assistant_task_steps SET preconditions_json=? WHERE id=?")
  .run(JSON.stringify(pre),step.stepId);
 assert.throws(()=>f.approve(step),{code:"assistant_deliverable_spec_changed"});
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,0);
});
test("P4.3 two SQLite verifiers race: exactly one may complete structured Task",async t=>{
 const f=fixture(t,"story");f.register();const step=f.plan();f.approve(step);f.commit(step);
 const dir=mkdtempSync(join(tmpdir(),"atelier-p43-race-"));
 const file=join(dir,"db.sqlite");await backup(f.db,file);
 const left=new DatabaseSync(file),right=new DatabaseSync(file);
 t.after(()=>{left.close();right.close();rmSync(dir,{recursive:true,force:true})});
 const req={projectId:"p",taskId:f.task.id,stepId:step.stepId,
  expectedPlanVersion:1,actionDigest:step.actionDigest};
 const results=await Promise.all([
  Promise.resolve().then(()=>verifyAssistantTextDeliverable(left,{...req,requestId:"verify-left"})),
  Promise.resolve().then(()=>verifyAssistantTextDeliverable(right,{...req,requestId:"verify-right"}))
 ]);
 assert.equal(results.filter(v=>v.verified&&v.existing===false).length,1);
 assert.equal(results.filter(v=>v.verified&&v.existing===true).length,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='deliverable_verified'").get().n,1);
 assert.equal(left.prepare("SELECT status FROM assistant_tasks").get().status,"completed");
});

test("P4.3 a stale spec fails before any billable Provider POST",async t=>{
 const f=fixture(t,"story");f.register();
 const nextTurn=f.turn("本轮撤回故事大纲要求，改为讨论分镜技术");
 let posts=0;
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_v,cb)=>cb(Buffer.from("mock-key"))};
 const chat=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  posts++;return new Response(JSON.stringify({choices:[{message:{role:"assistant",content:"不应被调用"}}]}),{status:200});
 }});
 const app=buildApp({db:f.db,assistantChat:chat,authorize:()=>true});
 t.after(()=>app.close());
 const response=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:{
  channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
  model:"mock",canvasActions:false,messages:[{role:"user",content:"本轮撤回故事大纲要求，改为讨论分镜技术"}],
  task:{taskId:f.task.id,turnMessageId:nextTurn,requestId:"stale-structured"}}});
 assert.equal(response.statusCode,409,response.body);
 assert.equal(response.json().code,"assistant_deliverable_source_turn_stale");
 assert.equal(posts,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_model_calls").get().n,0);
});
