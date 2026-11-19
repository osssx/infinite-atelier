import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createAssistantTask,appendAssistantTaskTurn,linkAssistantTaskToChat} from "./assistant-tasks.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";

const shot=[
 "### 镜头 1｜发现（0:00–0:05）",
 "- **景别/运镜**：大远景 → 全景，低角度贴地跟随，从蘑菇坡掠过草地落到树洞小屋门口",
 "- **画面**：午后暖光，蒲公英飘絮。小兔嘟嘟系着明黄短围巾从天蓝背带裤口袋里掏出一颗亮玻璃珠，蹦跳着往前跑，耳朵一颠一颠；跑到一半突然刹住——蒲公英丛里一只小鸟的翅膀被藤蔓缠住",
 "- **表演**：瞪圆眼「咦？」→ 耳朵直竖 → 身体前倾",
 "- **色彩光影**：奶白／天蓝／明黄主色，暖橙逆光，影子短而软",
 "- **音效**：轻快木琴＋风铃，小脚丫噗噗声",
 "- **转场**：用嘟嘟的视线做甩镜接镜头 2"
].join("\n");
const storyboard="## 三镜头分镜\n\n"+shot+"\n\n### 镜头 2｜救援\n- 小兔去找兔妈妈。\n\n### 镜头 3｜归巢\n- 小鸟飞回树梢。";
const question="把刚才的镜头 1 转成 H3 Ref2VA";
const oldCard="旧角色卡中的画布正文：这段角色设定只获授权在创作分镜时读取，切换到图像参考后需要继续排除。";
const skillBody="输出格式使用 H3 Ref2VA，给三个角色参考图依次编号。";
const hash=text=>createHash("sha256").update(text).digest("hex");
const policy=includedIds=>({includeContext:true,scope:"selection",includedIds});

async function fixture(t,{authorizedSkillText=skillBody,managed=false}={}) {
 const db=new DatabaseSync(":memory:");
 initializeSchema(db);
 const temp=mkdtempSync(join(tmpdir(),"atelier-history-quote-"));
 const blobStore=createBlobStore({db,dataDir:temp});
 const ids=["img-rabbit","img-mother","img-turtle"];
 const bytes=ids.map((_,index)=>Buffer.from([137,80,78,71,13,10,26,10,index]));
 const images=await Promise.all(ids.map(async(id,index)=>{
  const {blobId}=await blobStore.put([bytes[index]],{mime:"image/png"});
  return {id,type:"image",title:id,metadata:{storageKey:"cas:"+blobId,mimeType:"image/png"}};
 }));
 createProject(db,{id:"p",document:{title:"创作画布 2",nodes:[
  {id:"old-card",type:"text",title:"角色卡",metadata:{content:oldCard}},...images
 ],connections:[]}});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat-a",rootMessageId:"root",
  requestId:"create",originalRequest:"创作儿童动画",contextPolicy:policy(["old-card"])}).task;
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_version,callback)=>callback(Buffer.from("test-secret"))};
 const upstream=[],answers=[storyboard];
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,{body})=>{
  const payload=JSON.parse(body);
  upstream.push(payload);
  const content=answers.shift()??"已完成转写。";
  return Response.json({choices:[{message:{role:"assistant",content},finish_reason:"stop"}]});
 }});
 const skillId="h3-prompt-writing",version="abc123def456";
 const skillRegistry={authorized:()=>({entries:[
  {id:skillId,version,name:"H3",description:"H3 Ref2VA",skillMd:authorizedSkillText}
 ]})};
 const app=buildApp({db,blobStore,assistantChat:service,skillRegistry,authorize:()=>true,
  assistantCacheRollout:()=>managed});
 t.after(async()=>{await app.close();db.close();rmSync(temp,{recursive:true,force:true})});
 function append(messageId,text,includedIds=ids,chatSessionId){
  return appendAssistantTaskTurn(db,{projectId:"p",taskId:task.id,requestId:"turn-"+messageId,
   messageId,text,contextPolicy:policy(includedIds),chatSessionId});
 }
 function call(turnMessageId,text,{requestId="infer-"+turnMessageId,historyQuote,withMedia=false,canvasActions=false}={}){
  return app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:{
   channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
   model:"mock",messages:[{role:"user",content:text}],canvasActions,
   ...(managed?{chatSessionId:"chat-a",turnId:turnMessageId,conversationRequestId:requestId}:{}),
   task:{taskId:task.id,turnMessageId,requestId,...(historyQuote?{historyQuote}:{})},
   ...(withMedia?{visualContext:{images:ids.map(nodeId=>({nodeId})),detail:"high"},
    skills:{mode:"manual",projectId:"p",expectedRevision:1,skillIds:[skillId],versionPins:{[skillId]:version}}}:{})
  }});
 }
 const source="生成三镜头分镜";
 append("source",source,["old-card"]);
 const initial=await call("source",source);
 assert.equal(initial.statusCode,200,initial.body);
 const answer=initial.json().answer;
 const start=answer.indexOf(shot);
 assert.ok(start>=0,answer);
 const quote={mode:"auto",sourceRequestId:"infer-source",start,end:start+shot.length,digest:hash(shot)};
 function discover(text=question,chatSessionId="chat-a"){
  return app.inject({method:"POST",url:`/api/v1/projects/p/assistant/tasks/${task.id}/history-quotes`,
   payload:{chatSessionId,text}});
 }
 return {db,task,append,call,upstream,quote,bytes,discover,answers};
}

