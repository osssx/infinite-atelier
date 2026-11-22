import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,validateProjectDocument} from "./projects.mjs";
import {createAssistantTask} from "./assistant-tasks.mjs";
import {decideAssistantTaskStep,claimAssistantTaskStep,verifyAssistantTaskClaim} from "./assistant-task-step-gate.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep,commitAssistantCanvasAttempt,
 recoverAssistantCanvasTasksAtStartup} from "./assistant-task-canvas-executor.mjs";
import {readCreativePayload} from "./creative-payloads.mjs";
import {readDramaRevisionScope,insertTextVersions} from "./canvas-text-versions.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createProjectArchive} from "./project-archive.mjs";
import {Readable} from "node:stream";

const assets=[{id:"hero",kind:"character",name:"兔子",description:"Hero",sourceRefs:[],
 variants:[{id:"hero-day",name:"Day",description:"Blue"}]},
 ...Array.from({length:49},(_,i)=>({id:"prop-"+i,kind:"prop",name:"Prop "+i,
 description:"A prop "+i,sourceRefs:[]}))];
const episodes=Array.from({length:4},(_,i)=>({id:"ep-"+i,title:"Episode "+i,
 synopsis:"Story "+i,ending:"Ending "+i,events:[],eventItems:[],sourceRefs:[]}));
const shots=Array.from({length:100},(_,i)=>({id:"shot-"+i,
 episodeId:"ep-"+Math.floor(i/25),order:i%25,
 description:"Camera "+i,characterVariantIds:["hero-day"],propIds:[],keyPropIds:[]}));
const text={assets:JSON.stringify({assets}),episodes:JSON.stringify({episodes}),shots:JSON.stringify({shots})};
const doc=()=>({title:"Scoped Task 200 nodes",nodes:[
 {id:"assets",type:"drama:assets",metadata:{dramaDraft:text.assets,dramaConfirmed:text.assets}},
 {id:"episodes",type:"drama:episodes",metadata:{dramaDraft:text.episodes,dramaConfirmed:text.episodes}},
 {id:"board",type:"drama:storyboard",metadata:{dramaDraft:text.shots,dramaConfirmed:text.shots}},
 {id:"video-config",type:"config",metadata:{dramaVideoSource:{nodeId:"board",
  revisionId:"frozen-board",shotId:"shot-75",prompt:"keep video input"}}},
 ...Array.from({length:196},(_,i)=>({id:"text-"+i,type:"text",metadata:{content:"Text "+i}}))
 ],connections:[
 {id:"assets-board",fromNodeId:"assets",toNodeId:"board"},
 {id:"episodes-board",fromNodeId:"episodes",toNodeId:"board"},
 {id:"board-config",fromNodeId:"board",toNodeId:"video-config"}]});
const actions=[
 {type:"patch_drama_asset",nodeId:"assets",assetId:"hero",changes:{description:"Rabbit main"}},
 {type:"patch_drama_episode",nodeId:"episodes",episodeId:"ep-3",changes:{synopsis:"New episode 3"}},
 {type:"patch_storyboard_shot",nodeId:"board",shotId:"shot-75",changes:{description:"New shot 75"}}
];
function fixture(db){
 initializeSchema(db);createProject(db,{id:"p",document:doc()});
 insertTextVersions(db,"p",["assets","episodes","board"].map((nodeId,i)=>({
  nodeId,id:nodeId==="board"?"frozen-board":"frozen-"+nodeId,
  createdAt:"2026-11-22T00:00:00Z",source:"confirmation",content:text[[ "assets","episodes","shots" ][i]]
 })));
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",
  rootMessageId:"root",originalRequest:"完成三个草案修改",requestId:"initial"}).task;
 return {db,taskId:task.id};
}
const setup=t=>{const db=new DatabaseSync(":memory:");t.after(()=>db.close());return fixture(db)};
const rev=ctx=>getProject(ctx.db,"p",{compact:true}).revision;
const body=(ctx,nodeId,kind)=>JSON.parse(readCreativePayload(ctx.db,"p",nodeId).payload.dramaDraft)[kind];
const plan=(ctx,work=actions,id="plan")=>planAssistantCanvasStep(ctx.db,{
 projectId:"p",taskId:ctx.taskId,requestId:id,expectedPlanVersion:1,
 expectedProjectRevision:rev(ctx),actions:work,center:{x:320,y:230},dependsOn:[],finalizeTask:false
});
const approval=(ctx,step,id="approve")=>decideAssistantTaskStep(ctx.db,{
 projectId:"p",taskId:ctx.taskId,stepId:step.stepId,requestId:id,
 expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve"
});
const execute=(ctx,step,id="execute",extras={})=>executeAssistantCanvasStep(ctx.db,{
 projectId:"p",taskId:ctx.taskId,stepId:step.stepId,requestId:id,
 expectedPlanVersion:1,actionDigest:step.actionDigest,...extras
});
const step=(ctx,candidate)=>ctx.db.prepare("SELECT * FROM assistant_task_steps WHERE id=?").get(candidate.stepId);
const frozen=(ctx,candidate)=>JSON.parse(step(ctx,candidate).preconditions_json);

