import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Readable} from "node:stream";
import {appendArtifact} from "./repository.mjs";
import {DEFAULT_OPENAI_ENDPOINT,compatEndpointFingerprint,normalizeOpenAiCompatBaseUrl,createPinnedOpenAiCompatCall} from "./openai-compat-endpoints.mjs";

const fail=(code,statusCode=400,confirmedNotAccepted=false)=>
 Object.assign(Error(code),{code,statusCode,confirmedNotAccepted});
const imageMimes=new Set(["image/png","image/jpeg","image/webp"]);
const validId=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const validModel=value=>typeof value==="string"&&value.length<=128&&
 /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value);
const validPrompt=value=>typeof value==="string"&&value.trim().length>0&&
 Buffer.byteLength(value,"utf8")<=16000;
const asSize=(resolution,ratio)=>{
 if(typeof resolution==="string"&&/^\d{3,4}x\d{3,4}$/.test(resolution))return resolution;
 const height=Number.parseInt(String(resolution).replace(/p$/i,""),10);
 const base=Number.isInteger(height)&&height>=480&&height<=2160?height:720;
 const portrait=["9:16","2:3","3:4"].includes(ratio);
 const landscape=["16:9","3:2","4:3","21:9"].includes(ratio);
 if(ratio==="1:1")return `${base}x${base}`;
 if(portrait)return `${Math.round(base*9/16)}x${base}`;
 if(landscape)return `${Math.round(base*16/9)}x${base}`;
 return "1280x720";
};

export function validateOpenAiVideoSnapshot(snapshot){
 if(!snapshot||snapshot.adapterKind!=="model"||
  !["openai","openai_compatible"].includes(snapshot.provider)||
  !validId(snapshot.channelId)||!validId(snapshot.secretVersionRef))
  throw fail("openai_video_snapshot_invalid");
 if(snapshot.provider==="openai_compatible"){
  let endpoint;
  try{endpoint=normalizeOpenAiCompatBaseUrl(snapshot.endpointBaseUrl)}catch{throw fail("openai_video_endpoint_invalid")}
  if(endpoint!==snapshot.endpointBaseUrl||
   snapshot.endpointFingerprint!==compatEndpointFingerprint(endpoint))
   throw fail("openai_video_endpoint_invalid");
 }else if(snapshot.endpointBaseUrl!==undefined||snapshot.endpointFingerprint!==undefined)
  throw fail("openai_video_endpoint_invalid");
 const task=snapshot.task;
 if(!task||task.kind!=="video"||!validModel(task.model)||!validPrompt(task.prompt)||
  Object.keys(task).some(key=>!["kind","model","prompt","duration","ratio","resolution","generateAudio","watermark","images","writeBack"].includes(key))||
  task.duration!==undefined&&(!Number.isInteger(task.duration)||task.duration<1||task.duration>20)||
  task.ratio!==undefined&&!["adaptive","16:9","9:16","1:1","4:3","3:4","21:9","3:2","2:3"].includes(task.ratio)||
  task.resolution!==undefined&&!(typeof task.resolution==="string"&&/^\d{3,4}p?$|^\d{3,4}x\d{3,4}$/.test(task.resolution))||
  task.generateAudio!==undefined&&typeof task.generateAudio!=="boolean"||
  task.watermark!==undefined&&typeof task.watermark!=="boolean"||
  task.writeBack!==undefined&&typeof task.writeBack!=="boolean")
  throw fail("openai_video_task_invalid");
 const images=task.images??[];
 if(!Array.isArray(images)||images.length>7||images.some(ref=>!ref||typeof ref!=="object"||Array.isArray(ref)||
  Object.keys(ref).some(key=>!["blobId","mimeType"].includes(key))||
  typeof ref.blobId!=="string"||!/^[a-f0-9]{64}$/.test(ref.blobId)||!imageMimes.has(ref.mimeType)))
  throw fail("openai_video_images_invalid");
 return task;
}

async function responseJson(response){
 if(!response.body)throw fail("openai_video_response_missing",502);
 const chunks=[];let total=0;
 for await(const part of response.body){const chunk=Buffer.from(part);total+=chunk.length;
  if(total>1024*1024)throw fail("openai_video_response_too_large",502);chunks.push(chunk)}
 try{return JSON.parse(Buffer.concat(chunks).toString("utf8"))}
 catch{throw fail("openai_video_response_invalid",502)}
}

/** OpenAI-compatible async video execution. Sora's official API is retired;
 * this adapter keeps the protocol server-owned for compatible providers that
 * still expose it. A successful create is persisted by JobCoordinator before
 * any poll. It never repeats a create after an ambiguous response.
 */
