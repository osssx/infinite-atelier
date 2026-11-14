/** P3c2: restart a REAL local backend twice against a disposable copy of the
 * successfully generated MiniMax Task. No ComfyUI, provider, coordinator or
 * background worker is enabled; the user's actual dataset is never opened for writes.
 *
 * node scripts/minimax-p3c2-server-restart-check.mjs --root <completed acceptance dir>
 */
import {DatabaseSync,backup} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {cpSync,existsSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync} from "node:fs";
import {join,relative,isAbsolute,sep} from "node:path";
import {tmpdir} from "node:os";
import {createLocalBackend} from "../server/backend/runtime.mjs";

const fail=code=>{throw Error("p3c2_backend_restart_"+code)};
const check=(ok,code)=>{if(!ok)fail(code)};
const args=process.argv.slice(2);
check(args.length===2&&args[0]==="--root","acceptance_root_required");
const root=realpathSync(args[1]),temp=realpathSync(tmpdir()),rel=relative(temp,root);
check(isAbsolute(root)&&rel.startsWith("infinite-atelier-minimax-p3c2-")&&
 !rel.includes(sep)&&!rel.includes("/")&&!rel.includes("\\")&&rel!=="..",
 "invalid_acceptance_root");
const dbFile=join(root,"db","atelier.sqlite"),reportFile=join(root,"minimax-p3c2-acceptance-result.json");
const report=JSON.parse(readFileSync(reportFile,"utf8"));
check(report.phase==="pass"&&report.taskId&&report.projectId,"live_acceptance_incomplete");
const sourceFacts=()=>{
 const db=new DatabaseSync(dbFile,{readOnly:true});
 try{return JSON.stringify({
  tasks:db.prepare("SELECT id,status,active_plan_version FROM assistant_tasks ORDER BY id").all(),
  jobs:db.prepare("SELECT id,status,upstream_task_id FROM jobs ORDER BY created_at").all(),
  attempts:db.prepare("SELECT id,status FROM assistant_task_attempts ORDER BY id").all(),
  chatLinks:db.prepare("SELECT task_id,chat_session_id FROM assistant_task_chat_links ORDER BY task_id,chat_session_id").all()
 })}finally{db.close()}
};
const before=sourceFacts(),clone=mkdtempSync(join(temp,"atelier-p3c2-live-backend-clone-"));
const chatSessionId="restart-chat-"+randomUUID().slice(0,8),cycles=[];
try{
 mkdirSync(join(clone,"db"),{recursive:true});
 const original=new DatabaseSync(dbFile,{readOnly:true});
 try{await backup(original,join(clone,"db","atelier.sqlite"))}finally{original.close()}
 for(const folder of ["workflows","blobs"]){
  const path=join(root,folder);
  if(existsSync(path))cpSync(path,join(clone,folder),{recursive:true,force:false});
 }
 const taskBase="/api/v1/projects/"+report.projectId+"/assistant/tasks";
 const taskPath=taskBase+"/"+report.taskId;
 for(let cycle=1;cycle<=2;cycle++){
  // The activation registry is also inside the disposable root, so even a
  // different production dataset lineage/owner cannot be modified.
  const runtime=createLocalBackend({dataDir:clone,activationRoot:join(clone,"activation"),
   autoDispatch:false,autoLocalSession:true});
  try{
   check(!runtime.worker&&!runtime.coordinator,"worker_or_provider_started");
   const address=await runtime.app.listen({host:"127.0.0.1",port:0});
   const auth=runtime.sessionAuth.issueLocalSession();
   const headers={cookie:"atelier_session="+auth.id,
    "x-atelier-csrf":auth.csrf,origin:address,"content-type":"application/json"};
   const http=async(method,url,payload)=>{
    const response=await fetch(address+url,{method,headers,
     ...(payload!==undefined?{body:JSON.stringify(payload)}:{}),
     signal:AbortSignal.timeout(12000)});
    const data=await response.json();
    check(response.ok,"http_"+response.status+"_"+(data.code??url));
    return data;
   };
   const db=runtime.db,initial={
    jobs:db.prepare("SELECT id,status,upstream_task_id FROM jobs ORDER BY created_at").all(),
    attempts:db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,
    artifacts:db.prepare("SELECT COUNT(*) n FROM artifacts").get().n,
    materializations:db.prepare("SELECT COUNT(*) n FROM materializations WHERE status='materialized'").get().n};
   check(initial.jobs.length===2&&initial.jobs.every(j=>j.status==="succeeded")&&
    initial.attempts===3&&initial.artifacts===2&&initial.materializations===2,
    "expected_two_real_jobs_and_materializations");
   const beforeTask=await http("GET",taskPath);
   check(beforeTask.task.status==="completed","task_did_not_survive_startup");
   if(cycle===1){
    const linked=await http("POST",taskPath+"/link-chat",{
     requestId:"restart-link-"+chatSessionId,chatSessionId});
    check(linked.task.chatSessionIds.includes(chatSessionId),"chat_link_not_confirmed");
   }
   const listed=await http("GET",taskBase+"?chatSessionId="+chatSessionId);
   check(listed.tasks?.some(x=>x.id===report.taskId),"cross_chat_task_not_visible");
   const seq=await http("GET",taskPath+"/run-sequences");
   check(seq.state==="completed"&&seq.outputs?.some(x=>x.kind==="video")&&
    seq.outputs?.some(x=>x.kind==="image"),"trusted_output_missing_after_restart");
   await http("POST",taskPath+"/reconcile",{});
   await http("POST",taskPath+"/reconcile",{});
   const taskAfter=await http("GET",taskPath),seqAfter=await http("GET",taskPath+"/run-sequences");
   const final={
    jobs:db.prepare("SELECT id,status,upstream_task_id FROM jobs ORDER BY created_at").all(),
    attempts:db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,
    artifacts:db.prepare("SELECT COUNT(*) n FROM artifacts").get().n,
    materializations:db.prepare("SELECT COUNT(*) n FROM materializations WHERE status='materialized'").get().n};
   check(JSON.stringify(final)===JSON.stringify(initial)&&
    taskAfter.task.status==="completed"&&seqAfter.state==="completed",
    "reconcile_did_not_preserve_completed_task");
   cycles.push({cycle,realHttpServer:true,taskStatus:taskAfter.task.status,
    runSequence:seqAfter.state,jobCount:final.jobs.length,
    attemptCount:final.attempts,artifacts:final.artifacts,
    materialized:final.materializations,
    crossChatVisible:true,noProviderConfigured:true,noNewJob:true});
  }finally{await runtime.close()}
 }
 check(sourceFacts()===before,"original_acceptance_dataset_mutated");
 console.log(JSON.stringify({event:"MINIMAX_P3C2_REAL_HTTP_BACKEND_RESTART_CLONE_PASS",
  sourceUnaffected:true,realBackendStarts:2,realBackendStops:2,
  liveProductionBackendRestarted:false,paidGenerationPosts:0,
  cycles},null,2));
}finally{rmSync(clone,{recursive:true,force:true,maxRetries:5,retryDelay:80})}
