/** P4.5c: resume observation of exactly one already-submitted MiniMax H3
 * I2V job from the isolated live acceptance root. Does NOT enqueue any Job,
 * call Comfy /prompt or invent a remote ID. It is safe after script timeout.
 *
 * ATELIER_MINIMAX_RECOVER_ROOT=<previous ACCEPTANCE_REPORT_PATH parent>
 * node scripts/minimax-p45c-recover.mjs
 */
import {DatabaseSync} from "node:sqlite";
import {join,resolve} from "node:path";
import {existsSync,openSync,readSync,closeSync,writeFileSync,createReadStream,copyFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {createLocalBackend} from "../server/backend/runtime.mjs";
import {loadBackendEnv} from "./load-backend-env.mjs";

loadBackendEnv();
const fail=(name)=>{throw Error("minimax_recovery_"+name)};
const expectedPrefix=join(tmpdir(),"infinite-atelier-minimax-p3c2-");
const root=process.env.ATELIER_MINIMAX_RECOVER_ROOT;
if(typeof root!=="string"||!resolve(root).startsWith(resolve(expectedPrefix))||
 !existsSync(join(root,"db","atelier.sqlite")))fail("root_not_isolated");
const records=()=>{
 const db=new DatabaseSync(join(root,"db","atelier.sqlite"),{readOnly:true});
 try{
  const jobs=db.prepare("SELECT id,status,upstream_task_id,snapshot_json FROM jobs ORDER BY created_at,id").all();
  const tasks=db.prepare("SELECT id,project_id FROM assistant_tasks").all();
  if(jobs.length!==2||tasks.length!==1)fail("unexpected_job_or_task_count");
  const first=jobs.find(job=>JSON.parse(job.snapshot_json)?.comfyTargetBinding?.mode==="image");
  const second=jobs.find(job=>JSON.parse(job.snapshot_json)?.comfyRequest?.rootOutputs?.some(p=>p.portId==="video"));
  if(!first||!second||first.id===second.id||first.status!=="succeeded"||
   !second.upstream_task_id||!["running","collecting","succeeded","submission_unknown",
     "failed","cancelled"].includes(second.status))fail("untrusted_resume_state");
  if(JSON.parse(first.snapshot_json).comfyRequest.projectId!==tasks[0].project_id||
   JSON.parse(second.snapshot_json).comfyRequest.projectId!==tasks[0].project_id)
   fail("cross_project_job");
  const submitted=db.prepare("SELECT COUNT(*) n FROM job_attempts WHERE job_id=? AND upstream_task_id=?")
   .get(second.id,second.upstream_task_id).n;
  if(submitted<1)fail("missing_original_submission");
  const last=JSON.parse(second.snapshot_json);
  if(last.comfyTemplate?.apiGraph?.["105_11"]?.inputs?.vae_name!==
   "minimax_h3_video_vae_int8_convrot.safetensors"||
   !last.comfyTemplate.requirements?.modelAssets?.includes(
    "minimax_h3_video_vae_int8_convrot.safetensors"))
    fail("h3_video_vae_not_the_user_selected_version");
  const submissions=db.prepare("SELECT COUNT(*) n FROM job_events WHERE job_id=? AND kind='job_submit_barrier'")
   .get(second.id).n;
  if(submissions!==1)fail("original_submit_marker_not_unique");
  const firstArtifacts=db.prepare("SELECT sha256,blob_id FROM artifacts WHERE job_id=? AND kind='image'").all(first.id);
  if(firstArtifacts.length!==1||!last.comfyRequest.externalInputs?.some(input=>
    input.sha256===firstArtifacts[0].sha256&&input.sourcePortId==="image"&&
    input.valueKind==="IMAGE"))fail("video_input_not_trusted");
  return {first:first.id,second:second.id,task:tasks[0].id,
   project:tasks[0].project_id,instanceId:last.instanceId,
   remoteTaskId:second.upstream_task_id,status:second.status,
   firstBlobId:firstArtifacts[0].blob_id,firstBlobSha:firstArtifacts[0].sha256};
 }finally{db.close()}
};
const originals=records();
const origin=process.env.ATELIER_COMFY_URL??"http://127.0.0.1:8188";
let runtime=null;
const now=()=>new Date().toISOString();
const emit=(event,properties={})=>console.log(JSON.stringify({at:now(),event,...properties}));
const result={startedAt:now(),root,jobId:originals.second,remoteTaskId:originals.remoteTaskId,
 noNewJobAllowed:true,video:null};
const readRow=()=>{
 const job=runtime.db.prepare("SELECT status,upstream_task_id FROM jobs WHERE id=?").get(originals.second);
 if(job?.upstream_task_id!==originals.remoteTaskId)fail("remote_identity_changed");
 return job;
};
try{
 runtime=createLocalBackend({dataDir:root,comfyInstances:[{id:originals.instanceId,url:origin}],
  enableComfyManagement:true,autoDispatch:true,autoLocalSession:true,dispatchIntervalMs:250});
 const firstBlob=await runtime.blobStore.stat(originals.firstBlobId);
 if(firstBlob.sha256!==originals.firstBlobSha||firstBlob.mimeType!=="image/png")
  fail("source_image_cas_invalid");
 emit("MINIMAX_P45C_RESTORED",{jobId:originals.second,remoteId:originals.remoteTaskId,
  pinnedVae:"minimax_h3_video_vae_int8_convrot.safetensors"});
 const deadline=Date.now()+30*60*1000;
 let previous=null;
 while(Date.now()<deadline){
  const row=readRow();
  if(row.status!==previous){
   previous=row.status;
   emit("MINIMAX_P45C_JOB_STATUS",{jobId:originals.second,status:row.status});
  }
  if(["failed","cancelled","submission_unknown","blocked","blocked_credential"].includes(row.status)){
   result.status=row.status;
   result.reason="never_retry_original_remote_submission";
   break;
  }
  if(row.status==="succeeded"){
   const artifacts=runtime.db.prepare("SELECT a.id,a.sha256,a.kind,a.blob_id,a.mime,m.status materialStatus "+
    "FROM artifacts a LEFT JOIN materializations m ON m.artifact_id=a.id AND m.project_id=? WHERE a.job_id=?")
    .all(originals.project,originals.second);
   const videos=artifacts.filter(item=>item.kind==="video"&&item.materialStatus==="materialized");
   if(videos.length>=1&&videos.length===artifacts.filter(item=>item.kind==="video").length){
    result.video=[];
    for(const item of videos){
     const blob=await runtime.blobStore.stat(item.blob_id);
     const fd=openSync(blob.path,"r"),head=Buffer.alloc(32);
     try{readSync(fd,head,0,32,0)}finally{closeSync(fd)}
     const mp4=head.subarray(4,8).toString("ascii")==="ftyp";
     const ebml=head[0]===0x1a&&head[1]===0x45&&head[2]===0xdf&&head[3]===0xa3;
     if(blob.sha256!==item.sha256||blob.byteSize<=4096||(!mp4&&!ebml))
      fail("video_integrity_invalid");
     const checksum=createHash("sha256");
     for await(const chunk of createReadStream(blob.path))checksum.update(chunk);
     if(checksum.digest("hex")!==item.sha256)fail("video_on_disk_sha_mismatch");
     const safeName="minimax-p45c-verified-"+item.sha256.slice(0,12)+(mp4?".mp4":".mkv");
     const verifiedPath=join(root,safeName);
     copyFileSync(blob.path,verifiedPath);
     const meta={artifactId:item.id,sha256:item.sha256,bytes:blob.byteSize,
      mime:blob.mimeType,verifiedCopy:verifiedPath};
     const ffprobe=spawnSync("ffprobe",["-v","error","-select_streams","v:0",
      "-show_entries","stream=codec_name,width,height,duration,nb_frames",
      "-of","json",blob.path],{timeout:18000,encoding:"utf8"});
     if(ffprobe.status===0)try{meta.stream=JSON.parse(ffprobe.stdout).streams?.[0]}catch{}
     result.video.push(meta);
    }
    const task=runtime.db.prepare("SELECT status FROM assistant_tasks WHERE id=?").get(originals.task);
    const verified=runtime.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps "+
     "WHERE task_id=? AND kind='materialize' AND status='succeeded' "+
     "AND receipt_trust='server_committed'").get(originals.task).n;
    if(task?.status!=="completed"||verified<2)fail("task_or_materialization_unverified");
    result.taskStatus=task.status;
    result.materializations=verified;
    result.status="completed";break;
   }
  }
  await new Promise(done=>setTimeout(done,2500));
 }
 result.status??="timeout_pending_manual_observation";
 if(runtime.db.prepare("SELECT COUNT(*) n FROM jobs").get().n!==2)
  fail("unexpected_duplicate_job");
 result.endAt=now();
 emit("MINIMAX_P45C_RECOVERY_RESULT",result);
}finally{
 try{if(runtime)await runtime.close()}finally{
  writeFileSync(join(root,"minimax-p45c-recovery-result.json"),JSON.stringify(result,null,2),"utf8");
 }
}
if(result.status!=="completed")process.exitCode=2;
