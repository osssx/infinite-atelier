import {appendArtifact} from "./repository.mjs";
import {DEFAULT_OPENAI_ENDPOINT,normalizeOpenAiCompatBaseUrl,
 createPinnedOpenAiCompatCall} from "./openai-compat-endpoints.mjs";
import {parseRestrictedModelScript,runRestrictedModelScript} from "./restricted-model-script.mjs";
import {createRestrictedVideoDownloader} from "./restricted-video-download.mjs";
import {validateFrozenVideoMedia,materializeFrozenVideoMedia} from "./restricted-video-media.mjs";
import {createScriptAssetUploadManager} from "./restricted-video-asset-upload.mjs";
import {createScriptAssetFinalizeManager} from "./restricted-video-asset-finalize.mjs";
import {createRestrictedAssetMultipart} from "./restricted-video-multipart.mjs";
import {createRestrictedSignedPut} from "./restricted-video-signed-put.mjs";

const fail=(code,confirmedNotAccepted=false)=>Object.assign(Error(code),
 {code,statusCode:422,confirmedNotAccepted});
const validId=id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
const knownStatus=new Set(["queued","running","in_progress","processing","succeeded",
 "completed","failed","cancelled","canceled","expired"]);
/** Frozen JSON with three independent JavaScript expression bodies. Each body
 * has exactly one statically permitted network operation; no general JS.
 */
