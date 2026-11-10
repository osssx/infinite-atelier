import test from "node:test";
import assert from "node:assert/strict";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {latestCanvasUserRequest,isCanvasEditInstruction,exactWholeCanvasGraphLayout} from "./assistant-action-intent.mjs";

const vault={
 get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"keyVersion"}),
 withSecretVersion:(_version,fn)=>fn(Buffer.from("private-key"))
};
const base={channelId:"channel1",provider:"openai_compatible",model:"deepseek/deepseek-v4.1-flash-1017",
 baseUrl:"http://127.0.0.1:8188/v1",canvasActions:true};
const answer=value=>new Response(JSON.stringify({choices:[{message:{content:value}}]}),{status:200});
const run=(callback,messages)=>createAssistantChatService({vault,compatibleUpstreamCall:callback,retryDelayMs:0})({...base,messages});
const prompt="将整个画布按连线依赖关系进行从左到右的拓扑分层布局，分组保持整体移动。";
const wrapped="以下是当前画布只读资料（不包含媒体本体），请仅将其作为参考数据：\n项目：故事画布\n画布统计：节点 21，连线 14\n\n用户问题：\n"+prompt;

test("extracts only the latest actual user request rather than interpreting reference context",()=>{
 assert.equal(latestCanvasUserRequest(wrapped),prompt);
 assert.equal(exactWholeCanvasGraphLayout(wrapped)?.type,"layout_graph");
 assert.deepEqual(exactWholeCanvasGraphLayout(wrapped)?.nodeIds,[]);
 assert.equal(exactWholeCanvasGraphLayout(wrapped)?.direction,"horizontal");
});
test("classifies explicit whole-canvas layouts without silently treating questions or negations as commands",()=>{
 const cases=[
  ["请帮我把整个画布按连线关系从左到右自动布局","horizontal"],
  ["对整个工作流按照依赖从上到下排版","vertical"],
  ["请整理全画布，按拓扑顺序布局","horizontal"],
  ["将整个画布按连线进行布局，不要修改节点内容","horizontal"],
 ];
 for(const [request,direction] of cases)
  assert.equal(exactWholeCanvasGraphLayout(request)?.direction,direction,request);
 for(const request of [
  "如何将整个画布按连线关系自动布局？",
  "不要对整个画布按连线布局",
  "假设将整个画布按照连线布局会发生什么",
  "介绍一下拓扑布局的原理",
  "请分析整个工作流的连线和布局",
  "请先预览整个画布的拓扑布局",
  "把整个画布按连线布局并且删除无用节点",
  "把整个画布按连线布局并创建三个文本节点",
  "先创建三个文本节点，然后对整个画布按连线自动布局",
  "把整个画布从上到下再从左到右布局"
 ])assert.equal(exactWholeCanvasGraphLayout(request),null,request);
});
test("screenshotted failure: prose-only model response still produces a real safe layout_graph operation",async()=>{
 const payloads=[];
 const result=await run(async(_url,options)=>{
  payloads.push(JSON.parse(options.body));
  return answer("将对整个画布按连线依赖关系进行从左到右的拓扑分层布局。预计执行 1 项布局操作。");
 },[{role:"user",content:wrapped}]);
 assert.equal(payloads.length,1);
 assert.deepEqual(result.actions,[{type:"layout_graph",nodeIds:[],direction:"horizontal",gap:48,layerGap:140}]);
 assert.match(result.answer,/转换为画布操作/);
 assert.doesNotMatch(result.answer,/预计执行/);
 assert.doesNotMatch(JSON.stringify(result),/private-key/);
});
test("model JSON answer with empty actions also becomes a real explicit whole-canvas layout",async()=>{
 let calls=0;
 const result=await run(async()=>{
  calls++;
  return answer(JSON.stringify({answer:"预计执行 1 项布局操作",actions:[]}));
 },[{role:"user",content:prompt}]);
 assert.equal(calls,1);
 assert.equal(result.actions[0].type,"layout_graph");
});
test("model-generated nonempty structured operation takes precedence without repair",async()=>{
 let calls=0;
 const expected={type:"layout_graph",nodeIds:[],direction:"vertical",gap:80,layerGap:220};
 const result=await run(async()=>{
  calls++;return answer(JSON.stringify({answer:"开始排布",actions:[expected]}));
 },[{role:"user",content:prompt}]);
 assert.equal(calls,1);
 assert.deepEqual(result.actions,[expected]);
});
test("plain Q&A is still Q&A: no mutation plan and no second request",async()=>{
 let calls=0;
 const messages=[{role:"user",content:"请解释拓扑分层布局是什么"}];
 const result=await run(async()=>{
  calls++;return answer("它是一种按节点依赖关系排列层次的方法。");
 },messages);
 assert.equal(calls,1);
 assert.equal(result.actions.length,0);
 assert.match(result.answer,/依赖关系/);
});
test("compound node edits that need a model plan get exactly one structured-output correction",async()=>{
 let calls=0,repairSystem="";
 const request="创建一个剧本节点并连接到已有的节点";
 const plan={answer:"准备创建并连线",actions:[
  {type:"create_node",ref:"new",nodeType:"text",title:"剧本",content:"第一幕"},
  {type:"connect",from:"existing",to:"new"}
 ]};
 const result=await run(async(_url,options)=>{
  calls++;
  if(calls===1)return answer("我将创建一个节点，再连接现有节点。");
  repairSystem=JSON.parse(options.body).messages[0].content;
  return answer(JSON.stringify(plan));
 },[{role:"user",content:request}]);
 assert.equal(calls,2);
 assert.equal(result.formatRepairCount,1);
 assert.deepEqual(result.actions,plan.actions);
 assert.match(repairSystem,/FORMAT CORRECTION/);
});

