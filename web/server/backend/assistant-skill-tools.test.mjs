import test from "node:test";
import assert from "node:assert/strict";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {createAssistantSkillToolSession} from "./assistant-skill-tools.mjs";

const skill={id:"story",name:"编剧",description:"分镜短剧",version:"a".repeat(12),
 skillMd:"先规划分镜，再细化镜头。",resources:{"references/shots.md":"镜头 A：远景。镜头 B：特写。"},
 scripts:{"scripts/run.py":"print('should never execute')"}};
const toolSkills=[skill];
const args={channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",
 model:"demo",canvasActions:true,messages:[{role:"user",content:"为故事新建分镜文本节点"}],
 skillContext:"<selected-skill>先规划分镜，再细化镜头。</selected-skill>",skillTools:toolSkills};
const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
 withSecretVersion:(_version,cb)=>cb(Buffer.from("private-key"))};
const call=(id,name,value)=>({id,type:"function",function:{name,arguments:JSON.stringify(value)}});
const response=(content,tools=[])=>new Response(JSON.stringify({choices:[{
 finish_reason:tools.length?"tool_calls":"stop",
 message:{role:"assistant",content,tool_calls:tools}
}]}),{status:200});
const result=JSON.stringify({answer:"已生成分镜规划",actions:[
 {type:"create_node",ref:"new",nodeType:"text",title:"分镜",content:"按两组镜头规划"}]});

test("assistant authorized read-only tool transcript uses references on demand and returns canvas actions",async()=>{
 const requests=[];let calls=0;
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,init)=>{
  const body=JSON.parse(init.body);requests.push(body);calls++;
  if(calls===1)return response(null,[call("s1","search_skills",{query:"编剧"})]);
  if(calls===2)return response(null,[call("r1","read_skill_resource",{skill_id:"story",path:"references/shots.md"})]);
  return response(result);
 }});
 const answer=await service(args);
 assert.equal(calls,3);
 assert.equal(answer.actions[0].type,"create_node");
 assert.deepEqual(answer.skillResourceReads,[{skillId:"story",path:"references/shots.md"}]);
 assert.deepEqual(answer.skillToolCalls.map(item=>item.name),["search_skills","read_skill_resource"]);
 assert.deepEqual(requests[0].tools.map(item=>item.function.name),[
  "search_skills","activate_skill","read_skill_resource"]);
 assert.doesNotMatch(JSON.stringify(requests[0]),/镜头 A：远景/);
 assert.match(requests[2].messages.at(-1).content,/镜头 A：远景/);
 assert.equal(requests[2].messages.at(-1).role,"tool");
 assert.equal(requests[2].messages.at(-2).role,"assistant");
 assert.doesNotMatch(JSON.stringify(answer),/镜头 A：远景|private-key|scripts\/run/);
});

test("assistant rejects unoffered scripts, path traversal, and forged Skill IDs without further inference",async()=>{
 const attempts=[
  call("a1","run_skill_script",{skill_id:"story",script_path:"scripts/run.py"}),
  call("a2","read_skill_resource",{skill_id:"story",path:"../scripts/run.py"}),
  call("a3","read_skill_resource",{skill_id:"other",path:"references/shots.md"}),
  call("a4","read_skill_resource",{skill_id:"story",path:"scripts/run.py"}),
  call("a5","read_skill_resource",{skill_id:"story",path:"references/shots.md",command:"cat"})
 ];
 for(const requested of attempts){
  let count=0;
  const service=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
   count++;return response(null,[requested]);
  }});
  await assert.rejects(service(args),error=>[
   "assistant_skill_tool_unauthorized","assistant_skill_tool_arguments_invalid"
  ].includes(error?.code));
  assert.equal(count,1);
 }
});

test("assistant rejects repeated tool IDs and enforces limits on tool-call rounds",async()=>{
 let count=0;
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  count++;
  return response(null,[call("same","activate_skill",{skill_id:"story"})]);
 }});
 await assert.rejects(service(args),{code:"assistant_skill_tool_response_invalid"});
 assert.equal(count,2);
 let round=0;
 const looping=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  round++;return response(null,[call("id"+round,"search_skills",{query:"编剧"})]);
 }});
 await assert.rejects(looping(args),{code:"assistant_skill_tool_round_limit"});
 assert.equal(round,5);
});