test("P3.3i: verified graph is only exposed by explicit opt-in after lease, witness and full digest checks",t=>{
 const ctx=setup(t),candidate=plan(ctx);
 approval(ctx,candidate);
 const claim=claimAssistantTaskStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  stepId:candidate.stepId,expectedPlanVersion:1});
 const query={projectId:"p",taskId:ctx.taskId,stepId:candidate.stepId,
  attemptId:claim.attemptId,leaseOwner:claim.leaseOwner,planVersion:1};
 const ordinary=verifyAssistantTaskClaim(ctx.db,query);
 assert.equal(ordinary.verifiedGraph,undefined);
 const proof=verifyAssistantTaskClaim(ctx.db,{...query,includeVerifiedGraph:true});
 assert.equal(proof.verifiedGraph.compact.nodes.length,200);
 assert.equal(proof.verifiedGraph.document.nodes.length,200);
 assert.equal(proof.verifiedGraph.document.nodes.find(n=>n.id==="board").metadata.dramaDraft,text.shots);
 assert.ok(proof.verifiedGraph.compact.nodes.find(n=>n.id==="board").metadata.creativePayloadRef);
 assert.throws(()=>verifyAssistantTaskClaim(ctx.db,{...query,leaseOwner:"forged",includeVerifiedGraph:true}),
  {code:"assistant_step_lease_invalid"});
 const result=commitAssistantCanvasAttempt(ctx.db,{...query,actionDigest:candidate.actionDigest});
 assert.equal(result.receipt.executionPath,"scoped_cas");
 assert.equal(rev(ctx),2);
});

test("P3.3i: altered Step preconditions after Claim cannot borrow the verified Attempt graph",t=>{
 const ctx=setup(t),candidate=plan(ctx);
 approval(ctx,candidate);
 const claim=claimAssistantTaskStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  stepId:candidate.stepId,expectedPlanVersion:1});
 const pre=frozen(ctx,candidate);
 pre.scopedPatches.expectedPostGraphDigest="0".repeat(64);
 ctx.db.prepare("UPDATE assistant_task_steps SET preconditions_json=? WHERE id=?")
  .run(JSON.stringify(pre),candidate.stepId);
 assert.throws(()=>commitAssistantCanvasAttempt(ctx.db,{projectId:"p",taskId:ctx.taskId,
  stepId:candidate.stepId,attemptId:claim.attemptId,
  leaseOwner:claim.leaseOwner,planVersion:1,actionDigest:candidate.actionDigest}),
  {code:"assistant_step_action_changed"});
 assert.equal(rev(ctx),1);
 assert.equal(body(ctx,"assets","assets")[0].description,"Hero");
 assert.equal(step(ctx,candidate).receipt_trust,"none");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id='p'").get().n,1);
});

