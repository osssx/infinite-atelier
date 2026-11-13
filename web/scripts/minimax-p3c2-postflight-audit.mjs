/** Read-only audit of the P3c2 Moss → MiniMax H3 acceptance dataset.
 * This script NEVER starts a backend, updates a Task, or submits to ComfyUI.
 *
 * Usage: node scripts/minimax-p3c2-postflight-audit.mjs --root H:\\Temp\\infinite-atelier-minimax-p3c2-...
 */
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {readFileSync,createReadStream,realpathSync,statSync} from "node:fs";
import {join,relative,isAbsolute,resolve,sep} from "node:path";
import {tmpdir} from "node:os";

const fail=(code)=>{throw Error("p3c2_audit_"+code)};
const check=(ok,code)=>{if(!ok)fail(code)};
const args=process.argv.slice(2);
check(args.length===2&&args[0]==="--root"&&typeof args[1]==="string","root_required");
const prefix="infinite-atelier-minimax-p3c2-";
const temp=realpathSync(tmpdir()),root=realpathSync(args[1]),rel=relative(temp,root);
check(isAbsolute(root)&&rel.startsWith(prefix)&&!rel.includes(sep)&&
 !rel.includes("/")&&!rel.includes("\\")&&rel!=="..","root_outside_acceptance_temp");
const dbFile=join(root,"db","atelier.sqlite"),reportFile=join(root,"minimax-p3c2-acceptance-result.json");
const report=JSON.parse(readFileSync(reportFile,"utf8"));
check(report.phase==="pass"&&report.summary?.jobs===2&&report.summary?.videoArtifacts>=1,
 "live_acceptance_not_completed");
const findRows=()=>{
 const db=new DatabaseSync(dbFile,{readOnly:true});
 try{
  const jobs=db.prepare("SELECT id,status,upstream_task_id FROM jobs ORDER BY created_at").all();
  const steps=db.prepare("SELECT kind,status,receipt_trust,attempt_count FROM assistant_task_steps ORDER BY ordinal").all();
  const task=db.prepare("SELECT id,status,active_plan_version FROM assistant_tasks LIMIT 1").get();
  const project=db.prepare("SELECT id,document_json FROM projects LIMIT 1").get();
  const events=db.prepare("SELECT kind,COUNT(*) AS n FROM assistant_task_events GROUP BY kind").all();
  const artifacts=db.prepare(`SELECT a.id,a.kind,a.sha256,a.blob_id,b.byte_size,b.mime,b.relative_path,
   m.status AS mat_status,m.node_id AS mat_node
   FROM artifacts a JOIN blobs b ON b.id=a.blob_id
   LEFT JOIN materializations m ON m.artifact_id=a.id AND m.project_id=?
   ORDER BY a.id`).all(project.id);
  const attempts=db.prepare("SELECT status,external_kind,external_id FROM assistant_task_attempts ORDER BY created_at").all();
  const commandRows=db.prepare("SELECT request_id,response_json FROM assistant_task_commands WHERE request_id IN ('accept-image-enqueue','accept-image-enqueue-replay','accept-video-enqueue','accept-video-enqueue-replay')").all();
  return {jobs,steps,task,projectId:project.id,
   document:JSON.parse(project.document_json),events,artifacts,attempts,
   commands:Object.fromEntries(commandRows.map(x=>[x.request_id,JSON.parse(x.response_json)]))};
 }finally{db.close()}
};
const before=findRows();
check(before.task?.status==="completed"&&before.task.active_plan_version===1,"task_not_completed");
check(before.projectId===report.projectId&&before.task.id===report.taskId,
 "task_report_identity_mismatch");
check(before.jobs.length===2&&before.jobs.every(x=>x.status==="succeeded"&&
 typeof x.upstream_task_id==="string"&&x.upstream_task_id.length>0),"jobs_not_succeeded");
check(before.jobs[0].id===report.results?.[0]?.jobId&&before.jobs[1].id===report.results?.[1]?.jobId,
 "job_report_identity_mismatch");
check(before.steps.filter(x=>x.status==="succeeded").length===5&&
 before.steps.every(x=>x.status==="succeeded"&&x.receipt_trust==="server_committed"),
 "step_receipts_not_trusted");
check(before.attempts.length===3&&
 before.attempts.filter(x=>x.external_kind==="job").length===2,"attempts_incorrect");
check(before.artifacts.length===2&&
 before.artifacts.some(x=>x.kind==="image")&&before.artifacts.some(x=>x.kind==="video"),
 "artifacts_missing");
check(before.events.some(x=>x.kind==="task_completed"&&x.n===1)&&
 before.events.some(x=>x.kind==="external_job_queued"&&x.n===2),
 "audit_events_missing");
const replayPairs=[["accept-image-enqueue","accept-image-enqueue-replay"],
 ["accept-video-enqueue","accept-video-enqueue-replay"]];
for(const [a,b] of replayPairs){
 check(before.commands[a]?.jobId&&before.commands[a]?.jobId===before.commands[b]?.jobId,
  "duplicate_enqueue_"+a);
}
const canvasNodes=new Set(before.document.nodes?.map(x=>x.id)??[]);
const edge=before.document.connections?.filter(x=>x.toNodeId==="minimax-i2v-workflow"&&
 x.toPortId==="first_frame")??[];
check(edge.length===1&&edge[0].fromNodeId==="moss-image-source","trusted_image_edge_missing");
const verified=[];
for(const row of before.artifacts){
 check(row.mat_status==="materialized"&&canvasNodes.has(row.mat_node),
  "materialization_missing_"+row.kind);
 check(row.sha256===row.blob_id&&/^[a-f0-9]{64}$/.test(row.sha256),
  "blob_identity_invalid");
 const path=resolve(root,...row.relative_path.replaceAll("\\","/").split("/"));
 check(relative(root,path).startsWith("blobs"+sep),"blob_path_outside_root");
 const stat=statSync(path);check(stat.isFile()&&stat.size===row.byte_size,
  "blob_file_size_invalid_"+row.kind);
 const sha=createHash("sha256"),header=Buffer.alloc(16);
 let read=0;
 for await(const chunk of createReadStream(path)){
  sha.update(chunk);
  const take=Math.min(chunk.length,header.length-read);
  if(take>0)chunk.copy(header,read,0,take);
  read+=take;
 }
 check(sha.digest("hex")===row.sha256,"blob_sha_invalid_"+row.kind);
 check(row.kind==="image"?
  header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
  header.toString("ascii",4,8)==="ftyp","blob_signature_invalid_"+row.kind);
 verified.push({artifactId:row.id,kind:row.kind,bytes:row.byte_size,sha256:row.sha256,
  nodeId:row.mat_node,mime:row.mime});
}
// Second independent SQLite connection demonstrates the task and receipts are
// still readable after the original worker has exited. This is not a backend
// restart or new-chat HTTP acceptance.
const after=findRows();
check(JSON.stringify(before.jobs)===JSON.stringify(after.jobs)&&
 JSON.stringify(before.steps)===JSON.stringify(after.steps)&&
 after.task.status==="completed","audit_second_read_changed");
console.log(JSON.stringify({event:"MINIMAX_P3C2_READ_ONLY_POSTFLIGHT_PASS",
 projectId:before.projectId,taskId:before.task.id,jobCount:before.jobs.length,
 noDuplicateEnqueue:true,serverCommittedSteps:before.steps.length,
 attemptCount:before.attempts.length,materialized:verified,
 twoIndependentSqliteReads:true,backendRestartVerified:false,crossChatVerified:false,
 noGenerationSubmittedByAudit:true},null,2));
