import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn,cancelAssistantTask} from "./assistant-tasks.mjs";
import {createAssistantAgentReadSession,createCanvasNodeReader,ASSISTANT_READ_TOOL_REGISTRY} from "./assistant-agent-read-tools.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {beginAssistantModelCommand,failAssistantModelCommand} from "./assistant-model-calls.mjs";

const visibleContent="这只兔子穿着蓝色斗篷，在山谷中探索新的星光，温柔勇敢并且善于合作。";
const secretContent="隐藏节点中的私人剧本和故事结局不允许外发，包含一段足够长的秘密背景资料。";
const node=(id,title,content)=>({id,type:"text",title,position:{x:0,y:0},
 width:340,height:240,metadata:{content}});
const chosen={includeContext:true,scope:"selection",includedIds:["visible"]};
function fixture(t,{policy=chosen,content=visibleContent}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:{nodes:[
  node("visible","小兔角色卡",content),node("secret","秘密故事",secretContent)
 ],connections:[{id:"edge1",fromNodeId:"visible",toNodeId:"secret",fromPortId:"out",toPortId:"in"}]}});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",
  rootMessageId:"root",originalRequest:"找到角色节点",requestId:"task"}).task;
 appendAssistantTaskTurn(db,{projectId:"p",taskId:task.id,requestId:"old-turn",messageId:"old-message",
  text:"主要角色包括小兔嘟嘟、兔妈妈、小龟慢慢。",
  contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}});
 appendAssistantTaskTurn(db,{projectId:"p",taskId:task.id,requestId:"turn",messageId:"message",
  text:"请查找画布中的角色节点并概括它的内容",contextPolicy:policy});
 const make=()=>createAssistantAgentReadSession(db,{projectId:"p",taskId:task.id,
  turnMessageId:"message",requestId:"agent-model"});
 return {db,task,make};
}
function invoke(session,name,args,callId="call1",round=0){
 return JSON.parse(session.invoke(name,args,{callId,round}));
}
test("P4.2a Tool Registry has only no-approval, read-only functions",()=>{
 assert.equal(ASSISTANT_READ_TOOL_REGISTRY.length,7);
 assert.ok(ASSISTANT_READ_TOOL_REGISTRY.every(t=>t.effect==="read"&&t.approval==="none"));
 assert.ok(!ASSISTANT_READ_TOOL_REGISTRY.some(t=>/(?:write|execute|delete|submit|run_skill)/.test(t.providerName)));
});
test("paginates authorized text without changing whitespace or splitting Unicode characters",t=>{
 const content="第一段\n  角色😀\t\n".repeat(220);
 const f=fixture(t,{content}),session=f.make();
 const first=invoke(session,"canvas_read_nodes",{node_ids:["visible"],offset:0}).data;
 const second=invoke(session,"canvas_read_nodes",{node_ids:["visible"],offset:first.nextOffset},"call2").data;
 assert.ok(first.nextOffset>0);
 assert.equal(first.nodes[0].content+second.nodes[0].content,content.slice(0,second.endOffset));
 assert.throws(()=>invoke(session,"canvas_read_nodes",{node_ids:["secret"],offset:0},"call3"),
  {code:"assistant_agent_context_scope_denied"});
});
test("reads effective defaults without disclosing unauthorized node settings",t=>{
 const f=fixture(t);
 f.db.prepare("UPDATE ui_settings SET value_json=? WHERE name='model_config'").run(JSON.stringify({
  comfyWorkflowDefaults:{image:{templateId:"moss",templateRevision:"r1"}}
 }));
 const session=f.make();
 assert.match(invoke(session,"canvas_get_generation_settings",{}).data.settings.join("\n"),/ComfyUI 工作流 moss/);
 assert.throws(()=>invoke(session,"canvas_get_generation_settings",{node_id:"secret"},"call2"),
  {code:"assistant_agent_context_scope_denied"});
});

