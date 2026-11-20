import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {initializeSchema} from "./schema.mjs";
import {openMainDatabase} from "./database.mjs";
import {createProject,getProject,saveSingleUserCanvas} from "./projects.mjs";
import {createComfyRegistry} from "./comfy-registry.mjs";
import {stableJson} from "./repository.mjs";
import {createAssistantTask,appendAssistantTaskTurn,linkAssistantTaskToChat} from "./assistant-tasks.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {beginConversationRequest,recoverConversationRequests,startConversationSubmission} from "./assistant-conversation.mjs";
import {buildApp} from "./app.mjs";

const plain={includeContext:false,scope:"selection",includedIds:[]};
const selected={includeContext:true,scope:"selection",includedIds:["private"]};
const marker="独有的画布隐私标记：天鹅在湖边看到一颗尚未对外公布的绿色月亮。";
const node={id:"private",type:"text",title:"私人故事",position:{x:0,y:0},width:340,height:240,metadata:{content:marker}};
const projectId="p";
const chatURL="/api/v1/projects/p/assistant/chat";
const durableURL=chatId=>"/api/v1/projects/p/assistant/conversations/"+chatId;
const normalResponse=answer=>new Response(JSON.stringify({choices:[{message:{content:answer},finish_reason:"stop"}]}),
 {headers:{"content-type":"application/json"}});
const geminiResponse=answer=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:answer}]},finishReason:"STOP"}]}),
 {headers:{"content-type":"application/json"}});

