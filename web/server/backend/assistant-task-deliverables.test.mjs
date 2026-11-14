import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync,backup} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn} from "./assistant-tasks.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep} from "./assistant-task-canvas-executor.mjs";
import {inspectAssistantTaskRecovery,replanAssistantTaskSafely} from "./assistant-task-safe-replan.mjs";
import {registerAssistantTextDeliverable,verifyAssistantTextDeliverable,
 currentAssistantTextDeliverable,mayCompleteAssistantTask,assertAssistantTextClaimBudget} from "./assistant-task-deliverables.mjs";

const names=["小兔嘟嘟","兔妈妈","小龟慢慢"];
const characters=names.map((title,i)=>({ref:"role_"+(i+1),title}));
const userText="为小兔嘟嘟、兔妈妈、小龟慢慢生成角色卡提示词文本节点";
const body=name=>name+"是一只勇敢善良的动画角色，拥有鲜明的服饰和毛色特征，性格温柔又充满好奇心。";
const cardActions=()=>characters.map(c=>({type:"create_text",ref:c.ref,title:c.title,content:body(c.title)}));
function fixture(t,{blank=false}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:{title:"角色卡",nodes:[],connections:[]}});
 const taskId=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",
  rootMessageId:"root",originalRequest:"角色卡",requestId:"task"}).task.id;
 const text=blank?"为小兔嘟嘟、兔妈妈、小龟慢慢生成空白角色卡模板":userText;
 appendAssistantTaskTurn(db,{projectId:"p",taskId,requestId:"turn",messageId:"turn-message",text,
  contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}});
 return {db,taskId,projectId:"p"};
}
const requireCard=(ctx,opts={})=>registerAssistantTextDeliverable(ctx.db,{
 projectId:"p",taskId:ctx.taskId,requestId:"require",sourceTurnMessageId:"turn-message",
 characters,requiredFields:[],allowEmptyTemplate:false,confirmed:true,...opts});
const plan=(ctx,actions=cardActions(),finalizeTask=false,requestId="plan")=>planAssistantCanvasStep(ctx.db,{
 projectId:"p",taskId:ctx.taskId,requestId,expectedPlanVersion:1,
 expectedProjectRevision:getProject(ctx.db,"p").revision,actions,
 center:{x:100,y:100},dependsOn:[],finalizeTask});
const approve=(ctx,step)=>decideAssistantTaskStep(ctx.db,{
 projectId:"p",taskId:ctx.taskId,stepId:step.stepId,requestId:"approve",
 expectedPlanVersion:step.planVersion,actionDigest:step.actionDigest,decision:"approve"});
const execute=(ctx,step)=>executeAssistantCanvasStep(ctx.db,{
 projectId:"p",taskId:ctx.taskId,stepId:step.stepId,requestId:"execute",
 expectedPlanVersion:step.planVersion,actionDigest:step.actionDigest});
const verify=(ctx,step,extras={})=>verifyAssistantTextDeliverable(ctx.db,{
 projectId:"p",taskId:ctx.taskId,stepId:step.stepId,requestId:"verify",
 expectedPlanVersion:step.planVersion,actionDigest:step.actionDigest,...extras});
const status=ctx=>ctx.db.prepare("SELECT status FROM assistant_tasks WHERE id=?").get(ctx.taskId).status;
const count=(ctx,kind)=>ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE task_id=? AND kind=?")
 .get(ctx.taskId,kind).n;

test("P4.0 three character cards: full spec binds approval and only verifier completes Task",t=>{
 const f=fixture(t),required=requireCard(f);
 assert.equal(required.existing,false);
 assert.equal(mayCompleteAssistantTask(f.db,f.taskId),false);
 assert.deepEqual(currentAssistantTextDeliverable(f.db,f.taskId).characters,characters);
 const step=plan(f);
 assert.deepEqual(step.deliverableSpec.characters,characters);
 const row=f.db.prepare("SELECT action_json,preconditions_json,action_digest FROM assistant_task_steps WHERE id=?").get(step.stepId);
 const action=JSON.parse(row.action_json),pre=JSON.parse(row.preconditions_json);
 assert.match(action.deliverableSpecDigest,/^[a-f0-9]{64}$/);
 assert.equal(action.deliverableSpecDigest,pre.deliverableSpecDigest);
 assert.equal(step.actionDigest,row.action_digest);
 approve(f,step);
 const commit=execute(f,step);
 assert.equal(commit.project.document.nodes.length,3);
 assert.equal(status(f),"ready"); // graph receipt is not a complete deliverable
 const verified=verify(f,step);
 assert.equal(verified.verified,true);
 assert.equal(Object.keys(verified.checkedNodeDigests).length,3);
 assert.equal(status(f),"completed");
 assert.equal(count(f,"deliverable_verified"),1);
 assert.equal(count(f,"task_completed"),1);
 assert.equal(verify(f,step).existing,true);
 assert.equal(count(f,"deliverable_verified"),1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,1);
});