test("P4.2a selected node text is readable, hidden neighbor is not",t=>{
 const f=fixture(t),session=f.make();
 const result=invoke(session,"canvas_read_nodes",{node_ids:["visible"]});
 assert.equal(result.ok,true);
 assert.match(result.data.nodes[0].content,/蓝色斗篷/);
 assert.throws(()=>invoke(session,"canvas_read_nodes",{node_ids:["secret"]},"denied"),{
  code:"assistant_agent_context_scope_denied"});
 assert.throws(()=>invoke(session,"canvas_get_map",{},"call1"),{
  code:"assistant_agent_tool_replay_conflict"});
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='agent_read_tool_completed'").get().n,1);
 const stored=f.db.prepare("SELECT payload_json FROM assistant_task_events WHERE kind='agent_read_tool_completed'").get();
 assert.ok(!stored.payload_json.includes(visibleContent),"audit metadata never persists raw content");
});
test("P4.2a overview mode returns only title and no content",t=>{
 const f=fixture(t,{policy:{includeContext:true,scope:"overview",includedIds:[]}}),s=f.make();
 const map=invoke(s,"canvas_get_map",{});
 assert.ok(map.data.nodes.some(n=>n.title==="秘密故事"));
 assert.ok(!JSON.stringify(map).includes(secretContent));
 assert.throws(()=>invoke(s,"canvas_read_nodes",{node_ids:["visible"]},"read2"),{
  code:"assistant_agent_context_scope_denied"});
 const search=invoke(s,"canvas_search_nodes",{query:"私人剧本"},"search2");
 assert.deepEqual(search.data.matches,[]);
});
test("P4.2a task.read_history and creative.search expose only authorized Task sources",t=>{
 const f=fixture(t),session=f.make();
 const history=invoke(session,"task_read_history",{limit:2},"history");
 assert.ok(history.data.turns.some(turn=>turn.messageId==="old-message"));
 assert.ok(!JSON.stringify(history).includes(secretContent));
 assert.deepEqual(history.data.steps,[]);
 const creative=invoke(session,"creative_search",{kind:"character",query:"兔"},"creative");
 assert.ok(creative.data.matches.some(item=>item.title==="小兔嘟嘟"));
 assert.ok(creative.data.matches.every(item=>item.provenance==="user_statement"));
 assert.ok(!JSON.stringify(creative).includes(secretContent));
});
test("P4.2a no canvas context means no node listing or hidden search",t=>{
 const f=fixture(t,{policy:{includeContext:false,scope:"selection",includedIds:[]}}),s=f.make();
 assert.deepEqual(invoke(s,"canvas_get_map",{}).data.nodes,[]);
 assert.deepEqual(invoke(s,"canvas_search_nodes",{query:"秘密"},"search").data.matches,[]);
});
test("P4.2a connections never traverse an unselected endpoint",t=>{
 const f=fixture(t),s=f.make();
 assert.deepEqual(invoke(s,"canvas_get_connections",{}).data.connections,[]);
 const map=invoke(s,"canvas_get_map",{},"map");
 assert.deepEqual(map.data.nodes.map(n=>n.id),["visible"]);
});

test("P4.2a connections preserve the actual canvas port IDs",t=>{
 const f=fixture(t,{policy:{...chosen,includedIds:["visible","secret"]}});
 const result=invoke(f.make(),"canvas_get_connections",{});
 assert.deepEqual(result.data.connections,[{fromNodeId:"visible",toNodeId:"secret",fromPortId:"out",toPortId:"in"}]);
});

