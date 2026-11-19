import test from "node:test";
import assert from "node:assert/strict";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {latestCanvasUserRequest,isCanvasEditInstruction,isAssistantTextOnlyRequest,exactWholeCanvasGraphLayout} from "./assistant-action-intent.mjs";
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

test("inspection of connection nouns is read-only while explicit follow-up edits remain edits",()=>{
 assert.equal(isCanvasEditInstruction("检查画布节点连线"),false);
 assert.equal(isCanvasEditInstruction("查看节点连接与布局"),false);
 assert.equal(isCanvasEditInstruction("先检查画布节点连线，然后创建文本节点"),true);
 for(const request of ["先检查画布节点，再把 A 和 B 连接起来",
  "检查连线，然后将整个画布按依赖从左到右排列","查看画布节点并连接 A 和 B",
  "读取人物ch04 / ch05 / ch06提示词提取到新建文本节点并配置好生图参数",
  "读取角色提示词提取到新建文本节点"])
  assert.equal(isCanvasEditInstruction(request),true,request);
 for(const request of ["查看整个画布的分组和连线布局","检查图像生成节点的连线","检查画布的布局设置"]){
  assert.equal(isCanvasEditInstruction(request),false,request);
  assert.equal(exactWholeCanvasGraphLayout(request),null,request);
 }
 assert.equal(exactWholeCanvasGraphLayout("检查连线，然后将整个画布按依赖从左到右排列")?.type,"layout_graph");
});


const textOnlyPrompt="请帮我规划一个包含 3 个镜头的短视频分镜，只输出文字方案。不要修改画布、调用 Skill 或提交任何图片和视频生成任务。后续我会继续完善这个方案。";
test("semantic canvas turns interpret a contextual confirmation in one model request",async()=>{
 const calls=[];
 const action={type:"create_text",ref:"role",title:"CH04",content:"角色原文"};
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  calls.push(JSON.parse(options.body));
  return answer(JSON.stringify({answer:"角色文本节点",actions:[action]}));
 }});
 const latest="就按你上面提的方案办";
 assert.equal(isCanvasEditInstruction(latest),false);
 const result=await service({...base,semanticCanvasIntent:true,messages:[
  {role:"user",content:"先讨论 CH04 的处理方式"},
  {role:"assistant",content:"可以在画布上添加 CH04 文本节点"},
  {role:"user",content:latest}
 ]});
 assert.equal(calls.length,1);
 assert.match(calls[0].messages[0].content,/Infer the user's intent/);
 assert.deepEqual(result.actions,[action]);
});
test("semantic canvas turns accept prose and enforce explicit no-write and no-run constraints",async()=>{
 const calls=[];
 const create={type:"create_node",ref:"portrait",nodeType:"image",title:"定妆照",prompt:"角色定妆"};
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  calls.push(JSON.parse(options.body));
  if(calls.length===1)return answer("这是一个说明。");
  return answer(JSON.stringify({answer:"配置节点",actions:[create,{type:"run_node",nodeId:"portrait"}]}));
 }});
 const ask=content=>service({...base,semanticCanvasIntent:true,messages:[{role:"user",content}]});
 assert.deepEqual((await ask("这种构图有什么利弊？")).actions,[]);
 assert.deepEqual((await ask("只给文字方案，不要修改画布")).actions,[]);
 assert.deepEqual((await ask("先建好定妆照节点，不提交生成")).actions,[create]);
 assert.equal(calls.length,3);
});
test("inspection followed by explicit layout keeps its proposed action",async()=>{
 const text="检查连线，然后将整个画布按依赖从左到右排列";
 const result=await run(async()=>answer(JSON.stringify({answer:"检查完成",actions:[]})),[{role:"user",content:text}]);
 assert.equal(result.actions[0].type,"layout_graph");
 assert.equal(result.actions[0].direction,"horizontal");
});

