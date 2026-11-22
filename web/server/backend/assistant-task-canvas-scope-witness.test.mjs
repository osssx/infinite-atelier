import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createAssistantTask} from "./assistant-tasks.mjs";
import {decideAssistantTaskStep,claimAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep,
 recoverAssistantCanvasTasksAtStartup} from "./assistant-task-canvas-executor.mjs";
import {freezeAssistantCanvasScopeWitness,assertAssistantCanvasScopeWitness} from "./assistant-task-canvas-scope-witness.mjs";

const node=(id,type,metadata={})=>({id,type,title:id,
 position:{x:0,y:0},width:340,height:240,metadata});
const assets=[
 {id:"hero",kind:"character",name:"兔子",description:"主角",sourceRefs:[],
  variants:[{id:"hero-day",name:"日常",description:"蓝衣"}]},
 ...Array.from({length:49},(_,i)=>({id:"prop-"+i,kind:"prop",name:"道具"+i,
  description:"描述"+i,sourceRefs:[]}))
];
const episodes=Array.from({length:4},(_,i)=>({id:"ep-"+i,title:"剧集"+i,
 synopsis:"剧情"+i,ending:"结尾"+i,events:[],eventItems:[],sourceRefs:[]}));
const shots=Array.from({length:100},(_,i)=>({id:"shot-"+i,episodeId:"ep-"+Math.floor(i/25),
 order:i%25,description:"分镜"+i,characterVariantIds:["hero-day"],propIds:[],keyPropIds:[]}));
const draft=(key,items)=>JSON.stringify({[key]:items});
const document=()=>({title:"P3.3g frozen scope witness",nodes:[
 node("source","drama:source",{dramaDraft:"树林里的童话",dramaConfirmed:"已确认故事"}),
 node("assets","drama:assets",{dramaDraft:draft("assets",assets),dramaConfirmed:draft("assets",assets)}),
 node("episodes","drama:episodes",{dramaDraft:draft("episodes",episodes),dramaConfirmed:draft("episodes",episodes)}),
 node("board","drama:storyboard",{dramaDraft:draft("shots",shots),dramaConfirmed:draft("shots",shots)}),
 node("hidden-board","drama:storyboard",{dramaDraft:draft("shots",[
  {id:"secret",episodeId:"hidden",order:0,description:"秘密正文不得传播",
   characterVariantIds:[],propIds:[],keyPropIds:[]}])}),
 ...Array.from({length:195},(_,i)=>node("text-"+i,"text",{content:"text "+i}))
],connections:[
 {id:"source-episodes",fromNodeId:"source",toNodeId:"episodes"},
 {id:"assets-board",fromNodeId:"assets",toNodeId:"board"},
 {id:"episodes-board",fromNodeId:"episodes",toNodeId:"board"}
]});
const actions=[
 {type:"patch_drama_asset",nodeId:"assets",assetId:"hero",changes:{description:"可靠的主角设定"}},
 {type:"patch_drama_episode",nodeId:"episodes",episodeId:"ep-3",changes:{synopsis:"新的剧情"}},
 {type:"patch_storyboard_shot",nodeId:"board",shotId:"shot-75",changes:{description:"森林远景"}}
];
function fixture(db){
 initializeSchema(db);
 createProject(db,{id:"p",document:document()});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"修改三条创作内容",requestId:"task"}).task;
 return {db,projectId:"p",taskId:task.id};
}
function setup(t){
 const db=new DatabaseSync(":memory:");
 t.after(()=>db.close());
 return fixture(db);
}
const frozen=(ctx,requestId="plan")=>planAssistantCanvasStep(ctx.db,{
 projectId:ctx.projectId,taskId:ctx.taskId,requestId,
 expectedPlanVersion:1,expectedProjectRevision:getProject(ctx.db,"p",{compact:true}).revision,
 actions,center:{x:380,y:220},dependsOn:[],finalizeTask:false
});
const approve=(ctx,step,id="approval")=>decideAssistantTaskStep(ctx.db,{
 projectId:"p",taskId:ctx.taskId,stepId:step.stepId,requestId:id,
 expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve"
});
const execute=(ctx,step,id="execute",extra={})=>executeAssistantCanvasStep(ctx.db,{
 projectId:"p",taskId:ctx.taskId,stepId:step.stepId,expectedPlanVersion:1,
 actionDigest:step.actionDigest,requestId:id,...extra
});
const stepRow=(ctx,step)=>ctx.db.prepare(
 "SELECT action_json,preconditions_json,approval_json,status,receipt_json,receipt_trust FROM assistant_task_steps WHERE id=?"
).get(step.stepId);
const preconditions=(ctx,step)=>JSON.parse(stepRow(ctx,step).preconditions_json);
const revision=ctx=>getProject(ctx.db,"p",{compact:true}).revision;
const graph=ctx=>getProject(ctx.db,"p").document;
function mutateAssetWithoutRevision(ctx,name){
 const row=ctx.db.prepare("SELECT payload_json FROM creative_node_payloads WHERE project_id='p' AND node_id='assets'").get();
 const payload=JSON.parse(row.payload_json),original=JSON.parse(payload.dramaDraft);
 original.assets[0].name=name;
 ctx.db.prepare("UPDATE creative_node_payloads SET payload_json=? WHERE project_id='p' AND node_id='assets'")
  .run(JSON.stringify({...payload,dramaDraft:JSON.stringify(original)}));
}
function mutateHiddenWithoutRevision(ctx){
 const row=ctx.db.prepare("SELECT payload_json FROM creative_node_payloads WHERE project_id='p' AND node_id='hidden-board'").get();
 const payload=JSON.parse(row.payload_json),draft=JSON.parse(payload.dramaDraft);
 draft.shots[0].description="已变动的隐藏正文";
 ctx.db.prepare("UPDATE creative_node_payloads SET payload_json=? WHERE project_id='p' AND node_id='hidden-board'")
  .run(JSON.stringify({...payload,dramaDraft:JSON.stringify(draft)}));
}