function createApp(db,onPayload,options){
 const vault={get:id=>({provider:id,hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(version,use)=>use(Buffer.from("fixture-key"))};
 const capture=async(url,request)=>onPayload(JSON.parse(request.body),url);
 const assistantChat=createAssistantChatService({vault,upstreamCall:capture,compatibleUpstreamCall:capture});
 return buildApp({db,authorize:()=>true,assistantChat,...options});
}
function fixture(t,onPayload,options){
 const db=new DatabaseSync(":memory:");
 initializeSchema(db);
 createProject(db,{id:projectId,document:{nodes:[node],connections:[]}});
 const app=createApp(db,onPayload,options);
 t.after(async()=>{await app.close();db.close();});
 return {db,app};
}
function input(chatSessionId,turnId,content,extras={}){
 return {chatSessionId,turnId,conversationRequestId:turnId+"-model",channelId:"openai",provider:"openai",
  model:"fixture",messages:[{role:"user",content}],canvasActions:false,conversationContext:plain,...extras};
}
const send=(app,payload,stream=false)=>app.inject({method:"POST",url:chatURL,payload,
 ...(stream?{headers:{accept:"text/event-stream"}}:{})});
test("semantic canvas format repair retries once and records a known outcome without writing to the canvas",async t=>{
 const captured=[];
 const {db,app}=fixture(t,payload=>{
  captured.push(payload);
  if(captured.length===2)return normalResponse(JSON.stringify({answer:"已给出节点方案",actions:[
   {type:"create_node",nodeType:"image",ref:"portrait",title:"定妆照",prompt:"半身照"},
   {type:"run_node",nodeId:"portrait"}
  ]}));
  return normalResponse('{"answer":"错误提案","actions":[{"type":"unknown"}]}');
 });
 const request="按方案建好定妆照节点，不提交生成";
 const extra={canvasActions:true,semanticCanvasIntent:true};
 const repaired=await send(app,input("format","repair",request,extra));
 assert.equal(repaired.statusCode,200,repaired.body);
 assert.equal(repaired.json().formatRepairCount,1);
 assert.deepEqual(repaired.json().actions.map(action=>action.type),["create_node"]);
 assert.match(captured[1].messages[0].content,/FORMAT CORRECTION/);
 const failed=await send(app,input("format","failed",request,extra));
 assert.equal(failed.statusCode,200,failed.body);
 assert.deepEqual(failed.json().actions,[]);
 assert.match(failed.json().answer,/画布未修改/);
 assert.equal(captured.length,4);
 assert.deepEqual(db.prepare("SELECT state FROM assistant_conversation_requests ORDER BY turn_seq").all().map(row=>row.state),
  ["completed","completed"]);
 assert.equal(getProject(db,projectId).revision,1);
});
test("recovery distinguishes an old format rejection from an unknown provider result",async t=>{
 const {db,app}=fixture(t,()=>normalResponse("答复"));
 for(const id of ["format","unknown"])assert.equal((await send(app,input("recovery",id,"测试"))).statusCode,200);
 db.prepare("UPDATE assistant_conversation_requests SET state='needs_reconcile',error_code=? WHERE request_id=?")
  .run("assistant_actions_invalid","format-model");
 db.prepare("UPDATE assistant_conversation_requests SET state='submitting',error_code=NULL WHERE request_id=?")
  .run("unknown-model");
 recoverConversationRequests(db);
 assert.deepEqual(db.prepare("SELECT state FROM assistant_conversation_requests ORDER BY turn_seq").all().map(row=>row.state),
  ["failed","needs_reconcile"]);
});

test("plain chat appends exact turns and excludes canvas context after revocation",async t=>{
 const captured=[];
 const {app}=fixture(t,payload=>{
  captured.push(payload);
  return normalResponse(captured.length===3?marker:"已收到");
 },{assistantCacheRollout:()=>true});
 for(const [id,context] of [["one",plain],["two",plain],["allowed",selected],["revoked",plain]]){
  const result=await send(app,input("plain",id,"问题 "+id,{conversationContext:context}));
  assert.equal(result.statusCode,200,result.body);
 }
 assert.equal(captured[0].messages.at(-1).content,"问题 one");
 assert.deepEqual(captured[1].messages.slice(0,2),captured[0].messages);
 assert.equal(captured[1].messages.at(-1).content,"问题 two");
 assert.match(captured[2].messages.at(-1).content,new RegExp(marker));
 assert.equal(captured[3].messages.at(-1).content,"问题 revoked");
 assert.doesNotMatch(JSON.stringify(captured[3]),new RegExp(marker));
});

test("large managed turns keep independently bounded canvas references",async t=>{
 const captured=[],samples=[];
 const {app}=fixture(t,payload=>{captured.push(payload);return normalResponse("答复");},
  {assistantCacheRollout:()=>true,onAssistantPromptUsage:sample=>samples.push(sample)});
 const text="x".repeat(96*1024-8);
 const result=await send(app,input("large","one",text,{conversationContext:selected}));
 assert.equal(result.statusCode,200,result.body);
 assert.equal(captured[0].messages.at(-1).content,text);
 assert.ok(captured[0].messages[0].content.includes(marker));
 assert.equal(samples[0].stablePromptPrefix,false);
});
const toolResponse=(id,name,args)=>new Response(JSON.stringify({choices:[{
 message:{content:null,tool_calls:[{id,type:"function",function:{name,arguments:JSON.stringify(args)}}]},
 finish_reason:"tool_calls"
}]}),{headers:{"content-type":"application/json"}});

test("ordinary canvas edits read authorized node text on demand and can return actions",async t=>{
 const request="读取人物ch04 / ch05 / ch06提示词提取到新建文本节点并配置好生图参数";
 const source="定妆照与三视图设定。\n".repeat(180)+"\nCH04\n  原始提示词\nCH05\nCH06";
 const captured=[],pages=[];
 const {db,app}=fixture(t,payload=>{
  captured.push(payload);
  const last=payload.messages.at(-1);
  if(payload.tools&&last.role==="user")
   return toolResponse("read-first","canvas_read_nodes",{node_ids:["private"],offset:0});
  if(last.role==="tool"){
   const page=JSON.parse(last.content);
   pages.push(page.nodes[0].content);
   if(page.nextOffset!==null)
    return toolResponse("read-"+page.nextOffset,"canvas_read_nodes",{node_ids:["private"],offset:page.nextOffset});
   return normalResponse(JSON.stringify({answer:"提取并新建角色文本节点",
    actions:[{type:"create_node",nodeType:"text",ref:"ch04",title:"CH04",content:"原始提示词"}]}));
  }
  return normalResponse("资料未授权。");
 });
 const project=getProject(db,projectId);
 saveSingleUserCanvas(db,{id:projectId,expectedRevision:project.revision,
  document:{nodes:[{...node,metadata:{content:source}}],connections:[]}});
 const result=await send(app,input("long-node","one",request,{canvasActions:true,conversationContext:selected}));
 assert.equal(result.statusCode,200,result.body);
 assert.equal(result.json().actions[0].ref,"ch04");
 assert.equal(pages.join(""),source);
 assert.ok(pages.length>1);
 assert.doesNotMatch(JSON.stringify(captured[0]),/原始提示词/);
 const revoked=await send(app,input("long-node","two","还记得什么？"));
 assert.equal(revoked.statusCode,200,revoked.body);
 assert.doesNotMatch(JSON.stringify(captured.at(-1)),/原始提示词|Selected canvas sources|canvas_read_nodes/);
});

test("episode planning tools let the model read first and optionally activate an image Skill",async t=>{
 const original=JSON.stringify({episodes:[{id:"ep1",title:"断桥",synopsis:"女主发现断桥下的旧钥匙",events:["钥匙失窃"],ending:"目击者是她的亲人"}]},null,2);
 const image={id:"qwen-image",name:"Qwen-Image",description:"Image prompt generation",
  version:"a".repeat(12),skillMd:"Format a Qwen image prompt.",resources:{}};
 const skills={mode:"auto",projectId,expectedRevision:1,skillIds:[image.id],versionPins:{[image.id]:image.version}};
 const captured=[];
 const {db,app}=fixture(t,payload=>{
  captured.push(payload);
  const last=payload.messages.at(-1);
  if(last.role==="user"){
   assert.doesNotMatch(JSON.stringify(payload),/钥匙失窃|Format a Qwen image prompt/);
   assert.match(JSON.stringify(payload),/剧集规划|Qwen-Image/);
   if(last.content.includes("只是问好"))return normalResponse("你好。");
   return toolResponse("episode-read","canvas_read_nodes",{node_ids:["private"],offset:0});
  }
  const content=JSON.parse(last.content);
  if(content.skill_id)return normalResponse("断桥下的旧钥匙，逆光近景。");
  assert.equal(content.nodes[0].source,"dramaDraft");
  assert.equal(content.nodes[0].content,original);
  if(payload.messages.some(item=>item.role==="user"&&item.content.includes("生图")))
   return toolResponse("image-skill","activate_skill",{skill_id:image.id});
  return normalResponse("把钥匙失窃移到结尾，让亲人成为唯一目击者。");
 },{skillRegistry:{authorized:()=>({entries:[image]})}});
 const project=getProject(db,projectId);
 saveSingleUserCanvas(db,{id:projectId,expectedRevision:project.revision,
  document:{nodes:[{...node,type:"drama:episodes",title:"剧集规划",
   metadata:{dramaDraft:original,dramaConfirmed:"旧稿"}}],connections:[]}});
 for(const [turn,request,skillIds,count] of [
  ["a","帮我优化剧情",[],1],
  ["b","把这集最后的悬念再往前铺一铺",[],1],
  ["c","为本集的断桥场景写生图提示词",[image.id],1],
  ["d","只是问好",[],0]
 ]){
  const result=await send(app,input("episodes-"+turn,turn,request,{conversationContext:selected,skills}));
  assert.equal(result.statusCode,200,result.body);
  assert.deepEqual(result.json().appliedSkillIds,skillIds);
  assert.equal(result.json().agentReadToolCalls.length,count);
 }
 assert.equal(captured.length,8);
 assert.equal(getProject(db,projectId).revision,project.revision+1);
});

test("a numbered follow-up keeps prior options only with the same authorized Skill and canvas scope",async t=>{
 const skill={id:"drama-05-revise-shot",version:"a".repeat(12),name:"修改镜头",
  description:"优化画面",skillMd:"修改分镜",resources:{}};
 const skills={mode:"auto",projectId,expectedRevision:1,skillIds:[skill.id],versionPins:{[skill.id]:skill.version}};
 const captured=[];
 const {app}=fixture(t,payload=>{
  captured.push(payload);
  return normalResponse(captured.length===1?"① 强化氛围。② 用皮球滚入画面做开场钩子。":"已收到选择。");
 },{skillRegistry:{authorized:()=>({entries:[skill]})}});
 for(const [turn,request,policy,catalog] of [
  ["one","优化镜头1",selected,skills],
  ["two","2",selected,skills],
  ["three","2",selected,{...skills,expectedRevision:2}],
  ["four","2",plain,skills]
 ]){
  const response=await send(app,input("numbered",turn,request,{conversationContext:policy,skills:catalog}));
  assert.equal(response.statusCode,200,response.body);
 }
 assert.ok(captured[1].messages.some(message=>message.role==="assistant"&&message.content.includes("皮球滚入画面")));
 assert.doesNotMatch(JSON.stringify(captured[2]),/皮球滚入画面/);
 assert.doesNotMatch(JSON.stringify(captured[3]),/皮球滚入画面/);
});

test("a durable model network failure is reported as unknown without claiming retries",async t=>{
 let posts=0;
 const {app,db}=fixture(t,()=>{
  if(++posts===1)return toolResponse("read","canvas_read_nodes",{node_ids:["private"],offset:0});
  throw new TypeError("fetch failed",{cause:{code:"ECONNRESET"}});
 });
 const response=await send(app,input("timeout","one","2",{conversationContext:selected}));
 assert.equal(response.body.includes("assistant_model_call_unknown"),true);
 assert.equal(posts,2);
 assert.equal(db.prepare("SELECT state FROM assistant_conversation_requests").get().state,"needs_reconcile");
 const history=await app.inject({method:"GET",url:durableURL("timeout")+"/turns"});
 assert.equal(history.statusCode,200,history.body);
 assert.deepEqual(history.json().turns[0].failureDetail,{kind:"skill_tool_round",
  diagnostic:{version:1,category:"transport_disconnected",phase:"await_response",httpStatus:null}});
 assert.doesNotMatch(history.body,/fetch failed|ECONNRESET/);
});

test("ordinary chat records the upstream HTTP status, separating rejection from an unknown result",async t=>{
 let status=503;
 const {app}=fixture(t,()=>new Response("private upstream body",{status}));
 for(const [turn,expected,category] of [
  ["unavailable","needs_reconcile","http_server_error"],["rejected","failed","http_client_rejected"]
 ]){
  const result=await send(app,input(turn,"one","优化镜头"));
  assert.ok(result.statusCode>=400);
  const history=await app.inject({url:durableURL(turn)+"/turns"});
  const saved=history.json().turns[0];
  assert.equal(saved.status,expected);
  assert.deepEqual(saved.failureDetail,{kind:"initial",
   diagnostic:{version:1,category,phase:"read_response",httpStatus:status}});
  assert.doesNotMatch(history.body,/private upstream body/);
  status=400;
 }
});

test("a malformed storyboard read and write are corrected inside the same assistant turn",async t=>{
 const captured=[];
 const shot={id:"shot1",episodeId:"ep1",order:1,description:"远处的灯塔熄灭。",
  characterVariantIds:[],propIds:[],keyPropIds:[]};
 const revised=JSON.stringify({shots:[{...shot,description:"近景中，灯塔的光束骤然熄灭。"}]});
 const {db,app}=fixture(t,payload=>{
  captured.push(payload);
  const last=payload.messages.at(-1);
  if(captured.length===1)
   return toolResponse("incorrect","canvas_read_nodes",{node_ids:["private"],shot:1});
  if(captured.length===2){
   const failure=JSON.parse(last.content);
   assert.equal(failure.error,"assistant_agent_tool_arguments_invalid");
   assert.match(failure.message,/offset:0/);
   assert.equal("nodes" in failure,false);
   return toolResponse("corrected","canvas_read_nodes",{node_ids:["private"],offset:0});
  }
  if(captured.length===3){
   assert.deepEqual(JSON.parse(JSON.parse(last.content).nodes[0].content).shots,[shot]);
   return normalResponse(JSON.stringify({answer:"修改镜头",actions:[
    {type:"set_text",nodeId:"private",content:"近景中，灯塔的光束骤然熄灭。"}
   ]}));
  }
  assert.equal(payload.tools,undefined);
  assert.match(payload.messages[0].content,/FORMAT CORRECTION/);
  assert.match(payload.messages[0].content,/nonempty, valid shots array/);
  assert.match(payload.messages[0].content,/远处的灯塔熄灭/);
  return normalResponse(JSON.stringify({answer:"已提出镜头 1 的改写",actions:[
   {type:"set_text",nodeId:"private",content:revised}
  ]}));
 });
 const project=getProject(db,projectId);
 saveSingleUserCanvas(db,{id:projectId,expectedRevision:project.revision,
  document:{nodes:[{...node,type:"drama:storyboard",title:"分镜表",
   metadata:{dramaDraft:JSON.stringify({shots:[shot]})}}],connections:[]}});
 const result=await send(app,input("storyboard","one","优化镜头1",{
  canvasActions:true,semanticCanvasIntent:true,conversationContext:selected
 }));
 assert.equal(result.statusCode,200,result.body);
 assert.equal(captured.length,4);
 assert.equal(result.json().formatRepairCount,1);
 assert.equal(result.json().actions[0].content,revised);
 assert.equal(result.json().agentReadToolCalls.length,1);
 assert.equal(getProject(db,projectId).revision,project.revision+1);
});

test("storyboard reads and Skills finish from retrieved data after the tool budget is used",async t=>{
 const captured=[];
 const skill={id:"shot-edit",name:"修改分镜",description:"写作建议",version:"a".repeat(12),skillMd:"保持镜头衔接。",resources:{}};
 const skills={mode:"auto",projectId,expectedRevision:1,skillIds:[skill.id],versionPins:{[skill.id]:skill.version}};
 const {app}=fixture(t,payload=>{
  captured.push(payload);
  if(captured.length===1)return toolResponse("skill","activate_skill",{skill_id:skill.id});
  if(captured.length<5)return toolResponse("read-"+captured.length,"canvas_read_nodes",{node_ids:["private"],offset:0});
  assert.equal(payload.tools,undefined);
  assert.equal(payload.tool_choice,undefined);
  assert.ok(payload.messages.every(message=>message.role!=="tool"));
  assert.match(payload.messages[0].content,/The tool budget is exhausted/);
  assert.match(JSON.stringify(payload),/保持镜头衔接/);
  assert.match(JSON.stringify(payload),new RegExp(marker));
  return normalResponse(JSON.stringify({answer:"建议让皮球滚入画面。",actions:[]}));
 },{skillRegistry:{authorized:()=>({entries:[skill]})}});
 const result=await send(app,input("bounded","one","优化镜头1",{
  canvasActions:true,semanticCanvasIntent:true,conversationContext:selected,skills
 }));
 assert.equal(result.statusCode,200,result.body);
 assert.equal(captured.length,5);
 assert.equal(result.json().answer,"建议让皮球滚入画面。");
 assert.equal(result.json().agentReadToolCalls.length,3);
 assert.deepEqual(result.json().appliedSkillIds,[skill.id]);
});

test("repeated invalid read parameters end as a known failure",async t=>{
 let attempt=0;
 const {db,app}=fixture(t,()=>toolResponse("read-"+(++attempt),"canvas_read_nodes",{node_ids:"private"}));
 const payload=input("invalid-reads","one","读取节点",{conversationContext:selected});
 const result=await send(app,payload);
 assert.equal(result.json().code,"assistant_skill_tool_round_limit");
 const row=db.prepare("SELECT state,error_code FROM assistant_conversation_requests").get();
 assert.deepEqual({...row},{state:"failed",error_code:"assistant_skill_tool_round_limit"});
 db.prepare("UPDATE assistant_conversation_requests SET state='needs_reconcile', error_code=?")
  .run("assistant_agent_tool_arguments_invalid");
 recoverConversationRequests(db);
 assert.equal(db.prepare("SELECT state FROM assistant_conversation_requests").get().state,"failed");
});

test("models rejecting node tools receive bounded episode excerpts without a tool declaration",async t=>{
 const captured=[];
 const {db,app}=fixture(t,payload=>{
  captured.push(payload);
  if(payload.tools)return new Response("tools unsupported",{status:400});
  assert.match(payload.messages[0].content,/已确认版本/);
  assert.match(payload.messages[0].content,/dramaConfirmed/);
  assert.match(payload.messages[0].content,/"truncated":true/);
  return normalResponse("根据已确认版本提供建议。");
 });
 const project=getProject(db,projectId);
 saveSingleUserCanvas(db,{id:projectId,expectedRevision:project.revision,
  document:{nodes:[{...node,type:"drama:episodes",title:"剧集规划",
   metadata:{dramaDraft:" ",dramaConfirmed:"已确认版本。".repeat(500),content:"历史原文"}}],connections:[]}});
 const result=await send(app,input("unsupported","one","帮我调整节奏",{conversationContext:selected}));
 assert.equal(result.statusCode,200,result.body);
 assert.equal(captured.length,2);
 assert.equal(result.json().nodeReadFallback,true);
 assert.doesNotMatch(JSON.stringify(captured[0]),/已确认版本/);
 assert.doesNotMatch(JSON.stringify(captured[1]),/历史原文/);
});

test("managed chats default to both cache optimizations and can roll each back independently",async t=>{
 const names=["PREFIX","BATCH_HISTORY","PLAIN_CHAT","CHANNELS","MODELS","MODES"].map(name=>"ATELIER_ASSISTANT_CACHE_"+name);
 const previous=new Map(names.map(name=>[name,process.env[name]]));
 t.after(()=>{
  for(const [name,value] of previous){
   if(value===undefined)delete process.env[name];
   else process.env[name]=value;
  }
 });
 for(const name of names)delete process.env[name];
 const samples=[],captured=[],turns=[];
 const {app}=fixture(t,payload=>{captured.push(payload);return normalResponse("答复");},
  {onAssistantPromptUsage:sample=>samples.push(sample),onAssistantPromptTurnUsage:sample=>turns.push(sample)});
 const ask=async turn=>{
  const response=await send(app,input("rollout",turn,"测试 "+turn));
  assert.equal(response.statusCode,200,response.body);
  const {stablePromptPrefix,batchHistory}=samples.at(-1);
  return [stablePromptPrefix,batchHistory];
 };
 assert.deepEqual(await ask("default"),[true,true]);
 assert.equal(captured.at(-1).messages.at(-1).content,"测试 default");
 assert.equal(samples.at(-1).plainCanvasChat,true);
 assert.equal(turns.at(-1).plainCanvasChat,true);
 process.env.ATELIER_ASSISTANT_CACHE_PLAIN_CHAT="0";
 assert.deepEqual(await ask("plain-off"),[true,true]);
 assert.match(captured.at(-1).messages.at(-1).content,/<Current turn reference data>/);
 assert.equal(samples.at(-1).plainCanvasChat,false);
 assert.equal(turns.at(-1).plainCanvasChat,false);
 delete process.env.ATELIER_ASSISTANT_CACHE_PLAIN_CHAT;
 process.env.ATELIER_ASSISTANT_CACHE_PREFIX="0";
 assert.deepEqual(await ask("prefix-off"),[false,true]);
 delete process.env.ATELIER_ASSISTANT_CACHE_PREFIX;
 process.env.ATELIER_ASSISTANT_CACHE_BATCH_HISTORY="0";
 assert.deepEqual(await ask("batch-off"),[true,false]);
 delete process.env.ATELIER_ASSISTANT_CACHE_BATCH_HISTORY;
 process.env.ATELIER_ASSISTANT_CACHE_MODES="task";
 assert.deepEqual(await ask("filtered"),[false,false]);
});

for(const provider of ["openai","google_gemini"]){
 test(`${provider} keeps the authorized history prefix while current canvas details change`,async t=>{
  const captured=[],samples=[];
  const {app,db}=fixture(t,payload=>{
   captured.push(payload);
   return provider==="openai"?Response.json({choices:[{message:{content:"公开回复"},finish_reason:"stop"}],
    usage:{prompt_tokens:1500,prompt_tokens_details:{cached_tokens:1024}}}):
    Response.json({candidates:[{content:{parts:[{text:"公开回复"}]},finishReason:"STOP"}],
     usageMetadata:{promptTokenCount:1500,cachedContentTokenCount:1024}});
  },{assistantCacheRollout:()=>true,onAssistantPromptUsage:sample=>samples.push(sample)});
  const config={provider,channelId:provider,...(provider==="google_gemini"?{baseUrl:"https://example.com/v1beta"}:{})};
  const ask=(id,context)=>send(app,input("stable",id,"用户问题 "+id,{...config,conversationContext:context}));
  assert.equal((await ask("one",plain)).statusCode,200);
  assert.equal((await ask("two",selected)).statusCode,200);
  const nextMarker=marker+" 更新后的资料";
  const existing=getProject(db,projectId);
  saveSingleUserCanvas(db,{id:projectId,expectedRevision:existing.revision,
   document:{...existing.document,nodes:[{...node,metadata:{content:nextMarker}}]}});
  assert.equal((await ask("three",selected)).statusCode,200);
  const system=payload=>payload.systemInstruction?.parts[0].text??payload.messages[0].content;
  const history=payload=>payload.contents??payload.messages.slice(1);
  assert.equal(system(captured[1]),system(captured[2]));
  assert.deepEqual(history(captured[1]).slice(0,2),history(captured[2]).slice(0,2));
  assert.match(JSON.stringify(history(captured[1]).at(-1)),new RegExp(marker));
  assert.match(JSON.stringify(history(captured[2]).at(-1)),new RegExp(nextMarker));
  assert.equal((await ask("four",plain)).statusCode,200);
  assert.doesNotMatch(JSON.stringify(captured.at(-1)),new RegExp(marker));
  assert.equal(samples.length,4);
  assert.ok(samples.every(sample=>sample.inputTokens===1500&&sample.cachedInputTokens===1024&&sample.firstTokenMs===null));
 });
}

test("batch retention keeps its checkpoint through multiple appends and database restart",async t=>{
 const root=mkdtempSync(join(tmpdir(),"assistant-cache-batch-"));
 let db=openMainDatabase(root),app;
 t.after(async()=>{await app?.close();db?.close();rmSync(root,{recursive:true,force:true});});
 createProject(db,{id:projectId,document:{nodes:[node],connections:[]}});
 const payloads=[];
 const open=()=>createApp(db,payload=>{payloads.push(payload);return normalResponse("答复");},
  {assistantCacheRollout:()=>true});
 const ask=async index=>{
  const result=await send(app,input("cached","turn-"+index,"第 "+index+" 条"));
  assert.equal(result.statusCode,200,result.body);
  return payloads.at(-1);
 };
 const checkpoint=()=>db.prepare(`SELECT through_seq,entries_json FROM assistant_conversation_checkpoints
  WHERE policy_key LIKE 'retained:%' ORDER BY through_seq DESC LIMIT 1`).get();
 app=open();
 for(let index=0;index<10;index++)await ask(index);
 assert.equal(checkpoint(),undefined);
 const trimmed=await ask(10),saved=checkpoint();
 assert.ok(saved.through_seq>0);
 assert.ok(trimmed.messages.length<=16);
 assert.equal(checkpoint().entries_json,saved.entries_json);
 await app.close();db.close();
 db=openMainDatabase(root);app=open();
 const appended=await ask(11);
 assert.equal(appended.messages[0].content,trimmed.messages[0].content);
 assert.deepEqual(appended.messages.slice(1,-3),trimmed.messages.slice(1,-1));
 assert.deepEqual(checkpoint(),saved);
 db.prepare("UPDATE assistant_conversation_checkpoints SET entries_json='invalid'").run();
 assert.equal((await ask(12)).messages[0].content,trimmed.messages[0].content);
 assert.deepEqual(checkpoint(),saved);
 db.exec(`CREATE TRIGGER reject_checkpoint BEFORE INSERT ON assistant_conversation_checkpoints
  BEGIN SELECT RAISE(ABORT,'test checkpoint unavailable'); END;`);
 for(let index=13;index<17;index++)assert.ok((await ask(index)).messages.length<=21);
 assert.deepEqual(checkpoint(),saved);
 db.exec("DROP TRIGGER reject_checkpoint");
 await ask(17);
 assert.ok(checkpoint().through_seq>saved.through_seq);
});
function registerTaskTurn(db,taskId,chatSessionId,turnId,text,policy){
 appendAssistantTaskTurn(db,{projectId,taskId,chatSessionId,requestId:turnId+"-register",messageId:turnId,text,contextPolicy:policy});
 return input(chatSessionId,turnId,text,{task:{taskId,turnMessageId:turnId,requestId:turnId+"-model"}});
}
test("managed ordinary and Task history enforce canvas revocation, current turn and session boundaries",async t=>{
 const captured=[];
 const {app,db}=fixture(t,payload=>{
  captured.push(payload);
  return normalResponse(captured.length===1||captured.length===4?marker:"公开回复");
 });
 assert.equal((await send(app,input("chat","a","保留我的风格设定",{conversationContext:selected}))).statusCode,200);
 const privateFirst=JSON.stringify(captured.at(-1));
 assert.match(privateFirst,new RegExp(marker));
 const follow=await send(app,input("chat","b","继续但关闭画布"));
 assert.equal(follow.statusCode,200,follow.body);
 assert.match(JSON.stringify(captured.at(-1)),/保留我的风格设定/);
 assert.doesNotMatch(JSON.stringify(captured.at(-1)),new RegExp(marker));
 assert.equal(captured.at(-1).messages.filter(message=>
  message.role==="user"&&message.content.split("\n\n<Current turn reference data>\n")[0]==="继续但关闭画布").length,1);
 assert.equal((await send(app,input("fresh","a","另一会话"))).statusCode,200);
 assert.doesNotMatch(JSON.stringify(captured.at(-1)),/保留我的风格设定/);
 const task=createAssistantTask(db,{projectId,chatSessionId:"task-chat",rootMessageId:"root",
  originalRequest:"连续创作",requestId:"create"}).task;
 const first=registerTaskTurn(db,task.id,"task-chat","task-a","我的角色叫小明",selected);
 assert.equal((await send(app,first)).statusCode,200);
 assert.match(JSON.stringify(captured.at(-1)),new RegExp(marker));
 const next=registerTaskTurn(db,task.id,"task-chat","task-b","继续角色设计，关闭画布",plain);
 assert.equal((await send(app,next)).statusCode,200);
 assert.match(JSON.stringify(captured.at(-1)),/我的角色叫小明/);
 assert.doesNotMatch(JSON.stringify(captured.at(-1)),new RegExp(marker));
 const wrong=await send(app,{...next,chatSessionId:"wrong"});
 assert.equal(wrong.statusCode,403);
 assert.equal(captured.length,5);
});

test("duplicate managed SSE and JSON requests use durable replies across a database restart",async t=>{
 const root=mkdtempSync(join(tmpdir(),"assistant-chat-"));
 let db=openMainDatabase(root),app,paid=0;
 t.after(async()=>{await app?.close();db?.close();rmSync(root,{recursive:true,force:true});});
 createProject(db,{id:projectId,document:{nodes:[node],connections:[]}});
 const onPayload=()=>{paid++;return normalResponse("已保存的回复");};
 app=createApp(db,onPayload);
 const body=input("chat","one","问题");
 const streamed=await send(app,body,true);
 assert.equal(streamed.statusCode,200);
 assert.match(streamed.body,/event: done/);
 await app.close();db.close();
 db=openMainDatabase(root);app=createApp(db,onPayload);
 const state=await app.inject({url:durableURL("chat")+"/turns/one/one-model"});
 assert.equal(state.json().state,"completed");
 assert.equal(state.json().response.answer,"已保存的回复");
 const retry=await send(app,body,true);
 assert.match(retry.body,/已保存的回复/);
 assert.equal((await send(app,body)).json().answer,"已保存的回复");
 const duplicateTurn=await send(app,{...body,conversationRequestId:"different-paid-id"});
 assert.equal(duplicateTurn.statusCode,409);
 const conflict=await send(app,{...body,messages:[{role:"user",content:"变更的问题"}]},true);
 assert.equal(conflict.statusCode,409);
 assert.equal(conflict.json().code,"assistant_conversation_request_conflict");
 assert.equal(paid,1);
 const chats=await app.inject({url:"/api/v1/projects/p/chats"});
 assert.equal(chats.json().sessions[0].id,"chat");
 assert.equal(chats.json().activeChatId,"chat");
 const savedSelection=await app.inject({method:"PUT",url:"/api/v1/projects/p/chats",payload:{
  sessions:chats.json().sessions,activeChatId:null,expectedRevision:chats.json().revision
 }});
 assert.equal(savedSelection.statusCode,200,savedSelection.body);
 const interruptedBody=input("chat","unresolved","中断前发送");
 const reserved=beginConversationRequest(db,{projectId,chatSessionId:"chat",turnId:"unresolved",
  requestId:"unresolved-model",userText:interruptedBody.messages[0].content,requestPayload:interruptedBody});
 startConversationSubmission(db,reserved,plain);
 await app.close();db.close();
 db=openMainDatabase(root);app=createApp(db,onPayload);
 assert.equal((await app.inject({url:"/api/v1/projects/p/chats"})).json().activeChatId,null);
 assert.equal((await app.inject({url:durableURL("chat")+"/turns/unresolved/unresolved-model"})).json().state,"needs_reconcile");
 assert.equal((await send(app,interruptedBody)).json().code,"assistant_model_call_unknown");
 assert.equal(paid,1);
});

test("an overflowing recovered catalog stays writable and new turns cannot create more sessions",async t=>{
 let posts=0;
 const {app,db}=fixture(t,()=>{posts++;return normalResponse("答复");});
 const insert=db.prepare(`INSERT INTO assistant_conversation_turns(project_id,session_id,turn_id,user_text,created_at)
  VALUES(?,?,?,?,?)`);
 for(let index=0;index<501;index++)insert.run(projectId,"chat-"+index,"turn","已恢复会话",index);
 const url="/api/v1/projects/p/chats";
 const catalog=(await app.inject({url})).json();
 assert.equal(catalog.sessions.length,500);
 assert.equal(catalog.activeChatId,"chat-500");
 const saved=await app.inject({method:"PUT",url,payload:{
  sessions:catalog.sessions,activeChatId:null,expectedRevision:catalog.revision
 }});
 assert.equal(saved.statusCode,200,saved.body);
 const rejected=await send(app,input("one-more","turn","超过上限"));
 assert.equal(rejected.statusCode,409,rejected.body);
 assert.equal(rejected.json().code,"assistant_conversation_limit");
 assert.equal(posts,0);
});

test("concurrent managed turns are isolated and ambiguous requests are never submitted again",async t=>{
 let calls=0,finish,started;
 const sent=new Promise(resolve=>{started=resolve;});
 const response=new Promise(resolve=>{finish=resolve;});
 const {app}=fixture(t,async()=>{
  calls++;
  if(calls===1){started();return await response;}
  throw Error("lost connection");
 });
 const first=send(app,input("chat","a","first"),true);
 await sent;
 const busy=await send(app,input("chat","b","second"),true);
 assert.equal(busy.statusCode,409);
 assert.equal(busy.json().code,"assistant_conversation_busy");
 const same=await send(app,input("chat","a","first"),true);
 assert.equal(same.statusCode,409);
 finish(normalResponse("ok"));
 assert.match((await first).body,/event: done/);
 const unknown=input("chat","b","second");
 assert.ok((await send(app,unknown)).statusCode>=400);
 const status=await app.inject({url:durableURL("chat")+"/turns/b/b-model"});
 assert.equal(status.json().state,"needs_reconcile");
 const retry=await send(app,unknown);
 assert.equal(retry.statusCode,409);
 assert.equal(retry.json().code,"assistant_model_call_unknown");
 assert.equal(calls,2);
});

test("explicit Task links carry Task facts while keeping each chat's user turns separate",async t=>{
 const captured=[];
 const {app,db}=fixture(t,body=>{captured.push(body);return normalResponse("了解");});
 const task=createAssistantTask(db,{projectId,chatSessionId:"first-chat",rootMessageId:"root",
  originalRequest:"共享任务目标",requestId:"create"}).task;
 const privateChatText="第一会话独有的细节";
 assert.equal((await send(app,registerTaskTurn(db,task.id,"first-chat","first",privateChatText,plain))).statusCode,200);
 linkAssistantTaskToChat(db,{projectId,taskId:task.id,requestId:"link",chatSessionId:"linked-chat"});
 const second=await send(app,registerTaskTurn(db,task.id,"linked-chat","second","继续共享任务",plain));
 assert.equal(second.statusCode,200,second.body);
 const providerInput=JSON.stringify(captured.at(-1));
 assert.match(providerInput,/共享任务目标/);
 assert.doesNotMatch(providerInput,new RegExp(privateChatText));
});

test("history removes resolved @ metadata and keeps credentials out of durable prose",async t=>{
 const payloads=[];
 const {app,db}=fixture(t,body=>{
  payloads.push(body);
  return normalResponse(payloads.length===1?"敏感节点标题，密码 password=hush-secret":"ok");
 });
 const first=await send(app,input("chat","one","请读【引用节点：敏感节点标题（text，id=private）】"));
 assert.equal(first.statusCode,200,first.body);
 assert.match(JSON.stringify(payloads[0]),/敏感节点标题/);
 assert.doesNotMatch(first.json().answer,/hush-secret/);
 await send(app,input("chat","two","后续请求"));
 assert.doesNotMatch(JSON.stringify(payloads.at(-1)),/敏感节点标题/);
 assert.doesNotMatch(db.prepare("SELECT response_json FROM assistant_conversation_requests WHERE request_id='one-model'").get().response_json,/hush-secret/);
});

test("ordinary chat sends exact workflow ports for authorized mentions through the real registry",async t=>{
 const captured=[];
 const {app,db}=fixture(t,body=>{captured.push(body);return normalResponse("分析完成");});
 const portId="composition-steps";
 const template={name:"构图",apiGraph:{"1":{class_type:"Image",inputs:{steps:12}}},
  requirements:{classTypes:["Image"]},ports:[{id:portId,label:"Steps",direction:"target",valueKind:"INT",
   inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"steps"}]},
   defaultValue:12},{id:"result",label:"Result",direction:"source",valueKind:"IMAGE",
   outputBinding:{nodeId:"1",outputIndex:0},capture:{kind:"none"}}]};
 const id="workflow:composition",revision=createHash("sha256").update(stableJson(template)).digest("hex");
 createComfyRegistry(db).installMany([{id,revision,...template}]);
 const project=getProject(db,projectId);
 saveSingleUserCanvas(db,{id:projectId,expectedRevision:project.revision,document:{...project.document,
  nodes:[...project.document.nodes,{id:"workflow",title:"构图工作流",type:"comfy:workflow",
   position:{x:0,y:0},metadata:{comfyWorkflow:{templateId:id,templateRevision:revision},
    comfyPorts:[{id:portId,label:"Steps",direction:"target",valueKind:"INT"}]}}]}});
 const selectedForOverview={includeContext:true,scope:"overview",includedIds:["workflow"]};
 const first=await send(app,input("chat","one","查看我引用的工作流",{conversationContext:selectedForOverview}));
 assert.equal(first.statusCode,200,first.body);
 assert.match(JSON.stringify(captured.at(-1)),new RegExp("portId="+portId));
 const follow=await send(app,input("chat","two","继续讨论",{conversationContext:{...selectedForOverview,includedIds:[]}}));
 assert.equal(follow.statusCode,200,follow.body);
 assert.doesNotMatch(JSON.stringify(captured.at(-1)),new RegExp(portId));
});