test("P3.3h: approved 200-node three-kind Task applies SQLite JSON1 patches without rewriting compact graph",t=>{
 const ctx=setup(t),candidate=plan(ctx),pre=frozen(ctx,candidate);
 assert.equal(pre.scopedPatches.schemaVersion,1);
 assert.equal(pre.scopedPatches.edits.length,3);
 assert.match(pre.scopedPatches.expectedPostGraphDigest,/^[a-f0-9]{64}$/);
 const compactBefore=ctx.db.prepare("SELECT document_json FROM projects WHERE id='p'").get().document_json;
 const configBefore=getProject(ctx.db,"p").document.nodes.find(n=>n.id==="video-config");
 const originalHist=readDramaRevisionScope(ctx.db,"p","board",{versionId:"frozen-board",entryId:"shot-75"});
 approval(ctx,candidate);
 const result=execute(ctx,candidate);
 assert.equal(result.status,"succeeded");
 assert.equal(result.receipt.executionPath,"scoped_cas");
 assert.equal(result.receipt.applied,3);
 assert.equal(result.receipt.projectGraphDigest,pre.scopedPatches.expectedPostGraphDigest);
 assert.equal(rev(ctx),2);
 assert.equal(ctx.db.prepare("SELECT document_json FROM projects WHERE id='p'").get().document_json,compactBefore);
 assert.equal(body(ctx,"assets","assets")[0].description,"Rabbit main");
 assert.equal(body(ctx,"episodes","episodes")[3].synopsis,"New episode 3");
 assert.equal(body(ctx,"board","shots")[75].description,"New shot 75");
 assert.deepEqual(body(ctx,"assets","assets").slice(1),assets.slice(1));
 assert.deepEqual(body(ctx,"episodes","episodes").slice(0,3),episodes.slice(0,3));
 assert.deepEqual(body(ctx,"board","shots").filter((_,i)=>i!==75),shots.filter((_,i)=>i!==75));
 assert.deepEqual(getProject(ctx.db,"p").document.nodes.find(n=>n.id==="video-config"),configBefore);
 assert.deepEqual(readDramaRevisionScope(ctx.db,"p","board",{versionId:"frozen-board",entryId:"shot-75"}),originalHist);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM project_events WHERE project_id='p'").get().n,2);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts WHERE status='succeeded'").get().n,1);
 assert.equal(step(ctx,candidate).receipt_trust,"server_committed");
 assert.equal(execute(ctx,candidate,"replayed").existing,true);
 assert.equal(rev(ctx),2);
});

test("P3.3h: two distinct items of same assets or shots node batch safely; repeated parent falls back",t=>{
 const ctx=setup(t),batch=[
  {type:"patch_drama_asset",nodeId:"assets",assetId:"hero",changes:{description:"Hero v2"}},
  {type:"patch_drama_asset",nodeId:"assets",assetId:"prop-40",changes:{description:"Prop 40 v2"}},
  {type:"patch_storyboard_shot",nodeId:"board",shotId:"shot-75",changes:{description:"Shot 75 v2"}},
  {type:"patch_storyboard_shot",nodeId:"board",shotId:"shot-76",changes:{description:"Shot 76 v2"}}
 ];
 const candidate=plan(ctx,batch);
 assert.equal(frozen(ctx,candidate).scopedPatches.edits.length,4);
 approval(ctx,candidate);
 const result=execute(ctx,candidate);
 assert.equal(result.receipt.executionPath,"scoped_cas");
 assert.equal(body(ctx,"assets","assets")[40+1].description,"Prop 40 v2");
 assert.equal(body(ctx,"board","shots")[76].description,"Shot 76 v2");
 assert.equal(rev(ctx),2);
});

test("P3.3h: repeated parent, refs edits, normalization and mixed action plans remain on full graph path",t=>{
 for(const work of [
  [{type:"patch_drama_asset",nodeId:"assets",assetId:"hero",changes:{description:"First"}},
   {type:"patch_drama_asset",nodeId:"assets",assetId:"hero",changes:{description:"Second"}}],
  [{type:"patch_drama_asset",nodeId:"assets",assetId:"hero",changes:{sourceRefs:["paragraph"]}}],
  [{type:"patch_storyboard_shot",nodeId:"board",shotId:"shot-75",changes:{description:"New shot"}},
   {type:"set_title",nodeId:"assets",title:"Assets renamed"}]
 ]){
  const ctx=setup(t),candidate=plan(ctx,work,"fallback-"+work.length+"-"+work[0].type);
  assert.equal(frozen(ctx,candidate).scopedPatches,undefined);
  approval(ctx,candidate);
  const result=execute(ctx,candidate);
  assert.equal(result.receipt.executionPath,undefined);
  assert.equal(rev(ctx),2);
 }
});