test("P3.3g: 200-node witness freezes three action roots, transitive source ancestor and three edges without raw data",t=>{
 const ctx=setup(t),compact=getProject(ctx.db,"p",{compact:true}).document;
 const candidate=frozen(ctx),w=preconditions(ctx,candidate).scopeWitness;
 assert.equal(compact.nodes.length,200);
 assert.equal(assets.length,50);assert.equal(shots.length,100);
 assert.equal(w.schemaVersion,1);
 assert.equal(w.rootCount,3);
 assert.equal(w.nodeCount,4,"source→episodes→board is a transitive dependency");
 assert.equal(w.edgeCount,3);
 assert.match(w.contentDigest,/^[a-f0-9]{64}$/);
 assert.equal(Buffer.byteLength(JSON.stringify(w))<400,true);
 assert.ok(!JSON.stringify(w).includes("兔子"));
 assert.ok(!JSON.stringify(w).includes("秘密正文"));
 const recomputed=freezeAssistantCanvasScopeWitness(ctx.db,"p",compact,actions);
 assert.deepEqual(recomputed,w);
 assertAssistantCanvasScopeWitness(ctx.db,"p",compact,actions,w);
 assert.equal(revision(ctx),1);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,0);
});

test("P3.3g: read-only witness does not hydrate a missing unrelated node, but full graph approval still fails closed",t=>{
 const ctx=setup(t),candidate=frozen(ctx);
 ctx.db.prepare("DELETE FROM creative_node_payloads WHERE project_id='p' AND node_id='hidden-board'").run();
 const compact=getProject(ctx.db,"p",{compact:true}).document;
 assert.doesNotThrow(()=>assertAssistantCanvasScopeWitness(
  ctx.db,"p",compact,actions,preconditions(ctx,candidate).scopeWitness));
 assert.throws(()=>approve(ctx,candidate),/creative_payload_missing/);
 assert.equal(stepRow(ctx,candidate).status,"waiting_approval");
 assert.equal(revision(ctx),1);
});