test("long Gemini chats paginate and recover checkpoints while retaining an early user constraint",async t=>{
 let last=null;
 const {app,db}=fixture(t,payload=>{last=payload;return geminiResponse("收到");});
 const fixed="项目始终只使用水彩风格";
 const ask=(index,text)=>send(app,input("chat","turn-"+index,text,{provider:"google_gemini",channelId:"google_gemini",baseUrl:"https://example.com/v1beta"}));
 for(let i=0;i<100;i++){
  const result=await ask(i,i===0?fixed:"创意讨论第 "+i+" 轮");
  assert.equal(result.statusCode,200,result.body);
 }
 assert.match(JSON.stringify(last.systemInstruction),new RegExp(fixed));
 assert.ok(last.contents.length<=20);
 assert.ok(db.prepare("SELECT COUNT(*) AS n FROM assistant_conversation_checkpoints").get().n>=3);
 db.prepare("UPDATE assistant_conversation_checkpoints SET entries_json='not JSON'").run();
 assert.equal((await ask(100,"从损坏的检查点恢复")).statusCode,200);
 assert.match(JSON.stringify(last.systemInstruction),new RegExp(fixed));
 assert.equal(app.assistantConversationMetrics.checkpoint_invalid,1);
 const page=await app.inject({url:durableURL("chat")+"/turns?limit=50"});
 assert.equal(page.json().turns.length,50);
 const earlier=await app.inject({url:durableURL("chat")+"/turns?limit=50&before="+page.json().nextBefore});
 assert.equal(earlier.json().turns.length,50);
 const oldest=await app.inject({url:durableURL("chat")+"/turns?before="+earlier.json().nextBefore});
 assert.deepEqual(oldest.json().turns,[{turnId:"turn-0",userText:fixed,status:"completed",answer:"收到"}]);
});

