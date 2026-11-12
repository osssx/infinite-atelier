import test from "node:test";
import assert from "node:assert/strict";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {assistantDeferredSkillScript} from "./assistant-skill-completion.mjs";

const workflow={
 id:"generic-kit",version:"abcdef123456",name:"通用工作流",description:"Compile a custom data artifact",
 skillMd:"Write a UTF-8 input file using references/format.md, then use scripts/transform.py with --output result.txt to compile. Read output and add it to a text node. Do not use the draft as final output.",
 resources:{"references/format.md":"Input is JSON with format_version=1 and content as a string."},
 scriptPaths:["scripts/transform.py"]
};
const args={channelId:"c1",provider:"openai_compatible",model:"demo",
 baseUrl:"http://localhost:8188/v1",canvasActions:true,
 skillContext:"<selected-skill>Write input JSON and compile with scripts/transform.py</selected-skill>",
 skillTools:[workflow],messages:[{role:"user",content:"请为图片生成最终提示词，并写入画布文本节点"}]};
const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
 withSecretVersion:(_v,cb)=>cb(Buffer.from("secret"))};
const call=(id,name,p)=>({id,type:"function",function:{name,arguments:JSON.stringify(p)}});
const answer=(content,calls=[])=>new Response(JSON.stringify({
 choices:[{finish_reason:calls.length?"tool_calls":"stop",
 message:{role:"assistant",content,tool_calls:calls}}]
}),{status:200});

test("generic incomplete draft is repaired into a real authorized script proposal, not a canvas write",async()=>{
 const requests=[];let attempts=0;
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,init)=>{
  const body=JSON.parse(init.body);requests.push(body);attempts++;
  if(attempts===1)return answer(JSON.stringify({
   answer:"草稿已准备；还需要使用技能自带脚本 scripts/transform.py 编译后才能交付，我没有执行脚本。",
   actions:[{type:"create_node",ref:"draft",nodeType:"text",title:"草稿",content:"{draft}"}]
  }));
  if(attempts===2)return answer(null,[call("ref","read_skill_resource",{
   skill_id:"generic-kit",path:"references/format.md"
  })]);
  return answer(null,[call("propose","run_skill_script",{
   skill_id:"generic-kit",script_path:"scripts/transform.py",
   args:["draft.json","--output","result.txt"],
   input_files_json:JSON.stringify({"draft.json":JSON.stringify({
    format_version:1,content:"scene description"
   })}),output_files:["result.txt"]
  })]);
 }});
 const result=await service(args);
 assert.equal(attempts,3);
 assert.deepEqual(result.actions,[]);
 assert.equal(result.skillScriptProposal.skill_id,"generic-kit");
 assert.equal(result.skillScriptProposal.script_path,"scripts/transform.py");
 assert.equal(result.skillScriptProposal.version,"abcdef123456");
 assert.deepEqual(result.skillScriptProposal.output_files,["result.txt"]);
 assert.equal(JSON.parse(result.skillScriptProposal.input_files["draft.json"]).format_version,1);
 assert.match(requests[1].messages[0].content,/SKILL WORKFLOW COMPLETION REQUIRED/);
 assert.equal(requests[2].messages.at(-1).role,"tool");
});
test("repair fails closed when model still refuses to use authorized Skill script",async()=>{
 let attempts=0;
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  attempts++;return answer(JSON.stringify({answer:"需要手动运行 scripts/transform.py 才能得到结果。",
    actions:[{type:"create_node",ref:"draft",nodeType:"text",title:"草稿",content:"pending"}]}));
 }});
 await assert.rejects(service(args),{code:"assistant_skill_execution_incomplete"});
 assert.equal(attempts,2);
});
test("ordinary advice, no-script Skill, and post-approval continuation never force a script",async()=>{
 const response=JSON.stringify({answer:"可以采用这个流程，不要求执行脚本。",actions:[]});
 const explainMessages=[{role:"user",content:"为什么要用 scripts/transform.py 编译？"}];
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async()=>answer(response)});
 assert.equal((await service({...args,messages:explainMessages})).answer,
  "可以采用这个流程，不要求执行脚本。");
 assert.equal((await service({...args,messages:explainMessages,skillTools:[{...workflow,scriptPaths:[]}]})).answer,
  "可以采用这个流程，不要求执行脚本。");
 assert.equal((await service({...args,messages:explainMessages,skillScriptProposalEnabled:false})).answer,
  "可以采用这个流程，不要求执行脚本。");
 assert.equal(assistantDeferredSkillScript({
  answer:JSON.stringify({answer:"已完成",actions:[]}),
  request:"帮我创建文本节点",authorizedEntries:[workflow]
 }),false);
});
test("does not falsely require rerunning a previously successful authorized script",()=>{
 const outputs=[
  "脚本已成功执行，outputs/prompt.txt 已保存，无需再手动编译。",
  "已经编译成功，结果可直接使用，不需要再运行脚本。",
  "Script already executed successfully; no need to run the compiler again."
 ];
 for(const answer of outputs)assert.equal(assistantDeferredSkillScript({
  answer:JSON.stringify({answer,actions:[]}),request:"把编译好的结果写入画布",
  authorizedEntries:[workflow]
 }),false,answer);
 assert.equal(assistantDeferredSkillScript({
  answer:JSON.stringify({answer:"第一步已经执行成功，但下一步仍需运行另一个脚本。",actions:[]}),
  request:"把结果写入画布",authorizedEntries:[workflow]
 }),true);
});
test("when further script approval is disabled a deferred manual script cannot become final canvas output",async()=>{
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async()=>answer(
  JSON.stringify({answer:"还必须手动运行 scripts/transform.py 才能完成结果。",
   actions:[{type:"create_node",ref:"draft",nodeType:"text",title:"草稿",content:"pending"}]})
 )});
 await assert.rejects(service({...args,skillScriptProposalEnabled:false}),
  {code:"assistant_skill_execution_incomplete"});
});
test("Gemini generic incomplete workflow also repairs through functionCall",async()=>{
 let calls=0;
 const geminiVault={get:()=>({provider:"google_gemini",hasKey:true,keyVersion:"v2"}),
  withSecretVersion:(_v,cb)=>cb(Buffer.from("secret"))};
 const service=createAssistantChatService({vault:geminiVault,compatibleUpstreamCall:async(_url,opts)=>{
  calls++;const body=JSON.parse(opts.body);
  if(calls===1)return new Response(JSON.stringify({candidates:[{content:{parts:[{
   text:JSON.stringify({answer:"还需要执行 scripts/transform.py 编译后才能交付。",
    actions:[]})}]},finishReason:"STOP"}]}),{status:200});
  assert.match(body.systemInstruction.parts.at(-1).text,/SKILL WORKFLOW COMPLETION REQUIRED/);
  return new Response(JSON.stringify({candidates:[{content:{parts:[{
   functionCall:{name:"run_skill_script",args:{
    skill_id:"generic-kit",script_path:"scripts/transform.py",
    input_files_json:JSON.stringify({"input.json":"{}"}),output_files:["result.txt"]
   }}
  }]},finishReason:"STOP"}]}),{status:200});
 }});
 const result=await service({...args,provider:"google_gemini"});
 assert.equal(calls,2);
 assert.equal(result.skillScriptProposal.script_path,"scripts/transform.py");
});
