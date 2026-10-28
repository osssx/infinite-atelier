import {createHash} from "node:crypto";
import {writeTransaction,matchesSourceFingerprint} from "./repository.mjs";
import {validateRestrictedVideoSnapshot} from "./restricted-video-adapter.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const VALID_ID=/^[A-Za-z0-9_-]{1,128}$/;
const scriptHash=script=>createHash("sha256").update(script).digest("hex");

function loadJob(db,{projectId,jobId}){
 const job=db.prepare("SELECT * FROM jobs WHERE id=? AND project_id=? AND project_scope=?")
  .get(jobId,projectId,projectId);
 if(!job)throw fail("script_asset_job_not_found",404);
 let snapshot,validated;
 try{
  snapshot=JSON.parse(job.snapshot_json);
  validated=validateRestrictedVideoSnapshot(snapshot);
 }catch{throw fail("script_asset_job_not_eligible")}
 if(job.execution_mode!=="poll"||!validated.spec.assetUpload)
  throw fail("script_asset_job_not_eligible");
 return {job,snapshot,...validated};
}
function currentRows(db,jobId){
 return db.prepare("SELECT reference_index,blob_id,script_fingerprint,status,remote_asset_id,updated_at FROM script_asset_uploads WHERE job_id=? ORDER BY reference_index")
  .all(jobId);
}
function verifyRows(references,spec,rows){
 const expected=references.flatMap((ref,i)=>ref.kind==="image"?[]:[{index:i,ref}]);
 const byIndex=new Map(rows.map(row=>[row.reference_index,row]));
 const fingerprint=scriptHash(spec.assetUpload);
 if(rows.length!==expected.length||expected.some(({index,ref})=>{
  const value=byIndex.get(index);
  return !value||value.blob_id!==ref.blobId||
   value.script_fingerprint!==fingerprint;
 }))throw fail("script_asset_identity_mismatch");
 return {expected,byIndex};
}
function safeChunkResumption(db,{jobId,references,spec,expected,byIndex}){
 if(!spec.assetPartAudit||!spec.assetPartUrls)return false;
 const hasProof=db.prepare("SELECT 1 FROM job_events WHERE job_id=? AND kind='script_asset_chunks_verified' LIMIT 1").get(jobId);
 if(!hasProof)return false;
 const fingerprint=scriptHash(spec.assetUpload);
 return expected.every(({index,ref})=>{
  const row=byIndex.get(index);
  if(!row||row.blob_id!==ref.blobId||row.script_fingerprint!==fingerprint)
   return false;
  if(row.status==="active")return true;
  if(row.status!=="uploading")return false;
  const session=db.prepare("SELECT * FROM script_asset_chunk_sessions WHERE job_id=? AND reference_index=?").get(jobId,index);
  if(!session||session.blob_id!==ref.blobId||
     session.grant_fingerprint!==fingerprint||
     session.refresh_fingerprint!==scriptHash(spec.assetPartUrls))
   return false;
  const final=db.prepare("SELECT status FROM script_asset_finalizations WHERE job_id=? AND reference_index=?").get(jobId,index);
  if(final&&final.status==="finalizing")return false;
  const parts=db.prepare("SELECT status FROM script_asset_chunks WHERE job_id=? AND reference_index=? ORDER BY part_number").all(jobId,index);
  return parts.length===session.part_count&&parts.length>=2&&
   parts.every(x=>x.status==="ready"||x.status==="uploaded");
 });
}
function safeList(db,{projectId,jobId}){
 const {job,spec,references}=loadJob(db,{projectId,jobId});
 const rows=currentRows(db,jobId),byIndex=new Map(rows.map(row=>[row.reference_index,row]));
 const stages=new Map(db.prepare("SELECT reference_index,status,asset_id FROM script_asset_finalizations WHERE job_id=?").all(jobId).map(row=>[row.reference_index,row]));
 const chunkRows=db.prepare("SELECT reference_index,part_number,status FROM script_asset_chunks WHERE job_id=? ORDER BY reference_index,part_number").all(jobId);
 const chunkCounts=new Map();
 for(const part of chunkRows){
  const stats=chunkCounts.get(part.reference_index)??{total:0,uploaded:0,uncertain:0};
  stats.total++;
  if(part.status==="uploaded")stats.uploaded++;
  if(part.status==="uploading")stats.uncertain++;
  chunkCounts.set(part.reference_index,stats);
 }
 const fingerprint=scriptHash(spec.assetUpload);
 const assets=references.flatMap((ref,index)=>{
  if(ref.kind==="image")return [];
  const record=byIndex.get(index);
  const valid=record?.blob_id===ref.blobId&&record.script_fingerprint===fingerprint;
  return [{referenceIndex:index,kind:ref.kind,role:ref.role,
   blobId:ref.blobId,mimeType:ref.mimeType,
   status:valid?record.status:record?"mismatch":"not_started",
   remoteAssetId:valid&&record.status==="active"?record.remote_asset_id:null,
   finalizeStage:stages.get(index)?.status??null,
   chunkProgress:valid?chunkCounts.get(index)??null:null,
   expectedAssetId:valid&&stages.has(index)?stages.get(index).asset_id:null,
   updatedAt:valid?record.updated_at:null}];
 });
 const neverSubmitted=job.submission_started_at===null&&job.submit_marker===null&&
  job.upstream_task_id===null&&job.recovery_receipt_json===null;
 return {jobId:job.id,projectId,jobStatus:job.status,
  submissionNeverStarted:neverSubmitted,
  canResume:job.status==="failed"&&neverSubmitted&&assets.length>0&&
   rows.length===assets.length&&
   (assets.every(asset=>asset.status==="active")||
    safeChunkResumption(db,{jobId,references,spec,
     expected:references.flatMap((ref,index)=>ref.kind==="image"?[]:[{index,ref}]),byIndex})),
  canResumePreparation:job.status==="failed"&&neverSubmitted&&
   assets.some(asset=>asset.status==="uploading")&&rows.length===assets.length&&
   safeChunkResumption(db,{jobId,references,spec,
    expected:references.flatMap((ref,index)=>ref.kind==="image"?[]:[{index,ref}]),byIndex}),
  assets};
}
/** Local authenticated operator attests that an asset ID was verified outside
 * the app. This does not pretend the provider supplied cryptographic proof.
 */