test("P4.2a connection overviews fit complete edges into per-call and run byte budgets",t=>{
 const f=fixture(t,{policy:{includeContext:true,scope:"overview",includedIds:[]}});
 const nodes=Array.from({length:40},(_,i)=>({id:"image-fixture-"+i,type:"image",title:"图片"+i,
  position:{x:0,y:0},width:320,height:240,metadata:{}}));
 const connections=nodes.slice(1).map((n,i)=>({id:"edge-"+i,fromNodeId:nodes[i].id,toNodeId:n.id,
  fromPortId:"image",toPortId:"reference"}));
 f.db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'")
  .run(JSON.stringify({nodes,connections}));
 const session=f.make();
 let firstCount=0;
 for(let i=0;i<4;i++){
  const raw=session.invoke("canvas_get_connections",{},{callId:"edges"+i});
  assert.ok(Buffer.byteLength(raw)<=4000);
  const result=JSON.parse(raw);
  assert.equal(result.data.truncated,true);
  assert.ok(session.bytes<=12*1024);
  for(const edge of result.data.connections){
   assert.equal(edge.fromPortId,"image");assert.equal(edge.toPortId,"reference");
   assert.ok(nodes.some(n=>n.id===edge.fromNodeId));
   assert.ok(nodes.some(n=>n.id===edge.toNodeId));
  }
  if(i===0){firstCount=result.data.connections.length;assert.ok(firstCount>0&&firstCount<39);}
  if(i===3)assert.ok(result.data.connections.length<firstCount);
 }
});

test("P4.2a explicitly selected plugin node IDs remain readable",t=>{
 const nodeId="comfy:workflow/plugin.node@v1";
 const f=fixture(t,{policy:{...chosen,includedIds:[nodeId]}});
 f.db.prepare("UPDATE projects SET document_json=json_set(document_json,'$.nodes[0].id',?) WHERE id='p'").run(nodeId);
 const result=invoke(f.make(),"canvas_read_nodes",{node_ids:[nodeId]});
 assert.equal(result.data.nodes[0].id,nodeId);
 assert.equal(result.data.nodes[0].content,visibleContent);
});

test("P4.2a tool call IDs are scoped to the model request",t=>{
 const f=fixture(t);
 invoke(f.make(),"canvas_get_map",{},"tool1");
 const next=createAssistantAgentReadSession(f.db,{projectId:"p",taskId:f.task.id,
  turnMessageId:"message",requestId:"next-model"});
 assert.equal(invoke(next,"canvas_get_map",{},"tool1").ok,true);
 const replay=f.make();
 assert.throws(()=>invoke(replay,"canvas_get_map",{},"tool1"),{code:"assistant_agent_tool_replayed"});
});