test("assistant Skill reference byte budget and script content are never exposed as tools",()=>{
 const session=createAssistantSkillToolSession(toolSkills);
 const activation=JSON.parse(session.invoke("activate_skill",{skill_id:"story"}));
 assert.deepEqual(activation.references,["references/shots.md"]);
 assert.equal(Object.hasOwn(activation,"scripts"),false);
 assert.equal(session.invoke("read_skill_resource",{skill_id:"story",path:"references/shots.md"})
  .includes("镜头 A"),true);
 assert.throws(()=>session.invoke("run_skill_script",{skill_id:"story"}),{code:"assistant_skill_tool_unauthorized"});
 const huge=createAssistantSkillToolSession([{...skill,resources:{"references/huge.md":"字".repeat(9000)}}]);
 assert.throws(()=>huge.invoke("read_skill_resource",{skill_id:"story",path:"references/huge.md"}),
  {code:"assistant_skill_tool_output_too_large"});
});

test("assistant Gemini native functionCall/functionResponse reads references without leaking scripts",async()=>{
 const geminiVault={get:()=>({provider:"google_gemini",hasKey:true,keyVersion:"v2"}),
  withSecretVersion:(_v,fn)=>fn(Buffer.from("gemini-secret"))};
 const requests=[];let n=0;
 const service=createAssistantChatService({vault:geminiVault,compatibleUpstreamCall:async(_url,init)=>{
  const body=JSON.parse(init.body);requests.push(body);n++;
  const parts=n===1?[{functionCall:{name:"read_skill_resource",
   args:{skill_id:"story",path:"references/shots.md"}}}]:[{text:result}];
  return new Response(JSON.stringify({candidates:[{content:{role:"model",parts},finishReason:"STOP"}]}),{status:200});
 }});
 const answer=await service({...args,provider:"google_gemini",baseUrl:"http://localhost:8080/v1beta"});
 assert.equal(n,2);
 assert.equal(answer.actions.length,1);
 assert.deepEqual(answer.skillResourceReads,[{skillId:"story",path:"references/shots.md"}]);
 assert.deepEqual(requests[0].tools[0].functionDeclarations.map(item=>item.name),[
  "search_skills","activate_skill","read_skill_resource"]);
 assert.equal(requests[1].contents.at(-1).role,"user");
 assert.equal(requests[1].contents.at(-1).parts[0].functionResponse.name,"read_skill_resource");
 assert.match(JSON.stringify(requests[1].contents.at(-1)),/镜头 A/);
 assert.doesNotMatch(JSON.stringify(answer),/镜头 A/);
});

test("Skill tool calls are preserved through Chat Completions SSE gateways",async()=>{
 let n=0;
 const frame=(delta,finish=null)=>"data: "+JSON.stringify({choices:[{
  index:0,delta,finish_reason:finish
 }]})+"\n\n";
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  n++;
  const tool=call("ref-1","read_skill_resource",{skill_id:"story",path:"references/shots.md"});
  const frames=n===1?
   frame({role:"assistant",tool_calls:[{index:0,id:tool.id,type:"function",function:tool.function}]})+
    frame({},"tool_calls"):
   frame({role:"assistant",content:result})+frame({},"stop");
  return new Response(frames+"data: [DONE]\n\n",{
   headers:{"content-type":"text/event-stream"},status:200});
 }});
 const reply=await service(args);
 assert.equal(n,2);
 assert.deepEqual(reply.skillResourceReads,[{skillId:"story",path:"references/shots.md"}]);
 assert.equal(reply.actions[0].type,"create_node");
});

test("incompatible function-declaration gateways fall back once to authorized SKILL.md guidance",async()=>{
 const requests=[];
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  const body=JSON.parse(options.body);requests.push(body);
  if(body.tools)return new Response(JSON.stringify({error:"tools unsupported"}),{status:400});
  return response(result);
 }});
 const reply=await service(args);
 assert.equal(requests.length,2);
 assert.equal(reply.actions.length,1);
 assert.equal(reply.skillToolsFallback,true);
 assert.deepEqual(reply.skillResourceReads,[]);
 assert.equal(requests[1].tools,undefined);
 assert.match(requests[1].messages.at(-1).content,/selected-skill/);
});

test("an unsupported tool declaration after a resource read cannot silently discard the transcript",async()=>{
 let requests=0;
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  requests++;
  if(requests===1)return response(null,[call("ref-1","read_skill_resource",{
   skill_id:"story",path:"references/shots.md"})]);
  return new Response(JSON.stringify({error:"bad tools"}),{status:400});
 }});
 await assert.rejects(service(args),{code:"assistant_skill_tool_response_invalid"});
 assert.equal(requests,2);
});

