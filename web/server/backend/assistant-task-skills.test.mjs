import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {zipSync,strToU8} from "fflate";
import {initializeSchema} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {createAssistantTask,cancelAssistantTask,getAssistantTask} from "./assistant-tasks.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {planAssistantSkillStep,reserveAssistantSkillRun,settleAssistantSkillRun,
 executeAssistantSkillStep,recoverAssistantSkillTasksAtStartup} from "./assistant-task-skills.mjs";
import {rebuildBlobReferenceLedger,persistedBlobReferences} from "./blob-reference-ledger.mjs";
const version="abcdef123456",skillId="fixture-skill",scriptPath="scripts/render.js",
 source='console.log("hello");';
const archive=Buffer.from(zipSync({"SKILL.md":strToU8("---\nname: Fixture Skill\ndescription: demo\n---\n"),[scriptPath]:strToU8(source)})).toString("base64");
function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 createProject(db,{id:"p",document:{nodes:[],connections:[]}});
 const task=createAssistantTask(db,{projectId:"p",requestId:"create",
  chatSessionId:"chat",rootMessageId:"root",originalRequest:"运行 Skill"}).task;
 let allowed=true;
 const registry={
  list:()=>({skills:[{id:skillId,enabled:allowed,versions:[version]}]}),
  get:()=>({package:{manifest:{hash:version+"0".repeat(52)},sourceArchiveBase64:archive}}),
  revoke:()=>{allowed=false}
 };
 t.after(()=>db.close());
 return {db,registry,projectId:"p",taskId:task.id};
}
function plan(f,options={}){
 return planAssistantSkillStep(f.db,{projectId:f.projectId,taskId:f.taskId,
  requestId:"plan",expectedPlanVersion:1,expectedProjectRevision:1,
  proposal:{skill_id:skillId,version,script_path:scriptPath,args:["a"],input_files:{"draft.txt":"text"},output_files:[]},
  skillRegistry:f.registry,...options});
}
function approve(f,step,decision="approve"){
 return decideAssistantTaskStep(f.db,{projectId:"p",taskId:f.taskId,
  stepId:step.stepId,requestId:"approve-"+step.stepId,
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision});
}
const request=(f,step,extra={})=>({db:f.db,skillRegistry:f.registry,projectId:"p",taskId:f.taskId,
 stepId:step.stepId,requestId:"execute-"+step.stepId,
 expectedPlanVersion:1,actionDigest:step.actionDigest,...extra});