export function reconcileScriptAsset(db,{projectId,jobId,referenceIndex,
 remoteAssetId,expectedUpdatedAt,action,operatorConfirmed}={}){
 if(!VALID_ID.test(projectId??"")||!VALID_ID.test(jobId??"")||
  !Number.isSafeInteger(referenceIndex)||referenceIndex<0||
  !Number.isSafeInteger(expectedUpdatedAt)||expectedUpdatedAt<1||
  !["confirm","reject"].includes(action)||operatorConfirmed!==true||
  action==="confirm"&&!VALID_ID.test(remoteAssetId??"")||
  action==="reject"&&remoteAssetId!==undefined)
  throw fail("script_asset_reconcile_invalid",400);
 return writeTransaction(db,()=>{
  const {job,spec,references}=loadJob(db,{projectId,jobId});
  if(job.status!=="failed"||job.lease_owner!==null||
     job.submission_started_at!==null||job.submit_marker!==null||
     job.upstream_task_id!==null||job.recovery_receipt_json!==null)
   throw fail("script_asset_reconcile_not_eligible");
  const ref=references[referenceIndex],row=db.prepare(
   "SELECT * FROM script_asset_uploads WHERE job_id=? AND reference_index=?")
   .get(jobId,referenceIndex);
  if(!ref||ref.kind==="image"||!row||row.blob_id!==ref.blobId||
     row.script_fingerprint!==scriptHash(spec.assetUpload))
   throw fail("script_asset_identity_mismatch");
  if(row.updated_at!==expectedUpdatedAt)
   throw fail("script_asset_reconcile_state_changed");
  if(row.status!=="uploading")
   throw fail("script_asset_reconcile_not_eligible");
  if(action==="confirm"){
   const stage=db.prepare("SELECT asset_id FROM script_asset_finalizations WHERE job_id=? AND reference_index=?").get(jobId,referenceIndex);
   if(stage&&stage.asset_id!==remoteAssetId)
    throw fail("script_asset_remote_id_conflict");
   const session=db.prepare("SELECT asset_id FROM script_asset_chunk_sessions WHERE job_id=? AND reference_index=?").get(jobId,referenceIndex);
   if(session&&session.asset_id!==remoteAssetId)
    throw fail("script_asset_remote_id_conflict");
  }
  if(action==="confirm"){
   const duplicate=db.prepare(
    "SELECT reference_index FROM script_asset_uploads WHERE job_id=? AND remote_asset_id=? AND status='active' AND reference_index<>?")
    .get(jobId,remoteAssetId,referenceIndex);
   if(duplicate)throw fail("script_asset_remote_id_conflict");
  }
  const next=action==="confirm"?"active":"rejected";
  const now=Date.now(),changed=db.prepare(
   "UPDATE script_asset_uploads SET status=?,remote_asset_id=?,updated_at=? WHERE job_id=? AND reference_index=? AND status='uploading' AND updated_at=?")
   .run(next,action==="confirm"?remoteAssetId:null,now,jobId,referenceIndex,expectedUpdatedAt).changes;
  if(changed!==1)throw fail("script_asset_reconcile_state_changed");
  db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
   .run(jobId,"script_asset_reconciled",JSON.stringify({referenceIndex,
    action,operatorAttested:true}),now);
  return {jobId,referenceIndex,status:next,jobStatus:job.status,
   ...(next==="active"?{remoteAssetId}:{} )};
 });
}
export function listScriptAssetReconciliation(db,{projectId,jobId}={}){
 if(!VALID_ID.test(projectId??"")||!VALID_ID.test(jobId??""))
  throw fail("script_asset_reconcile_invalid",400);
 return safeList(db,{projectId,jobId});
}
/** Explicit resume; never rewrites the original job, task, submit marker,
 * attempt receipts, or idempotency key. Requires all uploads verified.
 */