test("P3.3h: fault at receipt causes all scoped edits, indexes, events, project revision to roll back",t=>{
 const ctx=setup(t),candidate=plan(ctx);
 approval(ctx,candidate);
 const before=ctx.db.prepare("SELECT document_json FROM projects WHERE id='p'").get().document_json;
 assert.throws(()=>execute(ctx,candidate,"fault",{
  beforeReceipt:()=>{throw Error("inject_p33h_receipt")}
 }),/inject_p33h_receipt/);
 assert.equal(rev(ctx),1);
 assert.equal(ctx.db.prepare("SELECT document_json FROM projects WHERE id='p'").get().document_json,before);
 assert.equal(body(ctx,"assets","assets")[0].description,"Hero");
 assert.equal(body(ctx,"episodes","episodes")[3].synopsis,"Story 3");
 assert.equal(body(ctx,"board","shots")[75].description,"Camera 75");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM project_events WHERE project_id='p'").get().n,1);
 assert.equal(step(ctx,candidate).receipt_trust,"none");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts WHERE status='succeeded'").get().n,0);
});

test("P3.3h: tampered frozen predicted post-graph digest fails closed with no partial CAS",t=>{
 const ctx=setup(t),candidate=plan(ctx),pre=frozen(ctx,candidate);
 assert.ok(pre.scopedPatches);
 pre.scopedPatches.expectedPostGraphDigest="0".repeat(64);
 ctx.db.prepare("UPDATE assistant_task_steps SET preconditions_json=? WHERE id=?")
  .run(JSON.stringify(pre),candidate.stepId);
 approval(ctx,candidate);
 assert.throws(()=>execute(ctx,candidate),{code:"assistant_step_source_changed"});
 assert.equal(body(ctx,"assets","assets")[0].description,"Hero");
 assert.equal(body(ctx,"board","shots")[75].description,"Camera 75");
 assert.equal(rev(ctx),1);
 assert.equal(step(ctx,candidate).receipt_trust,"none");
});

test("P3.3h: SQLite guard prohibits document_json writes yet an approved scoped Task still commits",t=>{
 const ctx=setup(t),candidate=plan(ctx);
 assert.ok(frozen(ctx,candidate).scopedPatches);
 approval(ctx,candidate);
 // Strong proof that this path never UPDATEs document_json, even with its
 // existing payload extraction trigger and multi-entry receipt co-transaction.
 ctx.db.exec(`CREATE TRIGGER forbid_graph_rewrite
  BEFORE UPDATE OF document_json ON projects BEGIN
    SELECT RAISE(ABORT,'unexpected_full_graph_rewrite');
  END`);
 const result=execute(ctx,candidate);
 assert.equal(result.receipt.executionPath,"scoped_cas");
 assert.equal(rev(ctx),2);
 assert.equal(body(ctx,"board","shots")[75].description,"New shot 75");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM drama_scope_batch_operations").get().n,0,
  "Task Step receipt, not the unrelated user batch ledger, grants Task idempotency");
});

test("P3.3h: missing scoped index takes the old graph path",t=>{
 const ctx=setup(t);
 ctx.db.prepare("DELETE FROM creative_scope_index_state WHERE project_id='p' AND node_id='board' AND stage='draft'").run();
 const candidate=plan(ctx);
 assert.equal(frozen(ctx,candidate).scopedPatches,undefined);
 approval(ctx,candidate);const result=execute(ctx,candidate);
 assert.equal(result.receipt.executionPath,undefined);
 assert.equal(body(ctx,"board","shots")[75].description,"New shot 75");
 assert.equal(rev(ctx),2);
});