test("negative canvas verbs and text-only output are not executable commands",()=>{
 for(const prompt of [
  textOnlyPrompt,
  "只输出文字方案，不要修改画布",
  "不要修改画布",
  "不要在画布创建节点",
  "仅提供分镜文字建议，不要生成媒体"
 ]){
  assert.equal(isAssistantTextOnlyRequest(prompt),true,prompt);
  assert.equal(isCanvasEditInstruction(prompt),false,prompt);
 }
 for(const prompt of [
  "创建三个分镜文本节点",
  "将整个画布按连线关系布局，不要修改节点内容",
  "修改图片节点参数，不要生成图片"
 ])assert.equal(isAssistantTextOnlyRequest(prompt),false,prompt);
});
test("legacy canvasActions=true never forces text-only storyboards to JSON or a repair retry",async()=>{
 const calls=[];
 const result=await run(async(_url,options)=>{
  calls.push(JSON.parse(options.body));
  return answer("镜头一：远景建立场景。\\n镜头二：近景推进情节。\\n镜头三：特写结尾。");
 },[{role:"user",content:textOnlyPrompt}]);
 assert.equal(calls.length,1);
 assert.match(calls[0].messages[0].content,/只能提供分析和建议/);
 assert.doesNotMatch(calls[0].messages[0].content,/create_text/);
 assert.deepEqual(result.actions,[]);
 assert.match(result.answer,/镜头一/);
 assert.equal(result.formatRepairCount,undefined);
});
test("text-only user's explicit no-write constraint also discards unexpected model canvas actions",async()=>{
 let calls=0;
 const result=await run(async()=>{
  calls++;
  return answer(JSON.stringify({answer:"三镜头文字方案",actions:[
   {type:"create_text",ref:"unexpected",title:"误操作",content:"不能写入画布"}
  ]}));
 },[{role:"user",content:textOnlyPrompt}]);
 assert.equal(calls,1);
 assert.equal(result.answer,"三镜头文字方案");
 assert.deepEqual(result.actions,[]);
});

test("HTTP text-only planning returns prose and leaves a real project unmodified",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const calls=[];
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  calls.push(JSON.parse(options.body));
  return answer("镜头一：建立场景；镜头二：推进冲突；镜头三：悬念结尾。");
 }});
 const app=buildApp({db,assistantChat:service,authorize:()=>true});
 t.after(async()=>{await app.close();db.close()});
 const project="/api/v1/projects/storyboard-text-only";
 const created=await app.inject({method:"POST",url:"/api/v1/projects",
  payload:{id:"storyboard-text-only",document:{nodes:[],connections:[]}}});
 assert.equal(created.statusCode,201,created.body);
 const response=await app.inject({method:"POST",url:project+"/assistant/chat",
  payload:{...base,messages:[{role:"user",content:textOnlyPrompt}]}});
 assert.equal(response.statusCode,200,response.body);
 assert.equal(calls.length,1);
 assert.deepEqual(response.json().actions,[]);
 assert.match(response.json().answer,/镜头一/);
 const after=await app.inject({method:"GET",url:project});
 assert.equal(after.json().revision,1);
 assert.deepEqual(after.json().document.nodes,[]);
});

test("cross-chat Task topic clarification stays ordinary prose for legacy canvasActions=true",async()=>{
 const calls=[];
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  calls.push(JSON.parse(options.body));
  return answer("兔子儿童动画分镜：镜头一，小兔子走出蘑菇屋；镜头二，发现迷路的小松鼠；镜头三，一起找到回家的路。");
 }});
 const taskContext="原始目标：三镜头分镜规划，只输出文字，不修改画布，不调用 Skill，也不生成图像视频。聊天已跨会话关联。";
 const result=await service({...base,taskContext,
  messages:[{role:"user",content:"主题是关于兔子的儿童动画片"}]});
 assert.equal(calls.length,1,"A text continuation must not trigger JSON format repair");
 assert.match(calls[0].messages[0].content,/只能提供分析和建议/);
 assert.doesNotMatch(calls[0].messages[0].content,/create_text/);
 assert.match(calls[0].messages[0].content,/原始目标/);
 assert.deepEqual(result.actions,[]);
 assert.match(result.answer,/兔子儿童动画分镜/);
});
test("non-edit topic clarification tolerates malformed action JSON and discards unsolicited actions",async()=>{
 const request="主题是关于兔子的儿童动画片";
 for(const payload of ['{"answer":"小兔子", "actions":[',JSON.stringify({
  answer:"兔子分镜 v3",actions:[{type:"create_text",ref:"unexpected",title:"自动创建",content:"不要执行"}]
 })]){
  let calls=0;
  const result=await run(async()=>{calls++;return answer(payload)},[{role:"user",content:request}]);
  assert.equal(calls,1);
  assert.deepEqual(result.actions,[]);
  if(payload.includes("v3"))assert.equal(result.answer,"兔子分镜 v3");
  else assert.match(result.answer,/小兔子/);
 }
});

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
test("P2.5 treats explicit generation and configuration commands as edit intent for format repair",()=>{
 for(const request of [
  "运行选中的图片节点",
  "执行 ComfyUI 工作流节点",
  "为图片节点设置模型",
  "切换文本节点模型",
  "生成选中的视频节点",
  "设置节点生成参数并运行"
 ])assert.equal(isCanvasEditInstruction(request),true,request);
 for(const request of [
  "请解释如何执行节点生成",
  "不要执行工作流",
  "如何配置图片模型？"
 ])assert.equal(isCanvasEditInstruction(request),false,request);
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