test("assistant script tool yields a proposal without executing a script or returning canvas actions",async()=>{
 const scriptArgs={...args,skillTools:[{...skill,scriptPaths:["scripts/run.py"]}]};
 let requests=0;
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  requests++;
  const payload=JSON.parse(options.body);
  assert.ok(payload.tools.some(item=>item.function.name==="run_skill_script"));
  return response(null,[call("script-1","run_skill_script",{
   skill_id:"story",script_path:"scripts/run.py",args:["--dry-run"],
   input_files_json:JSON.stringify({"inputs/prompt.txt":"test input"}),output_files:["result.txt"]
  })]);
 }});
 const result=await service(scriptArgs);
 assert.equal(requests,1);
 assert.deepEqual(result.actions,[]);
 assert.match(result.answer,/确认/);
 assert.deepEqual(result.skillScriptProposal,{
  skill_id:"story",version:"a".repeat(12),script_path:"scripts/run.py",
  args:["--dry-run"],input_files:{"inputs/prompt.txt":"test input"},output_files:["result.txt"]
 });
 assert.equal(result.skillScriptProposal.scriptSource,undefined);
});

test("script proposal must be pinned to an authorized Skill and safe package path",()=>{
 const session=createAssistantSkillToolSession([{...skill,scriptPaths:["scripts/run.py"]}],{scriptProposalEnabled:true});
 const approved=session.propose({skill_id:"story",script_path:"scripts/run.py"});
 assert.equal(approved.version,"a".repeat(12));
 assert.deepEqual(approved.input_files,{});
 assert.throws(()=>session.propose({skill_id:"other",script_path:"scripts/run.py"}),
  {code:"assistant_skill_tool_unauthorized"});
 assert.throws(()=>session.propose({skill_id:"story",script_path:"scripts/unknown.py"}),
  {code:"assistant_skill_tool_unauthorized"});
 assert.throws(()=>session.propose({skill_id:"story",script_path:"scripts/run.py",
  input_files_json:'{"../escaped":"bad"}'}),{code:"assistant_skill_tool_arguments_invalid"});
 assert.throws(()=>session.propose({skill_id:"story",script_path:"scripts/run.py",
  input_files_json:JSON.stringify({"scripts/overwrite.py":"bad"})}),{code:"assistant_skill_tool_arguments_invalid"});
 assert.throws(()=>session.propose({skill_id:"story",script_path:"scripts/run.py",
  output_files:["C:/secret.txt"]}),{code:"assistant_skill_tool_arguments_invalid"});
 assert.throws(()=>session.propose({skill_id:"story",script_path:"scripts/run.py",command:"rm -rf /"}),
  {code:"assistant_skill_tool_unauthorized"});
});
test("script tools are absent during the post-execution continuation round",async()=>{
 const scriptArgs={...args,skillTools:[{...skill,scriptPaths:["scripts/run.py"]}],
  skillScriptProposalEnabled:false};
 let captured;
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  captured=JSON.parse(options.body);return response(result);
 }});
 const next=await service(scriptArgs);
 assert.equal(next.actions.length,1);
 assert.ok(!captured.tools.some(item=>item.function.name==="run_skill_script"));
 assert.deepEqual(next.skillResourceReads,[]);
});
test("Gemini script request is a proposal and never invokes a local interpreter",async()=>{
 const geminiVault={get:()=>({provider:"google_gemini",hasKey:true,keyVersion:"v2"}),
  withSecretVersion:(_v,fn)=>fn(Buffer.from("gemini-secret"))};
 let declarations;
 const service=createAssistantChatService({vault:geminiVault,compatibleUpstreamCall:async(_url,options)=>{
  const body=JSON.parse(options.body);declarations=body.tools[0].functionDeclarations;
  return new Response(JSON.stringify({candidates:[{content:{parts:[{functionCall:{name:"run_skill_script",
   args:{skill_id:"story",script_path:"scripts/run.py"}}}]},finishReason:"STOP"}]}),{status:200});
 }});
 const result=await service({...args,provider:"google_gemini",
  baseUrl:"http://localhost:8080/v1beta",skillTools:[{...skill,scriptPaths:["scripts/run.py"]}]});
 assert.ok(declarations.some(item=>item.name==="run_skill_script"));
 assert.equal(result.skillScriptProposal.script_path,"scripts/run.py");
 assert.deepEqual(result.actions,[]);
});
test("assistant can answer without requesting any tools, preserving the Skill and plan",async()=>{
 let requests=0;
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  requests++;return response(result);
 }});
 const value=await service(args);
 assert.equal(requests,1);
 assert.equal(value.actions.length,1);
 assert.deepEqual(value.skillResourceReads,[]);
 assert.deepEqual(value.skillToolCalls,[]);
});