test("P4.0 verifier refuses completion while another approved required step remains",t=>{
 const f=fixture(t);requireCard(f);
 const first=plan(f);approve(f,first);execute(f,first);
 const next=plan(f,cardActions(),false,"next-plan");
 decideAssistantTaskStep(f.db,{projectId:"p",taskId:f.taskId,stepId:next.stepId,
  requestId:"next-approval",expectedPlanVersion:1,actionDigest:next.actionDigest,decision:"approve"});
 assert.throws(()=>verify(f,first),{code:"assistant_deliverable_steps_incomplete"});
 assert.equal(status(f),"ready");
 assert.equal(count(f,"deliverable_verified"),0);
 assert.equal(count(f,"task_completed"),0);
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(next.stepId).status,"ready");
 executeAssistantCanvasStep(f.db,{projectId:"p",taskId:f.taskId,stepId:next.stepId,
  requestId:"next-execute",expectedPlanVersion:1,actionDigest:next.actionDigest});
 assert.equal(verify(f,next).verified,true);
 assert.equal(status(f),"completed");
});

test("P4.0 requirement idempotency, unconfirmed names and blank-template permission",t=>{
 const f=fixture(t);
 assert.equal(requireCard(f).existing,false);
 assert.equal(requireCard(f).existing,true);
 assert.throws(()=>requireCard(f,{characters:[{ref:"role_1",title:"未知人物"}]}),{
  code:"assistant_task_command_conflict"});
 assert.equal(count(f,"deliverable_required"),1);
 assert.throws(()=>plan(f,characters.map(c=>({type:"create_text",ref:c.ref,title:c.title,content:""}))),{
  code:"assistant_deliverable_content_invalid"});
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps").get().n,0);
 const b=fixture(t,{blank:true});
 assert.equal(requireCard(b,{allowEmptyTemplate:true}).allowEmptyTemplate,true);
 const s=plan(b,characters.map(c=>({type:"create_text",ref:c.ref,title:c.title,content:""})));
 approve(b,s);execute(b,s);assert.equal(verify(b,s).verified,true);
});

test("P4.0 old approval cannot certify edited specs",t=>{
 const f=fixture(t);requireCard(f);const step=plan(f);
 const row=f.db.prepare("SELECT preconditions_json FROM assistant_task_steps WHERE id=?").get(step.stepId);
 const pre=JSON.parse(row.preconditions_json);
 pre.deliverableSpec.characters[0].title="伪造角色";
 f.db.prepare("UPDATE assistant_task_steps SET preconditions_json=? WHERE id=?")
  .run(JSON.stringify(pre),step.stepId);
 assert.throws(()=>approve(f,step),{code:"assistant_deliverable_spec_changed"});
 assert.equal(status(f),"waiting_approval");
});

test("P4.0 verify failure stays blocked for public safe replan without undoing committed graph",t=>{
 const f=fixture(t);requireCard(f);const step=plan(f);approve(f,step);execute(f,step);
 const project=getProject(f.db,"p"),doc=structuredClone(project.document);
 doc.nodes[0].metadata.content="";
 f.db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id='p'")
  .run(JSON.stringify(doc),project.revision+1);
 const result=verify(f,step);
 assert.equal(result.verified,false);
 assert.equal(status(f),"blocked");
 assert.equal(count(f,"deliverable_verification_failed"),1);
 assert.equal(f.db.prepare("SELECT receipt_trust FROM assistant_task_steps WHERE id=?").get(step.stepId).receipt_trust,
  "server_committed");
 assert.equal(inspectAssistantTaskRecovery(f.db,{projectId:"p",taskId:f.taskId}).canReplan,true);
 const revised=replanAssistantTaskSafely(f.db,{projectId:"p",taskId:f.taskId,
  requestId:"replan",expectedPlanVersion:1,expectedProjectRevision:project.revision+1});
 assert.equal(revised.activePlanVersion,2);
 assert.equal(mayCompleteAssistantTask(f.db,f.taskId),false); // monotone Task-level guard survives replan
});

test("P4.0 verification fault rolls back event and Task completion atomically",t=>{
 const f=fixture(t);requireCard(f);const step=plan(f);approve(f,step);execute(f,step);
 assert.throws(()=>verify(f,step,{afterVerificationEvent:()=>{throw Error("crash_in_verify")} }),/crash_in_verify/);
 assert.equal(count(f,"deliverable_verified"),0);
 assert.equal(status(f),"ready");
 assert.equal(verify(f,step).verified,true);
 assert.equal(count(f,"deliverable_verified"),1);
});