test("P4.2a kind-filtered creative searches do not lose style behind scenes",t=>{
 const f=fixture(t);
 const append=(messageId,text)=>appendAssistantTaskTurn(f.db,{projectId:"p",taskId:f.task.id,
  requestId:"append-"+messageId,messageId,text,contextPolicy:chosen});
 append("style","美术风格：温暖柔光，柔和水彩质感与清晰圆润轮廓，低饱和绿色配色。");
 for(let i=0;i<20;i++)append("scene-"+i,"场景设定：清晨的森林广场，有高大树木、柔和阳光与木质舞台。");
 append("latest","请查找创作资料中的美术风格");
 const session=createAssistantAgentReadSession(f.db,{projectId:"p",taskId:f.task.id,
  turnMessageId:"latest",requestId:"style-search"});
 const result=invoke(session,"creative_search",{kind:"style"});
 assert.equal(result.data.matches.length,1);
 assert.match(result.data.matches[0].excerpt,/柔和水彩/);
});
test("P4.2a tool names, arguments, byte budget and duplicate IDs fail closed",t=>{
 const f=fixture(t),s=f.make();
 assert.throws(()=>invoke(s,"delete_node",{nodeId:"visible"}),{code:"assistant_agent_tool_unauthorized"});
 assert.throws(()=>invoke(s,"canvas_search_nodes",{query:"a",execute:true}),{
  code:"assistant_agent_tool_arguments_invalid"});
 assert.throws(()=>invoke(s,"canvas_read_nodes",{node_ids:["visible","visible"]}),{
  code:"assistant_agent_tool_arguments_invalid"});
 invoke(s,"canvas_get_map",{});
 assert.throws(()=>invoke(s,"canvas_get_map",{}),{code:"assistant_agent_tool_replayed"});
});
test("P4.2a an unsubmitted model preflight can reuse the round-zero checkpoint safely",t=>{
 const f=fixture(t),requestId="recover-before-post";
 const payload={task:{turnMessageId:"message"},agentReadTools:true};
 const command={projectId:"p",taskId:f.task.id,requestId,requestPayload:payload};
 beginAssistantModelCommand(f.db,command);
 const first=createAssistantAgentReadSession(f.db,{projectId:"p",taskId:f.task.id,
  turnMessageId:"message",requestId});
 first.recordRound(0);
 failAssistantModelCommand(f.db,{projectId:"p",taskId:f.task.id,requestId});
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls").get().n,0);
 beginAssistantModelCommand(f.db,command);
 const recovered=createAssistantAgentReadSession(f.db,{projectId:"p",taskId:f.task.id,
  turnMessageId:"message",requestId});
 recovered.recordRound(0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='agent_read_round_planned'").get().n,1);
});
test("P4.2a changed graph or new user turn invalidates this read session",t=>{
 const f=fixture(t),s=f.make();
 f.db.prepare("UPDATE projects SET revision=revision+1 WHERE id='p'").run();
 assert.throws(()=>invoke(s,"canvas_get_map",{}),{code:"assistant_agent_read_source_changed"});
 const second=f.make();
 appendAssistantTaskTurn(f.db,{projectId:"p",taskId:f.task.id,requestId:"next-turn",
  messageId:"next-message",text:"新的请求",contextPolicy:chosen});
 assert.throws(()=>invoke(second,"canvas_get_map",{}),{code:"assistant_agent_read_turn_stale"});
});

const firstTool=(name="canvas_read_nodes",args={node_ids:["visible"]},toolId="tool1")=>({
 choices:[{message:{role:"assistant",content:null,tool_calls:[
  {id:toolId,type:"function",function:{name,arguments:JSON.stringify(args)}}
 ]},finish_reason:"tool_calls"}]
});
const finalAnswer={choices:[{message:{role:"assistant",content:"小兔的蓝色斗篷体现了勇敢的性格。"},
 finish_reason:"stop"}]};
function httpFixture(t,{responseGenerator}={}){
 const f=fixture(t);
 const requests=[];
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_version,fn)=>fn(Buffer.from("mock-key"))};
 const assistantChat=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  const data=JSON.parse(options.body);requests.push(data);
  const payload=responseGenerator?await responseGenerator(data,requests.length):requests.length===1?
   firstTool():finalAnswer;
  return new Response(JSON.stringify(payload),{status:200});
 }});
 const app=buildApp({db:f.db,assistantChat,authorize:()=>true});t.after(()=>app.close());
 const base="/api/v1/projects/p/assistant/chat";
 const req=requestId=>({
  channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
  model:"mock",canvasActions:false,agentReadTools:true,
  messages:[{role:"user",content:"请查找画布中的角色节点并概括它的内容"}],
  task:{taskId:f.task.id,turnMessageId:"message",requestId}
 });
 return {...f,requests,app,base,req};
}
test("P4.2a HTTP model -> selected-node read -> model, no canvas writes",async t=>{
 const f=httpFixture(t);
 const response=await f.app.inject({method:"POST",url:f.base,payload:f.req("agent-round")});
 assert.equal(response.statusCode,200,response.body);
 const output=response.json();
 assert.equal(output.answer,"小兔的蓝色斗篷体现了勇敢的性格。");
 assert.equal(output.agentReadRounds,1);
 assert.equal(output.agentReadToolCalls.length,1);
 assert.equal(f.requests.length,2);
 assert.equal(f.requests[0].tools[0].function.name,"canvas_get_map");
 const second=JSON.stringify(f.requests[1]);
 assert.match(second,/蓝色斗篷/);
 assert.ok(!second.includes(secretContent));
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls").get().n,2);
 assert.deepEqual(f.db.prepare("SELECT json_extract(payload_json,'$.round') AS round FROM assistant_task_events WHERE kind='agent_read_round_planned' ORDER BY seq").all().map(row=>row.round),[0,1]);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='agent_read_tool_completed'").get().n,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,0);
 const replay=await f.app.inject({method:"POST",url:f.base,payload:f.req("agent-round")});
 assert.equal(replay.statusCode,200,replay.body);
 assert.equal(f.requests.length,2,"idempotent same command cannot re-bill");
});
test("P4.2a unknown read-tool name rejects with no following provider POST",async t=>{
 const f=httpFixture(t,{responseGenerator:()=>firstTool("canvas_delete_node",{nodeId:"visible"})});
 const response=await f.app.inject({method:"POST",url:f.base,payload:f.req("agent-denied")});
 assert.equal(response.statusCode,403,response.body);
 assert.equal(response.json().code,"assistant_agent_tool_unauthorized");
 assert.equal(f.requests.length,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
});
test("P4.2a more than 2 read rounds stops and cannot perform another upstream POST",async t=>{
 const f=httpFixture(t,{responseGenerator:(_body,seq)=>firstTool("canvas_get_map",{},"t"+seq)});
 const response=await f.app.inject({method:"POST",url:f.base,payload:f.req("agent-loop")});
 assert.equal(response.statusCode,409,response.body);
 assert.equal(response.json().code,"assistant_agent_tool_round_limit");
 assert.equal(f.requests.length,3);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='agent_read_round_planned'").get().n,3);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='agent_read_tool_completed'").get().n,2);
});