export function resumeReconciledVideoJob(db,{projectId,jobId}={}){
 if(!VALID_ID.test(projectId??"")||!VALID_ID.test(jobId??""))
  throw fail("script_asset_reconcile_invalid",400);
 return writeTransaction(db,()=>{
  const {job,snapshot,spec,references}=loadJob(db,{projectId,jobId});
  if(job.status!=="failed"||job.lease_owner!==null||
    job.submission_started_at!==null||job.submit_marker!==null||
    job.upstream_task_id!==null||job.recovery_receipt_json!==null||
    job.attempt_id!==null)
   throw fail("script_asset_resume_not_eligible");
  const last=db.prepare("SELECT outcome FROM job_attempts WHERE job_id=? ORDER BY started_at DESC,id DESC LIMIT 1").get(jobId);
  if(last?.outcome!=="prepare_failed")throw fail("script_asset_resume_not_eligible");
  // A failed prepare with preexisting active assets is not automatically
  // equivalent to a human-reconciled uncertain upload. Require an explicit
  // operator attestation recorded for this exact job.
  const attested=db.prepare("SELECT 1 FROM job_events WHERE job_id=? AND (kind='script_asset_chunks_verified' OR kind='script_asset_reconciled' AND json_extract(payload_json,'$.action')='confirm') LIMIT 1").get(jobId);
  if(!attested)throw fail("script_asset_resume_not_eligible");
  const rows=currentRows(db,jobId);
  const {expected,byIndex}=verifyRows(references,spec,rows);
  if(expected.length===0||!(expected.every(({index})=>byIndex.get(index).status==="active"&&
      VALID_ID.test(byIndex.get(index).remote_asset_id))||
      safeChunkResumption(db,{jobId,references,spec,expected,byIndex})))
   throw fail("script_asset_uploads_incomplete");
  const credential=db.prepare("SELECT channel_id,revoked_at FROM credential_versions WHERE id=?")
   .get(snapshot.secretVersionRef);
  if(!credential||credential.channel_id!==snapshot.channelId||credential.revoked_at!==null)
   throw fail("script_asset_credential_unavailable");
  if(job.project_id!==null){
   const project=db.prepare("SELECT document_json,revision,deleted_at FROM projects WHERE id=?")
    .get(projectId);
   if(!project||project.deleted_at!==null||
     project.revision!==job.expected_project_revision||
     !matchesSourceFingerprint(JSON.parse(project.document_json),
      job.target_node_id,job.source_fingerprint,snapshot))
    throw fail("script_asset_source_changed");
   // Do not overlap another in-flight model generation on the same source.
   const other=db.prepare("SELECT 1 FROM jobs WHERE principal=? AND project_id=? AND target_node_id=? AND id<>? AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1")
    .get(job.principal,projectId,job.target_node_id,jobId);
   if(other)throw fail("script_asset_source_busy");
  }
  const now=Date.now();
  const changed=db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=? AND status='failed' AND submission_started_at IS NULL AND submit_marker IS NULL AND upstream_task_id IS NULL AND lease_owner IS NULL")
   .run(now,jobId).changes;
  if(changed!==1)throw fail("script_asset_resume_not_eligible");
  db.prepare("DELETE FROM job_schedules WHERE job_id=?").run(jobId);
  db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
   .run(jobId,"script_asset_resume_approved",
    JSON.stringify({from:"failed",to:"queued",verifiedAssets:expected.length}),now);
  return {jobId,status:"queued",resumed:true,verifiedAssets:expected.length};
 });
}
