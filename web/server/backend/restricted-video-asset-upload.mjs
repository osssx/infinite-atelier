import {writeTransaction} from "./repository.mjs";
import {createHash} from "node:crypto";

const fail=(code,confirmedNotAccepted=false)=>Object.assign(Error(code),
 {code,statusCode:422,confirmedNotAccepted});
const validId=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value);

/** One immutable CAS item and one provider upload request per durable slot.
 * The 'uploading' row is written BEFORE the remote POST. If the reply is lost
 * or the process crashes, it is impossible to infer the remote asset ID:
 * block automatic replay until explicit provider reconciliation is provided.
 */
export function createScriptAssetUploadManager({db}={}){
 if(!db)throw Error("script_asset_upload_db_required");
 const lookup=db.prepare("SELECT * FROM script_asset_uploads WHERE job_id=? AND reference_index=?");
 function row(jobId,index){return lookup.get(jobId,index)}
 function requireId(jobId,index,ref){
  const saved=row(jobId,index);
  if(!saved||saved.blob_id!==ref.blobId||saved.status!=="active"||
     !validId(saved.remote_asset_id))
   throw fail("video_script_asset_not_ready");
  return saved.remote_asset_id;
 }
 async function ensureReady({job,index,ref,script,upload}){
  if(!job?.id||!Number.isSafeInteger(index)||index<0||
     !ref?.blobId||typeof script!=="string"||typeof upload!=="function")
   throw fail("video_script_asset_prepare_invalid",true);
  const fingerprint=createHash("sha256").update(script,"utf8").digest("hex");
  let saved=row(job.id,index);
  if(saved){
   if(saved.blob_id!==ref.blobId||saved.script_fingerprint!==fingerprint)
    throw fail("video_script_asset_identity_conflict",true);
   if(saved.status==="active")return requireId(job.id,index,ref);
   if(saved.status==="rejected")throw fail("video_script_asset_upload_rejected",true);
   // Ambiguous upload completion: never POST again.
   throw fail("video_script_asset_upload_unknown");
  }
  // The irreversible barrier and any concurrent loser are handled by SQLite.
  const changed=writeTransaction(db,()=>db.prepare(
   "INSERT OR IGNORE INTO script_asset_uploads(job_id,reference_index,blob_id,script_fingerprint,status,updated_at) VALUES(?,?,?,?,?,?)")
   .run(job.id,index,ref.blobId,fingerprint,"uploading",Date.now()).changes);
  if(changed!==1)throw fail("video_script_asset_upload_unknown");
  let result;
  try{result=await upload()}
  catch(error){
   if(error?.confirmedNotAccepted===true)
    db.prepare("UPDATE script_asset_uploads SET status='rejected',updated_at=? WHERE job_id=? AND reference_index=? AND status='uploading'")
     .run(Date.now(),job.id,index);
   throw error;
  }
  const assetId=typeof result==="string"?result:result?.id;
  if(!validId(assetId))throw fail("video_script_asset_id_unknown");
  const completed=db.prepare("UPDATE script_asset_uploads SET status='active',remote_asset_id=?,updated_at=? WHERE job_id=? AND reference_index=? AND blob_id=? AND script_fingerprint=? AND status='uploading'")
   .run(assetId,Date.now(),job.id,index,ref.blobId,fingerprint).changes;
  if(completed!==1)throw fail("video_script_asset_update_unknown");
  return assetId;
 }
 return {ensureReady,requireId,row};
}