test("P4.2a read runs never add an unaudited format-repair POST",async t=>{
 const f=httpFixture(t,{responseGenerator:(_body,seq)=>seq<=2?
  firstTool("canvas_get_map",{},"tool"+seq):
  {choices:[{message:{role:"assistant",content:JSON.stringify({answer:"我会创建文本节点",actions:[]})},finish_reason:"stop"}]}});
 const text="请查找画布中的角色节点并创建文本节点";
 appendAssistantTaskTurn(f.db,{projectId:"p",taskId:f.task.id,requestId:"edit-turn",
  messageId:"edit-message",text,contextPolicy:chosen});
 const response=await f.app.inject({method:"POST",url:f.base,payload:{...f.req("read-edit"),
  canvasActions:true,messages:[{role:"user",content:text}],
  task:{taskId:f.task.id,turnMessageId:"edit-message",requestId:"read-edit"}}});
 assert.equal(response.statusCode,502,response.body);
 assert.equal(response.json().code,"assistant_actions_missing");
 assert.equal(f.requests.length,3);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_model_calls WHERE call_kind='format_repair'").get().n,0);
});

test("P4.2a inspecting connections cannot return executable actions",async t=>{
 const f=httpFixture(t,{responseGenerator:()=>({choices:[{message:{role:"assistant",
  content:JSON.stringify({answer:"检查完成",actions:[{type:"delete_node",nodeId:"visible"}]})},finish_reason:"stop"}]})});
 const text="检查画布节点连线";
 appendAssistantTaskTurn(f.db,{projectId:"p",taskId:f.task.id,requestId:"inspect-turn",
  messageId:"inspect-message",text,contextPolicy:chosen});
 const response=await f.app.inject({method:"POST",url:f.base,payload:{...f.req("inspect"),canvasActions:true,
  messages:[{role:"user",content:text}],task:{taskId:f.task.id,turnMessageId:"inspect-message",requestId:"inspect"}}});
 assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json().actions,[]);
 assert.equal(f.requests.length,1);
});

