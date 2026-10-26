import {randomUUID} from "node:crypto";
import {createReadStream,openAsBlob} from "node:fs";
import {createHash} from "node:crypto";
import {Readable} from "node:stream";
import {compileSingleWorkflow,verifyTemplate,validateSingleRequest,canonical,sha256} from "../comfy-workflow/compiler.mjs";
import {extractCapture,detectArtifactMime,captureLimits} from "../comfy-workflow/capture-adapters.mjs";
import {appendArtifact,writeTransaction} from "./repository.mjs";
import {makeComfyArtifactProvenance} from "./comfy-provenance.mjs";

const fail=(code,statusCode=422)=>Object.assign(Error(code),{code,statusCode});
const validId=id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
function validateInstance(raw){
 if(!validId(raw?.id)||typeof raw.url!=="string")throw fail("invalid_comfy_instance",400);
 const u=new URL(raw.url);
 if(u.protocol!=="http:"||!["127.0.0.1","[::1]"].includes(u.hostname)||
    !u.port||u.pathname!=="/"||u.username||u.password||u.search||u.hash)
   throw fail("comfy_instance_must_be_exact_loopback_origin",400);
 return {id:raw.id,url:u.origin};
}
/** The existing Comfy V2 /object_info, /prompt, /history and /view protocol.
 * No redirect follow or arbitrary remote URL is allowed. Binary bodies stream.
 */
