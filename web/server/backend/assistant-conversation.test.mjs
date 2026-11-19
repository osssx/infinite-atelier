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
import {beginConversationRequest,startConversationSubmission} from "./assistant-conversation.mjs";
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

function createApp(db,onPayload){
 const vault={get:id=>({provider:id,hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(version,use)=>use(Buffer.from("fixture-key"))};
 const capture=async(url,request)=>onPayload(JSON.parse(request.body),url);
 const assistantChat=createAssistantChatService({vault,upstreamCall:capture,compatibleUpstreamCall:capture});
 return buildApp({db,authorize:()=>true,assistantChat});
}
function fixture(t,onPayload){
 const db=new DatabaseSync(":memory:");
 initializeSchema(db);
 createProject(db,{id:projectId,document:{nodes:[node],connections:[]}});
 const app=createApp(db,onPayload);
 t.after(async()=>{await app.close();db.close();});
 return {db,app};
}
function input(chatSessionId,turnId,content,extras={}){
 return {chatSessionId,turnId,conversationRequestId:turnId+"-model",channelId:"openai",provider:"openai",
  model:"fixture",messages:[{role:"user",content}],canvasActions:false,conversationContext:plain,...extras};
}
const send=(app,payload,stream=false)=>app.inject({method:"POST",url:chatURL,payload,
 ...(stream?{headers:{accept:"text/event-stream"}}:{})});
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
 assert.equal(captured.at(-1).messages.filter(message=>message.content==="继续但关闭画布").length,1);
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
 const interruptedBody=input("chat","unresolved","中断前发送");
 const reserved=beginConversationRequest(db,{projectId,chatSessionId:"chat",turnId:"unresolved",
  requestId:"unresolved-model",userText:interruptedBody.messages[0].content,requestPayload:interruptedBody});
 startConversationSubmission(db,reserved,plain);
 await app.close();db.close();
 db=openMainDatabase(root);app=createApp(db,onPayload);
 assert.equal((await app.inject({url:durableURL("chat")+"/turns/unresolved/unresolved-model"})).json().state,"needs_reconcile");
 assert.equal((await send(app,interruptedBody)).json().code,"assistant_model_call_unknown");
 assert.equal(paid,1);
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

test("managed Task tools save distinct references and re-resolve only authorized nodes",async t=>{
 const captured=[];
 const {app,db}=fixture(t,body=>{
  captured.push(body);
  if(captured.length!==1)return normalResponse("记录已分析");
  return new Response(JSON.stringify({choices:[{finish_reason:"tool_calls",message:{content:null,
   tool_calls:["read-1","read-2"].map(id=>({id,type:"function",function:{
    name:"canvas_read_nodes",arguments:JSON.stringify({node_ids:["private"]})}}))}}]}),
   {headers:{"content-type":"application/json"}});
 });
 const task=createAssistantTask(db,{projectId,chatSessionId:"task-chat",rootMessageId:"root",
  originalRequest:"分析取景",requestId:"create"}).task;
 const asked=registerTaskTurn(db,task.id,"task-chat","tool-a","请读取当前画布节点",selected);
 const result=await send(app,{...asked,agentReadTools:true});
 assert.equal(result.statusCode,200,result.body);
 const refs=db.prepare("SELECT call_id,node_ids_json FROM assistant_conversation_tool_refs ORDER BY call_id").all();
 assert.deepEqual(refs.map(({call_id})=>call_id),["read-1","read-2"]);
 assert.ok(refs.every(ref=>!ref.node_ids_json.includes(marker)));
 const allowed=registerTaskTurn(db,task.id,"task-chat","tool-b","延续上个发现",selected);
 const allowedResult=await send(app,allowed);
 assert.equal(allowedResult.statusCode,200,allowedResult.body);
 assert.match(captured.at(-1).messages[0].content,/当前重新核验的历史工具节点/);
 assert.match(captured.at(-1).messages[0].content,new RegExp(marker));
 const denied=registerTaskTurn(db,task.id,"task-chat","tool-c","停止读取画布",plain);
 assert.equal((await send(app,denied)).statusCode,200);
 assert.doesNotMatch(JSON.stringify(captured.at(-1)),/当前重新核验的历史工具节点/);
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
