import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync,backup} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {fingerprintSource,appendArtifact} from "./repository.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {createCanvasMaterializer} from "./canvas-materializer.mjs";
import {createAssistantTaskContinuationEvents} from "./assistant-task-continuation-events.mjs";
import {createAssistantTask,cancelAssistantTask} from "./assistant-tasks.mjs";
import {registerAssistantRunSequence,getAssistantRunSequence} from "./assistant-task-run-sequences.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep,
 reconcileAssistantExternalTask} from "./assistant-task-external-jobs.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {createAssistantRunBudgetGrant,getAssistantRunBudgetGrant,
 revokeAssistantRunBudgetGrant} from "./assistant-task-run-budget.mjs";
import {frozenLocalComfyScope} from "./assistant-local-comfy-scope.mjs";
import {buildApp} from "./app.mjs";

const rev="d".repeat(64);
const template={id:"local-art",revision:rev,apiGraph:{"1":{
 class_type:"TextEncoder",inputs:{text:"local prompt"}}},requirements:{classTypes:["TextEncoder"]},
 ports:[{id:"image",label:"Image",direction:"source",valueKind:"IMAGE",
  outputBinding:{nodeId:"1",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}]};
const wf=id=>({id,type:"comfy:workflow",title:id,position:{x:id==="a"?0:500,y:0},
 width:420,height:270,metadata:{comfyWorkflow:{templateId:template.id,
  templateRevision:rev,inputOverrides:{seed:42}},
  comfyPorts:[{id:"image",direction:"source",valueKind:"IMAGE",label:"Output"}]}});
const doc={nodes:[wf("a"),wf("b")],connections:[]};
const count=(db,table)=>db.prepare("SELECT COUNT(*) n FROM "+table).get().n;
function context(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 db.prepare("INSERT INTO comfy_instances(id,url) VALUES(?,?)").run("local-gpu","http://127.0.0.1:8188");
 createProject(db,{id:"p",document:doc});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"u",
  originalRequest:"两个本地 ComfyUI 工作流依次执行",requestId:"task"}).task;
 const base={projectId:"p",taskId:task.id};
 const sequence=registerAssistantRunSequence(db,{...base,requestId:"seq",
  sourceMessageId:"u",expectedPlanVersion:1,expectedProjectRevision:1,
  actions:[{type:"run_workflow",nodeId:"a"},{type:"run_workflow",nodeId:"b"}]});
 const job=(nodeId,alter)=>{
  const graph=getProject(db,"p");
  const snap={adapterKind:"comfy",instanceId:"local-gpu",comfyTemplate:template,
   comfyRequest:{schemaVersion:2,projectId:"p",canvasRevision:String(graph.revision),
    instanceId:"local-gpu",rootOutputs:[{nodeId,portId:"image"}],
    nodes:[{id:nodeId,templateId:template.id,templateRevision:rev,
     inputOverrides:{seed:42}}],
    edges:[],externalInputs:[],runOptions:{},idempotencyKey:"browser-"+nodeId}};
  alter?.(snap);
  return {targetNodeId:nodeId,sourceNodeFingerprint:fingerprintSource(graph.document,nodeId),
   executionMode:"poll",snapshot:snap};
 };
 const plan=(index,opts={})=>{
  const view=getAssistantRunSequence(db,base);
  const graph=getProject(db,"p");
  return planAssistantExternalJobStep(db,{...base,requestId:"plan-"+index,
   kind:"comfy_workflow",expectedPlanVersion:1,expectedProjectRevision:graph.revision,
   runSequenceId:sequence.sequenceId,runIndex:index,dependsOn:view.next?.dependsOn??[],
   job:job(index===0?"a":"b",opts.alter)});
 };
 const enqueue=(planned,grantId,requestId="enq-"+planned.stepId)=>
  enqueueAssistantExternalJobStep(db,{...base,stepId:planned.stepId,requestId,
   expectedPlanVersion:1,actionDigest:planned.actionDigest,...(grantId?{grantId}:{})});
 const first=plan(0);
 decideAssistantTaskStep(db,{...base,stepId:first.stepId,requestId:"approve-first",
  expectedPlanVersion:1,actionDigest:first.actionDigest,decision:"approve"});
 const queued=enqueue(first,null,"enq-first");
 const finishFirst=()=>{
  db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(queued.jobId);
  const sha="a".repeat(64);
  db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) "+
   "VALUES(?,?,128,'image/png','cas/first.png','ready')").run(sha,sha);
  db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) "+
   "VALUES('art-first',?,'image','0',?,'image','image/png',?,'{}')")
   .run(queued.jobId,sha,sha);
  reconcileAssistantExternalTask(db,base);
  const graph=getProject(db,"p").document;
  graph.nodes.push({id:"result-first",type:"image",title:"First",position:{x:0,y:320},
   width:360,height:280,metadata:{storageKey:"cas:"+sha}});
  db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'")
   .run(JSON.stringify(graph));
  db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) "+
   "VALUES('mat-first',?,'art-first','p','materialized','result-first')")
   .run(queued.jobId);
  reconcileAssistantExternalTask(db,base);
  assert.equal(getAssistantRunSequence(db,base).state,"ready");
  assert.equal(getAssistantRunSequence(db,base).next.index,1);
 };
 const grant=(more={})=>createAssistantRunBudgetGrant(db,{...base,requestId:"grant",
  sequenceId:sequence.sequenceId,expectedPlanVersion:1,allowedIndices:[1],
  maxJobs:1,confirmed:true,mode:"local_comfy",...more});
 return {db,base,sequence,first,queued,job,plan,enqueue,finishFirst,grant,task};
}
test("P4.5a same frozen local template admitted after prior verified materialization, no extra approval",t=>{
 const f=context(t);
 assert.equal(SCHEMA_VERSION,32);
 // Already-enqueued frozen Step remains idempotently inspectable; a forged
 // grant cannot create a second Job or authorize another workflow.
 assert.equal(f.enqueue(f.first,"forged").jobId,f.queued.jobId);
 f.finishFirst();
 const permission=f.grant();
 assert.equal(permission.mode,"local_comfy");
 assert.equal(permission.comfyScopeSummary.instanceId,"local-gpu");
 const step=f.plan(1),queued=f.enqueue(step,permission.grantId,"enq-second");
 assert.ok(queued.jobId);
 assert.equal(count(f.db,"jobs"),2);
 assert.equal(count(f.db,"assistant_task_attempts"),2);
 assert.equal(f.db.prepare("SELECT json_extract(approval_json,'$.grantId') id FROM assistant_task_steps WHERE id=?")
  .get(step.stepId).id,permission.grantId);
 assert.equal(getAssistantRunBudgetGrant(f.db,{...f.base,grantId:permission.grantId}).remainingJobs,0);
 assert.equal(f.enqueue(step,permission.grantId,"enq-second-again").jobId,queued.jobId);
 assert.equal(count(f.db,"jobs"),2);
 const actual=f.db.prepare("SELECT idempotency_key,snapshot_json FROM jobs WHERE id=?").get(queued.jobId);
 assert.equal(JSON.parse(actual.snapshot_json).comfyRequest.idempotencyKey,actual.idempotency_key);
 assert.equal(JSON.parse(actual.snapshot_json).comfyRequest.nodes[0].templateRevision,rev);
});
test("P4.5a no Comfy grant without an earlier separately approved template",t=>{
 const f=context(t);
 f.db.prepare("UPDATE assistant_task_steps SET approval_json='{}' WHERE id=?").run(f.first.stepId);
 assert.throws(()=>f.grant(),{code:"assistant_local_comfy_approval_required"});
 assert.equal(count(f.db,"jobs"),1);
});
test("P4.5a rejects modified instance, template, overrides and output capture",t=>{
 for(const [name,change] of [
  ["instance",s=>{s.instanceId="other";s.comfyRequest.instanceId="other"}],
  ["template",s=>{s.comfyTemplate={...s.comfyTemplate,name:"modified"}}],
  ["parameters",s=>{s.comfyRequest.nodes[0].inputOverrides.seed=100}],
  ["output",s=>{s.comfyRequest.rootOutputs[0].portId="other"}],
  ["external",s=>{s.comfyRequest.externalInputs=[{kind:"asset",valueKind:"IMAGE"}]}],
  ["edges",s=>{s.comfyRequest.edges=[{fromNodeId:"a",toNodeId:"b"}]}]
 ]){
  const f=context(t);f.finishFirst();const permission=f.grant();
  const step=f.plan(1,{alter:change});
  assert.throws(()=>f.enqueue(step,permission.grantId,"bad-"+name));
  assert.equal(count(f.db,"jobs"),1);
  assert.equal(getAssistantRunBudgetGrant(f.db,{...f.base,grantId:permission.grantId}).remainingJobs,1);
 }
});
test("P4.5a dynamic upstream media binding cannot be preauthorized as static local Comfy",t=>{
 const f=context(t);f.finishFirst();
 const graph=getProject(f.db,"p").document;
 graph.connections.push({id:"edge",fromNodeId:"result-first",fromPortId:"image",
  toNodeId:"b",toPortId:"image_in"});
 f.db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'")
  .run(JSON.stringify(graph));
 assert.throws(()=>f.grant(),{code:"assistant_local_comfy_scope_unsupported"});
 assert.equal(count(f.db,"jobs"),1);
});
test("P4.5a modifying already-materialized predecessor CAS rejects next Comfy enqueue atomically",t=>{
 const f=context(t);f.finishFirst();
 const permission=f.grant(),step=f.plan(1);
 f.db.prepare("UPDATE blobs SET status='missing' WHERE id=?").run("a".repeat(64));
 assert.throws(()=>f.enqueue(step,permission.grantId),{code:"assistant_run_budget_prior_evidence_missing"});
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(getAssistantRunBudgetGrant(f.db,{...f.base,grantId:permission.grantId}).remainingJobs,1);
});
test("P4.5a revocation and active-plan change halt subsequent local Comfy enqueue",t=>{
 const f=context(t);f.finishFirst();
 const permission=f.grant(),step=f.plan(1);
 revokeAssistantRunBudgetGrant(f.db,{...f.base,grantId:permission.grantId,requestId:"revoke"});
 assert.throws(()=>f.enqueue(step,permission.grantId),{code:"assistant_run_budget_not_active"});
 assert.equal(count(f.db,"jobs"),1);
});
test("P4.5a two SQLite handles cannot enqueue the same local Comfy job twice",async t=>{
 const f=context(t);f.finishFirst();const grant=f.grant(),step=f.plan(1);
 const dir=mkdtempSync(join(tmpdir(),"atelier-comfy-two-")),file=join(dir,"shared.db");
 await backup(f.db,file);const a=new DatabaseSync(file),b=new DatabaseSync(file);
 t.after(()=>{a.close();b.close();rmSync(dir,{recursive:true,force:true})});
 const args={...f.base,stepId:step.stepId,expectedPlanVersion:1,
  actionDigest:step.actionDigest,grantId:grant.grantId};
 const [one,two]=await Promise.all([
  Promise.resolve().then(()=>enqueueAssistantExternalJobStep(a,{...args,requestId:"one"})),
  Promise.resolve().then(()=>enqueueAssistantExternalJobStep(b,{...args,requestId:"two"}))
 ]);
 assert.equal(one.jobId,two.jobId);
 assert.equal(count(a,"jobs"),2);
 assert.equal(a.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='run_budget_consumed'").get().n,1);
});
test("P4.5a HTTP grant requires explicit consent; Comfy job still uses original freezing/enqueue",async t=>{
 const f=context(t);f.finishFirst();
 const app=buildApp({db:f.db,authorize:async()=>true});t.after(()=>app.close());
 const url="/api/v1/projects/p/assistant/tasks/"+f.task.id;
 const payload={requestId:"permit",sequenceId:f.sequence.sequenceId,
  expectedPlanVersion:1,maxJobs:1,allowedIndices:[1],mode:"local_comfy",confirmed:true};
 const refused=await app.inject({method:"POST",url:url+"/run-budget",
  payload:{...payload,confirmed:false}});
 assert.equal(refused.statusCode,400);
 const granted=await app.inject({method:"POST",url:url+"/run-budget",payload});
 assert.equal(granted.statusCode,200,granted.body);
 assert.equal(granted.json().mode,"local_comfy");
 const frozen=f.plan(1);
 const posted=await app.inject({method:"POST",
  url:url+"/steps/"+frozen.stepId+"/enqueue-authorized",
  payload:{requestId:"paid-once",expectedPlanVersion:1,actionDigest:frozen.actionDigest,
   grantId:granted.json().grantId}});
 assert.equal(posted.statusCode,200,posted.body);
 assert.equal(count(f.db,"jobs"),2);
});

test("P4.5a mock local Comfy coordinator submits exactly twice after each verified CAS materialization",async t=>{
 const f=context(t),dir=mkdtempSync(join(tmpdir(),"atelier-comfy-e2e-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const db=f.db,blobStore=createBlobStore({db,dataDir:dir});
 const events=createAssistantTaskContinuationEvents({db});
 let submissions=0;
 const pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/T/8AAAAASUVORK5CYII=","base64");
 const adapter={
  async prepare(){},
  async submit(){submissions++;return {kind:"accepted",remoteTaskId:"local-comfy-"+submissions}},
  async poll(){return {kind:"completed",receipt:{verified:true}}},
  async collect({job}){
   const blob=await blobStore.put([pixel],{mime:"image/png"});
   appendArtifact(db,{id:"image-"+job.id,jobId:job.id,portId:"image",itemKey:"0",
    blobId:blob.blobId,kind:"image",mime:"image/png",sha256:blob.sha256,
    metadata:{comfyArtifact:{index:0}}});
  }
 };
 const coordinator=createJobCoordinator({db,adapters:{comfy:{"local-gpu":adapter}},
  onTerminalCommitted:jobId=>{events.notifyJob(jobId);events.drain()}});
 coordinator.recoverAtStartup();
 const materializer=createCanvasMaterializer({db,blobStore,
  onSettled:result=>{events.notifyMaterialization(result.artifactId);events.drain()}});
 assert.equal(await coordinator.tick(),1);
 assert.equal(await coordinator.tick(),1);
 assert.equal(submissions,1);
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(f.queued.jobId).status,"succeeded");
 let outputs=await materializer.runOnce();
 assert.equal(outputs.length,1);
 assert.equal(outputs[0].status,"materialized");
 assert.equal(getAssistantRunSequence(db,f.base).state,"ready");
 assert.equal(getAssistantRunSequence(db,f.base).next.index,1);
 const grant=f.grant(),second=f.plan(1),next=f.enqueue(second,grant.grantId);
 assert.ok(next.jobId);
 assert.equal(await coordinator.tick(),1);
 assert.equal(await coordinator.tick(),1);
 assert.equal(submissions,2);
 outputs=await materializer.runOnce();
 assert.equal(outputs.length,1);
 assert.equal(outputs[0].status,"materialized");
 assert.equal(getAssistantRunSequence(db,f.base).state,"completed");
 assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,2);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,2);
 assert.equal(getAssistantRunBudgetGrant(db,{...f.base,grantId:grant.grantId}).remainingJobs,0);
 assert.equal(await coordinator.tick(),0);
 assert.equal(submissions,2,"No duplicate remote /prompt submission after sequence completion");
});

