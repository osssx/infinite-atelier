import {randomUUID} from "node:crypto";
import {createReadStream,openAsBlob} from "node:fs";
import {createHash} from "node:crypto";
import {Readable} from "node:stream";
import {compileSingleWorkflow,verifyTemplate,validateSingleRequest,workflowObjectInfoClasses,canonical,sha256} from "../comfy-workflow/compiler.mjs";
import {resolveMediaCapabilities,validateMediaRequest} from "../../shared/media-capabilities.mjs";
import {readMediaDurationMs} from "./media-duration.mjs";
import {extractCapture,detectArtifactMime,captureLimits} from "../comfy-workflow/capture-adapters.mjs";
import {appendArtifact,writeTransaction} from "./repository.mjs";
import {makeComfyArtifactProvenance} from "./comfy-provenance.mjs";
import {parseComfyExecutionError,parseComfyPromptError} from "./comfy-live.mjs";

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
    if(path==="/prompt"&&method==="POST"&&[400,422].includes(response.status)){
     let diagnostic=null;
     try{
      const chunks=[];let size=0;
      for await(const chunk of response.body??[]){
       size+=chunk.length;if(size>65536)break;
       chunks.push(Buffer.from(chunk));
      }
      if(size<=65536)diagnostic=parseComfyPromptError(JSON.parse(Buffer.concat(chunks).toString("utf8")));
     }catch{/* malformed upstream details must not turn a confirmed rejection into an unknown submit */}
     throw Object.assign(fail("comfy_prompt_rejected",422),{confirmedNotAccepted:true,comfyDiagnostic:diagnostic});
    }
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
  // Legacy /queue deletion returns HTTP 200 with an empty body.
  if(path==="/queue"&&method==="POST"&&total===0)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"))}
  catch{throw fail("comfy_invalid_json",502)}
 }finally{clearTimeout(timer)}
}
/** Query only schemas used by this workflow. No cross-job schema cache: a
 * Comfy restart/model-list change is observed on the next preparation.
 * Preserve compatibility with servers lacking the per-class route and very
 * large templates; the full catalog remains available for the settings UI.
 * All requests (including compatibility fallback) share one original deadline.
 */