test("optimized Task validates the exact quote in the multimodal tail",async t=>{
 const f=await fixture(t,{managed:true});
 f.append("convert",question,undefined,"chat-a");
 const converted=await f.call("convert",question,{historyQuote:f.quote,withMedia:true});
 assert.equal(converted.statusCode,200,converted.body);
 const payload=f.upstream.at(-1);
 assert.ok(!payload.messages[0].content.includes(shot));
 const parts=payload.messages.at(-1).content;
 assert.ok(parts[0].text.startsWith(question));
 assert.ok(parts[0].text.includes(shot));
 assert.ok(!parts[0].text.includes(oldCard));
 assert.equal(parts.filter(part=>part.type==="image_url").length,3);
});

test("optimized quote location survives format repair and never exempts another copy",async t=>{
 const f=await fixture(t,{managed:true,authorizedSkillText:oldCard});
 const edit="请在画布创建一个文本节点";
 const historyQuote={mode:"user",text:oldCard,digest:hash(oldCard)};
 f.append("repair",edit,undefined,"chat-a");
 f.answers.push("无效回复",JSON.stringify({answer:"已提议",actions:[{type:"create_text",ref:"card",title:"分镜",content:"对白"}]}));
 const repaired=await f.call("repair",edit,{historyQuote,canvasActions:true});
 assert.equal(repaired.statusCode,200,repaired.body);
 assert.equal(repaired.json().formatRepairCount,1);
 assert.equal(f.upstream.length,3);
 for(const payload of f.upstream.slice(1)){
  assert.doesNotMatch(payload.messages[0].content,new RegExp(oldCard));
  assert.equal(payload.messages.at(-1).content.split(oldCard).length,2);
 }
 f.append("duplicated",question,undefined,"chat-a");
 const blocked=await f.call("duplicated",question,{historyQuote,withMedia:true});
 assert.equal(blocked.statusCode,403,blocked.body);
 assert.equal(blocked.json().code,"assistant_task_context_not_authorized");
 assert.equal(f.upstream.length,3);
});

test("Task HTTP sends the unique historical shot, ordered image pixels and H3 Skill in the same provider call",async t=>{
 const f=await fixture(t);
 const discovery=await f.discover();
 assert.equal(discovery.statusCode,200,discovery.body);
 const [candidate,...otherCandidates]=discovery.json().candidates;
 assert.deepEqual(otherCandidates,[]);
 assert.equal(candidate.text,shot);
 const {sourceRequestId,start,end,digest}=candidate;
 const options={historyQuote:{mode:"auto",sourceRequestId,start,end,digest},withMedia:true};
 f.append("convert",question,undefined,"chat-a");
 const result=await f.call("convert",question,options);
 assert.equal(result.statusCode,200,result.body);
 assert.equal(result.json().usedHistoryQuote.text,shot);
 const payload=f.upstream.at(-1);
 const text=payload.messages.flatMap(message=>typeof message.content==="string"?[message.content]:
  message.content.filter(part=>part.type==="text").map(part=>part.text)).join("\n");
 assert.ok(text.includes(shot),"the exact multiline shot must reach the provider");
 assert.ok(text.includes(skillBody));
 assert.ok(!text.includes(oldCard));
 assert.ok(!text.includes("镜头 2｜救援"));
 const actualImages=payload.messages.at(-1).content.filter(part=>part.type==="image_url");
 assert.deepEqual(actualImages.map(part=>Buffer.from(part.image_url.url.split(",")[1],"base64")),f.bytes);
 const repeat=await f.call("convert",question,options);
 assert.equal(repeat.statusCode,200,repeat.body);
 assert.equal(f.upstream.length,2,"idempotent replay must not post again");
 const changed=await f.call("convert",question,{requestId:"changed",withMedia:true});
 assert.ok(changed.statusCode>=400&&changed.statusCode<500,changed.body);
 assert.equal(f.upstream.length,2,"a new command cannot silently drop a frozen quote");
});