test("P3.3h: a stale frozen item digest aborts all three scoped writes without persisting partial materialization",t=>{
 const ctx=setup(t),candidate=plan(ctx),pre=frozen(ctx,candidate);
 assert.ok(pre.scopedPatches);
 pre.scopedPatches.edits[2].expectedDigest="a".repeat(64);
 ctx.db.prepare("UPDATE assistant_task_steps SET preconditions_json=? WHERE id=?")
  .run(JSON.stringify(pre),candidate.stepId);
 approval(ctx,candidate);
 assert.throws(()=>execute(ctx,candidate),{code:"assistant_step_source_changed"});
 assert.equal(rev(ctx),1);
 assert.equal(body(ctx,"assets","assets")[0].description,"Hero");
 assert.equal(body(ctx,"episodes","episodes")[3].synopsis,"Story 3");
 assert.equal(body(ctx,"board","shots")[75].description,"Camera 75");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM project_events WHERE project_id='p'").get().n,1);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts WHERE status='succeeded'").get().n,0);
});
test("P3.3h: episode eventItem normalization cannot silently enter SQL content-only path",t=>{
 const ctx=setup(t);
 const row=ctx.db.prepare("SELECT payload_json FROM creative_node_payloads WHERE project_id='p' AND node_id='episodes'").get();
 const payload=JSON.parse(row.payload_json),episodes=JSON.parse(payload.dramaDraft);
 delete episodes.episodes[3].eventItems;
 ctx.db.prepare("UPDATE creative_node_payloads SET payload_json=? WHERE project_id='p' AND node_id='episodes'")
  .run(JSON.stringify({...payload,dramaDraft:JSON.stringify(episodes)}));
 const candidate=plan(ctx);
 assert.equal(frozen(ctx,candidate).scopedPatches,undefined);
 approval(ctx,candidate);
 const result=execute(ctx,candidate);
 assert.equal(result.receipt.executionPath,undefined);
 assert.deepEqual(body(ctx,"episodes","episodes")[3].eventItems,[]);
 assert.equal(body(ctx,"episodes","episodes")[3].synopsis,"New episode 3");
});
test("P3.3h: SQLite restart retains frozen scoped plan, releases prepared claim and commits once",t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-p33h-")),location=join(dir,"local.sqlite");
 let db=new DatabaseSync(location);
 t.after(()=>{try{db.close();}finally{rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80});}});
 let ctx=fixture(db),candidate=plan(ctx);
 assert.ok(frozen(ctx,candidate).scopedPatches);
 approval(ctx,candidate);
 assert.throws(()=>execute(ctx,candidate,"interrupted",{afterClaim:()=>{throw Error("prepared_restart")}}),
  /prepared_restart/);
 db.close();db=new DatabaseSync(location);initializeSchema(db);ctx={...ctx,db};
 assert.equal(recoverAssistantCanvasTasksAtStartup(db).released,1);
 assert.equal(step(ctx,candidate).status,"ready");
 const committed=execute(ctx,candidate,"after-restart");
 assert.equal(committed.receipt.executionPath,"scoped_cas");
 assert.equal(execute(ctx,candidate,"replay-restart").existing,true);
 assert.equal(rev(ctx),2);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts WHERE status='succeeded'").get().n,1);
});

test("P3.3h: archived frozen shots, manual Config and CAS results survive project ZIP",async t=>{
 const ctx=setup(t),candidate=plan(ctx);
 approval(ctx,candidate);execute(ctx,candidate);
 const dir=mkdtempSync(join(tmpdir(),"atelier-p33h-zip-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80}));
 const store=createBlobStore({db:ctx.db,dataDir:dir,maxBlobBytes:100_000_000});
 const archive=createProjectArchive({db:ctx.db,blobStore:store});
 const stream=(await archive.exportProject("p")).stream;
 const bytes=Buffer.concat(await Array.fromAsync(stream));
 const imported=await archive.importProject(Readable.from([bytes]));
 assert.equal(getProject(ctx.db,imported.id).document.nodes.find(n=>n.id==="video-config").metadata.dramaVideoSource.shotId,"shot-75");
 assert.equal(readDramaRevisionScope(ctx.db,imported.id,"board",{draft:true,entryId:"shot-75"}).entries[0].description,"New shot 75");
 assert.equal(readDramaRevisionScope(ctx.db,imported.id,"board",{versionId:"frozen-board",entryId:"shot-75"}).entries[0].description,"Camera 75");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts WHERE project_id=?").get(imported.id).n,1,
  "ZIP retains the historical Task attempt, with its imported status handled by archive migration");
});
