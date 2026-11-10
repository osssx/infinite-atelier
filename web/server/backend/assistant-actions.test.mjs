import test from "node:test";
import assert from "node:assert/strict";
import {CANVAS_ACTION_SYSTEM,parseAssistantActionResponse} from "./assistant-actions.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
const actions=[
 {type:"create_text",ref:"scene_1",title:"开场",content:"雨夜街头"},
 {type:"create_text",ref:"scene_2",title:"转折",content:"主角发现秘密"},
 {type:"connect",from:"scene_1",to:"scene_2"},
 {type:"set_text",nodeId:"text-123",content:"已修改"},
 {type:"delete_node",nodeId:"text-456"}
];
const messages=[{role:"user",content:"创建两个连续分镜"}];
test("P2 server action parser accepts bounded typed operations and JSON fences",()=>{
 const raw=JSON.stringify({answer:"拟定五项操作",actions});
 assert.deepEqual(parseAssistantActionResponse(raw),{answer:"拟定五项操作",actions});
 assert.deepEqual(parseAssistantActionResponse("```json\n"+raw+"\n```"),{answer:"拟定五项操作",actions});
 assert.deepEqual(parseAssistantActionResponse("普通文本建议"),{answer:"普通文本建议",actions:[]});
 assert.match(CANVAS_ACTION_SYSTEM,/Use existing IDs ONLY when provided/i);
});
test("P2 parser fails closed on unsupported or malformed operations",()=>{
 const wrap=actions=>JSON.stringify({answer:"test",actions});
 for(const invalid of [
  [{type:"run_workflow",nodeId:"a"}],
  [{type:"delete_node",nodeId:"a",force:true}],
  [{type:"set_text",nodeId:"a",content:"x".repeat(12001)}],
  [{type:"create_text",ref:"same",title:"a",content:"x"},{type:"create_text",ref:"same",title:"b",content:"y"}],
  [{type:"connect",from:"a",to:"a"}],
  [{type:"connect",from:"a",to:"b",replace:true}],
  Array.from({length:17},(_,n)=>({type:"create_text",ref:"n"+n,title:"t",content:"c"}))
 ])assert.throws(()=>parseAssistantActionResponse(wrap(invalid)),/assistant_actions_invalid/);
 assert.throws(()=>parseAssistantActionResponse('{"answer":"ok","actions":['),/assistant_actions_invalid/);
 assert.throws(()=>parseAssistantActionResponse(JSON.stringify({answer:"abc",actions:[],secret:"private"})),/assistant_actions_invalid/);
});
test("P2 assistant responds with structured plan but never mutates graph in backend",async()=>{
 const recorded=[];
 const vault={
  get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"version"}),
  withSecretVersion:(version,cb)=>cb(Buffer.from("server-only-secret"))
 };
 const ask=createAssistantChatService({vault,compatibleUpstreamCall:async(url,options)=>{
  recorded.push({url,body:JSON.parse(options.body)});
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({answer:"将创建节点",actions})}}]}),{status:200});
 }});
 const result=await ask({channelId:"channel",provider:"openai_compatible",model:"demo",
  baseUrl:"http://127.0.0.1:8188/v1",messages,canvasActions:true});
 assert.equal(result.answer,"将创建节点");
 assert.deepEqual(result.actions,actions);
 assert.equal(result.retryCount,0);
 assert.match(recorded[0].body.messages[0].content,/create_text/);
 assert.doesNotMatch(JSON.stringify(result),/server-only-secret/);
 const regular=await ask({channelId:"channel",provider:"openai_compatible",model:"demo",
  baseUrl:"http://127.0.0.1:8188/v1",messages});
 assert.equal(regular.actions,undefined);
 assert.match(regular.answer,/actions/);
});
test("P2 rejects non-boolean action mode and malformed model action payload",async()=>{
 let raw=JSON.stringify({answer:"test",actions:[{type:"run_shell",cmd:"rm"}]});
 let calls=0;
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"version"}),
  withSecretVersion:(v,fn)=>fn(Buffer.from("secret"))};
 const ask=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  calls++;
  return new Response(JSON.stringify({choices:[{message:{content:raw}}]}),{status:200});
 }});
 const input={channelId:"channel",provider:"openai_compatible",model:"demo",baseUrl:"http://127.0.0.1:8188/v1",messages,canvasActions:true};
 await assert.rejects(ask(input),error=>error?.code==="assistant_actions_invalid");
 assert.equal(calls,1);
 await assert.rejects(ask({...input,canvasActions:"true"}),error=>error?.code==="assistant_actions_invalid");
 assert.equal(calls,1);
 raw="普通建议";
 assert.deepEqual((await ask(input)).actions,[]);
});
test("P2 assistant HTTP route passes action mode and does not write canvas graph",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 let passed=null;
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner",
  assistantChat:async input=>{
   passed=input;
   return {answer:"已生成操作计划",actions:[actions[0]],model:"demo",retryCount:0};
  }});
 t.after(async()=>{await app.close();db.close()});
 const headers={"x-test-owner":"owner"};
 const create=await app.inject({method:"POST",url:"/api/v1/projects",
  headers,payload:{id:"p2-project",document:{nodes:[],connections:[]}}});
 assert.equal(create.statusCode,201,create.body);
 const body={channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",
  model:"demo",messages,canvasActions:true};
 const reply=await app.inject({method:"POST",url:"/api/v1/projects/p2-project/assistant/chat",
  headers,payload:body});
 assert.equal(reply.statusCode,200,reply.body);
 assert.equal(passed.canvasActions,true);
 assert.equal(reply.json().actions.length,1);
 const after=await app.inject({method:"GET",url:"/api/v1/projects/p2-project",headers});
 assert.equal(after.json().revision,1);
 assert.deepEqual(after.json().document.nodes,[]);
 const rejected=await app.inject({method:"POST",url:"/api/v1/projects/p2-project/assistant/chat",
  headers,payload:{...body,canvasActions:"not-a-boolean"}});
 assert.equal(rejected.statusCode,400);
});

