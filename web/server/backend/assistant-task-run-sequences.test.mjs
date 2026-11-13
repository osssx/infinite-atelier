import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync,backup} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {buildApp} from "./app.mjs";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {fingerprintSource} from "./repository.mjs";
import {createAssistantTask,getAssistantTask} from "./assistant-tasks.mjs";
import {registerAssistantRunSequence,getAssistantRunSequence,skipAssistantRunBranch} from "./assistant-task-run-sequences.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep,reconcileAssistantExternalTask,
 recoverAssistantExternalTasksAtStartup} from "./assistant-task-external-jobs.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";

const node=id=>({id,type:"text",title:id,position:{x:0,y:0},width:300,height:200,
 metadata:{content:"Story "+id}});
const doc={nodes:[node("first"),node("second"),node("third")],connections:[]};
function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:doc});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"c",rootMessageId:"u",
  originalRequest:"请连续生成三段文字",requestId:"create"}).task;
 const base={projectId:"p",taskId:task.id};
 return {db,base};
}
const actions=[{type:"run_node",nodeId:"first",mode:"text"},
 {type:"run_node",nodeId:"second",mode:"text"}];
function capture(ctx,requestId="capture",act=actions){
 return registerAssistantRunSequence(ctx.db,{...ctx.base,requestId,sourceMessageId:"message-123",
  expectedPlanVersion:1,expectedProjectRevision:1,actions:act});
}
function plan(ctx,seq,index,dependsOn){
 const nodeId=(ctx.branchActions??actions)[index].nodeId;
 return planAssistantExternalJobStep(ctx.db,{...ctx.base,
  requestId:"planned-"+index,kind:"model_job",expectedPlanVersion:1,
  expectedProjectRevision:1,
  job:{targetNodeId:nodeId,sourceNodeFingerprint:fingerprintSource(doc,nodeId),executionMode:"poll",
   snapshot:{adapterKind:"model",task:{kind:"text",model:"mock",prompt:"Story "+nodeId}}},
  runSequenceId:seq.sequenceId,runIndex:index,dependsOn});
}
function send(ctx,step,index){
 decideAssistantTaskStep(ctx.db,{...ctx.base,stepId:step.stepId,requestId:"approve-"+index,
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve"});
 return enqueueAssistantExternalJobStep(ctx.db,{...ctx.base,stepId:step.stepId,
  requestId:"enqueue-"+index,expectedPlanVersion:1,actionDigest:step.actionDigest});
}
function complete(ctx,jobId,index){
 ctx.db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
 const sha=(""+(index+1)).repeat(64);
 const blob="blob-"+index,artifact="art-"+index;
 ctx.db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,4,'text/plain',?,'ready')")
  .run(blob,sha,"test/"+blob);
 ctx.db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) VALUES(?,?,NULL,?,?,'text','text/plain',?,'{}')")
  .run(artifact,jobId,"part-"+index,blob,sha);
 reconcileAssistantExternalTask(ctx.db,ctx.base);
 const material=ctx.db.prepare("SELECT id FROM assistant_task_steps WHERE task_id=? AND kind='materialize' AND json_extract(action_json,'$.jobId')=?")
  .get(ctx.base.taskId,jobId);
 assert.ok(material);
 ctx.db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES(?,?,?,'p','materialized',?)")
  .run("mat-"+index,jobId,artifact,(ctx.branchActions??actions)[index].nodeId);
 reconcileAssistantExternalTask(ctx.db,ctx.base);
 return material.id;
}
const branchActions=kind=>[
 {type:"run_node",nodeId:"first",mode:"text"},
 {type:"run_node",nodeId:"second",mode:"text",
  when:{sourceIndex:0,kind,op:"gte",count:1}},
 {type:"run_node",nodeId:"third",mode:"text",
  when:{sourceIndex:0,kind,op:"lt",count:1}}
];
function branchFixture(t,kind="text"){
 const ctx=setup(t);ctx.branchActions=branchActions(kind);
 const seq=capture(ctx,"branch-seq",ctx.branchActions);
 const first=plan(ctx,seq,0,[]),job=send(ctx,first,0),mat=complete(ctx,job.jobId,0);
 return {ctx,seq,first,jobId:job.jobId,mat};
}
function skipBranch(ctx,seq,index,requestId="skip-"+index,overrides={}){
 const state=getAssistantRunSequence(ctx.db,ctx.base);
 return skipAssistantRunBranch(ctx.db,{...ctx.base,requestId,runSequenceId:seq.sequenceId,
  runIndex:index,expectedPlanVersion:1,expectedProjectRevision:1,
  evidenceDigest:state.skip?.evidenceDigest??"0".repeat(64),...overrides});
}
test("P3c3b trusted count chooses gte branch, skips lt branch with durable receipt and no third Job",t=>{
 const {ctx,seq,mat}=branchFixture(t,"text");
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).state,"ready");
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).next.index,1);
 assert.throws(()=>skipBranch(ctx,seq,2),{code:"assistant_task_run_branch_not_ready"});
 const second=plan(ctx,seq,1,[mat]),paid=send(ctx,second,1);
 complete(ctx,paid.jobId,1);
 const next=getAssistantRunSequence(ctx.db,ctx.base);
 assert.equal(next.state,"skip_ready");
 assert.equal(next.index,2);
 assert.equal(next.skip.count,1);
 assert.equal(next.skip.verifiedCount,1);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,2);
 assert.throws(()=>skipBranch(ctx,seq,2,"wrong-proof",{evidenceDigest:"0".repeat(64)}),{
  code:"assistant_task_run_branch_not_ready"});
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_run_branch_skips").get().n,0);
 const result=skipBranch(ctx,seq,2);
 assert.equal(result.skipped,true);
 assert.equal(result.completed,true);
 assert.equal(result.receipt.receiptTrust,"server_committed");
 assert.equal(skipBranch(ctx,seq,2,"skip-2",{evidenceDigest:next.skip.evidenceDigest}).existing,true);
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).state,"completed");
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).branchSkips[0].index,2);
 assert.equal(getAssistantTask(ctx.db,ctx.base).task.status,"completed");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,2);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_run_branch_skips").get().n,1);
});
test("P3c3b trusted zero image count skips gte branch then runs lt branch with separate paid approval",t=>{
 const {ctx,seq,mat}=branchFixture(t,"image");
 const before=getAssistantRunSequence(ctx.db,ctx.base);
 assert.equal(before.state,"skip_ready");
 assert.equal(before.index,1);
 assert.equal(before.skip.count,0);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 const result=skipBranch(ctx,seq,1);
 assert.equal(result.completed,false);
 const follow=getAssistantRunSequence(ctx.db,ctx.base);
 assert.equal(follow.state,"ready");
 assert.equal(follow.next.index,2);
 assert.deepEqual(follow.next.dependsOn,[mat]);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.throws(()=>plan(ctx,seq,1,[mat]),{code:"assistant_task_run_not_ready"});
 const third=plan(ctx,seq,2,[mat]);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).state,"waiting_approval");
 const paid=send(ctx,third,2);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,2);
 complete(ctx,paid.jobId,2);
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).state,"completed");
 assert.equal(getAssistantTask(ctx.db,ctx.base).task.status,"completed");
});
test("P3c3b never interprets missing CAS or unverified materialization as the zero-count branch",t=>{
 const {ctx,seq}=branchFixture(t,"image");
 ctx.db.prepare("UPDATE blobs SET status='missing' WHERE id='blob-0'").run();
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).state,"awaiting_verified_branch_evidence");
 assert.throws(()=>skipBranch(ctx,seq,1),{code:"assistant_task_run_branch_not_ready"});
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_run_branch_skips").get().n,0);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 ctx.db.prepare("UPDATE blobs SET status='ready' WHERE id='blob-0'").run();
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).state,"skip_ready");
 skipBranch(ctx,seq,1);
 ctx.db.prepare("UPDATE blobs SET status='missing' WHERE id='blob-0'").run();
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).state,"branch_evidence_invalidated");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
});
test("P3c3b validates a single complementary trusted source; malformed branches leave zero Steps",t=>{
 const ctx=setup(t);
 const base=branchActions("text");
 const invalid=[
  [base[0],base[1]], // only 2 run actions
  [base[0],base[1],{...base[2],when:{...base[2].when,op:"gte"}}],
  [base[0],base[1],{...base[2],when:{...base[2].when,count:2}}],
  [{...base[0],when:base[1].when},base[1],base[2]],
  [base[0],{...base[1],when:{...base[1].when,sourceIndex:1}},base[2]],
  [base[0],{...base[1],when:{...base[1].when,kind:"missing"}},base[2]]
 ];
 for(const [n,actions] of invalid.entries())
  assert.throws(()=>registerAssistantRunSequence(ctx.db,{...ctx.base,requestId:"invalid-branch-"+n,
   sourceMessageId:"invalid-branch-"+n,expectedPlanVersion:1,expectedProjectRevision:1,actions}),
   {code:"assistant_task_run_branch_invalid"});
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_run_sequences").get().n,0);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
});
test("P3c3b HTTP skip command is approval-independent, idempotent and never creates a Job",async t=>{
 const {ctx,seq}=branchFixture(t,"image"),app=buildApp({db:ctx.db,authorize:()=>true});
 t.after(async()=>app.close());
 const base="/api/v1/projects/p/assistant/tasks/"+ctx.base.taskId+"/run-sequences";
 const call=async(method,url,payload)=>{
  const r=await app.inject({method,url,...(payload?{payload}:{})});
  return {status:r.statusCode,body:r.json()};
 };
 const state=(await call("GET",base)).body;
 assert.equal(state.state,"skip_ready");
 const body={requestId:"http-skip",runSequenceId:seq.sequenceId,runIndex:1,
  expectedPlanVersion:1,expectedProjectRevision:1,evidenceDigest:state.skip.evidenceDigest};
 const fake=await call("POST",base+"/skip",{...body,requestId:"fake-digest",
  evidenceDigest:"0".repeat(64)});
 assert.equal(fake.status,409);
 assert.equal((await call("POST",base+"/skip",body)).body.skipped,true);
 assert.equal((await call("POST",base+"/skip",body)).body.existing,true);
 assert.equal((await call("GET",base)).body.next.index,2);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_run_branch_skips").get().n,1);
});
test("P3c3b persisted skip survives SQLite restart, preserves existing Job and remains immutable",async t=>{
 const {ctx,seq}=branchFixture(t,"image");
 skipBranch(ctx,seq,1);
 const dir=mkdtempSync(join(tmpdir(),"atelier-p3c3b-")),file=join(dir,"branch.sqlite");
 let reopened;
 t.after(()=>{try{reopened?.close()}catch{};rmSync(dir,{recursive:true,force:true})});
 await backup(ctx.db,file);
 reopened=new DatabaseSync(file);initializeSchema(reopened);
 const next=getAssistantRunSequence(reopened,ctx.base);
 assert.equal(next.state,"ready");assert.equal(next.next.index,2);
 assert.equal(next.branchSkips.length,1);
 assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(recoverAssistantExternalTasksAtStartup(reopened).advanced,0);
 assert.throws(()=>skipAssistantRunBranch(reopened,{...ctx.base,requestId:"switch-branch",
  runSequenceId:seq.sequenceId,runIndex:2,expectedPlanVersion:1,
  expectedProjectRevision:1,evidenceDigest:next.branchSkips[0].receipt.evidenceDigest}),
  {code:"assistant_task_run_branch_not_ready"});
 assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
});
test("P3b freeze two intents; one Job at a time; approval and materialization gate next",t=>{
 const ctx=setup(t);
 assert.equal(SCHEMA_VERSION,30);
 const seq=capture(ctx);
 assert.equal(seq.count,2);
 assert.equal(capture(ctx).sequenceId,seq.sequenceId);
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).next.index,0);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
 assert.throws(()=>capture(ctx,"changed-request",actions.slice().reverse()),{code:"assistant_task_run_already_planned"});
 assert.throws(()=>registerAssistantRunSequence(ctx.db,{...ctx.base,requestId:"wrong-rev",
  sourceMessageId:"different",expectedPlanVersion:1,expectedProjectRevision:99,actions}),{
  code:"assistant_step_source_changed"});
 assert.throws(()=>plan(ctx,seq,1,[]),{code:"assistant_task_run_not_ready"});
 const first=plan(ctx,seq,0,[]);
 assert.equal(first.status,"waiting_approval");
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).state,"waiting_approval");
 assert.throws(()=>plan(ctx,seq,1,[]),{code:"assistant_step_already_planned"});
 const queued=send(ctx,first,0);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).state,"waiting_external");
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).next,null);
 assert.equal(recoverAssistantExternalTasksAtStartup(ctx.db).advanced,0);
 const mat=complete(ctx,queued.jobId,0);
 const next=getAssistantRunSequence(ctx.db,ctx.base);
 assert.equal(next.state,"ready");
 assert.equal(next.next.index,1);
 assert.deepEqual(next.next.dependsOn,[mat]);
 assert.equal(next.outputs.length,1);
 assert.deepEqual({index:next.outputs[0].runIndex,source:next.outputs[0].nodeId,
  kind:next.outputs[0].kind,material:next.outputs[0].materialStepId},
  {index:0,source:"first",kind:"text",material:mat});
 const second=plan(ctx,seq,1,[mat]);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 const pre=JSON.parse(ctx.db.prepare("SELECT preconditions_json FROM assistant_task_steps WHERE id=?").get(second.stepId).preconditions_json);
 assert.equal(pre.finalizeTask,true);
 assert.equal(pre.runIndex,1);
 const queued2=send(ctx,second,1);
 assert.notEqual(queued2.jobId,queued.jobId);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,2);
 complete(ctx,queued2.jobId,1);
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).state,"completed"); // final Task completed
 assert.equal(getAssistantTask(ctx.db,ctx.base).task.status,"completed");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,2);
});