test("P4.0 imported audit events never grant writable verification authority",t=>{
 const f=fixture(t);requireCard(f);const step=plan(f);approve(f,step);execute(f,step);
 f.db.prepare("UPDATE assistant_tasks SET read_only=1 WHERE id=?").run(f.taskId);
 f.db.prepare("INSERT INTO assistant_task_events(task_id,step_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)")
  .run(f.taskId,step.stepId,"deliverable_verified",JSON.stringify({verified:true,source:"fake_zip"}),Date.now());
 assert.throws(()=>verify(f,step),{code:"assistant_deliverable_not_verifiable"});
 assert.equal(status(f),"ready");
});

test("P4.0 full frozen Claim budget is checked without truncation",()=>{
 const giant="X".repeat(35_000);
 assert.throws(()=>assertAssistantTextClaimBudget({projectId:"p",taskId:"t",stepId:"s",planVersion:1,
  action:{actions:[],center:{x:0,y:0}},preconditions:{deliverableSpec:{raw:giant}},actionDigest:"a".repeat(64)}),
 {code:"assistant_task_payload_too_large"});
});

test("P4.0 fault after Task CAS rolls back both completion and verification events",t=>{
 const f=fixture(t);requireCard(f);const step=plan(f);approve(f,step);execute(f,step);
 assert.throws(()=>verify(f,step,{afterCompletionUpdate:()=>{throw Error("crash_after_cas")}}),
  /crash_after_cas/);
 assert.equal(status(f),"ready");
 assert.equal(count(f,"deliverable_verified"),0);
 assert.equal(count(f,"task_completed"),0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE command_kind='deliverable_verify'").get().n,0);
 assert.equal(verify(f,step).verified,true);
});

test("P4.0 crash after committed graph recovers by verifying persisted Step only",async t=>{
 const f=fixture(t);requireCard(f);const step=plan(f);approve(f,step);execute(f,step);
 const dir=mkdtempSync(join(tmpdir(),"atelier-p40-recovery-"));
 // Temporary SQLite cleanup is registered after all DB handles are closed.
 const file=join(dir,"main.db");
 await backup(f.db,file);
 const recovered=new DatabaseSync(file);t.after(()=>{recovered.close();rmSync(dir,{recursive:true,force:true})});
 assert.equal(recovered.prepare("SELECT status FROM assistant_tasks").get().status,"ready");
 const result=verifyAssistantTextDeliverable(recovered,{
  projectId:"p",taskId:f.taskId,stepId:step.stepId,requestId:"verify-restart",
  expectedPlanVersion:1,actionDigest:step.actionDigest});
 assert.equal(result.verified,true);
 assert.equal(recovered.prepare("SELECT status FROM assistant_tasks").get().status,"completed");
 assert.equal(recovered.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,1);
 assert.equal(recovered.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='deliverable_verified'").get().n,1);
});

test("P4.0 two SQLite connections race verifier; only one event can complete Task",async t=>{
 const f=fixture(t);requireCard(f);const step=plan(f);approve(f,step);execute(f,step);
 const dir=mkdtempSync(join(tmpdir(),"atelier-p40-verify-race-"));
 // Temporary SQLite cleanup is registered after all DB handles are closed.
 const file=join(dir,"main.db");await backup(f.db,file);
 const left=new DatabaseSync(file),right=new DatabaseSync(file);
 t.after(()=>{left.close();right.close();rmSync(dir,{recursive:true,force:true})});
 const a={projectId:"p",taskId:f.taskId,stepId:step.stepId,
  expectedPlanVersion:1,actionDigest:step.actionDigest};
 const results=await Promise.all([
  Promise.resolve().then(()=>verifyAssistantTextDeliverable(left,{...a,requestId:"left"})),
  Promise.resolve().then(()=>verifyAssistantTextDeliverable(right,{...a,requestId:"right"}))
 ]);
 assert.equal(results.filter(x=>x.verified&&x.existing===false).length,1);
 assert.equal(results.filter(x=>x.verified&&x.existing===true).length,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='deliverable_verified'").get().n,1);
 assert.equal(left.prepare("SELECT status FROM assistant_tasks").get().status,"completed");
});

test("P4.0 spec-bearing Task refuses finalizeTask at planner; old Tasks keep legacy choice",t=>{
 const f=fixture(t);requireCard(f);
 assert.throws(()=>plan(f,cardActions(),true),{code:"assistant_deliverable_plan_invalid"});
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps").get().n,0);
});