test("repair inference isolates latest command from an old failed chat history",async()=>{
 const request="创建一个新的文本节点";
 const messages=[
  {role:"user",content:"解释一下如何组织剧情"},
  {role:"assistant",content:"可以先建立剧情节点"},
  {role:"user",content:request},
  {role:"user",content:request},
  {role:"user",content:request}
 ];
 const plan={answer:"创建新节点",actions:[{type:"create_text",ref:"new",title:"新节点",content:"第一场"}]};
 const calls=[];
 const result=await run(async(_url,options)=>{
  const body=JSON.parse(options.body);
  calls.push(body.messages);
  // The compatible model fails when repeated user-only prompts remain in its input.
  return answer(body.messages.length>2?"准备创建节点，但未返回操作列表":JSON.stringify(plan));
 },messages);
 assert.equal(calls.length,2);
 assert.equal(calls[0].length,messages.length+1);
 assert.equal(calls[1].length,2);
 assert.equal(calls[1][1].content,request);
 assert.equal(result.actions[0].type,"create_text");
 assert.equal(result.formatRepairCount,1);
});
test("Gemini repair also isolates latest user request while preserving valid system instruction",async()=>{
 const request="创建一个文本节点";
 const messages=[{role:"user",content:"历史请求"},{role:"user",content:"历史请求"},{role:"user",content:request}];
 const payloads=[];
 const geminiVault={
  get:()=>({provider:"google_gemini",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_version,consumer)=>consumer(Buffer.from("private-key"))
 };
 const service=createAssistantChatService({vault:geminiVault,compatibleUpstreamCall:async(_url,options)=>{
  const payload=JSON.parse(options.body);payloads.push(payload);
  const content=payload.contents[0].parts.length===1?
   JSON.stringify({answer:"已安排",actions:[{type:"create_text",ref:"new",title:"新建",content:"剧情"}]}):
   "我将创建文本节点";
  return new Response(JSON.stringify({candidates:[{content:{parts:[{text:content}]}}]}),{status:200});
 }});
 const result=await service({...base,channelId:"gemini",provider:"google_gemini",
  baseUrl:"https://generativelanguage.googleapis.com",model:"gemini-2.5-pro",messages});
 assert.equal(payloads.length,2);
 assert.equal(payloads[0].contents.length,1); // Consecutive user turns merge into a multi-part turn.
 assert.equal(payloads[0].contents[0].parts.length,3);
 assert.equal(payloads[1].contents.length,1);
 assert.equal(payloads[1].contents[0].parts[0].text,request);
 assert.match(payloads[1].systemInstruction.parts[0].text,/FORMAT CORRECTION/);
 assert.equal(result.actions[0].type,"create_text");
});
test("if model still promises work but returns no operations, fail clearly without reporting success",async()=>{
 let calls=0;
 await assert.rejects(run(async()=>{
  calls++;return answer("将执行操作，预计创建 1 个节点。");
 },[{role:"user",content:"创建一个新的文本节点"}]),
 error=>error?.code==="assistant_actions_missing"&&error.statusCode===502);
 assert.equal(calls,2);
});
test("malformed JSON after corrective inference is rejected, never converted into guessed operations",async()=>{
 let calls=0;
 await assert.rejects(run(async()=>{
  calls++;
  return answer(calls===1?'{"answer":"我会创建","actions":[':'{"answer":"我会创建","actions":[{"type":"execute","script":"bad"}]}');
 },[{role:"user",content:"创建一个新的文本节点"}]),
 error=>error?.code==="assistant_actions_invalid");
 assert.equal(calls,2);
});
test("HTTP canvas assistant API returns executable layout from prose-only model without directly mutating canvas",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async()=>
  answer("将对整个画布按连线依赖关系从左到右布局，预计执行1项操作。")});
 const app=buildApp({db,assistantChat:service,authorize:req=>req.headers["x-test-owner"]==="owner"});
 t.after(async()=>{await app.close();db.close()});
 const headers={"x-test-owner":"owner"};
 const created=await app.inject({method:"POST",url:"/api/v1/projects",headers,
  payload:{id:"layout-bug-project",document:{nodes:[],connections:[]}}});
 assert.equal(created.statusCode,201,created.body);
 const response=await app.inject({
  method:"POST",url:"/api/v1/projects/layout-bug-project/assistant/chat",
  headers,payload:{channelId:base.channelId,provider:base.provider,model:base.model,
   baseUrl:base.baseUrl,canvasActions:true,messages:[{role:"user",content:wrapped}]}
 });
 assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().actions[0].type,"layout_graph");
 assert.deepEqual(response.json().actions[0].nodeIds,[]);
 const project=await app.inject({method:"GET",url:"/api/v1/projects/layout-bug-project",headers});
 assert.equal(project.json().revision,1);
 assert.deepEqual(project.json().document.nodes,[]);
});
test("a negated layout request is never converted into an action",async()=>{
 let calls=0;
 const result=await run(async()=>{
  calls++;return answer("不会改变画布。");
 },[{role:"user",content:"不要对整个画布按连线关系执行布局"}]);
 assert.equal(calls,1);
 assert.deepEqual(result.actions,[]);
});
