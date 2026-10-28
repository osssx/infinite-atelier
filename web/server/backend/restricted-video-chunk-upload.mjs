import {writeTransaction} from "./repository.mjs";
import {createHash} from "node:crypto";
import {validateSignedPutAsset,validateSignedPutUrl} from "./restricted-video-signed-put.mjs";
const fail=code=>Object.assign(Error(code),{code,statusCode:422});
const id=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const etag=x=>typeof x==="string"&&x.length>=2&&x.length<=128&&
 /^"?[A-Za-z0-9._-]+"?$/.test(x)&&!/[\r\n]/.test(x);
const signature=script=>createHash("sha256").update(script,"utf8").digest("hex");
const MAX_PARTS=8;
const MIN_PART_SIZE=1,MAX_PART_SIZE=8*1024*1024;

/** Frozen CAS references and upload-session metadata stay durable. Transient
 * signed URLs are NEVER stored. Each PUT is fenced before the network call.
 * A response loss leaves 'uploading' and can only be reconciled manually.
 */
export function createRestrictedVideoChunkManager({db,putSignedAsset}={}){
 if(!db||typeof putSignedAsset!=="function")throw Error("chunk_upload_dependencies_required");
 const sessionSQL="SELECT * FROM script_asset_chunk_sessions WHERE job_id=? AND reference_index=?";
 const rowsSQL="SELECT * FROM script_asset_chunks WHERE job_id=? AND reference_index=? ORDER BY part_number";
 function inspect(jobId,index){return db.prepare(sessionSQL).get(jobId,index)}
 function chunks(jobId,index){return db.prepare(rowsSQL).all(jobId,index)}
 function normalizeUrls(value,{assetId,partCount,partSize,allowOmitSize=false}){
  if(!value||typeof value!=="object"||Array.isArray(value)||
    Object.keys(value).some(k=>!["id","partSize","parts"].includes(k))||
    value.id!==assetId||
    !Array.isArray(value.parts)||value.parts.length!==partCount||
    (!allowOmitSize||value.partSize!==undefined)&&value.partSize!==partSize)
   throw fail("video_script_chunk_grant_invalid");
  const urls=new Map();
  for(const part of value.parts){
   if(!part||typeof part!=="object"||Array.isArray(part)||
      Object.keys(part).some(k=>!["partNumber","uploadUrl"].includes(k))||
      !Number.isSafeInteger(part.partNumber)||part.partNumber<1||
      part.partNumber>partCount||urls.has(part.partNumber))
    throw fail("video_script_chunk_parts_invalid");
   validateSignedPutUrl(part.uploadUrl);
   urls.set(part.partNumber,part.uploadUrl);
  }
  return urls;
 }
 function assertSession(session,{job,index,ref,script,partScript,bytes}){
  if(!session||session.blob_id!==ref.blobId||
   session.grant_fingerprint!==signature(script)||
   session.refresh_fingerprint!==signature(partScript)||
   session.byte_size!==bytes.length||
   !id(session.asset_id)||
   session.part_size<MIN_PART_SIZE||session.part_size>MAX_PART_SIZE||
   session.part_count<2||session.part_count>MAX_PARTS||
   session.part_count!==Math.ceil(bytes.length/session.part_size))
   throw fail("video_script_chunk_identity_mismatch");
  const parts=chunks(job.id,index);
  if(parts.length!==session.part_count||
    parts.some((part,i)=>part.part_number!==i+1||!["ready","uploading","uploaded"].includes(part.status)))
   throw fail("video_script_chunk_identity_mismatch");
  return parts;
 }
 /** Provider attestation must be exact for every unknown part. A missing
  * part is NOT proof it was never stored; it remains non-replayable.
  * Verify all evidence and the frozen job state in a single transaction.
  */
 function reconcileUnknown({job,index,ref,script,partScript,asset,
  auditScript,remote,expectedUpdatedAt}){
  const bytes=validateSignedPutAsset(asset);
  if(typeof auditScript!=="string"||!auditScript.trim()||
     !Number.isSafeInteger(expectedUpdatedAt)||expectedUpdatedAt<1)
   throw fail("video_script_chunk_audit_invalid");
  return writeTransaction(db,()=>{
   const current=db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id);
   const upload=db.prepare("SELECT * FROM script_asset_uploads WHERE job_id=? AND reference_index=?")
    .get(job.id,index);
   const session=inspect(job.id,index);
   const parts=assertSession(session,{job,index,ref,script,partScript,bytes});
   if(!current||current.status!=="failed"||current.lease_owner!==null||
    current.submission_started_at!==null||current.submit_marker!==null||
    current.upstream_task_id!==null||current.recovery_receipt_json!==null||
    !upload||upload.status!=="uploading"||
    upload.blob_id!==ref.blobId||upload.script_fingerprint!==signature(script)||
    upload.updated_at!==expectedUpdatedAt)
    throw fail("video_script_chunk_audit_not_eligible");
   const unknown=parts.filter(p=>p.status==="uploading");
   if(unknown.length===0)throw fail("video_script_chunk_audit_not_eligible");
   if(!remote||typeof remote!=="object"||Array.isArray(remote)||
    Object.keys(remote).some(k=>!["id","parts"].includes(k))||
    remote.id!==session.asset_id||!Array.isArray(remote.parts)||
    remote.parts.length>session.part_count)
    throw fail("video_script_chunk_audit_evidence_invalid");
   const got=new Map();
   for(const part of remote.parts){
    if(!part||typeof part!=="object"||Array.isArray(part)||
     Object.keys(part).some(k=>!["partNumber","etag"].includes(k))||
     !Number.isSafeInteger(part.partNumber)||part.partNumber<1||
     part.partNumber>session.part_count||got.has(part.partNumber)||
     !etag(part.etag))
     throw fail("video_script_chunk_audit_evidence_invalid");
    got.set(part.partNumber,part.etag);
   }
   for(const part of parts){
    if(part.status==="uploaded"&&got.has(part.part_number)&&
      got.get(part.part_number)!==part.etag)
     throw fail("video_script_chunk_audit_etag_conflict");
    if(part.status==="ready"&&got.has(part.part_number))
     throw fail("video_script_chunk_audit_unsent_conflict");
   }
   // No partial acceptance: all uncertain parts need explicit remote proof.
   if(unknown.some(part=>!got.has(part.part_number)))
    return {verified:false,reason:"remote_evidence_incomplete",unknown:unknown.length};
   const now=Date.now();
   for(const part of unknown){
    const changed=db.prepare("UPDATE script_asset_chunks SET status='uploaded',etag=?,updated_at=? WHERE job_id=? AND reference_index=? AND part_number=? AND status='uploading'")
     .run(got.get(part.part_number),now,job.id,index,part.part_number).changes;
    if(changed!==1)throw fail("video_script_chunk_audit_state_changed");
   }
   db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
    .run(job.id,"script_asset_chunks_verified",JSON.stringify({
     referenceIndex:index,partNumbers:unknown.map(x=>x.part_number),
     verifiedBy:"provider_read_only",assetId:session.asset_id
    }),now);
   return {verified:true,verifiedParts:unknown.length,
    readyParts:parts.filter(x=>x.status==="ready").length,
    assetId:session.asset_id};
  });
 }
 async function uploadPending({job,index,ref,script,partScript,asset,urls,allowResume}){
  const bytes=validateSignedPutAsset(asset),session=inspect(job.id,index);
  const parts=assertSession(session,{job,index,ref,script,partScript,bytes});
  if(parts.some(p=>p.status==="uploading"))
   throw fail("video_script_chunk_outcome_unknown");
  if(parts.every(p=>p.status==="uploaded"))return complete(job.id,index);
  if(!(urls instanceof Map)||urls.size!==session.part_count)
   throw fail("video_script_chunk_urls_unavailable");
  for(const part of parts){
   if(part.status==="uploaded")continue;
   if(part.status!=="ready")throw fail("video_script_chunk_outcome_unknown");
   const changed=writeTransaction(db,()=>db.prepare(
    "UPDATE script_asset_chunks SET status='uploading',updated_at=? WHERE job_id=? AND reference_index=? AND part_number=? AND status='ready'")
    .run(Date.now(),job.id,index,part.part_number).changes);
   if(changed!==1)throw fail("video_script_chunk_outcome_unknown");
   const start=(part.part_number-1)*session.part_size;
   const block=bytes.subarray(start,Math.min(bytes.length,start+session.part_size));
   const sha256=createHash("sha256").update(block).digest("hex");
   const piece={kind:asset.kind,mimeType:asset.mimeType,sha256,
    dataUrl:"data:"+asset.mimeType+";base64,"+block.toString("base64")};
   let receipt;
   try{receipt=await putSignedAsset({uploadUrl:urls.get(part.part_number),asset:piece})}
   catch{throw fail("video_script_chunk_outcome_unknown")}
   if(!etag(receipt?.etag))throw fail("video_script_chunk_etag_unknown");
   const completed=writeTransaction(db,()=>db.prepare(
    "UPDATE script_asset_chunks SET status='uploaded',etag=?,updated_at=? WHERE job_id=? AND reference_index=? AND part_number=? AND status='uploading'")
    .run(receipt.etag,Date.now(),job.id,index,part.part_number).changes);
   if(completed!==1)throw fail("video_script_chunk_outcome_unknown");
  }
  return complete(job.id,index);
 }
 function complete(jobId,index){
  const session=inspect(jobId,index),parts=chunks(jobId,index);
  if(!session||parts.length!==session.part_count||
   parts.some(p=>p.status!=="uploaded"||!etag(p.etag)))
   throw fail("video_script_chunk_incomplete");
  return {id:session.asset_id,partEtags:parts.map(p=>({
   partNumber:p.part_number,etag:p.etag
  }))};
 }
 async function begin({job,index,ref,script,partScript,asset,grant}){
  const bytes=validateSignedPutAsset(asset);
  if(!grant||!id(grant.id)||!Number.isSafeInteger(grant.partSize)||
   grant.partSize<MIN_PART_SIZE||grant.partSize>MAX_PART_SIZE)
   throw fail("video_script_chunk_grant_invalid");
  const partCount=Math.ceil(bytes.length/grant.partSize);
  if(partCount<2||partCount>MAX_PARTS)throw fail("video_script_chunk_count_invalid");
  const urls=normalizeUrls(grant,{assetId:grant.id,partCount,partSize:grant.partSize});
  writeTransaction(db,()=>{
   const parent=db.prepare("SELECT status,blob_id FROM script_asset_uploads WHERE job_id=? AND reference_index=?")
    .get(job.id,index);
   if(!parent||parent.status!=="uploading"||parent.blob_id!==ref.blobId||
     inspect(job.id,index))throw fail("video_script_chunk_identity_mismatch");
   db.prepare("INSERT INTO script_asset_chunk_sessions(job_id,reference_index,blob_id,asset_id,grant_fingerprint,refresh_fingerprint,byte_size,part_size,part_count,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(job.id,index,ref.blobId,grant.id,signature(script),
     signature(partScript),bytes.length,grant.partSize,partCount,Date.now());
   const insert=db.prepare("INSERT INTO script_asset_chunks(job_id,reference_index,part_number,status,updated_at) VALUES(?,?,?,'ready',?)");
   for(let n=1;n<=partCount;n++)insert.run(job.id,index,n,Date.now());
  });
  return uploadPending({job,index,ref,script,partScript,asset,urls});
 }
 async function resume({job,index,ref,script,partScript,asset,refresh}){
  const bytes=validateSignedPutAsset(asset);
  const session=inspect(job.id,index);
  const parts=assertSession(session,{job,index,ref,script,partScript,bytes});
  if(parts.some(p=>p.status==="uploading"))
   throw fail("video_script_chunk_outcome_unknown");
  if(parts.every(p=>p.status==="uploaded"))return complete(job.id,index);
  if(typeof refresh!=="function")
   throw fail("video_script_chunk_urls_unavailable");
  // GET is a provider-guaranteed read-only re-sign operation; it cannot
  // create a new upload session. URLs never cross the persistence boundary.
  const grant=await refresh(session.asset_id);
  const urls=normalizeUrls(grant,{assetId:session.asset_id,
   partCount:session.part_count,partSize:session.part_size,allowOmitSize:true});
  return uploadPending({job,index,ref,script,partScript,asset,urls});
 }
 return {inspect,chunks,begin,resume,complete,reconcileUnknown};
}
