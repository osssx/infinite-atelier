import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {createAssistantTask,appendAssistantTaskTurn} from "./assistant-tasks.mjs";
import {parseAssistantSemanticCandidates} from "./assistant-semantic-proposals.mjs";
import {listAssistantSemanticProposals} from "./assistant-semantic-proposals.mjs";
import {exportAssistantTaskArchive,importAssistantTaskArchive} from "./assistant-task-archive.mjs";
import {createProject} from "./projects.mjs";
import {writeTransaction} from "./repository.mjs";

const projectId="semantic-proposals-test";
const plain={includeContext:false,scope:"selection",includedIds:[]};
const privatePolicy={includeContext:true,scope:"selection",includedIds:["private"]};
const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
 withSecretVersion:(_v,cb)=>cb(Buffer.from("test-key"))};
const answer=value=>new Response(JSON.stringify({choices:[{message:{content:value},finish_reason:"stop"}]}),
 {status:200,headers:{"content-type":"application/json"}});
async function fixture(t,modelAnswer,{scope=plain}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const captured=[];let calls=0;
 const service=createAssistantChatService({vault,retryDelayMs:0,
  compatibleUpstreamCall:async(_url,options)=>{
   calls++;captured.push(JSON.parse(options.body));return answer(modelAnswer);
  }});
 const app=buildApp({db,authorize:()=>true,assistantChat:service});
 t.after(async()=>{await app.close();db.close()});
 const api=async(method,url,body)=>{
  const reply=await app.inject({method,url,...(body===undefined?{}:{payload:body})});
  return {status:reply.statusCode,body:reply.json()};
 };
 assert.equal((await api("POST","/api/v1/projects",{id:projectId,document:{nodes:[
  {id:"private",type:"text",title:"SECRET_NODE",metadata:{content:"SECRET_CANVAS_TEXT"}}],connections:[]}})).status,201);
 const task=createAssistantTask(db,{projectId,chatSessionId:"chat-a",rootMessageId:"root-1",
  originalRequest:"连续制作短剧",requestId:"create",contextPolicy:scope});
 const taskId=task.task.id,base="/api/v1/projects/"+projectId+"/assistant/tasks/"+taskId;
 let index=0;
 const propose=async(p=scope)=>{
  index++;const turn="proposal-turn-"+index;
  appendAssistantTaskTurn(db,{projectId,taskId,requestId:turn,messageId:turn,
   text:"请提取需要长期保留的创作约束",contextPolicy:p});
  return api("POST","/api/v1/projects/"+projectId+"/assistant/chat",{
   channelId:"channel-a",provider:"openai_compatible",model:"demo",
   baseUrl:"http://localhost:8080/v1",canvasActions:false,
   task:{taskId,turnMessageId:turn,requestId:"model-proposal-"+index,callKind:"semantic_proposal"},
   messages:[{role:"user",content:"用户本轮请求：长期约束候选"}]});
 };
 const decide=(id,decision,revision,contextPolicy=plain,requestId="decision-"+id)=>api("POST",base+"/semantic-proposals/decision",
  {requestId,proposalId:id,decision,expectedRevision:revision,confirmed:true,contextPolicy});
 return {db,api,taskId,base,propose,decide,captured,get calls(){return calls}};
}
test("P3 proposal-only model call persists pending candidates; user accepts/rejects one by one atomically",async t=>{
 const fx=await fixture(t,JSON.stringify({proposals:[
  {kind:"constraint",text:"场景始终为水彩画风"},{kind:"decision",text:"最后一幕月台告别"}]}));
 const sent=await fx.propose();
 assert.equal(sent.status,200,JSON.stringify(sent.body));
 assert.equal(sent.body.proposals.length,2);
 assert.equal(sent.body.proposals[0].kind,"constraint");
 const id=sent.body.proposals[0].id,other=sent.body.proposals[1].id;
 assert.equal(fx.calls,1);
 const pending=await fx.api("GET",fx.base+"/semantic-proposals");
 assert.equal(pending.status,200,JSON.stringify(pending.body));
 assert.deepEqual(pending.body.proposals.map(p=>p.status),["pending","pending"]);
 assert.equal(pending.body.proposals.every(p=>p.source==="model_suggested"),true);
 let row=fx.db.prepare("SELECT goal_json,constraints_json FROM assistant_tasks WHERE id=?").get(fx.taskId);
 assert.equal(JSON.parse(row.constraints_json).semantic,undefined,"model must not auto-confirm");
 assert.equal(fx.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
 assert.equal(fx.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps").get().n,0);
 const accepted=await fx.decide(id,"accept",0,plain,"accept-one");
 assert.equal(accepted.status,200,JSON.stringify(accepted.body));
 assert.equal(accepted.body.semanticRevision,1);
 const again=await fx.decide(id,"accept",0,plain,"accept-one");
 assert.equal(again.status,200);assert.equal(again.body.existing,true);
 assert.equal((await fx.decide(id,"accept",1,plain,"accept-other")).status,409);
 const rejected=await fx.decide(other,"reject",1,plain,"reject-two");
 assert.equal(rejected.status,200,JSON.stringify(rejected.body));
 assert.equal(rejected.body.semanticRevision,1);
 row=fx.db.prepare("SELECT constraints_json FROM assistant_tasks WHERE id=?").get(fx.taskId);
 const semantic=JSON.parse(row.constraints_json).semantic;
 assert.equal(semantic.revision,1);
 assert.equal(semantic.notes.length,1);
 assert.equal(semantic.notes[0].text,"场景始终为水彩画风");
 assert.equal(semantic.notes[0].provenance,"user_confirmed");
 assert.deepEqual((await fx.api("GET",fx.base+"/semantic-proposals")).body.proposals.map(p=>p.status),["accepted","rejected"]);
 assert.equal(fx.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE task_id=? AND kind='semantic_proposals_generated'").get(fx.taskId).n,1);
 assert.equal(fx.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE task_id=? AND kind='semantic_proposal_decided'").get(fx.taskId).n,2);
 assert.equal(fx.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE task_id=? AND kind='semantic_user_confirmed'").get(fx.taskId).n,1,
  "accepted proposal must also have a user-confirmed semantic audit receipt"); const invalid=await fx.api("POST",fx.base+"/semantic-proposals/decision",{
  requestId:"forge",proposalId:id,decision:"accept",expectedRevision:1,
  confirmed:true,contextPolicy:plain,text:"伪造另一个候选"});
 assert.equal(invalid.status,409,"extra client fields are stripped; a decided proposal must still reject another accept");
 assert.equal((await fx.api("GET",fx.base)).body.task.semantic.revision,1);
});

test("P3 candidate request replay is cached and does not repeat model POST or suggestion events",async t=>{
 const fx=await fixture(t,'{"proposals":[{"kind":"goal","text":"制作十集短剧"}]}');
 const first=await fx.propose();
 assert.equal(first.status,200);
 const again=await fx.api("POST","/api/v1/projects/"+projectId+"/assistant/chat",{
  channelId:"channel-a",provider:"openai_compatible",model:"demo",baseUrl:"http://localhost:8080/v1",
  canvasActions:false,task:{taskId:fx.taskId,turnMessageId:"proposal-turn-1",
   requestId:"model-proposal-1",callKind:"semantic_proposal"},
  messages:[{role:"user",content:"用户本轮请求：长期约束候选"}]});
 assert.equal(again.status,200,JSON.stringify(again.body));
 assert.deepEqual(again.body.proposals,first.body.proposals);
 assert.equal(fx.calls,1);
 const chosen=first.body.proposals[0];
 assert.equal((await fx.decide(chosen.id,"accept",0,plain,"confirm-goal")).status,200);
 const task=(await fx.api("GET",fx.base)).body.task;
 assert.equal(task.semantic.goal.text,"制作十集短剧");
 assert.equal(task.semantic.revision,1);
 assert.equal(fx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,0);
});

test("P3 proposed private information is blocked from acceptance after frozen policy narrows",async t=>{
 const fx=await fixture(t,'{"proposals":[{"kind":"constraint","text":"保持私有节点内容 SECRET_CANVAS_TEXT"}]}',{scope:privatePolicy});
 const first=await fx.propose(privatePolicy);
 assert.equal(first.status,200,JSON.stringify(first.body));
 assert.equal(fx.captured.length,1);
 const upstream=JSON.stringify(fx.captured[0]);
 assert.match(upstream,/SECRET_CANVAS_TEXT/);
 const id=first.body.proposals[0].id;
 const blocked=await fx.decide(id,"accept",0,plain,"accept-denied");
 assert.equal(blocked.status,409);
 assert.equal(blocked.body.code,"assistant_semantic_proposal_scope_changed");
 assert.equal((await fx.api("GET",fx.base)).body.task.semantic.revision,0);
 const accepted=await fx.decide(id,"accept",0,privatePolicy,"accept-authorized");
 assert.equal(accepted.status,200,JSON.stringify(accepted.body));
 const saved=(await fx.api("GET",fx.base)).body.task.semantic.notes[0];
 assert.deepEqual(saved.contextPolicy,privatePolicy);
});

test("P3 malformed/unsafe model output yields no candidate and no approved semantic state",async t=>{
 assert.deepEqual(parseAssistantSemanticCandidates("not JSON"),[]);
 assert.deepEqual(parseAssistantSemanticCandidates('{"proposals":[{"kind":"decision","text":"sk-1234567890123456789012345"}]}'),[]);
 assert.deepEqual(parseAssistantSemanticCandidates('{"proposals":[{"kind":"constraint","text":"x"}]}'),[{kind:"constraint",text:"x"}]);
 const fx=await fixture(t,"没有明确需要保存的内容");
 const response=await fx.propose();
 assert.equal(response.status,200,JSON.stringify(response.body));
 assert.deepEqual(response.body.proposals,[]);
 assert.deepEqual((await fx.api("GET",fx.base+"/semantic-proposals")).body.proposals,[]);
 assert.equal((await fx.api("GET",fx.base)).body.task.semantic.revision,0);
});

test("P3 proposal history persists through 32+ turns and portable ZIP restore without execution links",async t=>{
 const fx=await fixture(t,'{"proposals":[{"kind":"goal","text":"坚持每集不超过一分钟"}]}');
 for(let i=1;i<=32;i++)appendAssistantTaskTurn(fx.db,{
  projectId,taskId:fx.taskId,requestId:"long-"+i,messageId:"history-"+i,
  text:"第"+i+"轮：短剧长度一致",contextPolicy:plain});
 const created=await fx.propose();
 assert.equal(created.status,200,JSON.stringify(created.body));
 assert.equal(created.body.proposals.length,1);
 const fromRequest=JSON.stringify(fx.captured[0]);
 assert.match(fromRequest,/累计用户续写轮次：33/);
 assert.match(fromRequest,/原始任务要求/);
 const backup=exportAssistantTaskArchive(fx.db,projectId);
 const restored=new DatabaseSync(":memory:");initializeSchema(restored);
 try{
  createProject(restored,{id:"imported-semantic-proposal-project",document:{nodes:[],connections:[]}});
  writeTransaction(restored,()=>importAssistantTaskArchive(restored,"imported-semantic-proposal-project",backup));
  const row=restored.prepare("SELECT id,read_only FROM assistant_tasks WHERE project_id=?")
   .get("imported-semantic-proposal-project");
  assert.equal(row.read_only,1);
  const recovered=listAssistantSemanticProposals(restored,{
   projectId:"imported-semantic-proposal-project",taskId:row.id});
  assert.equal(recovered.proposals.length,1);
  assert.equal(recovered.proposals[0].id,created.body.proposals[0].id);
  assert.equal(recovered.proposals[0].status,"pending");
  assert.equal(recovered.proposals[0].text,"坚持每集不超过一分钟");
  assert.equal(restored.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
  assert.equal(restored.prepare("SELECT COUNT(*) n FROM assistant_model_calls").get().n,0);
 }finally{restored.close()}
});

test("P3 proposal extraction refuses canvas/actions or tools before the paid request",async t=>{
 const fx=await fixture(t,'{"proposals":[{"kind":"decision","text":"无关"}]}');
 const body={channelId:"channel-a",provider:"openai_compatible",model:"demo",
  baseUrl:"http://localhost:8080/v1",
  task:{taskId:fx.taskId,turnMessageId:"not-registered",requestId:"bad-proposal-model",callKind:"semantic_proposal"},
  canvasActions:true,messages:[{role:"user",content:"执行节点生成"}]};
 const denied=await fx.api("POST","/api/v1/projects/"+projectId+"/assistant/chat",body);
 assert.equal(denied.status,400,JSON.stringify(denied.body));
 assert.equal(denied.body.code,"assistant_semantic_proposal_invalid");
 assert.equal(fx.calls,0);
 assert.equal(fx.db.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE command_kind='model_infer'").get().n,0);
});

test("P3 archived Task cannot decide proposals, but proposal history stays read-only",async t=>{
 const fx=await fixture(t,'{"proposals":[{"kind":"constraint","text":"禁止跳过审核"}]}');
 const first=await fx.propose();
 assert.equal(first.status,200);
 const id=first.body.proposals[0].id;
 fx.db.prepare("UPDATE assistant_tasks SET read_only=1 WHERE id=?").run(fx.taskId);
 assert.equal((await fx.api("GET",fx.base+"/semantic-proposals")).body.proposals[0].status,"pending");
 const denied=await fx.decide(id,"accept",0);
 assert.equal(denied.status,409);
 assert.equal(denied.body.code,"assistant_task_not_editable");
});