test("P4.5a cannot preauthorize a fabricated non-captured output port",t=>{
 const f=context(t);f.finishFirst();
 const anchor=structuredClone(template);
 anchor.ports[0].capture={kind:"none",adapterId:"none"};
 const document=getProject(f.db,"p").document;
 assert.throws(()=>frozenLocalComfyScope({
  adapterKind:"comfy",instanceId:"local-gpu",comfyTemplate:anchor,
  comfyRequest:{schemaVersion:2,projectId:"p",canvasRevision:"2",instanceId:"local-gpu",
   rootOutputs:[{nodeId:"a",portId:"image"}],nodes:[{id:"a",
    templateId:template.id,templateRevision:rev,inputOverrides:{seed:42}}],
   edges:[],externalInputs:[],runOptions:{},idempotencyKey:"provisional"}
 },{projectId:"p",targetNodeId:"a",document}),{
  code:"assistant_local_comfy_scope_unsupported"});
});
test("P4.5a pending or cancelled predecessor never permits a subsequent paid local Comfy Step",t=>{
 const f=context(t);
 const initial=f.grant();
 assert.equal(initial.active,true,"Grant is permission, not immediate execution");
 assert.equal(getAssistantRunSequence(f.db,f.base).state,"waiting_external");
 assert.throws(()=>f.plan(1),{code:"assistant_step_already_claimed"});
 assert.equal(count(f.db,"jobs"),1);
 cancelAssistantTask(f.db,{...f.base,requestId:"cancel"});
 assert.equal(getAssistantRunBudgetGrant(f.db,{...f.base,grantId:initial.grantId}).active,false);
 assert.equal(count(f.db,"jobs"),1);
});


