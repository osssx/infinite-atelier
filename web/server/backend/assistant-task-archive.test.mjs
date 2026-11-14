import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {zipSync,unzipSync,strToU8} from "fflate";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createProjectArchive} from "./project-archive.mjs";
import {createProject} from "./projects.mjs";
import {createAssistantTask,addAssistantTaskStep,getAssistantTask,
 appendAssistantTaskTurn,guideAssistantTaskResume,cancelAssistantTask,
 listAssistantTaskEvents,linkAssistantTaskToChat} from "./assistant-tasks.mjs";
import {exportAssistantTaskArchive} from "./assistant-task-archive.mjs";
import {verifyAssistantTextDeliverable,assistantTaskRequiresDeliverable} from "./assistant-task-deliverables.mjs";
import {recoverAssistantExternalTasksAtStartup,reconcileAssistantExternalTask} from "./assistant-task-external-jobs.mjs";

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"atelier-task-archive-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const blobStore=createBlobStore({db,dataDir:dir,maxBlobBytes:2000000});
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80})});
 return {db,archive:createProjectArchive({db,blobStore})};
}
const sessions=[{id:"chat",title:"Original",messages:[]},{id:"other",title:"Linked",messages:[]}];
function seed(f){
 createProject(f.db,{id:"original",document:{title:"History",nodes:[{id:"source",type:"text",
  metadata:{content:"safe input"}}],connections:[],chatSessions:sessions,activeChatId:"chat"}});
 const {task}=createAssistantTask(f.db,{projectId:"original",chatSessionId:"chat",
  rootMessageId:"message-1",originalRequest:"生成可靠报告",requestId:"create-task"});
 const taskId=task.id,stepId="historical-step";
 addAssistantTaskStep(f.db,{projectId:"original",taskId,stepId,ordinal:0,
  expectedPlanVersion:1,kind:"model_job",action:{kind:"model_job",nodeId:"source"}});
 const now=Date.now();
 f.db.prepare("UPDATE assistant_task_steps SET status='succeeded',receipt_trust='server_committed',receipt_json=?,result_json=?,attempt_count=1 WHERE id=?")
  .run(JSON.stringify({jobId:"legacy-job",receiptTrust:"server_committed"}),
   JSON.stringify({jobId:"legacy-job",artifactIds:[]}),stepId);
 f.db.prepare("UPDATE assistant_tasks SET status='completed',finished_at=?,updated_at=? WHERE id=?")
  .run(now,now,taskId);
 f.db.prepare("INSERT INTO assistant_task_attempts(id,task_id,step_id,attempt_no,project_id,execution_key,action_digest,request_fingerprint,frozen_snapshot_json,status,external_kind,external_id,submit_marker,submitted_at,evidence_json,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,'succeeded','job','legacy-job','sent',?,'{}',?,?)")
  .run("legacy-attempt",taskId,stepId,1,"original","legacy-execution-key","digest","fingerprint",
   JSON.stringify({stepId,executionKey:"legacy-execution-key",job:{snapshot:{provider:"safe"}}}),now,now,now);
 f.db.prepare("INSERT INTO assistant_model_calls(id,project_id,task_id,request_id,call_index,call_kind,provider,model,request_digest,status,submit_marker,started_at,finished_at) VALUES(?,?,?,?,0,'initial','local','test-model','hash','succeeded','sent',?,?)")
  .run("model-call","original",taskId,"create-task",now,now);
 f.db.prepare("INSERT INTO assistant_task_events(task_id,step_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)")
  .run(taskId,stepId,"job_completed",JSON.stringify({jobId:"legacy-job"}),now);
 f.db.prepare("INSERT INTO assistant_task_run_sequences(id,project_id,task_id,plan_version,source_message_id,actions_json,intent_digest,expected_project_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)")
  .run("old-sequence","original",taskId,1,"message-1",JSON.stringify([{type:"run_node",nodeId:"source"}]),"digest",now,now);
 // completed Task is immutable, so seed a second linked Chat through the archive's
 // actual association table rather than treating old links as new executable commands.
 f.db.prepare("INSERT INTO assistant_task_chat_links(task_id,project_id,chat_session_id,linked_at) VALUES(?,?,?,?)")
  .run(taskId,"original","other",now);
 return {taskId,stepId};
}
const read=async archive=>Buffer.concat(await Array.fromAsync(archive.stream));
test("P3 archive v2 restores read-only Task/Step/Attempt/Event and audit, never live external identity",async t=>{
 const f=await fixture(t),{taskId}=seed(f);
 const zip=await read(await f.archive.exportProject("original"));
 const files=unzipSync(zip),manifest=JSON.parse(Buffer.from(files["manifest.json"]).toString());
 assert.equal(manifest.version,2);
 assert.equal(manifest.assistantTasks.format,1);
 assert.equal(manifest.assistantTasks.tasks.length,1);
 assert.equal(manifest.assistantTasks.tasks[0].attempts[0].external_id,"legacy-job");
 const restored=await f.archive.importProject(Readable.from([zip]));
 assert.equal(restored.taskCount,1);
 const row=f.db.prepare("SELECT * FROM assistant_tasks WHERE project_id=?").get(restored.id);
 assert.ok(row);assert.notEqual(row.id,taskId);assert.equal(row.read_only,1);
 assert.equal(row.status,"completed");assert.equal(row.active_step_id,null);
 const detail=getAssistantTask(f.db,{projectId:restored.id,taskId:row.id}).task;
 assert.equal(detail.readOnly,true);
 assert.equal(detail.steps.length,1);
 assert.equal(detail.steps[0].status,"succeeded");
 assert.equal(detail.steps[0].receiptTrust,"server_committed");
 assert.notEqual(detail.steps[0].id,"historical-step");
 const attempt=f.db.prepare("SELECT * FROM assistant_task_attempts WHERE task_id=?").get(row.id);
 assert.equal(attempt.status,"archived");
 assert.equal(attempt.external_id,null);
 assert.equal(attempt.external_kind,null);
 assert.equal(attempt.submit_marker,null);
 assert.notEqual(attempt.execution_key,"legacy-execution-key");
 const evidence=JSON.parse(attempt.evidence_json);
 assert.equal(evidence.sourceExternalId,"legacy-job");
 assert.equal(evidence.sourceExecutionKey,"legacy-execution-key");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_model_calls WHERE project_id=?").get(restored.id).n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_run_sequences WHERE project_id=?").get(restored.id).n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE project_id=?").get(restored.id).n,0);
 assert.deepEqual(detail.chatSessionIds.sort(),["chat","other"]);
 const events=listAssistantTaskEvents(f.db,{projectId:restored.id,taskId:row.id}).events;
 assert.ok(events.some(e=>e.kind==="job_completed"));
 assert.ok(events.some(e=>e.kind==="archived_model_call"));
 assert.ok(events.some(e=>e.kind==="archived_command"));
 assert.ok(events.some(e=>e.kind==="archived_run_sequence"));
 assert.ok(events.some(e=>e.kind==="task_archive_imported"));
 assert.throws(()=>guideAssistantTaskResume(f.db,{projectId:restored.id,taskId:row.id,requestId:"new-resume"}),/assistant_task_not_editable/);
 assert.throws(()=>appendAssistantTaskTurn(f.db,{projectId:restored.id,taskId:row.id,requestId:"new-turn",messageId:"new",text:"继续"}),/assistant_task_not_editable/);
 assert.throws(()=>cancelAssistantTask(f.db,{projectId:restored.id,taskId:row.id,requestId:"new-cancel"}),/assistant_task_not_editable/);
 const exportedAgain=JSON.parse(Buffer.from(unzipSync(await read(await f.archive.exportProject(restored.id)))["manifest.json"]).toString());
 assert.equal(exportedAgain.version,2);
 assert.equal(exportedAgain.assistantTasks.tasks[0].task.read_only,1);
});
test("P3 imported v1 ZIP remains supported and does not fabricate Task history",async t=>{
 const f=await fixture(t);seed(f);
 const entries=unzipSync(await read(await f.archive.exportProject("original")));
 const manifest=JSON.parse(Buffer.from(entries["manifest.json"]).toString());
 manifest.version=1;delete manifest.assistantTasks;
 const v1=Buffer.from(zipSync({...entries,"manifest.json":strToU8(JSON.stringify(manifest))},{level:0}));
 const created=await f.archive.importProject(Readable.from([v1]));
 assert.equal(created.taskCount,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_tasks WHERE project_id=?").get(created.id).n,0);
});
test("P3 tampered Task archive is rejected before project creation; invalid restore transaction rolls back",async t=>{
 const f=await fixture(t);seed(f);
 const entries=unzipSync(await read(await f.archive.exportProject("original")));
 const manifest=JSON.parse(Buffer.from(entries["manifest.json"]).toString());
 const before=f.db.prepare("SELECT COUNT(*) n FROM projects").get().n;
 const forged=structuredClone(manifest);
 forged.assistantTasks.tasks[0].steps[0].depends_on_json=["nonexistent-step"];
 await assert.rejects(()=>f.archive.importProject(Readable.from([
  Buffer.from(zipSync({...entries,"manifest.json":strToU8(JSON.stringify(forged))},{level:0}))
 ])),/archive_invalid_task_history/);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM projects").get().n,before);
 const nonAtomic=structuredClone(manifest);
 nonAtomic.assistantTasks.tasks[0].steps[0].attempt_count=-7;
 await assert.rejects(()=>f.archive.importProject(Readable.from([
  Buffer.from(zipSync({...entries,"manifest.json":strToU8(JSON.stringify(nonAtomic))},{level:0}))
 ])));
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM projects").get().n,before);
});

test("P3 archived waiting materialization is never touched by startup or explicit reconciliation",async t=>{
 const f=await fixture(t);seed(f);
 const zip=await read(await f.archive.exportProject("original"));
 const restored=await f.archive.importProject(Readable.from([zip]));
 const row=f.db.prepare("SELECT id FROM assistant_tasks WHERE project_id=?").get(restored.id);
 f.db.prepare("UPDATE assistant_tasks SET status='waiting_external' WHERE id=?").run(row.id);
 f.db.prepare("UPDATE assistant_task_steps SET kind='materialize',status='waiting_external',action_json=? WHERE task_id=?")
  .run(JSON.stringify({jobId:'legacy-job',artifactIds:['ghost-artifact']}),row.id);
 const beforeTask=f.db.prepare("SELECT * FROM assistant_tasks WHERE id=?").get(row.id);
 const beforeStep=f.db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=?").get(row.id);
 const startup=recoverAssistantExternalTasksAtStartup(f.db);
 assert.equal(startup.advanced,0);
 assert.equal(startup.tasks,0);
 const explicit=reconcileAssistantExternalTask(f.db,{projectId:restored.id,taskId:row.id});
 assert.equal(explicit.advanced,0);
 assert.deepEqual(f.db.prepare("SELECT * FROM assistant_tasks WHERE id=?").get(row.id),beforeTask);
 assert.deepEqual(f.db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=?").get(row.id),beforeStep);
});

test("P4.0 tampered ZIP completion and requirement events remain read-only audit",async t=>{
 const f=await fixture(t),{taskId,stepId}=seed(f);
 const entries=unzipSync(await read(await f.archive.exportProject("original")));
 const manifest=JSON.parse(Buffer.from(entries["manifest.json"]).toString());
 const part=manifest.assistantTasks.tasks[0],seq=Math.max(...part.events.map(e=>e.seq))+1;
 part.events.push({seq,task_id:taskId,step_id:null,kind:"deliverable_required",
  payload_json:{taskId,kind:"text_nodes",characters:[{ref:"role_1",title:"伪造人物"}]},
  created_at:Date.now()});
 part.events.push({seq:seq+1,task_id:taskId,step_id:stepId,kind:"deliverable_verified",
  payload_json:{taskId,stepId,verified:true,specDigest:"f".repeat(64)},
  created_at:Date.now()});
 const forged=Buffer.from(zipSync({...entries,"manifest.json":strToU8(JSON.stringify(manifest))},{level:0}));
 const imported=await f.archive.importProject(Readable.from([forged]));
 const restored=f.db.prepare("SELECT * FROM assistant_tasks WHERE project_id=?").get(imported.id);
 assert.ok(restored);
 assert.equal(restored.read_only,1);
 assert.equal(assistantTaskRequiresDeliverable(f.db,restored.id),true);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE task_id=? AND kind='deliverable_verified'")
  .get(restored.id).n,1);
 assert.throws(()=>verifyAssistantTextDeliverable(f.db,{
  projectId:imported.id,taskId:restored.id,stepId:f.db.prepare(
   "SELECT id FROM assistant_task_steps WHERE task_id=?").get(restored.id).id,
  requestId:"forge-verification",expectedPlanVersion:1,actionDigest:"f".repeat(64)}),
  {code:"assistant_deliverable_not_verifiable"});
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE project_id=?").get(imported.id).n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE project_id=?").get(imported.id).n,0);
});