export async function readComfyWorkflowObjectInfo(instance,classTypes,{upstreamCall=comfyUpstream,timeoutMs=45000}={}){
 const trusted=validateInstance(instance);
 const types=[...new Set(classTypes)].sort();
 const deadline=Date.now()+timeoutMs;
 const call=async path=>{
  const remaining=deadline-Date.now();
  if(remaining<=0)throw fail("comfy_object_info_timeout",502);
  const result=await upstreamCall(trusted,path,{timeoutMs:remaining});
  if(!result||typeof result!=="object"||Array.isArray(result))throw fail("comfy_object_info_invalid",502);
  return result;
 };
 if(types.length>32||types.some(type=>typeof type!=="string"||!type||type==="."||type===".."||/[\\/]/.test(type)))
  return call("/object_info");
 const info=Object.create(null);
 for(const type of types){
  let result;
  try{result=await call("/object_info/"+encodeURIComponent(type));}
  catch(error){
   if(["comfy_upstream_404","comfy_upstream_405"].includes(error?.code))return call("/object_info");
   throw error;
  }
  // Comfy returns {} for an absent class. Do not turn that into a full
  // directory fetch or silently supply a fabricated schema.
  if(Object.hasOwn(result,type)){
   if(!result[type]||typeof result[type]!=="object"||Array.isArray(result[type]))throw fail("comfy_object_info_invalid",502);
   info[type]=result[type];
  }
 }
 return info;
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
 validateSingleRequest(s.comfyRequest,s.comfyTemplate);verifyTemplate(s.comfyTemplate);
 if(s.comfyTargetBinding!==undefined){
  const target=s.comfyTargetBinding,binding=target?.binding,useCase=s.comfyTemplate.mediaUseCase;
  if(!target||!(["image","video","audio"].includes(target.mode))||!binding||
     binding.templateId!==s.comfyTemplate.id||binding.templateRevision!==s.comfyTemplate.revision||
     useCase?.channel!==target.mode||!binding.overrides||typeof binding.overrides!=="object"||Array.isArray(binding.overrides)||
     !binding.slots||typeof binding.slots!=="object"||Array.isArray(binding.slots))
   throw fail("comfy_target_binding_invalid",400);
  if(target.generationMode!==undefined&&(!useCase.mediaCapabilities||!useCase.modeBindings?.[target.generationMode]||
    !useCase.mediaCapabilities.modes.some(mode=>mode.id===target.generationMode&&mode.enabled)))
   throw fail("comfy_target_generation_mode_invalid",400);
  if(target.generationMode!==s.comfyRequest.runOptions?.mediaMode)
   throw fail("comfy_target_generation_mode_mismatch",400);
 }
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
/** ComfyUI 0.45 records: [queueNo,promptId,graph,extraData,outputs]. */
function matchesOriginalSubmission({db,job,prepared,tuple,remoteTaskId}){
 if(!Array.isArray(tuple)||tuple.length<5||tuple[1]!==remoteTaskId||
    !tuple[2]||typeof tuple[2]!=="object"||Array.isArray(tuple[2])||
    !tuple[3]||typeof tuple[3]!=="object"||Array.isArray(tuple[3]))return false;
 const extra=tuple[3];
 if(extra.infinite_atelier_submit_marker!==job.submit_marker||
    canonical(tuple[2])!==prepared.graph_json)return false;
 if(extra.client_id!==undefined&&extra.client_id!==job.attempt_id){
  const submitted=db.prepare("SELECT id FROM job_attempts WHERE job_id=? AND phase IN ('submitting','running') AND id=?")
   .get(job.id,extra.client_id);
  if(!submitted)return false;
 }
 return true;
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
export function createComfyV2Adapter({instance,db,blobStore,upstreamCall=comfyUpstream,liveHub}={}){
 const trusted=validateInstance(instance);
 if(!db||!blobStore||typeof upstreamCall!=="function")throw Error("invalid_comfy_v2_adapter");
 async function prepare({job}){
  const snapshot=snapshotOf(job,trusted.id);
  if(getPreparation(db,job.id))return; // immutable compilation, including across restarts
  const request=snapshot.comfyRequest,template=snapshot.comfyTemplate;
  const classes=workflowObjectInfoClasses(request,template);
  const info=await readComfyWorkflowObjectInfo(trusted,classes,{upstreamCall});
  if(snapshot.localShotBatch&&classes.some(type=>info?.[type]?.api_node||info?.[type]?.apiNode))
   throw fail("shot_local_video_workflow_required",422);
  // Names are content-derived and uploads can safely be repeated before /prompt.
  const mediaFiles={};
  const allowed={
   IMAGE:{"image/png":"png","image/jpeg":"jpg","image/webp":"webp"},
   MASK:{"image/png":"png"},
   VIDEO:{"video/mp4":"mp4","video/webm":"webm","video/x-matroska":"mkv"},
   AUDIO:{"audio/wav":"wav","audio/flac":"flac","audio/ogg":"ogg","audio/mpeg":"mp3"}
  };
  const sizes={IMAGE:captureLimits.image,MASK:captureLimits.image,VIDEO:captureLimits.video,AUDIO:captureLimits.audio};
  const items=request.externalInputs.filter(x=>x.kind==="asset");
  const trustedMedia=new Map();
  for(const item of items){
   const blobId=snapshot.comfyAssetBlobs?.[item.assetId]??item.assetId;
   if(blobId!==item.sha256)throw fail("comfy_asset_snapshot_mismatch",400);
   const blob=await blobStore.stat(blobId);
   const extension=allowed[item.valueKind]?.[blob.mimeType];
   if(blob.sha256!==item.sha256||!extension)
    throw fail("comfy_asset_reference_invalid",400);
   if(blob.byteSize>sizes[item.valueKind])throw fail("comfy_asset_too_large",413);
   trustedMedia.set(item.sourceNodeId+"\0"+item.sourcePortId,{item,blob});
   mediaFiles[item.assetId]="atelier_"+item.sha256+"."+extension;
  }
  const useCase=template.mediaUseCase,modeId=request.runOptions?.mediaMode??useCase?.mediaCapabilities?.defaultMode;
  const modeSpec=useCase?.mediaCapabilities?.modes.find(mode=>mode.id===modeId);
  if(modeSpec){
   const modeBinding=useCase.modeBindings?.[modeId],refs=[];
   for(const [role,portIds] of Object.entries(modeBinding?.rolePorts??{}))for(const portId of portIds){
    for(const edge of request.edges.filter(edge=>edge.toNodeId===request.nodes[0]?.id&&edge.toPortId===portId)){
     const trusted=trustedMedia.get(edge.fromNodeId+"\0"+edge.fromPortId);if(!trusted)continue;
     const {item,blob}=trusted,kind=item.valueKind==="IMAGE"?"image":item.valueKind==="VIDEO"?"video":item.valueKind==="AUDIO"?"audio":"mask";
     const hasDurationLimit=modeSpec.inputs.some(rule=>rule.role===role&&rule.maxDurationSeconds!==undefined);
     const durationMs=hasDurationLimit&&(kind==="video"||kind==="audio")?await readMediaDurationMs(blob.path,blob.mimeType):undefined;
     if(hasDurationLimit&&(kind==="video"||kind==="audio")&&!durationMs)throw fail("media_reference_duration_unverified",422);
     refs.push({role,kind,mimeType:blob.mimeType,bytes:blob.byteSize,...(durationMs?{durationMs}:{})});
    }
   }
   const resolved=resolveMediaCapabilities({mediaCapabilities:useCase.mediaCapabilities},{kind:useCase.channel,
    supportedModes:Object.keys(useCase.modeBindings??{}),supportedParameters:Object.keys(modeBinding?.parameterPorts??{})});
   const runNode=request.nodes.find(node=>node.id===request.nodes[0]?.id);
   const overrides=runNode?.inputOverrides??{};
   const parameters=Object.fromEntries(modeSpec.parameters.map(spec=>[spec.id,modeBinding?.parameterPorts?.[spec.id]?overrides[modeBinding.parameterPorts[spec.id]]:undefined]));
   const diagnostics=validateMediaRequest({mode:modeId,references:refs,parameters},resolved);
   if(diagnostics.length)throw fail("media_capability_invalid",422);
  }
  // Compilation validates every port and target binding BEFORE any upload.
  const compiled=compileSingleWorkflow(request,template,{info,mediaFiles,mediaMode:request.runOptions?.mediaMode});
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
   const frozen=snapshotOf(job,trusted.id);
   const previewNodeId=prepared.previewNodeId??(frozen.comfyTemplate.previewBinding
    ?`w_${frozen.comfyRequest.nodes[0].id}__${frozen.comfyTemplate.previewBinding.nodeId}`:undefined);
   if(previewNodeId){
    try{liveHub?.observe({jobId:job.id,promptId:null,clientId:attemptId,url:trusted.url,graph:prepared.graph,previewNodeId})}catch{/* optional preview connection */}
    try{await liveHub?.waitReady?.(job.id,1000)}catch{/* optional preview connection */}
   }
   try{
    result=await upstreamCall(trusted,"/prompt",{method:"POST",body:JSON.stringify({
     prompt:prepared.graph,client_id:attemptId,
     extra_data:{infinite_atelier_submit_marker:submitMarker}
    })});
   }catch(error){
    if(error?.confirmedNotAccepted===true||error?.promptRejected===true||
       ["comfy_upstream_400","comfy_upstream_422"].includes(error?.code)){
      liveHub?.disconnect(job.id);
      throw Object.assign(fail("comfy_prompt_rejected",422),{confirmedNotAccepted:true,comfyDiagnostic:error?.comfyDiagnostic??null});
    }
    liveHub?.disconnect(job.id);
    throw error; // ambiguous: JobCoordinator -> submission_unknown
   }
   if(result?.error&&!result?.prompt_id){
    liveHub?.disconnect(job.id);
    throw Object.assign(fail("comfy_prompt_rejected",422),{confirmedNotAccepted:true,comfyDiagnostic:parseComfyPromptError(result)});
   }
   if(!validRemoteId(result?.prompt_id)){liveHub?.disconnect(job.id);throw fail("comfy_prompt_id_missing",502)}
   try{liveHub?.observe({jobId:job.id,promptId:result.prompt_id,clientId:attemptId,url:trusted.url,graph:prepared.graph,previewNodeId})}catch{/* submission is already accepted */}
   return {kind:"accepted",remoteTaskId:result.prompt_id};
  }finally{sending.delete(job.id)}
 }
 /**
  * Human-initiated reconciliation is GET-only. A manually supplied prompt ID
  * cannot be trusted unless Comfy's recorded submission marker AND the exact
  * immutable prepared graph both match this specific job. A missing history
  * entry is never proof that /prompt was not accepted.
  */
 async function reconcile({job,remoteTaskId}){
  snapshotOf(job,trusted.id);
  if(!validRemoteId(remoteTaskId))throw fail("comfy_remote_task_invalid",400);
  const prepared=getPreparation(db,job.id);
  if(!prepared||!job.submit_marker||!job.submission_started_at)
   throw fail("comfy_reconciliation_evidence_missing",409);
  const history=await upstreamCall(trusted,"/history/"+encodeURIComponent(remoteTaskId));
  const entry=historyEntry(history,remoteTaskId);
  if(entry){
   if(!matchesOriginalSubmission({db,job,prepared,tuple:entry.prompt,remoteTaskId}))
    return {kind:"mismatch"};
   if(failed(entry))return {kind:"failed"};
   if(successful(entry))return {kind:"completed"};
   return {kind:"pending"};
  }
  // A running prompt is not yet in /history. It may still be attested by the
  // original marker, immutable graph and client ID in /queue.
  const queue=await upstreamCall(trusted,"/queue",{timeoutMs:12000});
  const rows=[...(Array.isArray(queue?.queue_running)?queue.queue_running:[]),
              ...(Array.isArray(queue?.queue_pending)?queue.queue_pending:[])];
  const tuple=rows.find(value=>Array.isArray(value)&&value[1]===remoteTaskId);
  if(!tuple)return {kind:"unverified"};
  return {kind:matchesOriginalSubmission({db,job,prepared,tuple,remoteTaskId})?"pending":"mismatch"};
 }
 /** Explicit human-triggered, read-only, bounded candidate discovery.
  * No matching item is NOT proof that /prompt was rejected.
  */
 async function discover({job}){
  snapshotOf(job,trusted.id);
  const prepared=getPreparation(db,job.id);
  if(!prepared||!job.submit_marker||!job.submission_started_at)
   throw fail("comfy_reconciliation_evidence_missing",409);
  const queue=await upstreamCall(trusted,"/queue",{timeoutMs:12000});
  const history=await upstreamCall(trusted,"/history?max_items=16",{timeoutMs:12000});
  const ids=new Set();
  for(const group of [queue?.queue_running,queue?.queue_pending])
   for(const tuple of Array.isArray(group)?group:[]){
    const remoteTaskId=tuple?.[1];
    if(validRemoteId(remoteTaskId)&&matchesOriginalSubmission({db,job,prepared,tuple,remoteTaskId}))
     ids.add(remoteTaskId);
   }
  if(history&&typeof history==="object"&&!Array.isArray(history))
   for(const [remoteTaskId,entry] of Object.entries(history))
    if(validRemoteId(remoteTaskId)&&matchesOriginalSubmission({db,job,prepared,tuple:entry?.prompt,remoteTaskId}))
     ids.add(remoteTaskId);
  if(!ids.size)return {kind:"missing"};
  if(ids.size!==1)return {kind:"ambiguous"};
  return {kind:"found",remoteTaskId:[...ids][0]};
 }
 /** Cancel only the Comfy prompt ID returned for this immutable job.
  * Never call the unscoped /interrupt endpoint: older Comfy builds may
  * ignore prompt_id and interrupt another user's currently running prompt.
  */
 async function cancel({job,remoteTaskId}){
  snapshotOf(job,trusted.id);
  if(!validRemoteId(remoteTaskId)||job.upstream_task_id!==remoteTaskId)
   throw fail("comfy_cancel_target_mismatch",409);
  try{
   const result=await upstreamCall(trusted,"/api/jobs/"+encodeURIComponent(remoteTaskId)+"/cancel",
    {method:"POST",timeoutMs:12000});
   if(result?.cancelled===true){liveHub?.disconnect(job.id);return {cancelled:true}}
   return {cancelled:false,reason:"comfy_cancel_not_confirmed"};
  }catch(error){
   // Only an absent endpoint permits a backward-compatible queue removal.
   if(!["comfy_upstream_404","comfy_upstream_405"].includes(error?.code))
    throw error;
  }
  const list=await upstreamCall(trusted,"/queue",{timeoutMs:12000});
  const queued=Array.isArray(list?.queue_pending)?list.queue_pending:[];
  const running=Array.isArray(list?.queue_running)?list.queue_running:[];
  const contains=(entries)=>entries.some(row=>Array.isArray(row)&&row[1]===remoteTaskId);
  if(contains(running))return {cancelled:false,reason:"comfy_scoped_running_cancel_unsupported"};
  if(!contains(queued))return {cancelled:false,reason:"comfy_remote_task_not_queued"};
  await upstreamCall(trusted,"/queue",{
   method:"POST",body:JSON.stringify({delete:[remoteTaskId]}),timeoutMs:12000
  });
  // Check the actual queue: a queued prompt could have started while DELETE
  // was in flight. Never claim confirmed cancellation in that race.
  const after=await upstreamCall(trusted,"/queue",{timeoutMs:12000});
  if(contains(Array.isArray(after?.queue_running)?after.queue_running:[]))
   return {cancelled:false,reason:"comfy_cancel_raced_with_execution"};
  if(contains(Array.isArray(after?.queue_pending)?after.queue_pending:[]))
   return {cancelled:false,reason:"comfy_cancel_not_confirmed"};
  // A prompt can disappear from the queue by starting/finishing, not just deletion.
  // Check its remote history before claiming the old queue API cancelled it.
  let history;
  try{history=await upstreamCall(trusted,"/history/"+encodeURIComponent(remoteTaskId),{timeoutMs:12000})}
  catch{return {cancelled:false,reason:"comfy_cancel_history_unavailable"}}
  if(historyEntry(history,remoteTaskId))
   return {cancelled:false,reason:"comfy_cancel_raced_with_execution"};
  // Legacy queue DELETE returned no per-prompt acknowledgement. Absence
  // from /queue and /history is still not proof of remote cancellation.
  return {cancelled:false,reason:"comfy_legacy_queue_delete_unconfirmed"};
 }
 async function poll({job,remoteTaskId}){
  snapshotOf(job,trusted.id);
  if(!validRemoteId(remoteTaskId))throw fail("comfy_remote_task_invalid",400);
   const history=await upstreamCall(trusted,"/history/"+encodeURIComponent(remoteTaskId));
   const entry=historyEntry(history,remoteTaskId);
   if(!entry){
    const first=db.prepare("SELECT id FROM job_attempts WHERE job_id=? AND upstream_task_id=? ORDER BY started_at LIMIT 1").get(job.id,remoteTaskId);
    const snap=snapshotOf(job,trusted.id),prep=getPreparation(db,job.id);
    liveHub?.observe({jobId:job.id,promptId:remoteTaskId,clientId:first?.id??job.attempt_id,url:trusted.url,graph:prep?.graph,
     previewNodeId:snap.comfyTemplate.previewBinding?`w_${snap.comfyRequest.nodes[0].id}__${snap.comfyTemplate.previewBinding.nodeId}`:undefined});
    return {kind:"pending"};
   }
   if(failed(entry)){
    liveHub?.disconnect(job.id);
    const detail=Array.isArray(entry.status?.messages)?entry.status.messages
     .find(row=>Array.isArray(row)&&row[0]==="execution_error")?.[1]:null;
    return {kind:"failed",error:parseComfyExecutionError(detail)};
   }
   if(successful(entry)){liveHub?.disconnect(job.id);return {kind:"completed",receipt:{remoteTaskId}};}
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
  const captures=preparation.captures.map(cap=>({cap,candidates:extractCapture(entry.outputs?.[cap.captureNodeId],cap)}));
  const missing=captures.find(({cap,candidates})=>cap.required&&!candidates.length);
  if(missing)throw Object.assign(fail("capture_missing:"+missing.cap.portId,409),{permanentCollectFailure:true});
  for(const {cap,candidates} of captures){
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
 return {prepare,submit,poll,collect,cancel,reconcile,discover,instance:trusted};
}
export function createComfyV2Adapters({instances,db,blobStore,upstreamCall,liveHub}={}){
 if(!Array.isArray(instances)||instances.length>16)throw fail("invalid_comfy_instances",400);
 const adapters=Object.create(null);
 for(const raw of instances){
  const instance=validateInstance(raw);
  if(Object.hasOwn(adapters,instance.id))throw fail("duplicate_comfy_instance",400);
  adapters[instance.id]=createComfyV2Adapter({instance,db,blobStore,upstreamCall,liveHub});
 }
 return adapters;
}