test("P3.3g: approved three-node Task preserves the witness in the durable trusted receipt",t=>{
 const ctx=setup(t),candidate=frozen(ctx),w=preconditions(ctx,candidate).scopeWitness;
 assert.equal(approve(ctx,candidate).status,"ready");
 const result=execute(ctx,candidate);
 assert.equal(result.receipt.applied,3);
 assert.equal(result.receipt.scopeWitnessDigest,w.contentDigest);
 assert.equal(result.receipt.projectRevision,2);
 assert.equal(stepRow(ctx,candidate).receipt_trust,"server_committed");
 const after=graph(ctx);
 assert.equal(JSON.parse(after.nodes.find(n=>n.id==="assets").metadata.dramaDraft).assets[0].description,"可靠的主角设定");
 assert.equal(JSON.parse(after.nodes.find(n=>n.id==="episodes").metadata.dramaDraft).episodes[3].synopsis,"新的剧情");
 assert.equal(JSON.parse(after.nodes.find(n=>n.id==="board").metadata.dramaDraft).shots[75].description,"森林远景");
 assert.equal(execute(ctx,candidate,"replay").existing,true);
 assert.equal(revision(ctx),2);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,1);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM project_events WHERE project_id='p'").get().n,2);
});

test("P3.3g: revision-stable selected payload change blocks approval before any claim or graph mutation",t=>{
 const ctx=setup(t),candidate=frozen(ctx),before=stepRow(ctx,candidate);
 mutateAssetWithoutRevision(ctx,"没有提升项目修订号的变更");
 assert.equal(revision(ctx),1);
 const compact=getProject(ctx.db,"p",{compact:true}).document;
 assert.throws(()=>assertAssistantCanvasScopeWitness(
  ctx.db,"p",compact,actions,preconditions(ctx,candidate).scopeWitness),
  {code:"assistant_step_source_changed"});
 assert.throws(()=>approve(ctx,candidate),{code:"assistant_step_source_changed"});
 assert.equal(stepRow(ctx,candidate).approval_json,before.approval_json);
 assert.equal(stepRow(ctx,candidate).status,"waiting_approval");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,0);
});

test("P3.3g: selected edge change under unchanged revision invalidates the frozen scope",t=>{
 const ctx=setup(t),candidate=frozen(ctx);
 const compact=getProject(ctx.db,"p",{compact:true}).document;
 compact.connections.find(edge=>edge.id==="assets-board").toPortId="a-different-port";
 ctx.db.prepare("UPDATE projects SET document_json=? WHERE id='p'").run(JSON.stringify(compact));
 assert.equal(revision(ctx),1);
 assert.throws(()=>approve(ctx,candidate),{code:"assistant_step_source_changed"});
 assert.equal(stepRow(ctx,candidate).status,"waiting_approval");
});

test("P3.3g: forged witness or unsupported schema version blocks approval despite unchanged full graph",t=>{
 const ctx=setup(t),candidate=frozen(ctx),pre=preconditions(ctx,candidate);
 pre.scopeWitness={...pre.scopeWitness,contentDigest:"0".repeat(64)};
 ctx.db.prepare("UPDATE assistant_task_steps SET preconditions_json=? WHERE id=?")
  .run(JSON.stringify(pre),candidate.stepId);
 assert.throws(()=>approve(ctx,candidate),{code:"assistant_step_source_changed"});
 pre.scopeWitness.schemaVersion=999;
 ctx.db.prepare("UPDATE assistant_task_steps SET preconditions_json=? WHERE id=?")
  .run(JSON.stringify(pre),candidate.stepId);
 assert.throws(()=>approve(ctx,candidate),{code:"assistant_step_source_changed"});
 assert.equal(revision(ctx),1);
});

