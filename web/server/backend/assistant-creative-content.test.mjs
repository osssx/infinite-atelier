import test from "node:test";
import assert from "node:assert/strict";
import {requiresPopulatedCreativeText,isPopulatedCreativeBody,
 hasPopulatedCreativeTextActions} from "./assistant-creative-content.mjs";

const three=[
 {type:"create_text",ref:"rabbit",title:"小兔嘟嘟",content:"小兔嘟嘟是一只毛色雪白的儿童动画主角，穿蓝色斗篷，活泼好奇，遇到困难会主动帮助小伙伴。"},
 {type:"create_node",ref:"mother",nodeType:"text",title:"兔妈妈",content:"兔妈妈穿着棕色围裙，毛色米白，性格温柔坚定，常用耐心的鼓励帮助小兔独立解决困难。"},
 {type:"create_text",ref:"turtle",title:"小龟慢慢",content:"小龟慢慢背着橄榄绿龟壳，行动缓慢但观察细致，是小兔的朋友，也是冒险中的理智伙伴。"},
 {type:"layout_nodes",nodeIds:["rabbit","mother","turtle"],direction:"horizontal",gap:48}
];

test("P4.9a explicit populated creative text-node intent, never blank templates or discussion",()=>{
 for(const req of [
  "为每个角色生成角色卡提示词文本节点",
  "请创建故事大纲文本节点，写出具体情节",
  "新建三个分镜提示词文本节点",
  "请生成场景设定文字节点，不要空白模板"
 ])assert.equal(requiresPopulatedCreativeText(req),true,req);
 for(const req of [
  "只要文字角色设定方案，不要修改画布",
  "请创建空白角色卡文本节点",
  "生成角色卡空模板文本节点，不填正文",
  "创建一个空文本节点",
  "创建角色卡分组",
  "请分析角色卡文本节点为什么为空",
  "不要生成角色卡文本节点"
 ])assert.equal(requiresPopulatedCreativeText(req),false,req);
});
test("P4.9a populated node bodies reject empty, bare headings and template placeholders",()=>{
 assert.equal(hasPopulatedCreativeTextActions(three),true);
 for(const body of [
  "", "  ", "姓名：\n外貌：\n性格：\n背景故事：",
  "角色名称：待填写，外貌：待补充，性格：待完善。",
  "姓名：小兔\n身份：\n外貌：\n性格：",
  "角色卡已生成"
 ])assert.equal(isPopulatedCreativeBody(body),false,body);
 assert.equal(hasPopulatedCreativeTextActions([{...three[0],content:""},...three.slice(1)]),false);
 assert.equal(hasPopulatedCreativeTextActions([{type:"create_node",ref:"x",nodeType:"text",title:"角色"},three[1]]),false);
 assert.equal(hasPopulatedCreativeTextActions([{type:"create_group",ref:"g1",title:"角色卡",members:[]}]),false);
 // Ordinary short text nodes and explicitly empty templates are intentionally
 // not passed through this requested-populated validator.
});

import {createAssistantChatService} from "./assistant-chat.mjs";

const vault={
 get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"one"}),
 withSecretVersion:(_version,fn)=>fn(Buffer.from("not-a-real-key"))
};
const request="为每个角色生成角色卡提示词文本节点";
const taskContext="原始任务：兔子儿童动画；有效计划版本：3。历史 AI 创作草案：小兔嘟嘟、兔妈妈、小龟慢慢；角色设定目前只是未确认的创意参考。";
const options={channelId:"model",provider:"openai_compatible",
 baseUrl:"http://127.0.0.1:8188/v1",model:"local-mock",
 messages:[{role:"user",content:request}],canvasActions:true,taskContext};
const upstream=text=>new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:text}}]}),
 {status:200,headers:{"content-type":"application/json"}});
const serialize=actions=>JSON.stringify({answer:"拟生成角色卡草案，等待画布执行确认",actions});

test("P4.9a real provider-shaped repair preserves frozen Task context and restores all three concrete role cards",async()=>{
 const calls=[],records=[];
 const broken=three.map(v=>v.type==="create_text"||v.type==="create_node"?
  {...v,content:"姓名：\\n外貌：\\n性格："}:v);
 const ask=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,{body})=>{
  calls.push(JSON.parse(body));
  return upstream(serialize(calls.length===1?broken:three));
 }});
 const result=await ask({...options,
  callObserver:{
   start:({kind})=>{records.push(kind);return "call-"+records.length},
   success:()=>{},failure:()=>{throw Error("unexpected call failure")}
  },
  providerPayloadGuard:(body,{kind})=>{
   assert.equal(JSON.parse(body).messages[0].content.includes(taskContext),true,kind);
  }
 });
 assert.equal(calls.length,2);
 assert.equal(records.length,2);
 assert.equal(records[1],"format_repair");
 assert.equal(result.formatRepairCount,1);
 assert.equal(result.actions.length,4);
 assert.equal(hasPopulatedCreativeTextActions(result.actions),true);
 for(const payload of calls){
  assert.match(payload.messages[0].content,/小兔嘟嘟、兔妈妈、小龟慢慢/);
  assert.match(payload.messages[0].content,/有效计划版本：3/);
  assert.doesNotMatch(JSON.stringify(payload),/not-a-real-key/);
 }
 assert.match(calls[1].messages[0].content,/CONTENT CORRECTION/);
 assert.match(calls[1].messages[1].content,/为每个角色生成角色卡提示词文本节点/);
});

test("P4.9a persistent blank creative nodes never escape to a canvas action result; only one corrective POST",async()=>{
 let sent=0;
 const ask=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  sent++;return upstream(serialize([{type:"create_text",ref:"blank",title:"小兔嘟嘟",content:"姓名：\\n外貌：\\n性格："}]));
 }});
 await assert.rejects(ask(options),error=>error?.code==="assistant_creative_content_incomplete");
 assert.equal(sent,2);
});

test("P4.9a explicit blank templates and ordinary empty text nodes remain allowed",async()=>{
 for(const input of ["创建空白角色卡文本节点","创建一个空文本节点"]){
  let sent=0;
  const ask=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
   sent++;return upstream(serialize([{type:"create_node",ref:"t",nodeType:"text",title:"空白",content:""}]));
  }});
  const result=await ask({...options,messages:[{role:"user",content:input}]});
  assert.equal(sent,1,input);
  assert.equal(result.actions[0].content,"");
 }
});

test("P4.9a original format-repair path keeps Task context even when first model returns prose instead of JSON",async()=>{
 const calls=[];
 const ask=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,{body})=>{
  calls.push(JSON.parse(body));
  return upstream(calls.length===1?"我会创建角色卡，但没有输出画布操作。":serialize(three));
 }});
 const result=await ask(options);
 assert.equal(calls.length,2);
 assert.equal(result.formatRepairCount,1);
 assert.equal(hasPopulatedCreativeTextActions(result.actions),true);
 assert.match(calls[1].messages[0].content,/有效计划版本：3/);
 assert.match(calls[1].messages[0].content,/历史 AI 创作草案/);
});

