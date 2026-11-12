import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";

async function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const app=buildApp({db,authorize:()=>true});
 t.after(async()=>{await app.close();db.close()});
 const call=async(method,url,payload)=>{
  const r=await app.inject({method,url,...(payload?{payload}:{})});
  return {status:r.statusCode,data:r.json()};
 };
 assert.equal((await call("POST","/api/v1/projects",{id:"story",
  document:{nodes:[{id:"old",type:"text",title:"旧节点",position:{x:0,y:0},width:340,height:240,
   metadata:{content:"before"}}],connections:[]}})).status,201);
 const base="/api/v1/projects/story";
 const created=await call("POST",base+"/assistant/tasks",{
  requestId:"create",chatSessionId:"chat",rootMessageId:"root",originalRequest:"请创建剧情节点"});
 assert.equal(created.status,201,JSON.stringify(created.data));
 return {db,call,base,taskId:created.data.task.id,stepBase:base+"/assistant/tasks/"+created.data.task.id};
}
test("P1b full HTTP plan/approve/execute chain is atomic and identical requests replay",async t=>{
 const f=await setup(t);
 const plan={requestId:"plan",expectedPlanVersion:1,expectedProjectRevision:1,
  center:{x:40,y:50},actions:[
   {type:"create_text",ref:"episode",title:"第一集",content:"序章"},
   {type:"connect",from:"old",to:"episode"}
  ]};
 const created=await f.call("POST",f.stepBase+"/canvas-steps",plan);
 assert.equal(created.status,200,JSON.stringify(created.data));
 assert.equal(created.data.status,"waiting_approval");
 const stepId=created.data.stepId;
 assert.equal((await f.call("POST",f.stepBase+"/canvas-steps",plan)).data.stepId,stepId);
 const denied=await f.call("POST",f.stepBase+"/steps/"+stepId+"/execute",{
  requestId:"exec",expectedPlanVersion:1,actionDigest:created.data.actionDigest});
 assert.equal(denied.status,409);
 assert.equal((await f.call("GET",f.base)).data.revision,1);
 const approve=await f.call("POST",f.stepBase+"/steps/"+stepId+"/approval",{
  requestId:"approve",expectedPlanVersion:1,actionDigest:created.data.actionDigest,decision:"approve"});
 assert.equal(approve.status,200,JSON.stringify(approve.data));
 const executed=await f.call("POST",f.stepBase+"/steps/"+stepId+"/execute",{
  requestId:"exec",expectedPlanVersion:1,actionDigest:created.data.actionDigest});
 assert.equal(executed.status,200,JSON.stringify(executed.data));
 assert.equal(executed.data.project.revision,2);
 assert.equal(executed.data.receipt.applied,2);
 const fresh=await f.call("GET",f.stepBase);
 assert.equal(fresh.data.task.recoveryMode,"canvas_atomic");
 assert.equal(fresh.data.task.steps[0].receiptTrust,"server_committed");
 assert.equal(fresh.data.task.steps[0].action.actions.length,2);
 assert.equal(fresh.data.task.steps[0].status,"succeeded");
 const repeat=await f.call("POST",f.stepBase+"/steps/"+stepId+"/execute",{
  requestId:"exec",expectedPlanVersion:1,actionDigest:created.data.actionDigest});
 assert.equal(repeat.status,200);
 assert.equal(repeat.data.existing,true);
 assert.equal((await f.call("GET",f.base)).data.revision,2);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,1);
 const oldPatch=await f.call("PATCH",f.base,{expectedRevision:1,document:{nodes:[],connections:[]}});
 assert.equal(oldPatch.status,409);
 assert.equal(oldPatch.data.code,"project_revision_conflict");
});
test("P1b direct user cannot submit a GPU/Skill plan or approve a mutated action",async t=>{
 const f=await setup(t);
 const unsupported=await f.call("POST",f.stepBase+"/canvas-steps",{
  requestId:"script-plan",expectedPlanVersion:1,expectedProjectRevision:1,
  center:{x:0,y:0},actions:[{type:"run_node",nodeId:"old"}]});
 assert.equal(unsupported.status,409);
 assert.equal(unsupported.data.code,"assistant_canvas_action_unsupported");
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
 const planned=await f.call("POST",f.stepBase+"/canvas-steps",{
  requestId:"text-plan",expectedPlanVersion:1,expectedProjectRevision:1,
  center:{x:0,y:0},actions:[{type:"set_text",nodeId:"old",content:"updated"}]});
 assert.equal(planned.status,200);
 const wrong=await f.call("POST",f.stepBase+"/steps/"+planned.data.stepId+"/approval",{
  requestId:"wrong",expectedPlanVersion:1,actionDigest:"f".repeat(64),decision:"approve"});
 assert.equal(wrong.status,409);
 assert.equal((await f.call("GET",f.base)).data.revision,1);
});
