import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync,backup} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createAssistantTask,cancelAssistantTask} from "./assistant-tasks.mjs";
import {registerAssistantRunSequence,getAssistantRunSequence} from "./assistant-task-run-sequences.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep,reconcileAssistantExternalTask} from "./assistant-task-external-jobs.mjs";
import {fingerprintSource} from "./repository.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantRunBudgetGrant,getAssistantRunBudgetGrant,revokeAssistantRunBudgetGrant} from "./assistant-task-run-budget.mjs";

const node=id=>({id,type:"text",title:id,position:{x:0,y:0},width:300,height:200,
 metadata:{content:"Prompt for "+id}});
const document={nodes:[node("first"),node("second"),node("third")],connections:[]};
const actions=[{type:"run_node",nodeId:"first",mode:"text"},
 {type:"run_node",nodeId:"second",mode:"text"}];
const count=(db,table)=>db.prepare("SELECT COUNT(*) n FROM "+table).get().n;
function fixture(t,{maxJobs=2,indices=[0,1],actions:runActions=actions}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",
  rootMessageId:"root",originalRequest:"预批准两项顺序生成",requestId:"create"}).task;
 const base={projectId:"p",taskId:task.id};
 const seq=registerAssistantRunSequence(db,{...base,requestId:"sequence",
  sourceMessageId:"root",expectedPlanVersion:1,expectedProjectRevision:1,actions:runActions});
 const grant=(extra={})=>createAssistantRunBudgetGrant(db,{...base,requestId:"grant",
  sequenceId:seq.sequenceId,expectedPlanVersion:1,maxJobs,
  allowedIndices:indices,expiresInMinutes:60,confirmed:true,...extra});
 const plan=(index,dependsOn=[],snapshotOverride={})=>planAssistantExternalJobStep(db,{...base,
  requestId:"plan-"+index,kind:"model_job",expectedPlanVersion:1,
  expectedProjectRevision:getProject(db,"p").revision,
  job:{targetNodeId:runActions[index].nodeId,
   sourceNodeFingerprint:fingerprintSource(getProject(db,"p").document,runActions[index].nodeId),
   executionMode:"poll",snapshot:{adapterKind:"model",provider:"openai",
    task:{kind:"text",model:"mock",prompt:runActions[index].nodeId},...snapshotOverride}},
  runSequenceId:seq.sequenceId,runIndex:index,dependsOn});
 const enqueue=(step,grantId,requestId="enqueue")=>enqueueAssistantExternalJobStep(db,{
  ...base,stepId:step.stepId,requestId,expectedPlanVersion:1,actionDigest:step.actionDigest,
  ...(grantId?{grantId}:{})});
 const complete=(job,index)=>{
  db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(job.jobId);
  const sha=(index+1).toString().repeat(64),blob="blob-"+index,artifact="art-"+index;
  db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,4,'text/plain',?,'ready')")
   .run(blob,sha,"test/"+blob);
  db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) VALUES(?,?,NULL,?,?,'text','text/plain',?,'{}')")
   .run(artifact,job.jobId,"out-"+index,blob,sha);
  reconcileAssistantExternalTask(db,base);
  const step=db.prepare("SELECT id FROM assistant_task_steps WHERE kind='materialize' AND json_extract(action_json,'$.jobId')=?").get(job.jobId);
  db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES(?,?,?,'p','materialized',?)")
   .run("mat-"+index,job.jobId,artifact,runActions[index].nodeId);
  reconcileAssistantExternalTask(db,base);
  return step.id;
 };
 // Individual approval of the first frozen Model Job supplies the immutable
 // provider/channel/model scope for the later bounded grant.
 const first=plan(0);
 decideAssistantTaskStep(db,{...base,stepId:first.stepId,requestId:"anchor-approve",
  expectedPlanVersion:1,actionDigest:first.actionDigest,decision:"approve"});
 return {db,base,seq,grant,plan,enqueue,complete,task};
}
test("P4.4c explicit user budget grant admits frozen run_node and atomically charges one Job",t=>{
 const f=fixture(t);
 assert.equal(SCHEMA_VERSION,32);
 const budget=f.grant(),step=f.plan(0);
 assert.equal(budget.remainingJobs,2);
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(step.stepId).status,"ready");
 const queued=f.enqueue(step,budget.grantId);
 assert.equal(queued.executionStarted,true);
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(count(f.db,"assistant_task_attempts"),1);
 const spent=getAssistantRunBudgetGrant(f.db,{...f.base,grantId:budget.grantId});
 assert.equal(spent.consumedJobs,1);
 assert.equal(spent.remainingJobs,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='run_budget_consumed'").get().n,1);
 assert.equal(JSON.parse(f.db.prepare("SELECT approval_json FROM assistant_task_steps WHERE id=?").get(step.stepId).approval_json).decision,"approved");
 assert.equal(f.enqueue(step,budget.grantId).jobId,queued.jobId);
 assert.equal(f.enqueue(step,budget.grantId,"fresh-replay").jobId,queued.jobId);
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='run_budget_consumed'").get().n,1);
});
test("P4.4c one-job limit refuses an additional paid Job, even with another request ID",t=>{
 const f=fixture(t,{maxJobs:1}),budget=f.grant(),first=f.plan(0);
 const queued=f.enqueue(first,budget.grantId);const mat=f.complete(queued,0);
 const second=f.plan(1,[mat]);
 assert.throws(()=>f.enqueue(second,budget.grantId,"second"),{code:"assistant_run_budget_not_active"});
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(getAssistantRunBudgetGrant(f.db,{...f.base,grantId:budget.grantId}).remainingJobs,0);
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(second.stepId).status,"waiting_approval");
});
test("P4.4c unauthorized scope and changed target node are blocked before Job creation",t=>{
 const f=fixture(t,{indices:[1],maxJobs:1}),grant=f.grant(),step=f.plan(0);
 assert.throws(()=>f.enqueue(step,grant.grantId),{code:"assistant_run_budget_scope_changed"});
 assert.equal(count(f.db,"jobs"),0);
 const other=fixture(t),budget=other.grant(),first=other.plan(0);
 const next=getProject(other.db,"p").document;next.nodes[0].metadata.content="tampered prompt";
 other.db.prepare("UPDATE projects SET document_json=? WHERE id='p'").run(JSON.stringify(next));
 assert.throws(()=>other.enqueue(first,budget.grantId),{code:"assistant_run_budget_scope_changed"});
 assert.equal(count(other.db,"jobs"),0);
});
test("P4.4c revocation, cancellation and plan revision invalidate grant, no automatic paid enqueue",t=>{
 const f=fixture(t),grant=f.grant(),step=f.plan(0);
 const revoked=revokeAssistantRunBudgetGrant(f.db,{...f.base,grantId:grant.grantId,requestId:"revoke"});
 assert.equal(revoked.active,false);
 assert.equal(revokeAssistantRunBudgetGrant(f.db,{...f.base,grantId:grant.grantId,requestId:"revoke"}).revoked,true);
 assert.throws(()=>f.enqueue(step,grant.grantId),{code:"assistant_run_budget_not_active"});
 assert.equal(count(f.db,"jobs"),0);
 const g=fixture(t),permit=g.grant(),pending=g.plan(0);
 cancelAssistantTask(g.db,{...g.base,requestId:"cancel"});
 assert.throws(()=>g.enqueue(pending,permit.grantId),{code:"assistant_task_not_editable"});
 assert.equal(count(g.db,"jobs"),0);
 const h=fixture(t),newGrant=h.grant(),waiting=h.plan(0);
 h.db.prepare("UPDATE assistant_tasks SET active_plan_version=2,status='planning',active_step_id=NULL").run();
 assert.throws(()=>h.enqueue(waiting,newGrant.grantId),{code:"assistant_step_plan_conflict"});
 assert.equal(count(h.db,"jobs"),0);
});
test("P4.4c fault between inserting Job and binding Step rolls back budget spend",t=>{
 const f=fixture(t),permit=f.grant(),step=f.plan(0);
 assert.throws(()=>enqueueAssistantExternalJobStep(f.db,{...f.base,stepId:step.stepId,
  requestId:"fault",expectedPlanVersion:1,actionDigest:step.actionDigest,
  grantId:permit.grantId,beforeLink:()=>{throw Error("crash_before_step_link")}}),/crash_before_step_link/);
 assert.equal(count(f.db,"jobs"),0);
 assert.equal(count(f.db,"assistant_task_attempts"),0);
 assert.equal(getAssistantRunBudgetGrant(f.db,{...f.base,grantId:permit.grantId}).remainingJobs,2);
 const job=f.enqueue(step,permit.grantId);
 assert.ok(job.jobId);
 assert.equal(count(f.db,"jobs"),1);
});
test("P4.4c rejects duplicate active grants, forged confirmation and dynamic bindings",t=>{
 const f=fixture(t);f.grant();
 assert.throws(()=>f.grant({requestId:"other"}),{code:"assistant_run_budget_already_active"});
 assert.throws(()=>f.grant({requestId:"unconfirmed",confirmed:false}),{code:"assistant_run_budget_invalid"});
 const outOfScope=fixture(t,{indices:[3],maxJobs:1});
 assert.throws(()=>outOfScope.grant(),{code:"assistant_run_budget_scope_invalid"});
});
test("P4.4c concurrent SQLite clients with same frozen grant cannot double-enqueue",async t=>{
 const f=fixture(t),permit=f.grant(),step=f.plan(0);
 const folder=mkdtempSync(join(tmpdir(),"atelier-budget-race-")),path=join(folder,"shared.db");
 await backup(f.db,path);
 const left=new DatabaseSync(path),right=new DatabaseSync(path);
 t.after(()=>{left.close();right.close();rmSync(folder,{recursive:true,force:true})});
 const args={...f.base,stepId:step.stepId,expectedPlanVersion:1,
  actionDigest:step.actionDigest,grantId:permit.grantId};
 const [one,two]=await Promise.all([
  Promise.resolve().then(()=>enqueueAssistantExternalJobStep(left,{...args,requestId:"client-1"})),
  Promise.resolve().then(()=>enqueueAssistantExternalJobStep(right,{...args,requestId:"client-2"}))
 ]);
 assert.equal(one.jobId,two.jobId);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM jobs").get().n,1);
 assert.equal(left.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='run_budget_consumed'").get().n,1);
});
test("P4.4c grant HTTP validates scope and revocation, never performs upstream generation",async t=>{
 const f=fixture(t);const app=buildApp({db:f.db,authorize:async()=>true});t.after(()=>app.close());
 const path="/api/v1/projects/p/assistant/tasks/"+f.base.taskId;
 const body={requestId:"via-http",sequenceId:f.seq.sequenceId,
  expectedPlanVersion:1,maxJobs:1,allowedIndices:[0],confirmed:true};
 const created=await app.inject({method:"POST",url:path+"/run-budget",payload:body});
 assert.equal(created.statusCode,200,created.body);
 const grant=created.json();assert.equal(grant.remainingJobs,1);
 const loaded=await app.inject({method:"GET",url:path+"/run-budget/"+grant.grantId});
 assert.equal(loaded.json().active,true);
 const frozen=f.plan(0);
 const job=await app.inject({method:"POST",url:path+"/steps/"+frozen.stepId+"/enqueue-authorized",
  payload:{requestId:"paid-one",expectedPlanVersion:1,actionDigest:frozen.actionDigest,grantId:grant.grantId}});
 assert.equal(job.statusCode,200,job.body);
 assert.equal(count(f.db,"jobs"),1);
 const revoked=await app.inject({method:"POST",url:path+"/run-budget/"+grant.grantId+"/revoke",
  payload:{requestId:"revoke-http"}});
 assert.equal(revoked.json().revoked,true);
 assert.equal(count(f.db,"jobs"),1);
});

test("P4.4c later Step needs no per-step approval when model/channel scope is identical",t=>{
 const f=fixture(t),permit=f.grant(),first=f.plan(0),queued=f.enqueue(first,permit.grantId);
 const material=f.complete(queued,0),next=f.plan(1,[material]);
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(next.stepId).status,"waiting_approval");
 const second=f.enqueue(next,permit.grantId,"enqueue-second");
 assert.ok(second.jobId);
 assert.notEqual(second.jobId,queued.jobId);
 const approval=JSON.parse(f.db.prepare("SELECT approval_json FROM assistant_task_steps WHERE id=?")
  .get(next.stepId).approval_json);
 assert.equal(approval.grantId,permit.grantId);
 assert.equal(approval.decision,"approved");
 assert.equal(getAssistantRunBudgetGrant(f.db,{...f.base,grantId:permit.grantId}).remainingJobs,0);
 assert.equal(count(f.db,"jobs"),2);
 assert.equal(count(f.db,"assistant_task_attempts"),2);
});
test("P4.4c model/channel changes invalidate earlier user-confirmed scope",t=>{
 const f=fixture(t),permit=f.grant(),first=f.plan(0),job=f.enqueue(first,permit.grantId);
 const material=f.complete(job,0),next=f.plan(1,[material],{
  task:{kind:"text",model:"more-expensive-model",prompt:"second"}});
 assert.throws(()=>f.enqueue(next,permit.grantId,"other-model"),{code:"assistant_run_budget_scope_changed"});
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(getAssistantRunBudgetGrant(f.db,{...f.base,grantId:permit.grantId}).remainingJobs,1);
});
test("P4.4c refuses grant without a prior individually approved frozen Model Job",t=>{
 const f=fixture(t);
 f.db.prepare("UPDATE assistant_task_steps SET approval_json='{}',status='waiting_approval' WHERE kind='model_job'").run();
 assert.throws(()=>f.grant(),{code:"assistant_run_budget_model_scope_missing"});
 assert.equal(count(f.db,"jobs"),0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='run_budget_granted'").get().n,0);
});

test("P4.4c expired grant and unrelated Task cannot authorize any future Job",t=>{
 const f=fixture(t),permit=f.grant(),first=f.plan(0);
 const task=createAssistantTask(f.db,{projectId:"p",chatSessionId:"another",
  rootMessageId:"another-root",originalRequest:"不共享授权",requestId:"other-task"}).task;
 assert.throws(()=>getAssistantRunBudgetGrant(f.db,{projectId:"p",taskId:task.id,
  grantId:permit.grantId}),{code:"assistant_run_budget_not_found"});
 const row=f.db.prepare("SELECT seq,payload_json FROM assistant_task_events WHERE task_id=? AND kind='run_budget_granted'").get(f.base.taskId);
 const record=JSON.parse(row.payload_json);
 record.expiresAt=Date.now()-1000;
 f.db.prepare("UPDATE assistant_task_events SET payload_json=? WHERE seq=?")
  .run(JSON.stringify(record),row.seq);
 assert.equal(getAssistantRunBudgetGrant(f.db,{...f.base,grantId:permit.grantId}).active,false);
 assert.throws(()=>f.enqueue(first,permit.grantId),{code:"assistant_run_budget_not_active"});
 assert.equal(count(f.db,"jobs"),0);
});
test("P4.4c HTTP request requires explicit confirmation and rejects unknown grant ID",async t=>{
 const f=fixture(t),app=buildApp({db:f.db,authorize:async()=>true});t.after(()=>app.close());
 const path="/api/v1/projects/p/assistant/tasks/"+f.base.taskId;
 const denied=await app.inject({method:"POST",url:path+"/run-budget",payload:{
  requestId:"without-consent",sequenceId:f.seq.sequenceId,
  expectedPlanVersion:1,maxJobs:1,allowedIndices:[0],confirmed:false}});
 assert.equal(denied.statusCode,400);
 const frozen=f.plan(0);
 const forged=await app.inject({method:"POST",url:path+"/steps/"+frozen.stepId+"/enqueue-authorized",
  payload:{requestId:"forged-permit",expectedPlanVersion:1,actionDigest:frozen.actionDigest,
   grantId:"nonexistent-grant"}});
 assert.equal(forged.statusCode,409);
 assert.equal(count(f.db,"jobs"),0);
 const none=await app.inject({method:"GET",url:path+"/run-budget"});
 assert.equal(none.statusCode,200);
 assert.equal(none.json().grant,null);
});

test("P4.4c lost predecessor CAS after Step freeze blocks grant before creating second Job",t=>{
 const f=fixture(t),grant=f.grant(),first=f.plan(0);
 const queued=f.enqueue(first,grant.grantId),material=f.complete(queued,0);
 const second=f.plan(1,[material]);
 f.db.prepare("UPDATE blobs SET status='missing' WHERE id='blob-0'").run();
 assert.throws(()=>f.enqueue(second,grant.grantId,"no-second"),{
  code:"assistant_run_budget_prior_evidence_missing"});
 assert.equal(count(f.db,"jobs"),1);
 assert.equal(count(f.db,"assistant_task_attempts"),1);
 assert.equal(getAssistantRunBudgetGrant(f.db,{...f.base,grantId:grant.grantId}).remainingJobs,1);
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps WHERE id=?").get(second.stepId).status,"waiting_approval");
});