for(const optimized of [false,true])test(`managed Task tools re-resolve only authorized nodes (optimized=${optimized})`,async t=>{
 const captured=[];
 const samples=[],turns=[];
 const {app,db}=fixture(t,body=>{
  captured.push(body);
  if(captured.length===2)return Response.json({choices:[{message:{content:"记录已分析"},finish_reason:"stop"}],
   usage:{prompt_tokens:200,prompt_cache_hit_tokens:120,prompt_cache_miss_tokens:80}});
  if(captured.length!==1)return normalResponse("记录已分析");
  return new Response(JSON.stringify({choices:[{finish_reason:"tool_calls",message:{content:null,
   tool_calls:["read-1","read-2"].map(id=>({id,type:"function",function:{
    name:"canvas_read_nodes",arguments:JSON.stringify({node_ids:["private"]})}}))}}]}),
   {headers:{"content-type":"application/json"}});
 },{assistantCacheRollout:()=>optimized,onAssistantPromptUsage:sample=>samples.push(sample),
  onAssistantPromptTurnUsage:sample=>turns.push(sample)});
 const task=createAssistantTask(db,{projectId,chatSessionId:"task-chat",rootMessageId:"root",
  originalRequest:"分析取景",requestId:"create"}).task;
 const asked=registerTaskTurn(db,task.id,"task-chat","tool-a","请读取当前画布节点",selected);
 const result=await send(app,{...asked,agentReadTools:true});
 assert.equal(result.statusCode,200,result.body);
 assert.equal(samples.length,2);
 assert.equal(turns[0].posts,2);
 assert.equal(turns[0].inputReports,1);
 assert.equal(samples[1].cachedInputTokens,120);
 const refs=db.prepare("SELECT call_id,node_ids_json FROM assistant_conversation_tool_refs ORDER BY call_id").all();
 assert.deepEqual(refs.map(({call_id})=>call_id),["read-1","read-2"]);
 assert.ok(refs.every(ref=>!ref.node_ids_json.includes(marker)));
 const allowed=registerTaskTurn(db,task.id,"task-chat","tool-b","延续上个发现",selected);
 const allowedResult=await send(app,allowed);
 assert.equal(allowedResult.statusCode,200,allowedResult.body);
 const messages=captured.at(-1).messages;
 const references=optimized?/Live tool references/:/当前重新核验的历史工具节点/;
 assert.match(messages.at(optimized?-1:0).content,references);
 assert.match(messages.at(optimized?-1:0).content,new RegExp(marker));
 const denied=registerTaskTurn(db,task.id,"task-chat","tool-c","停止读取画布",plain);
 assert.equal((await send(app,denied)).statusCode,200);
 assert.doesNotMatch(JSON.stringify(captured.at(-1)),references);
 assert.doesNotMatch(JSON.stringify(captured.at(-1)),new RegExp(marker));
});