test("P3.3g: existing legacy frozen Step with no witness remains executable but still requires full graph digest",t=>{
 const ctx=setup(t),candidate=frozen(ctx),pre=preconditions(ctx,candidate);
 delete pre.scopeWitness;
 ctx.db.prepare("UPDATE assistant_task_steps SET preconditions_json=? WHERE id=?")
  .run(JSON.stringify(pre),candidate.stepId);
 approve(ctx,candidate);
 const result=execute(ctx,candidate);
 assert.equal(result.status,"succeeded");
 assert.equal(result.receipt.scopeWitnessDigest,undefined);
 assert.equal(result.project.revision,2);
});

test("P3.3g: legacy whole-graph safeguard still rejects unrelated changed payload with no witness",t=>{
 const ctx=setup(t),candidate=frozen(ctx),pre=preconditions(ctx,candidate);
 delete pre.scopeWitness;
 ctx.db.prepare("UPDATE assistant_task_steps SET preconditions_json=? WHERE id=?")
  .run(JSON.stringify(pre),candidate.stepId);
 mutateHiddenWithoutRevision(ctx);
 assert.throws(()=>approve(ctx,candidate),{code:"assistant_step_source_changed"});
 assert.equal(revision(ctx),1);
});

test("P3.3g: injected exception before receipt rolls back three node edits, project revision and trusted receipt",t=>{
 const ctx=setup(t),candidate=frozen(ctx),before=graph(ctx);
 approve(ctx,candidate);
 assert.throws(()=>execute(ctx,candidate,"fault",{
  beforeReceipt:()=>{throw Error("injected_p33g_receipt_failure")}
 }),/injected_p33g_receipt_failure/);
 assert.deepEqual(graph(ctx),before);
 assert.equal(revision(ctx),1);
 assert.equal(stepRow(ctx,candidate).receipt_trust,"none");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM project_events WHERE project_id='p'").get().n,1);
});

test("P3.3g: immutable prepared claim recovers after SQLite restart, retains frozen witness and executes once",t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-p33g-recovery-")),file=join(dir,"witness.sqlite");
 let db=new DatabaseSync(file);
 t.after(()=>{try{db.close();}finally{rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80});}});
 let ctx=fixture(db),candidate=frozen(ctx),w=preconditions(ctx,candidate).scopeWitness;
 approve(ctx,candidate);
 assert.throws(()=>execute(ctx,candidate,"interrupted",{
  afterClaim:()=>{throw Error("prepared_restart")}
 }),/prepared_restart/);
 assert.equal(stepRow(ctx,candidate).status,"running");
 const attempt=ctx.db.prepare("SELECT frozen_snapshot_json FROM assistant_task_attempts").get();
 assert.equal(JSON.parse(attempt.frozen_snapshot_json).preconditions.scopeWitness.contentDigest,w.contentDigest);
 db.close();db=new DatabaseSync(file);initializeSchema(db);
 ctx={...ctx,db};
 const recovered=recoverAssistantCanvasTasksAtStartup(db);
 assert.equal(recovered.released,1);
 assert.equal(stepRow(ctx,candidate).status,"ready");
 const committed=execute(ctx,candidate,"after-restart");
 assert.equal(committed.receipt.scopeWitnessDigest,w.contentDigest);
 assert.equal(committed.status,"succeeded");
 assert.equal(execute(ctx,candidate,"repeat-restart").existing,true);
 assert.equal(revision(ctx),2);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts WHERE status='succeeded'").get().n,1);
});

test("P3.3g: changed scoped payload blocks post-restart release of prepared claim with no project write",t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-p33g-stale-")),file=join(dir,"stale.sqlite");
 let db=new DatabaseSync(file);
 t.after(()=>{try{db.close();}finally{rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80});}});
 let ctx=fixture(db),candidate=frozen(ctx);
 approve(ctx,candidate);
 assert.throws(()=>execute(ctx,candidate,"interrupted",{
  afterClaim:()=>{throw Error("before-submit")}
 }),/before-submit/);
 mutateAssetWithoutRevision(ctx,"写入栅栏之外的变动");
 db.close();db=new DatabaseSync(file);initializeSchema(db);ctx={...ctx,db};
 const result=recoverAssistantCanvasTasksAtStartup(db);
 assert.equal(result.released,1);
 assert.equal(stepRow(ctx,candidate).status,"blocked");
 assert.equal(revision(ctx),1);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts WHERE status='released_pre_submit'").get().n,1);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM project_events WHERE project_id='p'").get().n,1);
});