function counts(db){
 return Object.fromEntries(["assistant_task_attempts","skill_script_runs"].map(table=>
  [table,db.prepare("SELECT COUNT(*) AS n FROM "+table).get().n]));
}
test("P2b approved Skill reserves one Run ID and freezes its execution key BEFORE spawn",async t=>{
 const f=setup(t),step=plan(f);assert.equal(plan(f).stepId,step.stepId);
 assert.throws(()=>reserveAssistantSkillRun(f.db,request(f,step)),{code:"assistant_step_already_claimed"});
 approve(f,step);
 let called=0,observed;
 const result=await executeAssistantSkillStep({...request(f,step),runner:async args=>{
  called++;observed=f.db.prepare("SELECT a.*,r.status AS run_status FROM assistant_task_attempts a JOIN skill_script_runs r ON r.id=a.external_id").get();
  assert.equal(observed.run_status,"started");
  assert.equal(observed.submit_marker,"skill_spawn_possible");
  assert.equal(args.scriptPath,scriptPath);
  return {status:"completed",exit_code:0,stdout:"ok",artifacts:[],log_blobs:{}};
 }});
 assert.equal(result.status,"completed");assert.equal(result.run_id,observed.external_id);
 assert.equal(called,1);
 assert.deepEqual(counts(f.db),{assistant_task_attempts:1,skill_script_runs:1});
 assert.equal(f.db.prepare("SELECT status,receipt_trust FROM assistant_task_steps").get().receipt_trust,"server_committed");
 const replay=await executeAssistantSkillStep({...request(f,step),runner:async()=>{called++;throw Error("repeat");}});
 assert.equal(replay.runId,result.run_id);assert.equal(replay.shouldLaunch,false);assert.equal(called,1);
 assert.equal(getAssistantTask(f.db,{projectId:"p",taskId:f.taskId}).task.status,"ready");
});
test("P2b interruption after reserve never spawns second process and startup marks unknown",async t=>{
 const f=setup(t),step=plan(f);approve(f,step);
 await assert.rejects(executeAssistantSkillStep({...request(f,step),runner:async()=>{
  assert.fail("child must not start before simulated crash");
 },afterReserve:()=>{throw Error("crash_before_spawn")}}),/crash_before_spawn/);
 assert.deepEqual(counts(f.db),{assistant_task_attempts:1,skill_script_runs:1});
 const recovered=recoverAssistantSkillTasksAtStartup(f.db);
 assert.equal(recovered.unknown,1);
 assert.equal(recoverAssistantSkillTasksAtStartup(f.db).unknown,0);
 assert.equal(f.db.prepare("SELECT status FROM skill_script_runs").get().status,"needs_reconcile");
 assert.equal(getAssistantTask(f.db,{projectId:"p",taskId:f.taskId}).task.status,"needs_reconcile");
 const replay=await executeAssistantSkillStep({...request(f,step),runner:()=>{throw Error("should_not_repeat")}});
 assert.equal(replay.status,"needs_reconcile");
 assert.equal(replay.shouldLaunch,false);
 assert.deepEqual(counts(f.db),{assistant_task_attempts:1,skill_script_runs:1});
});
test("P2b failed/nonzero/9009 Skill never claims success or reruns automatically",async t=>{
 const f=setup(t),step=plan(f);approve(f,step);
 const response=await executeAssistantSkillStep({...request(f,step),runner:async()=>
  ({status:"failed",exit_code:9009,stderr:"",artifacts:[]})});
 assert.equal(response.exit_code,9009);
 assert.equal(f.db.prepare("SELECT status,receipt_trust FROM assistant_task_steps").get().status,"failed");
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks").get().status,"failed");
 assert.equal(f.db.prepare("SELECT status FROM skill_script_runs").get().status,"failed");
 assert.equal((await executeAssistantSkillStep({...request(f,step),runner:async()=>{throw Error("retry")}})).shouldLaunch,false);
});
test("P2b cancelling while Skill child is running preserves late outcome and disables continuation",async t=>{
 const f=setup(t),step=plan(f);approve(f,step);
 let release;
 const hold=new Promise(resolve=>{release=resolve});
 const pending=executeAssistantSkillStep({...request(f,step),runner:async()=>hold});
 await Promise.resolve();
 const cancelled=cancelAssistantTask(f.db,{projectId:"p",taskId:f.taskId,requestId:"cancel"});
 assert.equal(cancelled.task.status,"cancelling");
 release({status:"completed",exit_code:0,artifacts:[],log_blobs:{}});
 await pending;
 assert.equal(f.db.prepare("SELECT status FROM skill_script_runs").get().status,"completed");
 assert.equal(f.db.prepare("SELECT status FROM assistant_tasks").get().status,"cancelled");
 assert.equal(f.db.prepare("SELECT status,receipt_trust FROM assistant_task_steps").get().receipt_trust,"server_committed");
});
test("P2b version permission is revalidated at script launch; no Run if disabled",async t=>{
 const f=setup(t),step=plan(f);approve(f,step);
 f.registry.revoke();
 await assert.rejects(executeAssistantSkillStep(request(f,step)),{code:"skill_authorization_changed"});
 assert.deepEqual(counts(f.db),{assistant_task_attempts:0,skill_script_runs:0});
 assert.equal(f.db.prepare("SELECT status,error_code FROM assistant_task_steps").get().status,"blocked");
 assert.equal(getAssistantTask(f.db,{projectId:"p",taskId:f.taskId}).task.status,"blocked");
});
test("P2b frozen plan replay stays readable even if pinned Skill later disappears",t=>{
 const f=setup(t),step=plan(f);
 f.registry.revoke();
 assert.equal(plan(f).stepId,step.stepId);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,1);
});
test("P2b fault inside reserve atomically rolls back Run and Task Attempt",t=>{
 const f=setup(t),step=plan(f);approve(f,step);
 assert.throws(()=>reserveAssistantSkillRun(f.db,{...request(f,step),
  beforeCommit:()=>{throw Error("fault_in_commit")}}),/fault_in_commit/);
 assert.deepEqual(counts(f.db),{assistant_task_attempts:0,skill_script_runs:0});
 assert.equal(f.db.prepare("SELECT status FROM assistant_task_steps").get().status,"ready");
});
test("P2b a script reporting completion without required CAS output cannot claim trusted success",t=>{
 const f=setup(t),step=plan(f,{proposal:{
  skill_id:skillId,version,script_path:scriptPath,args:[],input_files:{},output_files:["result.txt"]
 }});
 approve(f,step);
 const reservation=reserveAssistantSkillRun(f.db,request(f,step));
 const receipt=settleAssistantSkillRun(f.db,{projectId:"p",taskId:f.taskId,
  stepId:step.stepId,runId:reservation.runId,
  result:{status:"completed",exit_code:0,artifacts:[],log_blobs:{}}});
 assert.equal(receipt.success,false);
 assert.equal(f.db.prepare("SELECT status,receipt_trust,error_code FROM assistant_task_steps").get().receipt_trust,"none");
 assert.equal(f.db.prepare("SELECT status FROM skill_script_runs").get().status,"failed");
});
test("P2b Task Skill outputs remain referenced after rebuild; old run ID is immutable",t=>{
 const f=setup(t),step=plan(f);approve(f,step);
 const reserved=reserveAssistantSkillRun(f.db,request(f,step));
 const blobId="a".repeat(64);
 f.db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?, ?, 16,'text/plain','blobs/sample','ready')").run(blobId,blobId);
 const result=settleAssistantSkillRun(f.db,{projectId:"p",taskId:f.taskId,
  stepId:step.stepId,runId:reserved.runId,result:{status:"completed",
   exit_code:0,artifacts:[{blob_id:blobId,path:"draft.txt"}],log_blobs:{}}});
 assert.equal(result.receipt.blobIds[0],blobId);
 rebuildBlobReferenceLedger(f.db,{force:true});
 assert.ok(persistedBlobReferences(f.db).has(blobId));
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM skill_script_runs").get().n,1);
});