export async function comfyUpstream(instance,path,{method="GET",body,receive,timeoutMs=45000}={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetch(instance.url+path,{
   method,body,redirect:"manual",signal:controller.signal,
   headers:typeof body==="string"?{"content-type":"application/json"}:undefined
  });
  if(response.status>=300&&response.status<400)throw fail("comfy_redirect_rejected",502);
  if(!response.ok){
   if(path==="/prompt"&&method==="POST"&&[400,422].includes(response.status))
    throw Object.assign(fail("comfy_prompt_rejected",422),{confirmedNotAccepted:true});
   throw fail("comfy_upstream_"+response.status,502);
  }
  const mime=(response.headers.get("content-type")??"").split(";")[0].toLowerCase();
  if(receive){
   if(!response.body)throw fail("comfy_empty_response",502);
   return receive(response.body,mime);
  }
  const chunks=[];let total=0;
  for await(const chunk of response.body??[]){
   total+=chunk.length;
   if(total>8_000_000)throw fail("comfy_response_too_large",502);
   chunks.push(Buffer.from(chunk));
  }
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"))}
  catch{throw fail("comfy_invalid_json",502)}
 }finally{clearTimeout(timer)}
}
function snapshotOf(job,instanceId){
 const s=job.snapshot??JSON.parse(job.snapshot_json);
 if(s.adapterKind!=="comfy"||s.instanceId!==instanceId||
    !s.comfyRequest||!s.comfyTemplate||s.comfyRequest.instanceId!==instanceId)
   throw fail("comfy_frozen_snapshot_required",400);
 if(s.comfyRequest.idempotencyKey!==job.idempotency_key)
   throw fail("comfy_idempotency_mismatch",400);
 if(job.project_id&&s.comfyRequest.projectId!==job.project_id)
   throw fail("comfy_project_mismatch",400);
 if(job.target_node_id&&s.comfyRequest.nodes?.[0]?.id!==job.target_node_id)
   throw fail("comfy_canvas_node_mismatch",400);
 validateSingleRequest(s.comfyRequest);verifyTemplate(s.comfyTemplate);
 return s;
}
function getPreparation(db,jobId){
 const row=db.prepare("SELECT * FROM comfy_job_preparations WHERE job_id=?").get(jobId);
 return row?{...row,graph:JSON.parse(row.graph_json),captures:JSON.parse(row.capture_map_json)}:null;
}
const validRemoteId=id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
function historyEntry(body,remoteTaskId){
 return body&&typeof body==="object"?body[remoteTaskId]:null;
}
function successful(entry){
 return entry?.status?.completed===true||entry?.status?.status_str==="success";
}
function failed(entry){
 return ["error","execution_error"].includes(entry?.status?.status_str);
}
async function storeCapturedFile({instance,cap,item,blobStore,upstreamCall}){
 const query=new URLSearchParams({filename:item.filename,subfolder:item.subfolder,type:item.fileType});
 // Retain the first bytes for V2's established MIME detection while keeping
 // the rest as a stream; BlobStore enforces the configured byte quota.
 const receive=async(stream,mime)=>{
  const iter=stream[Symbol.asyncIterator]();
  const buffered=[];let length=0;
  while(length<64){
   const n=await iter.next();
   if(n.done)break;
   const bytes=Buffer.from(n.value);
   buffered.push(bytes);length+=bytes.length;
  }
  const head=Buffer.concat(buffered).subarray(0,64);
  // Text may begin with split multibyte UTF-8; BlobStore validates the whole stream.
  const actual=cap.kind==="text"?"text/plain":detectArtifactMime(cap.kind,head,mime);
  if(cap.kind==="text"&&!["","text/plain","application/octet-stream","binary/octet-stream"].includes(mime))
   throw fail("captured_mime_mismatch");
  const extensions={
   "image/png":["png"],"image/jpeg":["jpg","jpeg"],"image/webp":["webp"],
   "video/mp4":["mp4","m4v"],"video/webm":["webm"],"video/x-matroska":["mkv"],
   "audio/wav":["wav"],"audio/flac":["flac"],"audio/ogg":["ogg","oga"],
   "audio/mpeg":["mp3"],"text/plain":["txt","text"]
  };
  if(!extensions[actual]?.includes(item.filename.split(".").at(-1)?.toLowerCase()))
   throw fail("captured_extension_mismatch");
  async function* all(){for(const b of buffered)yield b;for await(const b of { [Symbol.asyncIterator]:()=>iter })yield b}
  return blobStore.put(all(),{mime:actual});
 };
 const answer=await upstreamCall(instance,"/view?"+query.toString(),{
  timeoutMs:120000,receive
 });
 if(answer?.blobId)return answer; // live transport streams into BlobStore
 if(answer?.bytes||answer?.stream){
  const bytes=answer.bytes??answer.stream;
  const chunks=Buffer.isBuffer(bytes)?[bytes]:bytes;
  return receive(Readable.from(chunks),answer.mime??"application/octet-stream");
 }
 throw fail("capture_download_invalid",502);
}
export function createComfyV2Adapter({instance,db,blobStore,upstreamCall=comfyUpstream}={}){
 const trusted=validateInstance(instance);
 if(!db||!blobStore||typeof upstreamCall!=="function")throw Error("invalid_comfy_v2_adapter");
 async function prepare({job}){
  const snapshot=snapshotOf(job,trusted.id);
  if(getPreparation(db,job.id))return; // immutable compilation, including across restarts
  const request=snapshot.comfyRequest,template=snapshot.comfyTemplate;
  const info=await upstreamCall(trusted,"/object_info");
  // Names are content-derived and uploads can safely be repeated before /prompt.
  const mediaFiles={};
  const allowed={
   IMAGE:{"image/png":"png","image/jpeg":"jpg","image/webp":"webp"},
   VIDEO:{"video/mp4":"mp4","video/webm":"webm","video/x-matroska":"mkv"},
   AUDIO:{"audio/wav":"wav","audio/flac":"flac","audio/ogg":"ogg","audio/mpeg":"mp3"}
  };
  const sizes={IMAGE:captureLimits.image,VIDEO:captureLimits.video,AUDIO:captureLimits.audio};
  const items=request.externalInputs.filter(x=>x.kind==="asset");
  for(const item of items){
   const blobId=snapshot.comfyAssetBlobs?.[item.assetId]??item.assetId;
   if(blobId!==item.sha256)throw fail("comfy_asset_snapshot_mismatch",400);
   const blob=await blobStore.stat(blobId);
   const extension=allowed[item.valueKind]?.[blob.mimeType];
   if(blob.sha256!==item.sha256||!extension)
    throw fail("comfy_asset_reference_invalid",400);
   if(blob.byteSize>sizes[item.valueKind])throw fail("comfy_asset_too_large",413);
   mediaFiles[item.assetId]="atelier_"+item.sha256+"."+extension;
  }
  // Compilation validates every port and target binding BEFORE any upload.
  const compiled=compileSingleWorkflow(request,template,{info,mediaFiles});
  for(const item of items){
   const blobId=snapshot.comfyAssetBlobs?.[item.assetId]??item.assetId;
   const blob=await blobStore.stat(blobId);
   // Stream verification prevents a large video/audio reference from loading
   // into Node memory. openAsBlob keeps multipart upload disk-backed.
   const hash=createHash("sha256");
   for await(const bytes of createReadStream(blob.path))hash.update(bytes);
   if(hash.digest("hex")!==item.sha256)throw fail("comfy_staged_asset_corrupted",409);
   const filename=mediaFiles[item.assetId];
   const form=new FormData();
   form.set("image",await openAsBlob(blob.path,{type:blob.mimeType}),filename);
   form.set("type","input");form.set("overwrite","true");
   // ComfyUI's local /upload/image saves arbitrary input media files. The
   // template must explicitly bind a media-file target to use this filename.
   const response=await upstreamCall(trusted,"/upload/image",{method:"POST",body:form,timeoutMs:120000});
   if(response?.name!==filename||response?.type&&response.type!=="input"||response?.subfolder)
    throw fail("comfy_upload_filename_mismatch",502);
  }
  writeTransaction(db,()=>{
   if(getPreparation(db,job.id))return; // idempotent race guard
   const row=db.prepare("SELECT status,submission_started_at FROM jobs WHERE id=?").get(job.id);
   if(row?.status!=="preparing"||row.submission_started_at!==null)
    throw fail("unsafe_comfy_preparation",409);
   db.prepare(`INSERT INTO comfy_job_preparations
    (job_id,graph_json,capture_map_json,graph_hash,image_files_json,workflow_node_id,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(job.id,canonical(compiled.graph),
     canonical(compiled.captureMap),compiled.graphHash,canonical(mediaFiles),
     request.nodes[0].id,Date.now());
  });
 }
 const sending=new Set();
 async function submit({job,attemptId,submitMarker}){
  snapshotOf(job,trusted.id);
  const row=db.prepare("SELECT status,attempt_id,submit_marker FROM jobs WHERE id=?").get(job.id);
  if(!row||row.status!=="submitting"||row.attempt_id!==attemptId||row.submit_marker!==submitMarker)
   throw fail("unsafe_comfy_submit",409);
  const prepared=getPreparation(db,job.id);
  if(!prepared)throw fail("comfy_compilation_not_persisted",409);
  if(sending.has(job.id))throw fail("comfy_submit_in_flight",409);
  sending.add(job.id);
  try{
   let result;
   try{
    result=await upstreamCall(trusted,"/prompt",{method:"POST",body:JSON.stringify({
     prompt:prepared.graph,client_id:attemptId,
     extra_data:{infinite_atelier_submit_marker:submitMarker}
    })});
   }catch(error){
    if(error?.confirmedNotAccepted===true||error?.promptRejected===true||
       ["comfy_upstream_400","comfy_upstream_422"].includes(error?.code)){
      throw Object.assign(fail("comfy_prompt_rejected",422),{confirmedNotAccepted:true});
    }
    throw error; // ambiguous: JobCoordinator -> submission_unknown
   }
   if(result?.error&&!result?.prompt_id)
    throw Object.assign(fail("comfy_prompt_rejected",422),{confirmedNotAccepted:true});
   if(!validRemoteId(result?.prompt_id))throw fail("comfy_prompt_id_missing",502);
   return {kind:"accepted",remoteTaskId:result.prompt_id};
  }finally{sending.delete(job.id)}
 }
 async function poll({job,remoteTaskId}){
  snapshotOf(job,trusted.id);
  if(!validRemoteId(remoteTaskId))throw fail("comfy_remote_task_invalid",400);
  const history=await upstreamCall(trusted,"/history/"+encodeURIComponent(remoteTaskId));
  const entry=historyEntry(history,remoteTaskId);
  if(!entry)return {kind:"pending"};
  if(failed(entry))return {kind:"failed"};
  if(successful(entry))return {kind:"completed",receipt:{remoteTaskId}};
  return {kind:"pending"};
 }
 async function collect({job,remoteTaskId,db:database}){
  snapshotOf(job,trusted.id);
  if(db!==database)throw fail("comfy_database_mismatch",409);
  if(!validRemoteId(remoteTaskId))throw fail("comfy_remote_task_invalid",400);
  const preparation=getPreparation(db,job.id);
  if(!preparation)throw fail("comfy_compilation_not_persisted",409);
  const result=await upstreamCall(trusted,"/history/"+encodeURIComponent(remoteTaskId));
  const entry=historyEntry(result,remoteTaskId);
  if(!successful(entry)||failed(entry))throw fail("comfy_history_not_completed",409);
  for(const cap of preparation.captures){
   const candidates=extractCapture(entry.outputs?.[cap.captureNodeId],cap);
   if(!candidates.length&&cap.required)throw fail("capture_missing:"+cap.portId,409);
   for(const [index,item] of candidates.entries()){
    const prior=db.prepare("SELECT id FROM artifacts WHERE job_id=? AND port_id=? AND item_key=?")
      .get(job.id,cap.portId,item.key);
    if(prior)continue; // collection is resumable; never download a duplicate again
    let blob;
    if(item.type==="inline"){
     const bytes=Buffer.from(item.text,"utf8");
     if(bytes.length>captureLimits.text)throw fail("capture_quota_exceeded",413);
     blob=await blobStore.put([bytes],{mime:"text/plain"});
    }else{
     blob=await storeCapturedFile({instance:trusted,cap,item,blobStore,upstreamCall});
    }
    const artifactId=randomUUID();
    const provenance=makeComfyArtifactProvenance({
     runId:job.id,artifactId,workflowNodeId:cap.workflowNodeId,
     portId:cap.portId,kind:cap.kind,index
    });
    appendArtifact(db,{id:artifactId,jobId:job.id,portId:cap.portId,itemKey:item.key,
     blobId:blob.blobId,sha256:blob.sha256,mime:blob.mimeType,kind:cap.kind,
     metadata:{comfyArtifact:provenance,provenance:{jobId:job.id,sourceNodeId:cap.workflowNodeId,
      portId:cap.portId,captureNodeId:cap.captureNodeId,index,
      adapterVersion:cap.adapterVersion,...(item.type==="file"?{filename:item.filename}:{})}}
    });
   }
  }
 }
 return {prepare,submit,poll,collect,instance:trusted};
}
export function createComfyV2Adapters({instances,db,blobStore,upstreamCall}={}){
 if(!Array.isArray(instances)||instances.length>16)throw fail("invalid_comfy_instances",400);
 const adapters=Object.create(null);
 for(const raw of instances){
  const instance=validateInstance(raw);
  if(Object.hasOwn(adapters,instance.id))throw fail("duplicate_comfy_instance",400);
  adapters[instance.id]=createComfyV2Adapter({instance,db,blobStore,upstreamCall});
 }
 return adapters;
}