test("Task HTTP rejects a forged automatic history quote before provider POST",async t=>{
 const f=await fixture(t);
 f.append("forged",question);
 const result=await f.call("forged",question,{historyQuote:{...f.quote,digest:"0".repeat(64)}});
 assert.ok(result.statusCode>=400&&result.statusCode<500,result.body);
 assert.equal(f.upstream.length,1);
});

test("Task HTTP requires selection when two earlier replies contain the requested shot",async t=>{
 const f=await fixture(t);
 const alternative=storyboard.replace("低角度贴地跟随","固定远景");
 f.answers.push(alternative);
 f.append("other","写另一个版本的分镜",["old-card"],"chat-a");
 const other=await f.call("other","写另一个版本的分镜");
 assert.equal(other.statusCode,200,other.body);
 const candidates=await f.discover();
 assert.equal(candidates.statusCode,200,candidates.body);
 assert.equal(candidates.json().candidates.length,2);
 f.append("ambiguous",question,undefined,"chat-a");
 const rejected=await f.call("ambiguous",question,{historyQuote:f.quote});
 assert.ok(rejected.statusCode>=400&&rejected.statusCode<500,rejected.body);
 assert.equal(f.upstream.length,2);
 const selected=await f.call("ambiguous",question,{historyQuote:{...f.quote,mode:"selected"}});
 assert.equal(selected.statusCode,200,selected.body);
 assert.equal(selected.json().usedHistoryQuote.text,shot);
});

test("Task HTTP excludes another linked chat's quote and accepts a manually selected legacy excerpt",async t=>{
 const f=await fixture(t);
 linkAssistantTaskToChat(f.db,{projectId:"p",taskId:f.task.id,requestId:"link-b",chatSessionId:"chat-b"});
 const foreign=await f.discover(question,"chat-b");
 assert.equal(foreign.statusCode,200,foreign.body);
 assert.deepEqual(foreign.json().candidates,[]);
 f.append("foreign",question,undefined,"chat-b");
 const rejected=await f.call("foreign",question,{historyQuote:{...f.quote,mode:"selected"}});
 assert.ok(rejected.statusCode>=400&&rejected.statusCode<500,rejected.body);
 assert.equal(f.upstream.length,1);
 const manual="旧回复中圈选的镜头：小兔在草地上发现一只小鸟。";
 const result=await f.call("foreign",question,{historyQuote:{mode:"user",text:manual,digest:hash(manual)}});
 assert.equal(result.statusCode,200,result.body);
 assert.equal(result.json().usedHistoryQuote.text,manual);
 assert.ok(JSON.stringify(f.upstream.at(-1)).includes(manual));
});

test("Task HTTP rejects a quote that exceeds its UTF-8 budget before provider POST",async t=>{
 const f=await fixture(t);
 f.append("large",question,undefined,"chat-a");
 const oversized="字".repeat(1500);
 const result=await f.call("large",question,{historyQuote:{mode:"user",text:oversized,digest:hash(oversized)}});
 assert.equal(result.statusCode,413,result.body);
 assert.equal(result.json().code,"assistant_history_quote_budget");
 assert.equal(f.upstream.length,1);
});

test("a linked chat cannot rebind another chat's user-turn ID",async t=>{
 const f=await fixture(t);
 linkAssistantTaskToChat(f.db,{projectId:"p",taskId:f.task.id,requestId:"link-b",chatSessionId:"chat-b"});
 assert.throws(()=>appendAssistantTaskTurn(f.db,{projectId:"p",taskId:f.task.id,
  requestId:"duplicate-source",messageId:"source",text:question,contextPolicy:policy([]),chatSessionId:"chat-b"}),
  error=>error.statusCode===409);
 const discovery=await f.discover(question,"chat-b");
 assert.equal(discovery.statusCode,200,discovery.body);
 assert.deepEqual(discovery.json().candidates,[]);
});

test("quote authorization is limited to the verified quote position in the model request",async t=>{
 const f=await fixture(t,{authorizedSkillText:oldCard});
 const historyQuote={mode:"user",text:oldCard,digest:hash(oldCard)};
 f.append("quoted-card",question,undefined,"chat-a");
 const quoted=await f.call("quoted-card",question,{historyQuote});
 assert.equal(quoted.statusCode,200,quoted.body);
 assert.equal(quoted.json().usedHistoryQuote.text,oldCard);
 f.append("duplicate-card",question,undefined,"chat-a");
 const blocked=await f.call("duplicate-card",question,{historyQuote,withMedia:true});
 assert.equal(blocked.statusCode,403,blocked.body);
 assert.equal(blocked.json().code,"assistant_task_context_not_authorized");
 assert.equal(f.upstream.length,2);
});
