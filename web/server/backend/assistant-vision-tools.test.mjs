import test from "node:test";
import assert from "node:assert/strict";
import {createAssistantChatService} from "./assistant-chat.mjs";
const img=Buffer.from([137,80,78,71,13,10,26,10,42]);
const toolCall=(id,name,args)=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const completed=(message,toolCalls=[])=>new Response(JSON.stringify({choices:[{
 finish_reason:toolCalls.length?"tool_calls":"stop",
 message:{role:"assistant",content:message,tool_calls:toolCalls}
}]}),{status:200});
const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
 withSecretVersion:(_id,callback)=>callback(Buffer.from("private-secret"))};
const base={channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8188/v1",model:"demo",
 canvasActions:true,messages:[{role:"user",content:"请观察图像，创建一个描述文本节点"}],
 visualImages:[{mimeType:"image/png",bytes:img}],visualDetail:"high",
 skillContext:"<selected-skill>使用准确描述</selected-skill>",
 skillTools:[{id:"story",name:"描述规范",description:"描述",version:"aaaaaaaaaaaa",
  skillMd:"观察后准确描述",resources:{"references/vision.md":"避免猜测细节"}}]};
test("multi-round Skill tools preserve vision parts in original request",async()=>{
 const sent=[];let n=0;
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  sent.push(JSON.parse(options.body));n++;
  if(n===1)return completed(null,[toolCall("s1","read_skill_resource",{
   skill_id:"story",path:"references/vision.md"})]);
  return completed(JSON.stringify({answer:"观察后创建了图片描述",actions:[
   {type:"create_node",ref:"new",nodeType:"text",title:"视觉描述",content:"一座山"}]}));
 }});
 const result=await service(base);
 assert.equal(sent.length,2);
 assert.equal(result.actions[0].type,"create_node");
 assert.deepEqual(result.skillResourceReads,[{skillId:"story",path:"references/vision.md"}]);
 const content=sent[0].messages.at(-1).content;
 assert.equal(content[1].type,"image_url");
 assert.equal(content[1].image_url.detail,"high");
 assert.deepEqual(Buffer.from(content[1].image_url.url.split(",")[1],"base64"),img);
 const second=sent[1].messages.find(message=>message.role==="user");
 assert.equal(second.content[1].type,"image_url");
 assert.doesNotMatch(JSON.stringify(result),/private-secret|base64/);
});
test("canvas action correction retains multimodal image context instead of silently losing image",async()=>{
 let n=0;const sent=[];
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  const body=JSON.parse(options.body);sent.push(body);n++;
  return completed(n===1?
   JSON.stringify({answer:"我可以帮你完成",actions:[]}):
   JSON.stringify({answer:"已规划",actions:[{type:"create_node",ref:"new",nodeType:"text",
    title:"视觉描述",content:"岩石"}]}));
 }});
 const result=await service({...base,skillTools:[]});
 assert.equal(n,2);assert.equal(result.actions.length,1);
 assert.equal(sent[1].messages.at(-1).content[1].type,"image_url");
 assert.deepEqual(Buffer.from(sent[1].messages.at(-1).content[1].image_url.url.split(",")[1],"base64"),img);
});
