/** Offline recovery drill for a completed real P3c2 acceptance dataset.
 *
 * Copies the real SQLite database with SQLite's online backup API. All
 * changes happen ONLY on a temporary clone. Starts NO coordinator, worker,
 * ComfyUI adapter, or remote HTTP request. Exercises Task HTTP routes.
 *
 * Usage: node scripts/minimax-p3c2-offline-recovery-check.mjs --root H:\\Temp\\infinite-atelier-minimax-p3c2-...
 */
import {DatabaseSync,backup} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {realpathSync,mkdtempSync,mkdirSync,rmSync,readFileSync} from "node:fs";
import {join,relative,isAbsolute,sep} from "node:path";
import {tmpdir} from "node:os";
import {buildApp} from "../server/backend/app.mjs";
import {recoverAssistantExternalTasksAtStartup} from "../server/backend/assistant-task-external-jobs.mjs";
import {recoverAssistantCanvasTasksAtStartup} from "../server/backend/assistant-task-canvas-executor.mjs";
import {getAssistantTask,listAssistantTasks} from "../server/backend/assistant-tasks.mjs";

const fail=code=>{throw Error("p3c2_restore_"+code)};
const check=(ok,code)=>{if(!ok)fail(code)};
const args=process.argv.slice(2);
check(args.length===2&&args[0]==="--root","root_required");
const temp=realpathSync(tmpdir()),root=realpathSync(args[1]),rel=relative(temp,root);
check(isAbsolute(root)&&rel.startsWith("infinite-atelier-minimax-p3c2-")&&
 !rel.includes(sep)&&!rel.includes("/")&&!rel.includes("\\")&&rel!=="..",
 "invalid_acceptance_root");
const originalDb=join(root,"db","atelier.sqlite");
const report=JSON.parse(readFileSync(join(root,"minimax-p3c2-acceptance-result.json"),"utf8"));
check(report.phase==="pass"&&report.projectId&&report.taskId,"unfinished_original_task");
// Observe source task/Job identities before and after the copy-only drill.
const sourceFacts=()=>{
 const source=new DatabaseSync(originalDb,{readOnly:true});
 try{return JSON.stringify({
  tasks:source.prepare("SELECT id,status,active_plan_version FROM assistant_tasks ORDER BY id").all(),
  jobs:source.prepare("SELECT id,status,upstream_task_id FROM jobs ORDER BY created_at").all(),
  attempts:source.prepare("SELECT id,status FROM assistant_task_attempts ORDER BY id").all(),
  links:source.prepare("SELECT task_id,chat_session_id FROM assistant_task_chat_links ORDER BY task_id,chat_session_id").all()
 });}finally{source.close()}
};
const originalFacts=sourceFacts();
const copy=mkdtempSync(join(temp,"atelier-p3c2-recovery-clone-"));
const dbFolder=join(copy,"db");mkdirSync(dbFolder);
const file=join(dbFolder,"atelier.sqlite"),chatSessionId="audit-chat-"+randomUUID().slice(0,10);
const snapshots=[];
try{
 // A consistent source snapshot, including any WAL changes, without modifying
 // or exclusively locking the completed acceptance source.
 const original=new DatabaseSync(originalDb,{readOnly:true});
 try{await backup(original,file)}finally{original.close()}
 for(let cycle=1;cycle<=2;cycle++){
  const db=new DatabaseSync(file);
  let app;
  try{
   // Simulates exactly the Task startup recovery transforms, but explicitly
   // does not assemble live provider adapters or dispatch workers.
   recoverAssistantCanvasTasksAtStartup(db);
   recoverAssistantExternalTasksAtStartup(db);
   app=buildApp({db,authorize:()=>true});
   const base="/api/v1/projects/"+report.projectId+"/assistant/tasks";
   const taskPath=base+"/"+report.taskId;
   const jobs=()=>db.prepare("SELECT id,status,upstream_task_id FROM jobs ORDER BY created_at").all();
   const attempts=()=>db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n;
   const startJobs=jobs(),startAttempts=attempts();
   check(startJobs.length===2&&startJobs.every(j=>j.status==="succeeded"&&j.upstream_task_id),
    "original_jobs_missing");
   const http=async(method,url,body)=>{
    const res=await app.inject({method,url,...(body===undefined?{}:{payload:body})});
    let value;try{value=res.json()}catch{value={body:res.body.slice(0,160)}}
    check(res.statusCode<400,"http_"+method+"_"+res.statusCode+"_"+(value.code??"unexpected"));
    return value;
   };
   const before=await http("GET",taskPath);
   check(before.task.status==="completed","task_not_completed");
   if(cycle===1){
    const linked=await http("POST",taskPath+"/link-chat",{
     requestId:"audit-link-"+chatSessionId,chatSessionId});
    check(linked.task.chatSessionIds.includes(chatSessionId),"cross_chat_not_linked");
   }
   const visible=await http("GET",base+"?chatSessionId="+chatSessionId);
   check(visible.tasks.some(x=>x.id===report.taskId),"task_not_visible_in_second_chat");
   const seqBefore=await http("GET",taskPath+"/run-sequences");
   check(seqBefore.state==="completed"&&seqBefore.outputs.length>=2,
    "sequence_not_completed_before_reconcile");
   await http("POST",taskPath+"/reconcile",{});
   await http("POST",taskPath+"/reconcile",{});
   const after=await http("GET",taskPath),seqAfter=await http("GET",taskPath+"/run-sequences");
   check(after.task.status==="completed"&&seqAfter.state==="completed",
    "reconcile_changed_terminal_status");
   check(JSON.stringify(startJobs)===JSON.stringify(jobs())&&startAttempts===attempts(),
    "reconcile_enqueued_or_modified_jobs");
   const task=listAssistantTasks(db,{projectId:report.projectId,chatSessionId}).tasks;
   check(task.length===1&&task[0].id===report.taskId,"cross_chat_link_did_not_persist");
   check(getAssistantTask(db,{projectId:report.projectId,taskId:report.taskId}).task.status==="completed",
    "task_snapshot_not_persisted");
   snapshots.push({cycle,taskStatus:after.task.status,runSequence:seqAfter.state,
    visibleFromSecondChat:visible.tasks.length,jobCount:jobs().length,
    attemptCount:attempts(),outputKinds:seqAfter.outputs.map(x=>x.kind),
    noProviderAdapter:true,noDuplicateJob:true});
  }finally{await app?.close();db.close()}
 }
 check(sourceFacts()===originalFacts,"live_acceptance_source_changed");
 console.log(JSON.stringify({event:"MINIMAX_P3C2_OFFLINE_CLONE_RECOVERY_PASS",
  sourceUnmodified:true,chatSessionId,cycles:snapshots,
  clonedDatabaseReopened:true,liveBackendRestartVerified:false,
  realProviderSubmission:false,noNewPaidJobs:true},null,2));
}finally{rmSync(copy,{recursive:true,force:true,maxRetries:5,retryDelay:80})}
