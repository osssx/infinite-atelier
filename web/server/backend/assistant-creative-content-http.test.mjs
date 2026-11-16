/** P4.9a: full Task HTTP, durable model-call audit, no graph changes on
 * incomplete creative text. All providers are protocol-shaped mocks: no paid API. */
import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn} from "./assistant-tasks.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";

const request="为每个角色生成角色卡提示词文本节点";
const policy={includeContext:false,scope:"selection",includedIds:[]};
const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
 withSecretVersion:(_version,fn)=>fn(Buffer.from("mock-secret"))};
const reply=actions=>new Response(JSON.stringify({choices:[{
 finish_reason:"stop",message:{content:JSON.stringify({answer:"将创建三个角色卡",actions})}
}]}),{status:200});
const cast=[
 {type:"create_text",ref:"r1",title:"小兔嘟嘟",
  content:"小兔嘟嘟毛色雪白，穿蓝色披风，性格开朗又好奇，遇到困难时依然主动帮助小伙伴。"},
 {type:"create_text",ref:"r2",title:"兔妈妈",
  content:"兔妈妈身穿棕色围裙，毛色米白，待人温柔耐心，遇到挑战时总能鼓励小兔独立思考。"},
 {type:"create_text",ref:"r3",title:"小龟慢慢",
  content:"小龟慢慢背着深绿色龟壳，性格沉稳幽默，行动虽慢却观察细致，是小兔可靠的冒险伙伴。"}
];
async function setup(t,{alwaysBlank=false}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 createProject(db,{id:"p",document:{title:"儿童兔子动画",nodes:[],connections:[]}});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat-a",rootMessageId:"root",
  requestId:"create",originalRequest:"兔子儿童动画：小兔嘟嘟、兔妈妈、小龟慢慢",contextPolicy:policy}).task;
 appendAssistantTaskTurn(db,{projectId:"p",taskId:task.id,requestId:"turn-1",messageId:"turn-user-1",
  text:request,contextPolicy:policy});
 const payloads=[];
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,{body})=>{
  payloads.push(JSON.parse(body));
  const blank=cast.map(action=>({...action,content:"姓名：\\n外貌：\\n性格："}));
  return reply(alwaysBlank||payloads.length===1?blank:cast);
 }});
 const app=buildApp({db,authorize:()=>true,assistantChat:service});
 t.after(async()=>{await app.close();db.close()});
 const call=async(requestId)=>app.inject({method:"POST",
  url:"/api/v1/projects/p/assistant/chat",
  payload:{channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
   model:"mock",messages:[{role:"user",content:request}],canvasActions:true,
   task:{taskId:task.id,turnMessageId:"turn-user-1",requestId}}});
 return {db,task,call,payloads};
}
test("P4.9a actual Task HTTP preserves full creative context during repaired role-card generation",async t=>{
 const fx=await setup(t),response=await fx.call("infer-ok");
 assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().actions.length,3);
 assert.equal(response.json().formatRepairCount,1);
 assert.equal(fx.payloads.length,2);
 for(const payload of fx.payloads){
  assert.match(payload.messages[0].content,/兔子儿童动画：小兔嘟嘟、兔妈妈、小龟慢慢/);
  assert.doesNotMatch(JSON.stringify(payload),/mock-secret/);
 }
 const calls=fx.db.prepare("SELECT call_kind,status FROM assistant_model_calls ORDER BY call_index").all();
 assert.deepEqual(calls.map(c=>c.call_kind),["initial","format_repair"]);
 assert.ok(calls.every(c=>c.status==="succeeded"));
 assert.equal(fx.db.prepare("SELECT status FROM assistant_task_commands WHERE request_id='infer-ok'").get().status,"completed");
 assert.equal(getProject(fx.db,"p").revision,1,"model reply is NOT a canvas commit");
 assert.equal(getProject(fx.db,"p").document.nodes.length,0);
 assert.equal(fx.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
 const repeat=await fx.call("infer-ok");
 assert.equal(repeat.statusCode,200,repeat.body);
 assert.equal(fx.payloads.length,2,"replayed command cannot call provider again");
});
test("P4.9a Task HTTP rejects twice-blank model plans without touching SQLite graph",async t=>{
 const fx=await setup(t,{alwaysBlank:true}),response=await fx.call("infer-blank");
 assert.equal(response.statusCode,502,response.body);
 assert.equal(response.json().code,"assistant_creative_content_incomplete");
 assert.equal(fx.payloads.length,2);
 assert.equal(getProject(fx.db,"p").revision,1);
 assert.equal(getProject(fx.db,"p").document.nodes.length,0);
 assert.equal(fx.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
 const calls=fx.db.prepare("SELECT call_kind,status FROM assistant_model_calls ORDER BY call_index").all();
 assert.deepEqual(calls.map(c=>c.call_kind),["initial","format_repair"]);
 assert.ok(calls.every(c=>c.status==="succeeded"));
 // No automatic model replay on the same command identity after provider POST.
 const retry=await fx.call("infer-blank");
 assert.equal(retry.statusCode,409);
 assert.equal(fx.payloads.length,2);
});