test("session deletion removes transcript and prevents late model writes",async t=>{
 let finish,started;
 const providerStarted=new Promise(resolve=>{started=resolve;});
 const pending=new Promise(resolve=>{finish=resolve;});
 const {app,db}=fixture(t,async()=>{started();return await pending;});
 const snapshot={sessions:[{id:"deleted",title:"删除的标题",createdAt:"now",updatedAt:"now",
  messages:[{id:"message",role:"user",text:"过期快照中必须清理的文本"}]}],activeChatId:"deleted"};
 const chatsURL="/api/v1/projects/p/chats";
 const saved=await app.inject({method:"PUT",url:chatsURL,payload:{...snapshot,expectedRevision:1}});
 assert.equal(saved.statusCode,200,saved.body);
 const sendRequest=send(app,input("deleted","turn","即将删除的请求"),true);
 await providerStarted;
 const removed=await app.inject({method:"DELETE",url:durableURL("deleted")});
 assert.equal(removed.statusCode,200,removed.body);
 assert.doesNotMatch(db.prepare("SELECT sessions_json FROM project_chats").get().sessions_json,/过期快照/);
 const stale=await app.inject({method:"PUT",url:chatsURL,payload:{...snapshot,expectedRevision:2}});
 assert.equal(stale.statusCode,200,stale.body);
 assert.deepEqual(stale.json().sessions,[]);
 finish(normalResponse("不得恢复的回复"));
 assert.match((await sendRequest).body,/assistant_conversation_not_found/);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assistant_conversation_turns").get().n,0);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assistant_conversation_requests").get().n,0);
 assert.equal((await app.inject({url:durableURL("deleted")+"/turns"})).statusCode,404);
 assert.equal((await send(app,input("deleted","again","不得恢复的会话"))).statusCode,404);
});