test("P4.2a cancellation while a POST is pending stops reads, further POSTs and completion",async t=>{
 for(const reply of [firstTool(),finalAnswer]){
  const f=httpFixture(t,{responseGenerator:()=>{
   cancelAssistantTask(f.db,{projectId:"p",taskId:f.task.id,requestId:"cancel"});
   return reply;
  }});
  const response=await f.app.inject({method:"POST",url:f.base,payload:f.req("cancel-in-flight")});
  assert.equal(response.statusCode,409,response.body);
  assert.equal(response.json().code,"assistant_task_not_editable");
  assert.equal(f.requests.length,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='agent_read_tool_completed'").get().n,0);
  assert.notEqual(f.db.prepare("SELECT status FROM assistant_task_commands WHERE request_id='cancel-in-flight'").get().status,"completed");
 }
});
test("P4.2a no Task, Gemini, Skill and visual mixes are rejected before any POST",async t=>{
 const f=httpFixture(t);
 const invalid=[
  {...f.req("no-task"),task:undefined},
  {...f.req("gemini"),provider:"google_gemini"},
  {...f.req("visual"),visualContext:{images:[{nodeId:"visible"}]}}
 ];
 for(const req of invalid){
  const res=await f.app.inject({method:"POST",url:f.base,payload:req});
  assert.equal(res.statusCode,400,res.body);
  assert.equal(res.json().code,"assistant_agent_read_unsupported");
 }
 assert.equal(f.requests.length,0);
});

test("P4.2a active Task read round blocks a second tab even when it does not request tools",async t=>{
 let allowFirst,notifyFirst;
 const gate=new Promise(resolve=>{allowFirst=resolve});
 const firstPosted=new Promise(resolve=>{notifyFirst=resolve});
 const f=httpFixture(t,{responseGenerator:async(_data,seq)=>{
  if(seq===1){notifyFirst();await gate;}
  return finalAnswer;
 }});
 const initial=Promise.resolve(f.app.inject({method:"POST",url:f.base,payload:f.req("read-owner")}));
 await firstPosted;
 const ordinary={...f.req("ordinary-tab"),agentReadTools:false};
 const second=await f.app.inject({method:"POST",url:f.base,payload:ordinary});
 assert.equal(second.statusCode,409,second.body);
 assert.equal(second.json().code,"assistant_agent_read_busy");
 assert.equal(f.requests.length,1,"no second Provider call was sent");
 allowFirst();
 const complete=await initial;
 assert.equal(complete.statusCode,200,complete.body);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls").get().n,1);
});


test("episode reader pins authorized text across pages and reports empty and legacy sources",()=>{
 const nodes=[
  {id:"draft",type:"drama:episodes",title:"剧集规划",metadata:{
   dramaDraft:"逐集梗概🌙\n".repeat(190),dramaConfirmed:"旧稿",content:"历史原文"}},
  {id:"legacy",type:"drama:episodes",title:"旧版",metadata:{content:"历史原文"}},
  {id:"empty",type:"drama:episodes",title:"空白",metadata:{dramaDraft:" "}},
  {id:"secret",type:"drama:episodes",title:"未授权",metadata:{dramaDraft:"不可读取"}}
 ];
 const policy={includeContext:true,scope:"selection",includedIds:["draft","legacy","empty"]};
 const reader=createCanvasNodeReader(policy,{nodes});
 const read=(node_id,offset=0)=>JSON.parse(reader.invoke({node_ids:[node_id],offset},"call"));
 const original=nodes[0].metadata.dramaDraft;
 const first=read("draft");
 assert.equal(first.nodes[0].source,"dramaDraft");
 assert.ok(first.nextOffset>0);
 nodes[0].metadata.dramaDraft="更新后的草案";
 const second=read("draft",first.nextOffset);
 assert.equal(first.nodes[0].content+second.nodes[0].content,original);
 assert.equal(second.nextOffset,null);
 assert.equal(read("legacy").nodes[0].source,"content");
 assert.equal(read("empty").nodes[0].status,"empty");
 assert.throws(()=>read("secret"),{code:"assistant_agent_context_scope_denied"});
 assert.equal(createCanvasNodeReader({...policy,scope:"overview"},{nodes}),null);
 assert.equal(createCanvasNodeReader({...policy,includeContext:false},{nodes}),null);
});