test("P2.2 validates multi-type creation, grouped layout, and legacy content safety",()=>{
 const extended=[
  {type:"create_node",ref:"img",nodeType:"image",title:"场景图",prompt:"夜间车站"},
  {type:"create_node",ref:"clip",nodeType:"video",title:"视频镜头"},
  {type:"create_node",ref:"audio",nodeType:"audio",title:"配乐"},
  {type:"create_node",ref:"config",nodeType:"config",title:"生成参数"},
  {type:"create_node",ref:"director",nodeType:"director",title:"导演"},
  {type:"layout_nodes",nodeIds:["img","clip","audio"],direction:"grid",gap:48},
  {type:"create_group",ref:"visuals",title:"画面组",members:["img","clip","audio"]},
  {type:"layout_nodes",nodeIds:["visuals"],direction:"vertical",gap:32},
  {type:"create_group",ref:"empty",title:"素材备用区",members:[]},
  {type:"set_title",nodeId:"text-existing",title:"新标题"}
 ];
 const result=parseAssistantActionResponse(JSON.stringify({answer:"创建并分组",actions:extended}));
 assert.deepEqual(result.actions,extended);
 assert.match(CANVAS_ACTION_SYSTEM,/image,video,audio,config,director/);
 assert.match(CANVAS_ACTION_SYSTEM,/explicit user confirmation/);
});
test("P2.2 refuses arbitrary node metadata, unknown actions, nesting shapes and unsafe layouts",()=>{
 const wrap=actions=>JSON.stringify({answer:"x",actions});
 for(const actions of [
  [{type:"create_node",ref:"f",nodeType:"plugin:arbitrary"}],
  [{type:"create_node",ref:"f",nodeType:"image",content:"data:image/png;base64,sensitive"}],
  [{type:"create_node",ref:"f",nodeType:"text",prompt:"unapproved"}],
  [{type:"create_node",ref:"f",nodeType:"image",metadata:{storageKey:"file"}}],
  [{type:"create_node",ref:"f",nodeType:"image",execute:true}],
  [{type:"layout_nodes",nodeIds:["a"],direction:"free"}],
  [{type:"layout_nodes",nodeIds:["a","a"],direction:"grid"}],
  [{type:"layout_nodes",nodeIds:["a"],direction:"horizontal",gap:3}],
  [{type:"layout_nodes",nodeIds:["a"],direction:"horizontal",gap:200}],
  [{type:"create_group",ref:"g",title:"单节点组",members:["a"]}],
  [{type:"create_group",ref:"g",title:"重复",members:["a","a"]}],
  [{type:"create_text",ref:"dupe",title:"a",content:"a"},
   {type:"create_group",ref:"dupe",title:"group",members:[]}],
  Array.from({length:13},(_,i)=>({type:"create_node",ref:"n"+i,nodeType:"text"})),
 ])assert.throws(()=>parseAssistantActionResponse(wrap(actions)),/assistant_actions_invalid/);
});