export function createOpenAiVideoAdapter({db,vault,blobStore,upstreamCall=fetch,
 compatibleUpstreamCall=createPinnedOpenAiCompatCall({allowVideoPollGet:true})}={}){
 if(!db||!vault||!blobStore||typeof upstreamCall!=="function")
  throw Error("openai_video_adapter_dependencies_required");
 const validate=job=>{
  const snapshot=job.snapshot??JSON.parse(job.snapshot_json);
  const task=validateOpenAiVideoSnapshot(snapshot);
  if(vault.get(snapshot.channelId).provider!==snapshot.provider)
   throw fail("openai_video_channel_mismatch",409,true);
  vault.checkReference(snapshot.secretVersionRef,snapshot.channelId);
  return {snapshot,task};
 };
 const endpoint=snapshot=>snapshot.provider==="openai_compatible"?
  snapshot.endpointBaseUrl:DEFAULT_OPENAI_ENDPOINT;
 const network=snapshot=>snapshot.provider==="openai_compatible"?
  compatibleUpstreamCall:upstreamCall;
 async function call(job,path,method="GET",body){
  const {snapshot}=validate(job);
  const authorization=vault.withSecretVersion(snapshot.secretVersionRef,
   bytes=>"Bearer "+bytes.toString("utf8"),{channelId:snapshot.channelId});
  return network(snapshot)(endpoint(snapshot)+path,{method,redirect:"manual",
   headers:{authorization,...(body?{}:{})},...(body?{body}:{}),signal:AbortSignal.timeout(method==="GET"?180000:120000)});
 }
 async function readInput(ref){
  const stat=await blobStore.stat(ref.blobId);
  if(stat.sha256!==ref.blobId||stat.mimeType!==ref.mimeType||!imageMimes.has(stat.mimeType)||
   stat.byteSize<1||stat.byteSize>20*1024*1024)
   throw fail("openai_video_image_input_invalid",422,true);
  const bytes=await readFile(stat.path);
  if(bytes.length!==stat.byteSize||createHash("sha256").update(bytes).digest("hex")!==ref.blobId)
   throw fail("openai_video_image_integrity_failed",503,true);
  return {bytes,mimeType:stat.mimeType};
 }
 async function prepare({job}){
  const {snapshot,task}=validate(job);
  // OpenAI retired Sora and the Videos API on 2026-09-24. Keep its former
  // protocol available only for compatible endpoints that still implement it.
  if(snapshot.provider==="openai")throw fail("openai_video_api_retired",410,true);
  for(const ref of task.images??[])await readInput(ref);
 }
 async function submit({job}){
  const {task}=validate(job);
  const form=new FormData();
  form.set("model",task.model);form.set("prompt",task.prompt);
  form.set("seconds",String(task.duration??6));
  form.set("size",asSize(task.resolution,task.ratio));
  if(task.generateAudio!==undefined)form.set("generate_audio",String(task.generateAudio));
  if(task.watermark!==undefined)form.set("watermark",String(task.watermark));
  for(let index=0;index<(task.images??[]).length;index++){
   const ref=task.images[index],image=await readInput(ref);
   const ext=ref.mimeType==="image/png"?"png":ref.mimeType==="image/webp"?"webp":"jpg";
   form.append("input_reference",new Blob([image.bytes],{type:image.mimeType}),`reference-${index}.${ext}`);
  }
  let response;
  try{response=await call(job,"/videos","POST",form)}
  catch{throw fail("openai_video_submit_uncertain",502)}
  if(response.status>=300&&response.status<400)throw fail("openai_video_redirect_rejected",502);
  if(response.status>=400&&response.status<500)throw fail("openai_video_rejected",502,true);
  const payload=await responseJson(response);
  if(!validId(payload?.id))throw fail("openai_video_submit_id_missing",502);
  return {kind:"accepted",remoteTaskId:payload.id};
 }
 async function taskStatus(job,remoteTaskId){
  if(!validId(remoteTaskId))throw fail("openai_video_task_id_invalid");
  let response;
  try{response=await call(job,"/videos/"+encodeURIComponent(remoteTaskId))}
  catch{throw fail("openai_video_poll_unavailable",502)}
  if(response.status>=300&&response.status<400)throw fail("openai_video_redirect_rejected",502);
  if(!response.ok)throw fail("openai_video_poll_failed",502);
  const payload=await responseJson(response);
  if(payload?.id!==remoteTaskId)throw fail("openai_video_task_id_mismatch",502);
  return payload;
 }
 async function poll({job,remoteTaskId}){
  const result=await taskStatus(job,remoteTaskId);
  if(["queued","in_progress","running","pending"].includes(result.status))return {kind:"pending"};
  if(["failed","expired","cancelled"].includes(result.status))return {kind:result.status==="cancelled"?"cancelled":"failed"};
  if(["completed","succeeded"].includes(result.status))return {kind:"completed",receipt:{remoteTaskId}};
  throw fail("openai_video_status_unknown",502);
 }
 async function collect({job,remoteTaskId}){
  if(db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(job.id).n>0)return;
  const status=await taskStatus(job,remoteTaskId);
  if(!["completed","succeeded"].includes(status.status))throw fail("openai_video_result_not_ready",409);
  let response;
  try{response=await call(job,"/videos/"+encodeURIComponent(remoteTaskId)+"/content")}
  catch{throw fail("openai_video_download_unavailable",502)}
  if(response.status>=300&&response.status<400)throw fail("openai_video_redirect_rejected",502);
  if(!response.ok||!response.body)throw fail("openai_video_download_failed",502);
  const type=response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if(type&&type!=="video/mp4"&&type!=="application/octet-stream")throw fail("openai_video_mime_invalid",502);
  const blob=await blobStore.put(Readable.fromWeb(response.body),{mime:"video/mp4"});
  appendArtifact(db,{jobId:job.id,portId:"video",itemKey:"0",blobId:blob.blobId,
   kind:"video",mime:blob.mimeType,sha256:blob.sha256,
   metadata:{modelGeneration:{kind:"video",model:validate(job).task.model}}});
 }
 async function cancel(){
  // DELETE /videos/{id} deletes the remote record; it is not a cancellation API.
  return {cancelled:false,reason:"openai_video_remote_cancel_unsupported"};
 }
 return {prepare,submit,poll,collect,cancel};
}