test("P3c trusted output references cannot be forged from an unverified materialization",t=>{
 const ctx=setup(t),seq=capture(ctx);
 const step=plan(ctx,seq,0,[]),queued=send(ctx,step,0),material=complete(ctx,queued.jobId,0);
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).outputs.length,1);
 ctx.db.prepare("UPDATE materializations SET node_id='forged' WHERE job_id=?").run(queued.jobId);
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).outputs.length,0);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 ctx.db.prepare("UPDATE materializations SET node_id='first' WHERE job_id=?").run(queued.jobId);
 ctx.db.prepare("UPDATE assistant_task_steps SET receipt_trust='none' WHERE id=?").run(material);
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).outputs.length,0);
 ctx.db.prepare("UPDATE assistant_task_steps SET receipt_trust='server_committed' WHERE id=?").run(material);
 ctx.db.prepare("UPDATE blobs SET status='missing' WHERE id='blob-0'").run();
 assert.equal(getAssistantRunSequence(ctx.db,ctx.base).outputs.length,0);
});
test("P3b Comfy Job target must match current pinned workflow template revision",t=>{
 const ctx=setup(t);
 const wf={id:"workflow",type:"comfy:workflow",title:"W",position:{x:10,y:10},
  width:420,height:240,metadata:{comfyWorkflow:{
   templateId:"demo-wf",templateRevision:"d".repeat(64),inputOverrides:{}
  }}};
 const changed={nodes:[wf,doc.nodes[1]],connections:[]};
 ctx.db.prepare("UPDATE projects SET document_json=? WHERE id='p'").run(JSON.stringify(changed));
 const candidate=registerAssistantRunSequence(ctx.db,{...ctx.base,
  requestId:"comfy-sequence",sourceMessageId:"comfy-message",expectedPlanVersion:1,
  expectedProjectRevision:1,actions:[
   {type:"run_workflow",nodeId:"workflow"},
   {type:"run_node",nodeId:"second",mode:"text"}]});
 const basic={...ctx.base,requestId:"comfy-job",kind:"comfy_workflow",
  expectedPlanVersion:1,expectedProjectRevision:1,runSequenceId:candidate.sequenceId,
  runIndex:0,dependsOn:[],job:{targetNodeId:"workflow",
   sourceNodeFingerprint:fingerprintSource(changed,"workflow"),executionMode:"poll",
   snapshot:{adapterKind:"comfy",comfyRequest:{
    nodes:[{id:"workflow",templateId:"demo-wf",templateRevision:"outdated"}]}}}};
 assert.throws(()=>planAssistantExternalJobStep(ctx.db,basic),{
  code:"assistant_task_run_target_invalid"
 });
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
 const correct=structuredClone(basic);
 correct.job.snapshot.comfyRequest.nodes[0].templateRevision="d".repeat(64);
 const step=planAssistantExternalJobStep(ctx.db,correct);
 assert.equal(step.status,"waiting_approval");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
});
test("P3b refuses malformed and tampered targets before any Job / Step",t=>{
 const ctx=setup(t);
 for(const invalid of [
  [{type:"run_node",nodeId:"missing"},{type:"run_node",nodeId:"second"}],
  [{type:"run_node",nodeId:"first"},{type:"run_node",nodeId:"first"}],
  [{type:"run_workflow",nodeId:"first"},{type:"run_node",nodeId:"second"}],
  [{type:"run_node",nodeId:"first",mode:"image"},{type:"run_node",nodeId:"second"}]
 ])assert.throws(()=>registerAssistantRunSequence(ctx.db,{...ctx.base,requestId:"invalid-"+JSON.stringify(invalid).length,
  sourceMessageId:"bad-"+invalid[0].nodeId,expectedPlanVersion:1,expectedProjectRevision:1,actions:invalid}));
 const seq=capture(ctx);
 assert.throws(()=>planAssistantExternalJobStep(ctx.db,{...ctx.base,
  requestId:"forged",kind:"model_job",expectedPlanVersion:1,expectedProjectRevision:1,
  runSequenceId:seq.sequenceId,runIndex:0,dependsOn:[],
  job:{targetNodeId:"third",sourceNodeFingerprint:fingerprintSource(doc,"third"),
   executionMode:"poll",snapshot:{adapterKind:"model",task:{kind:"text"}}}}),{code:"assistant_task_run_target_invalid"});
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
});
