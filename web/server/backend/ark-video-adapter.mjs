import {Readable} from "node:stream";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {appendArtifact} from "./repository.mjs";

const ARK_BASE="https://ark.cn-beijing.volces.com/api/v3";
const resultHost=/^(?:[a-z0-9-]+\.)*tos-cn-beijing\.volces\.com$/i;
const fail=(code,confirmedNotAccepted=false)=>
 Object.assign(Error(code),{code,confirmedNotAccepted});
const validId=id=>typeof id==="string"&&/^[a-zA-Z0-9_-]{1,160}$/.test(id);
const safeModel=model=>typeof model==="string"&&
 /^([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/.test(model);

const roles={image:["first_frame","last_frame","reference_image"],
 video:["reference_video"],audio:["reference_audio"]};
const mimeTypes={image:["image/png","image/jpeg","image/webp"],
 video:["video/mp4","video/quicktime"],audio:["audio/wav","audio/mpeg"]};
export function validateArkReferences(task){
 const refs=task.references??[];
 const mode=task.mode??"text_to_video";
 if(!Array.isArray(refs)||refs.length>15||
  !["text_to_video","first_frame","first_last_frame","omni_reference"].includes(mode))
  throw fail("ark_video_references_invalid",true);
 const types={image:[],video:[],audio:[]};
 for(const ref of refs){
  if(!ref||typeof ref!=="object"||!roles[ref.kind]?.includes(ref.role)||
    Object.keys(ref).some(k=>!["kind","role","blobId","sha256","mimeType","assetUrl","durationMs","width","height"].includes(k)))
   throw fail("ark_video_reference_invalid",true);
  const asset=ref.kind==="video"&&typeof ref.assetUrl==="string"&&
   /^asset:\/\/[A-Za-z0-9_-]{1,160}$/.test(ref.assetUrl);
  if((ref.kind==="video"&&!asset)||ref.kind!=="video"&&ref.assetUrl!==undefined)
   throw fail("ark_video_reference_asset_invalid",true);
  if(ref.blobId!==undefined||ref.sha256!==undefined){
   if(!/^[a-f0-9]{64}$/.test(ref.blobId)||ref.blobId!==ref.sha256||
     !mimeTypes[ref.kind].includes(ref.mimeType))
    throw fail("ark_video_reference_digest_invalid",true);
  }else if(ref.kind!=="video"||!asset||ref.mimeType!==undefined)
   throw fail("ark_video_reference_missing_cas",true);
  if(ref.durationMs!==undefined&&(!Number.isInteger(ref.durationMs)||
    ref.durationMs<2000||ref.durationMs>15000))throw fail("ark_video_reference_duration_invalid",true);
  if(ref.width!==undefined&&(!Number.isInteger(ref.width)||ref.width<300||ref.width>6000)||
     ref.height!==undefined&&(!Number.isInteger(ref.height)||ref.height<300||ref.height>6000))
   throw fail("ark_video_reference_dimensions_invalid",true);
  types[ref.kind].push(ref);
 }
 const imgs=types.image,vids=types.video,auds=types.audio;
 if(imgs.length>9||vids.length>3||auds.length>3||
    vids.reduce((sum,r)=>sum+(r.durationMs??0),0)>15000||
    auds.reduce((sum,r)=>sum+(r.durationMs??0),0)>15000)
  throw fail("ark_video_reference_limit",true);
 if(mode==="text_to_video"&&refs.length||
    mode==="first_frame"&&(refs.length!==1||imgs[0]?.role!=="first_frame")||
    mode==="first_last_frame"&&(refs.length!==2||imgs.filter(r=>r.role==="first_frame").length!==1||
      imgs.filter(r=>r.role==="last_frame").length!==1)||
    mode==="omni_reference"&&(!refs.length||refs.some(r=>r.role!=="reference_"+r.kind)||
       auds.length>0&&imgs.length+vids.length===0))
  throw fail("ark_video_reference_mode_invalid",true);
 return refs;
}
export function validateArkVideoSnapshot(snapshot){
 if(snapshot?.adapterKind!=="model"||snapshot.provider!=="volcengine_ark"||
  !validId(snapshot.channelId)||!validId(snapshot.secretVersionRef))
  throw fail("ark_video_snapshot_invalid",true);
 const task=snapshot.task;
 if(!task||task.kind!=="video"||!safeModel(task.model)||
  typeof task.prompt!=="string"||!task.prompt.trim()||
  Buffer.byteLength(task.prompt,"utf8")>16000||
  Object.keys(task).some(key=>!["kind","model","prompt","duration","ratio","resolution","generateAudio","watermark","mode","references"].includes(key))||
  !Number.isInteger(task.duration)||task.duration<4||task.duration>15||
  !["adaptive","16:9","9:16","1:1","4:3","3:4","21:9"].includes(task.ratio)||
  !["480p","720p","1080p"].includes(task.resolution)||
  typeof task.generateAudio!=="boolean"||typeof task.watermark!=="boolean")
  throw fail("ark_video_task_invalid",true);
 validateArkReferences(task);
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
async function pinnedArkContent(task,blobStore){
 const refs=validateArkReferences(task);
 const items=[{type:"text",text:task.prompt}];
 let total=Buffer.byteLength(task.prompt,"utf8");
 for(const ref of refs){
  let url=ref.assetUrl;
  if(ref.blobId){
   const blob=await blobStore.stat(ref.blobId);
   const max=ref.kind==="image"?30*1024*1024:ref.kind==="audio"?15*1024*1024:200*1024*1024;
   if(blob.sha256!==ref.sha256||blob.mimeType!==ref.mimeType||blob.byteSize>=max)
    throw fail("ark_video_reference_cas_invalid",true);
   // Never emit localhost: the cloud needs immutable bytes, not an authenticated
   // loopback URL. For video Ark requires an uploaded asset:// ID.
   if(ref.kind!=="video"){
    const bytes=await readFile(blob.path);
    if(createHash("sha256").update(bytes).digest("hex")!==ref.sha256)
     throw fail("ark_video_reference_corrupt",true);
    url="data:"+blob.mimeType+";base64,"+bytes.toString("base64");
    total+=url.length;
   }
  }
  if(!url||total>60*1024*1024)throw fail("ark_video_reference_request_too_large",true);
  const type=ref.kind+"_url";
  items.push({type,[type]:{url},role:ref.role});
 }
 return items;
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
  const content=await pinnedArkContent(task,blobStore);
  const body={model:task.model,
   content,
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