test("P4.5a replacing a granted instance URL requires fresh consent before enqueue",t=>{
 const f=context(t);f.finishFirst();const grant=f.grant(),step=f.plan(1);
 f.db.prepare("UPDATE comfy_instances SET url=? WHERE id=?")
  .run("http://127.0.0.1:8189","local-gpu");
 assert.throws(()=>f.enqueue(step,grant.grantId),{code:"assistant_run_budget_not_active"});
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(getAssistantRunBudgetGrant(f.db,{...f.base,grantId:grant.grantId}).remainingJobs,1);
});


test("P4.5a incomplete frozen scope returns the unsupported contract",t=>{
 const f=context(t),document=getProject(f.db,"p").document;
 for(const field of ["runOptions","inputOverrides"]){
  const snapshot=f.job("a").snapshot;
  if(field==="runOptions")delete snapshot.comfyRequest.runOptions;
  else delete snapshot.comfyRequest.nodes[0].inputOverrides;
  assert.throws(()=>frozenLocalComfyScope(snapshot,{projectId:"p",targetNodeId:"a",document}),
   {code:"assistant_local_comfy_scope_unsupported",statusCode:400});
 }
});


test("P4.5a HTTP preserves actionable local scope rejection codes",async t=>{
 for(const missingApproval of [true,false]){
  const f=context(t);f.finishFirst();
  if(missingApproval)f.db.prepare("UPDATE assistant_task_steps SET approval_json='{}' WHERE id=?").run(f.first.stepId);
  else {
   const action=JSON.parse(f.db.prepare("SELECT action_json FROM assistant_task_steps WHERE id=?").get(f.first.stepId).action_json);
   delete action.job.snapshot.comfyRequest.runOptions;
   f.db.prepare("UPDATE assistant_task_steps SET action_json=? WHERE id=?").run(JSON.stringify(action),f.first.stepId);
  }
  const app=buildApp({db:f.db,authorize:async()=>true});t.after(()=>app.close());
  const response=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/tasks/"+f.task.id+"/run-budget",
   payload:{requestId:"invalid-grant",sequenceId:f.sequence.sequenceId,expectedPlanVersion:1,
    maxJobs:1,allowedIndices:[1],mode:"local_comfy",confirmed:true}});
  assert.equal(response.statusCode,missingApproval?409:400);
  assert.equal(response.json().code,missingApproval?"assistant_local_comfy_approval_required":"assistant_local_comfy_scope_unsupported");
 }
});


test("P4.5a address changed since individual approval cannot anchor a grant",t=>{
 const f=context(t);f.finishFirst();
 f.db.prepare("UPDATE comfy_instances SET url=? WHERE id=?").run("http://127.0.0.1:8189","local-gpu");
 assert.throws(()=>f.grant(),{code:"assistant_local_comfy_scope_unsupported"});
 assert.equal(count(f.db,"jobs"),1);
});

test("P4.5a legacy grants lacking endpoint evidence are inactive",t=>{
 const f=context(t);f.finishFirst();const grant=f.grant();
 const row=f.db.prepare("SELECT seq,payload_json FROM assistant_task_events WHERE kind='run_budget_granted'").get();
 const payload=JSON.parse(row.payload_json);delete payload.comfyInstanceUrl;
 f.db.prepare("UPDATE assistant_task_events SET payload_json=? WHERE seq=?").run(JSON.stringify(payload),row.seq);
 assert.equal(getAssistantRunBudgetGrant(f.db,{...f.base,grantId:grant.grantId}).active,false);
});
