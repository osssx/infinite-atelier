import {Readable} from "node:stream";
import {appendArtifact} from "./repository.mjs";

const ARK_BASE="https://ark.cn-beijing.volces.com/api/v3";
const resultHost=/^(?:[a-z0-9-]+\.)*tos-cn-beijing\.volces\.com$/i;
const fail=(code,confirmedNotAccepted=false)=>
 Object.assign(Error(code),{code,confirmedNotAccepted});
const validId=id=>typeof id==="string"&&/^[a-zA-Z0-9_-]{1,160}$/.test(id);
const safeModel=model=>typeof model==="string"&&
 /^([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/.test(model);

export function validateArkVideoSnapshot(snapshot){
 if(snapshot?.adapterKind!=="model"||snapshot.provider!=="volcengine_ark"||
  !validId(snapshot.channelId)||!validId(snapshot.secretVersionRef))
  throw fail("ark_video_snapshot_invalid",true);
 const task=snapshot.task;
 if(!task||task.kind!=="video"||!safeModel(task.model)||
  typeof task.prompt!=="string"||!task.prompt.trim()||
  Buffer.byteLength(task.prompt,"utf8")>16000||
  Object.keys(task).some(key=>!["kind","model","prompt","duration","ratio","resolution","generateAudio","watermark"].includes(key))||
  !Number.isInteger(task.duration)||task.duration<4||task.duration>15||
  !["adaptive","16:9","9:16","1:1","4:3","3:4","21:9"].includes(task.ratio)||
  !["480p","720p","1080p"].includes(task.resolution)||
  typeof task.generateAudio!=="boolean"||typeof task.watermark!=="boolean")
  throw fail("ark_video_task_invalid",true);
 return task;
}
export function verifyArkVideoUrl(raw){
 let parsed;
 try{parsed=new URL(raw)}catch{throw fail("ark_video_url_invalid")}
 if(parsed.protocol!=="https:"||parsed.port||parsed.username||parsed.password||
  parsed.hash||!resultHost.test(parsed.hostname))
  throw fail("ark_video_url_untrusted");
 return parsed.href;
}
async function responseJson(response){
 if(!response.ok)throw fail("ark_video_http_"+response.status);
 if(!response.body)throw fail("ark_video_empty_response");
 const parts=[];let size=0;
 for await(const data of response.body){
  const chunk=Buffer.from(data);size+=chunk.length;
  if(size>512_000)throw fail("ark_video_response_too_large");
  parts.push(chunk);
 }
 try{return JSON.parse(Buffer.concat(parts).toString("utf8"))}
 catch{throw fail("ark_video_invalid_json")}
}
/** Seedance async adapter: POST once, persist task id before any poll, download
 * signed Ark-owned TOS media into CAS on successful completion. A download
 * failure retries only GET, never another billable generation POST.
 */
export function createArkVideoAdapter({db,vault,blobStore,upstreamCall=fetch}={}){
 if(!db||!vault||!blobStore||typeof upstreamCall!=="function")
  throw Error("ark_video_adapter_dependencies_required");
 const validate=job=>{
  const snapshot=job.snapshot??JSON.parse(job.snapshot_json);
  const task=validateArkVideoSnapshot(snapshot);
  if(vault.get(snapshot.channelId).provider!=="volcengine_ark")
   throw fail("ark_video_channel_mismatch",true);
  vault.checkReference(snapshot.secretVersionRef,snapshot.channelId);
  return {snapshot,task};
 };
 async function call(job,url,init){
  const {snapshot}=validate(job);
  const authorization=vault.withSecretVersion(snapshot.secretVersionRef,
   bytes=>"Bearer "+bytes.toString("utf8"),{channelId:snapshot.channelId});
  return upstreamCall(url,{...init,redirect:"manual",
   headers:{...(init.headers||{}),authorization},
   signal:AbortSignal.timeout(120000)});
 }
 async function prepare({job}){validate(job)}
 async function submit({job}){
  const {task}=validate(job);
  const body={model:task.model,
   content:[{type:"text",text:task.prompt}],
   ratio:task.ratio,resolution:task.resolution,duration:task.duration,
   generate_audio:task.generateAudio,watermark:task.watermark};
  let response;
  try{response=await call(job,ARK_BASE+"/contents/generations/tasks",{
   method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify(body)
  })}catch{throw fail("ark_video_submit_uncertain")}
  if(response.status>=300&&response.status<400)throw fail("ark_video_redirect_forbidden");
  if(response.status>=400&&response.status<500)throw fail("ark_video_rejected",true);
  const payload=await responseJson(response);
  if(!validId(payload?.id))throw fail("ark_video_submit_id_missing");
  return {kind:"accepted",remoteTaskId:payload.id};
 }
 async function taskStatus(job,remoteTaskId){
  if(!validId(remoteTaskId))throw fail("ark_video_task_id_invalid");
  let response;
  try{response=await call(job,ARK_BASE+"/contents/generations/tasks/"+encodeURIComponent(remoteTaskId),
   {method:"GET"})}catch{throw fail("ark_video_poll_unavailable")}
  if(response.status>=300&&response.status<400)throw fail("ark_video_redirect_forbidden");
  const payload=await responseJson(response);
  if(payload?.id!==remoteTaskId)throw fail("ark_video_task_id_mismatch");
  return payload;
 }
 async function poll({job,remoteTaskId}){
  const result=await taskStatus(job,remoteTaskId);
  if(["queued","running"].includes(result.status))return {kind:"pending"};
  if(result.status==="cancelled")return {kind:"cancelled"};
  if(["failed","expired"].includes(result.status))return {kind:"failed"};
  if(result.status==="succeeded")return {kind:"completed",receipt:{remoteTaskId}};
  throw fail("ark_video_status_unknown");
 }
 async function cancel({job,remoteTaskId}){
  // Ark DELETE for succeeded/failed erases historical evidence; NEVER use
  // it except after confirming the upstream task is still queued.
  const current=await taskStatus(job,remoteTaskId);
  if(current.status==="cancelled")return {cancelled:true};
  if(current.status!=="queued")return {cancelled:false,reason:"ark_video_not_queued"};
  let response;
  try{response=await call(job,ARK_BASE+"/contents/generations/tasks/"+encodeURIComponent(remoteTaskId),
   {method:"DELETE"})}catch{return {cancelled:false,reason:"ark_video_cancel_unknown"}}
  if(response.status!==200)return {cancelled:false,reason:"ark_video_cancel_unconfirmed"};
  // Ark DELETE also deletes completed task records; HTTP 200 alone is NOT
  // proof of cancellation. Require a confirmed cancelled state on follow-up.
  try{
   const confirmed=await taskStatus(job,remoteTaskId);
   if(confirmed.status==="cancelled")return {cancelled:true};
  }catch{/* remote terminal state remains unconfirmed; normal polling resumes */}
  return {cancelled:false,reason:"ark_video_cancel_unconfirmed"};
 }
 async function collect({job,remoteTaskId}){
  const existing=db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(job.id);
  if(existing.n>0)return;
  const status=await taskStatus(job,remoteTaskId);
  if(status.status!=="succeeded"||typeof status.content?.video_url!=="string")
   throw fail("ark_video_result_not_ready");
  const url=verifyArkVideoUrl(status.content.video_url);
  let response;
  try{response=await upstreamCall(url,{method:"GET",redirect:"manual",
   signal:AbortSignal.timeout(180000)})}
  catch{throw fail("ark_video_download_unavailable")}
  if(!response.ok||!response.body||response.status>=300)
   throw fail("ark_video_download_failed");
  const blob=await blobStore.put(Readable.fromWeb(response.body),{mime:"video/mp4"});
  appendArtifact(db,{jobId:job.id,portId:"video",itemKey:"0",blobId:blob.blobId,
   kind:"video",mime:"video/mp4",sha256:blob.sha256,
   metadata:{modelGeneration:{kind:"video",model:validate(job).task.model}}});
 }
 return {prepare,submit,poll,collect,cancel};
}
