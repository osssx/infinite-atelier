import {writeTransaction} from "./repository.mjs";
import {createHash} from "node:crypto";

const failure=code=>Object.assign(Error(code),{code,statusCode:409});
const validId=id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
const fingerprint=script=>createHash("sha256").update(script,"utf8").digest("hex");
/**
 * A successful PUT can be resumed at finalize without re-uploading.
 * No signed URL is persisted, only the remote ID and frozen script hash.
 * Once finalize starts, the outcome is ambiguous until a human reconciles.
 */
export function createScriptAssetFinalizeManager({db}={}){
 if(!db)throw Error("script_asset_finalize_db_required");
 const get=db.prepare("SELECT * FROM script_asset_finalizations WHERE job_id=? AND reference_index=?");
 function inspect(jobId,index){return get.get(jobId,index)}
 function assertIdentity(item,{job,index,ref,script}){
  if(!item||item.blob_id!==ref.blobId||item.finalize_fingerprint!==fingerprint(script))
   throw failure("script_asset_finalize_identity_mismatch");
 }
 function recordUploaded({job,index,ref,script,assetId}){
  if(!job?.id||!Number.isSafeInteger(index)||index<0||
   !ref?.blobId||typeof script!=="string"||!validId(assetId))
   throw failure("script_asset_finalize_invalid");
  return writeTransaction(db,()=>{
   const base=db.prepare("SELECT status,blob_id FROM script_asset_uploads WHERE job_id=? AND reference_index=?")
    .get(job.id,index);
   if(!base||base.status!=="uploading"||base.blob_id!==ref.blobId)
    throw failure("script_asset_finalize_not_ready");
   const already=inspect(job.id,index);
   if(already)throw failure("script_asset_finalize_exists");
   db.prepare("INSERT INTO script_asset_finalizations(job_id,reference_index,blob_id,finalize_fingerprint,asset_id,status,updated_at) VALUES(?,?,?,?,?,'uploaded',?)")
    .run(job.id,index,ref.blobId,fingerprint(script),assetId,Date.now());
   return assetId;
  });
 }
 async function finalize({job,index,ref,script,call}){
  const item=inspect(job.id,index);
  assertIdentity(item,{job,index,ref,script});
  if(item.status!=="uploaded")throw failure("script_asset_finalize_outcome_unknown");
  const changed=writeTransaction(db,()=>db.prepare(
   "UPDATE script_asset_finalizations SET status='finalizing',updated_at=? WHERE job_id=? AND reference_index=? AND status='uploaded' AND blob_id=? AND finalize_fingerprint=?")
   .run(Date.now(),job.id,index,ref.blobId,fingerprint(script)).changes);
  if(changed!==1)throw failure("script_asset_finalize_outcome_unknown");
  let result;
  try{result=await call(item.asset_id)}
  catch{throw failure("script_asset_finalize_outcome_unknown")}
  const resultId=typeof result==="string"?result:result?.id;
  if(resultId!==item.asset_id)throw failure("script_asset_finalize_id_mismatch");
  return writeTransaction(db,()=>{
   const now=Date.now();
   const changed=db.prepare("UPDATE script_asset_uploads SET status='active',remote_asset_id=?,updated_at=? WHERE job_id=? AND reference_index=? AND blob_id=? AND status='uploading'")
    .run(item.asset_id,now,job.id,index,ref.blobId).changes;
   if(changed!==1)throw failure("script_asset_finalize_outcome_unknown");
   const stage=db.prepare("UPDATE script_asset_finalizations SET status='completed',updated_at=? WHERE job_id=? AND reference_index=? AND status='finalizing'")
    .run(now,job.id,index).changes;
   if(stage!==1)throw failure("script_asset_finalize_outcome_unknown");
   return item.asset_id;
  });
 }
 return {inspect,recordUploaded,finalize};
}