export function parseRestrictedVideoScript(source){
 if(typeof source!=="string"||Buffer.byteLength(source,"utf8")>32*1024)
  throw fail("video_script_invalid",true);
 let spec;
 try{spec=JSON.parse(source)}catch{throw fail("video_script_invalid",true)}
 if(!spec||Array.isArray(spec)||spec.version!==1||
    Object.keys(spec).some(k=>!["version","submit","poll","cancel","assetUpload","assetFinalize"].includes(k))||
    typeof spec.submit!=="string"||typeof spec.poll!=="string"||
    spec.cancel!==undefined&&typeof spec.cancel!=="string"||
    spec.assetUpload!==undefined&&typeof spec.assetUpload!=="string"||
    spec.assetFinalize!==undefined&&(!spec.assetUpload||typeof spec.assetFinalize!=="string"||!spec.assetFinalize.trim()))
  throw fail("video_script_invalid",true);
 for(const [phase,body] of Object.entries({submit:spec.submit,poll:spec.poll,
  ...(spec.cancel?{cancel:spec.cancel}:{}),
  ...(spec.assetUpload?{assetUpload:spec.assetUpload}:{}),
  ...(spec.assetFinalize?{assetFinalize:spec.assetFinalize}:{})})){
  parseRestrictedModelScript(body);
  if(["poll","cancel"].includes(phase)&&!body.includes("remoteTaskId"))
   throw fail("video_script_remote_id_missing",true);
 }
 return spec;
}
export function validateRestrictedVideoSnapshot(snapshot){
 if(snapshot?.adapterKind!=="model"||
    !["openai","openai_compatible"].includes(snapshot.provider)||
    !validId(snapshot.channelId)||!validId(snapshot.secretVersionRef))
  throw fail("video_script_snapshot_invalid",true);
 if(snapshot.provider==="openai"){
  if(snapshot.endpointBaseUrl!==undefined)throw fail("video_script_endpoint_invalid",true);
 }else{
  let endpoint;
  try{endpoint=normalizeOpenAiCompatBaseUrl(snapshot.endpointBaseUrl)}
  catch{throw fail("video_script_endpoint_invalid",true)}
  if(endpoint!==snapshot.endpointBaseUrl)throw fail("video_script_endpoint_invalid",true);
 }
 const task=snapshot.task;
 if(!task||task.kind!=="video"||
    typeof task.model!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(task.model)||
    typeof task.prompt!=="string"||!task.prompt.trim()||
    Buffer.byteLength(task.prompt,"utf8")>16000||
    Object.keys(task).some(key=>!["kind","model","prompt","script","duration","ratio",
     "resolution","generateAudio","watermark","references"].includes(key))||
    task.duration!==undefined&&(!Number.isInteger(task.duration)||task.duration<1||task.duration>60)||
    task.ratio!==undefined&&!["adaptive","16:9","9:16","1:1","4:3","3:4","21:9"].includes(task.ratio)||
    task.resolution!==undefined&&!["480p","720p","1080p"].includes(task.resolution)||
    task.generateAudio!==undefined&&typeof task.generateAudio!=="boolean"||
    task.watermark!==undefined&&typeof task.watermark!=="boolean")
  throw fail("video_script_task_invalid",true);
 const references=validateFrozenVideoMedia(task.references);
 const spec=parseRestrictedVideoScript(task.script);
 return {task,spec,references};
}
export function createRestrictedVideoAdapter({db,vault,blobStore,
 upstreamCall=fetch,compatibleUpstreamCall=createPinnedOpenAiCompatCall({
  allowVideoPollGet:true,allowVideoCancel:true
 }),mediaDownloader,signedPut}={}){
 if(!db||!vault||!blobStore)throw Error("video_script_dependencies_required");
 const downloader=mediaDownloader??createRestrictedVideoDownloader({blobStore});
 const uploadedAssets=createScriptAssetUploadManager({db});
 const finalizer=createScriptAssetFinalizeManager({db});
 const putSignedAsset=signedPut??createRestrictedSignedPut();
 const check=job=>{
  const snapshot=job.snapshot??JSON.parse(job.snapshot_json);
  const {task,spec,references}=validateRestrictedVideoSnapshot(snapshot);
  if(vault.get(snapshot.channelId).provider!==snapshot.provider)
   throw fail("video_script_channel_mismatch",true);
  vault.checkReference(snapshot.secretVersionRef,snapshot.channelId);
  return {snapshot,task,spec,references};
 };
 const endpoint=snap=>snap.provider==="openai_compatible"?
  snap.endpointBaseUrl:DEFAULT_OPENAI_ENDPOINT;
 async function phase(job,name,remoteTaskId,asset){
  const {snapshot,task,spec,references}=check(job);
  const script=spec[name];
  const media=name==="submit"?await materializeFrozenVideoMedia(blobStore,
   spec.assetUpload?references.filter(ref=>ref.kind==="image"):references):null;
  const assetIds=name==="submit"&&spec.assetUpload?{
   referenceVideoAssetIds:references.flatMap((ref,index)=>ref.kind==="video"?
    [uploadedAssets.requireId(job.id,index,ref)]:[]),
   referenceAudioAssetIds:references.flatMap((ref,index)=>ref.kind==="audio"?
    [uploadedAssets.requireId(job.id,index,ref)]:[])
  }:null;
  if(!script)return null;
  const auth=vault.withSecretVersion(snapshot.secretVersionRef,
   bytes=>"Bearer "+bytes.toString("utf8"),{channelId:snapshot.channelId});
  const network=snapshot.provider==="openai_compatible"?compatibleUpstreamCall:upstreamCall;
  let hasCalled=false;
  return runRestrictedModelScript({
   script,model:task.model,prompt:task.prompt,remoteTaskId,
   messages:[{role:"user",content:task.prompt}],
    params:{duration:task.duration,ratio:task.ratio,resolution:task.resolution,
     generateAudio:task.generateAudio,watermark:task.watermark,
     ...(media?{firstFrame:media.firstFrame,lastFrame:media.lastFrame,
      referenceImages:media.referenceImages,
      referenceVideos:media.referenceVideos,referenceAudios:media.referenceAudios}:{}),
     ...(assetIds??{}),...(asset?{asset}:{})},
   http:async(method,path,body)=>{
    if(hasCalled)throw fail("video_script_multiple_requests",true);
    hasCalled=true;
    if(name==="submit"&&method!=="post"||
       name==="assetUpload"&&!["post","multipart"].includes(method)||
       name==="assetFinalize"&&method!=="post"||
       name==="poll"&&method!=="get"||
       name==="cancel"&&method!=="delete")
     throw fail("video_script_method_forbidden",true);
    if(["poll","cancel"].includes(name)&&(!validId(remoteTaskId)||
       !path.endsWith("/"+remoteTaskId)))throw fail("video_script_poll_path_invalid",true);
    let payload;
    let multipart;
    if(name==="assetUpload"&&method==="multipart"){
     multipart=createRestrictedAssetMultipart({asset,options:body});
    }else if(["submit","assetUpload","assetFinalize"].includes(name)){
     try{payload=JSON.stringify(body)}
     catch{throw fail("video_script_body_invalid",true)}
     if(!payload||Buffer.byteLength(payload)>(references.length?45*1024*1024:128*1024))
      throw fail("video_script_body_invalid",true);
    }
    let response;
    try{response=await network(endpoint(snapshot)+path,{
     method:method.toUpperCase(),redirect:"manual",
     headers:{authorization:auth,...(payload?{"content-type":"application/json"}:{})},
     ...(multipart?{body:multipart}:payload?{body:payload}:{}),
     signal:AbortSignal.timeout(120000)
    })}catch{
     throw fail(name==="submit"?"video_script_submit_uncertain":
      ["assetUpload","assetFinalize"].includes(name)?
       "video_script_asset_stage_unknown":"video_script_status_unavailable");
    }
    if(response.status>=300&&response.status<400)
     throw fail("video_script_redirect_forbidden");
    if(!response.ok)throw fail("video_script_upstream_rejected",
     ["submit","assetUpload"].includes(name)&&response.status>=400&&response.status<500);
    if(!response.body)throw fail("video_script_response_empty");
    const parts=[];let size=0;
    for await(const chunk of response.body){
     const bytes=Buffer.from(chunk);size+=bytes.length;
     if(size>256*1024)throw fail("video_script_response_too_large");
     parts.push(bytes);
    }
    try{return JSON.parse(Buffer.concat(parts).toString("utf8"))}
    catch{throw fail("video_script_response_invalid")}
   }
  });
 }
 async function prepare({job}){
  const {references,spec}=check(job);
  if(!references.length)return;
  const media=await materializeFrozenVideoMedia(blobStore,references);
  if(!spec.assetUpload)return;
  let videoIndex=0,audioIndex=0;
  for(let index=0;index<references.length;index++){
   const ref=references[index];
   if(ref.kind==="image")continue;
   const dataUrl=ref.kind==="video"?media.referenceVideos[videoIndex++]:
    media.referenceAudios[audioIndex++];
   const finalizeUploaded=async()=>{
    const stage=finalizer.inspect(job.id,index);
    if(!stage||stage.status!=="uploaded")
     throw fail("video_script_finalize_outcome_unknown");
    return finalizer.finalize({job,index,ref,script:spec.assetFinalize,
     call:async assetId=>{
      const result=await phase(job,"assetFinalize",undefined,{
       kind:ref.kind,role:ref.role,mimeType:ref.mimeType,
       sha256:ref.sha256,index,remoteAssetId:assetId});
      return result;
     }});
   };
   await uploadedAssets.ensureReady({job,index,ref,script:spec.assetUpload,
    ...(spec.assetFinalize?{resumeFinalize:finalizeUploaded}:{}),
    upload:async()=>{
     const asset={kind:ref.kind,role:ref.role,
      mimeType:ref.mimeType,sha256:ref.sha256,index,dataUrl};
     const result=await phase(job,"assetUpload",undefined,asset);
     if(result&&typeof result==="object"&&!Array.isArray(result)&&
        Object.hasOwn(result,"uploadUrl")){
      if(Object.keys(result).some(key=>!["id","uploadUrl"].includes(key))||
         !validId(result.id)||typeof result.uploadUrl!=="string")
       throw fail("video_script_signed_grant_invalid");
      // URL remains in memory only: PUT never receives the Vault bearer
      // token and no signed URL is persisted in SQLite or error messages.
      await putSignedAsset({uploadUrl:result.uploadUrl,asset});
      if(spec.assetFinalize){
       // Persist PUT success before any finalize POST, so a restart can
       // resume finalize without re-requesting a URL or re-uploading bytes.
       finalizer.recordUploaded({job,index,ref,script:spec.assetFinalize,
        assetId:result.id});
       await finalizeUploaded();
      }
      return {id:result.id};
     }
     if(spec.assetFinalize)throw fail("video_script_finalize_requires_signed_put");
     return result;
    }});

  }
 }
 async function submit({job}){
  const result=await phase(job,"submit");
  const id=typeof result==="string"?result:result?.id;
  if(!validId(id))throw fail("video_script_submit_id_unknown");
  return {kind:"accepted",remoteTaskId:id};
 }
 async function taskStatus(job,remoteTaskId){
  if(!validId(remoteTaskId))throw fail("video_script_remote_id_invalid");
  const result=await phase(job,"poll",remoteTaskId);
  if(!result||typeof result!=="object"||Array.isArray(result)||
     !knownStatus.has(result.status))
   throw fail("video_script_status_invalid");
  // A result must never swap the task ID being polled.
  if(result.id!==undefined&&result.id!==remoteTaskId)
   throw fail("video_script_remote_id_mismatch");
  return result;
 }
 async function poll({job,remoteTaskId}){
  const status=await taskStatus(job,remoteTaskId);
  if(["queued","running","in_progress","processing"].includes(status.status))return {kind:"pending"};
  if(["cancelled","canceled"].includes(status.status))return {kind:"cancelled"};
  if(["failed","expired"].includes(status.status))return {kind:"failed"};
  return {kind:"completed",receipt:{remoteTaskId}};
 }
 async function collect({job,remoteTaskId}){
  if(db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(job.id).n>0)return;
  const status=await taskStatus(job,remoteTaskId);
  if(!["succeeded","completed"].includes(status.status)||typeof status.videoUrl!=="string")
   throw fail("video_script_media_not_ready");
  const {snapshot,task}=check(job);
  // Never forward the bearer key to this URL. Public CDN/explicit same origin only.
  const blob=await downloader.importUrl(status.videoUrl,
   {endpointBaseUrl:endpoint(snapshot)});
  if(!["video/mp4","video/webm"].includes(blob.mimeType))
   throw fail("video_script_media_mime_invalid");
  appendArtifact(db,{jobId:job.id,portId:"video",itemKey:"0",
   blobId:blob.blobId,kind:"video",mime:blob.mimeType,sha256:blob.sha256,
   metadata:{modelGeneration:{kind:"video",model:task.model}}});
 }
 async function cancel({job,remoteTaskId}){
  const {spec}=check(job);
  if(!spec.cancel)return {cancelled:false,reason:"video_script_cancel_not_configured"};
  // Destructive cancellation is only ever allowed for a proven queued task.
  const status=await taskStatus(job,remoteTaskId);
  if(["cancelled","canceled"].includes(status.status))return {cancelled:true};
  if(status.status!=="queued")
   return {cancelled:false,reason:"video_script_cancel_not_queued"};
  try{
   await phase(job,"cancel",remoteTaskId);
   const confirmed=await taskStatus(job,remoteTaskId);
   return ["cancelled","canceled"].includes(confirmed.status)?{cancelled:true}:
    {cancelled:false,reason:"video_script_cancel_unconfirmed"};
  }catch{return {cancelled:false,reason:"video_script_cancel_unconfirmed"}}
 }
 return {prepare,submit,poll,collect,cancel};
}
