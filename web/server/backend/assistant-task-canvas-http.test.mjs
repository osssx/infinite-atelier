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
 const graph=executed.data.project.document,preview=created.data.graphPreview;
 assert.deepEqual(preview.nodes.removed,[]);
 assert.deepEqual(preview.nodes.upserted,graph.nodes.filter(node=>node.id!=="old"));
 assert.deepEqual(preview.connections.upserted,graph.connections);
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
test("P1b character-card text creation, horizontal layout and group commit as one durable Task Step",async t=>{
 const f=await setup(t),actions=[
  {type:"create_node",ref:"n1",nodeType:"text",title:"主角小兔嘟嘟",content:"角色卡一：小白兔"},
  {type:"create_node",ref:"n2",nodeType:"text",title:"兔妈妈",content:"角色卡二：温柔母亲"},
  {type:"create_node",ref:"n3",nodeType:"text",title:"好友小龟慢慢",content:"角色卡三：小龟"},
  {type:"layout_nodes",nodeIds:["n1","n2","n3"],direction:"horizontal",gap:48},
  {type:"create_group",ref:"g1",title:"角色卡提示词",members:["n1","n2","n3"]}
 ];
 const plan={requestId:"role-cards-plan",expectedPlanVersion:1,expectedProjectRevision:1,
  center:{x:200,y:150},actions};
 const frozen=await f.call("POST",f.stepBase+"/canvas-steps",plan);
 assert.equal(frozen.status,200,JSON.stringify(frozen.data));
 assert.equal(frozen.data.status,"waiting_approval");
 assert.equal(frozen.data.operationCount,5);
 assert.deepEqual(Object.keys(frozen.data.preconditions.refs.nodes).sort(),["g1","n1","n2","n3"]);
 assert.equal((await f.call("GET",f.base)).data.document.nodes.length,1,"no eager canvas writes");
 const samePlan=await f.call("POST",f.stepBase+"/canvas-steps",plan);
 assert.equal(samePlan.status,200);
 assert.equal(samePlan.data.existing,true);
 assert.equal(samePlan.data.stepId,frozen.data.stepId);
 const endpoint=f.stepBase+"/steps/"+frozen.data.stepId;
 const approval=await f.call("POST",endpoint+"/approval",{requestId:"cards-approve",
  expectedPlanVersion:1,actionDigest:frozen.data.actionDigest,decision:"approve"});
 assert.equal(approval.status,200,JSON.stringify(approval.data));
 const executePayload={requestId:"cards-execute",expectedPlanVersion:1,actionDigest:frozen.data.actionDigest};
 const saved=await f.call("POST",endpoint+"/execute",executePayload);
 assert.equal(saved.status,200,JSON.stringify(saved.data));
 assert.equal(saved.data.receipt.applied,5);
 assert.equal(saved.data.project.revision,2);
 const nodes=saved.data.project.document.nodes;
 const group=nodes.find(node=>node.id===frozen.data.preconditions.refs.nodes.g1);
 assert.equal(group.type,"group");
 assert.equal(group.title,"角色卡提示词");
 const cards=["n1","n2","n3"].map(ref=>nodes.find(node=>node.id===frozen.data.preconditions.refs.nodes[ref]));
 assert.deepEqual(cards.map(node=>node.metadata.groupId),[group.id,group.id,group.id]);
 assert.deepEqual(cards.map(node=>node.type),["text","text","text"]);
 assert.deepEqual(cards.map(node=>node.position.y),[30,30,30]);
 assert(cards[0].position.x<cards[1].position.x&&cards[1].position.x<cards[2].position.x);
 assert(cards.every(card=>card.position.x>=group.position.x&&card.position.y>=group.position.y&&
  card.position.x+card.width<=group.position.x+group.width&&card.position.y+card.height<=group.position.y+group.height));
 assert.deepEqual(cards.map(node=>node.metadata.content),["角色卡一：小白兔","角色卡二：温柔母亲","角色卡三：小龟"]);
 assert.equal(saved.data.project.document.connections.length,0);
 assert.equal(saved.data.project.document.nodes[0].metadata.content,"before");
 const retry=await f.call("POST",endpoint+"/execute",executePayload);
 assert.equal(retry.status,200,JSON.stringify(retry.data));
 assert.equal(retry.data.existing,true);
 assert.equal((await f.call("GET",f.base)).data.document.nodes.length,5);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps").get().n,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,1);
 assert.equal(f.db.prepare("SELECT receipt_trust FROM assistant_task_steps").get().receipt_trust,"server_committed");
});
test("P1b invalid group membership or missing layout target rejects entire Task plan",async t=>{
 const f=await setup(t);
 for(const [index,actions,status] of [
  [1,[{type:"create_group",ref:"g1",title:"不完整",members:["old"]}],400],
  [2,[{type:"create_group",ref:"g2",title:"不存在的成员",members:["old","missing"]}],409],
  [3,[{type:"layout_nodes",nodeIds:["old","missing"],direction:"horizontal"}],409],
  [4,[{type:"create_node",ref:"n1",nodeType:"text",content:"one",title:"一"},
   {type:"create_group",ref:"g3",title:"错误组合",members:["n1","missing"]}],409]
 ]){
  const result=await f.call("POST",f.stepBase+"/canvas-steps",{
   requestId:"bad-"+index,expectedPlanVersion:1,expectedProjectRevision:1,
   center:{x:200,y:150},actions
  });
  assert.equal(result.status,status,JSON.stringify(result.data));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps").get().n,0);
  assert.equal((await f.call("GET",f.base)).data.revision,1);
  assert.equal((await f.call("GET",f.base)).data.document.nodes.length,1);
 }
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