test("P3.3g: approved Step refuses a selected source changed before claim and creates no Attempt",t=>{
 const ctx=setup(t),candidate=frozen(ctx);
 approve(ctx,candidate);
 mutateAssetWithoutRevision(ctx,"审批后无修订变更");
 assert.throws(()=>execute(ctx,candidate,"stale-before-claim"),{code:"assistant_step_source_changed"});
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,0);
 assert.equal(stepRow(ctx,candidate).status,"ready");
 assert.equal(revision(ctx),1);
});

test("P3.3g: source modified after prepared claim is rechecked inside final commit transaction",t=>{
 const ctx=setup(t),candidate=frozen(ctx),beforeRevision=revision(ctx);
 approve(ctx,candidate);
 assert.throws(()=>execute(ctx,candidate,"stale-after-claim",{
  afterClaim:()=>mutateAssetWithoutRevision(ctx,"领取执行后改变的主角")
 }),{code:"assistant_step_source_changed"});
 assert.equal(revision(ctx),beforeRevision);
 assert.equal(stepRow(ctx,candidate).status,"running");
 assert.equal(stepRow(ctx,candidate).receipt_trust,"none");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts WHERE status='prepared'").get().n,1);
 assert.equal(JSON.parse(graph(ctx).nodes.find(n=>n.id==="assets").metadata.dramaDraft).assets[0].description,"主角");
 assert.equal(JSON.parse(graph(ctx).nodes.find(n=>n.id==="episodes").metadata.dramaDraft).episodes[3].synopsis,"剧情3");
 assert.equal(JSON.parse(graph(ctx).nodes.find(n=>n.id==="board").metadata.dramaDraft).shots[75].description,"分镜75");
});

test("P3.3g: changed unrelated creative payload still triggers global projectGraphDigest after scoped witness passes",t=>{
 const ctx=setup(t),candidate=frozen(ctx),w=preconditions(ctx,candidate).scopeWitness;
 mutateHiddenWithoutRevision(ctx);
 const compact=getProject(ctx.db,"p",{compact:true}).document;
 assert.doesNotThrow(()=>assertAssistantCanvasScopeWitness(ctx.db,"p",compact,actions,w));
 assert.throws(()=>approve(ctx,candidate),{code:"assistant_step_source_changed"});
 assert.equal(stepRow(ctx,candidate).status,"waiting_approval");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,0);
});

test("P3.3g: connection-only action roots include its endpoints and all upstream dependencies",t=>{
 const ctx=setup(t),compact=getProject(ctx.db,"p",{compact:true}).document;
 const witness=freezeAssistantCanvasScopeWitness(ctx.db,"p",compact,[
  {type:"delete_connection",connectionId:"assets-board"}]);
 assert.equal(witness.rootCount,2);
 assert.equal(witness.nodeCount,4);
 assert.equal(witness.edgeCount,3);
 assertAssistantCanvasScopeWitness(ctx.db,"p",compact,
  [{type:"delete_connection",connectionId:"assets-board"}],witness);
});
test("P3.3g: create-only plan without existing node roots retains mandatory graph fence",t=>{
 const ctx=setup(t);
 const created=planAssistantCanvasStep(ctx.db,{
  projectId:"p",taskId:ctx.taskId,requestId:"create-only",
  expectedPlanVersion:1,expectedProjectRevision:1,
  actions:[{type:"create_text",ref:"card",title:"新文本",content:"你好"}],
  center:{x:400,y:300},dependsOn:[],finalizeTask:false
 });
 assert.equal(preconditions(ctx,created).scopeWitness,undefined);
 approve(ctx,created);
 const result=execute(ctx,created,"create-execute");
 assert.equal(result.status,"succeeded");
 assert.equal(result.project.revision,2);
});
