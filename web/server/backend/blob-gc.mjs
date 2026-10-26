import {lstatSync,unlinkSync} from "node:fs";
import {writeTransaction} from "./repository.mjs";
import {currentBlobReferences,persistedBlobReferences,rebuildBlobReferenceLedger,blobReferenceLedgerStatus} from "./blob-reference-ledger.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const DAY=86400000;
const MAX_PER_SWEEP=50;
export const referencedBlobHashes=currentBlobReferences;
/** Explicit maintenance only: dry-run by default, no background deletions.
 * Apply requires exact confirmation and at least seven days of inactivity.
 * Each candidate has a synchronous write transaction, with a fresh reference
 * scan and FK checks before unlinking. Separate transactions prevent a later
 * I/O failure rolling back rows for files already removed. The runtime's
 * exclusive instance lock keeps other processes from mutating the store.
 */
export function createBlobGarbageCollector({db,blobStore}={}){
 if(!db||!blobStore)throw Error("invalid_blob_gc");
 function sweep({dryRun=true,confirmation,now=Date.now(),limit=MAX_PER_SWEEP}={}){
  if(!dryRun&&confirmation!=="DELETE_UNREFERENCED")throw fail("gc_confirmation_required",400);
  if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_PER_SWEEP)throw fail("invalid_gc_limit",400);
  if(blobStore.hasActiveUploads())throw fail("gc_upload_in_progress",409);
  // Rebuild dirty persisted ownership records before evaluating deletions.
  // Dry runs never delete media; a ledger refresh is a SQLite-only audit write.
  if(blobReferenceLedgerStatus(db).dirty)rebuildBlobReferenceLedger(db);
  function scan(){
   if(blobStore.hasActiveUploads())throw fail("gc_upload_in_progress",409);
   const referenced=referencedBlobHashes(db);
   for(const hash of persistedBlobReferences(db))referenced.add(hash);
   const rows=db.prepare("SELECT id,byte_size,mime,status FROM blobs WHERE status='ready' ORDER BY id").all();
   const candidates=[];let totalBytes=0,kept=0,protectedRecent=0,missing=0;
   for(const row of rows){
    totalBytes+=row.byte_size;
    if(referenced.has(row.id)){kept++;continue}
    const path=blobStore.pathFor(row.id);
    if(!path)throw fail("gc_invalid_blob_id",500);
    let fsStat;
    try{fsStat=lstatSync(path)}
    catch(e){if(e.code==="ENOENT"){missing++;continue}throw e}
    if(!fsStat.isFile()||fsStat.isSymbolicLink()||fsStat.size!==row.byte_size)
     throw fail("gc_blob_integrity_error",503);
    // File creation time, not "last read": a restored/renamed file must
    // still spend a full grace window in the store before eligible deletion.
    const age=Math.max(fsStat.birthtimeMs,fsStat.mtimeMs);
    if(!Number.isFinite(age)||age>now-7*DAY){protectedRecent++;continue}
    if(candidates.length<limit)candidates.push({id:row.id,bytes:row.byte_size,mimeType:row.mime});
   }
   return {dryRun:true,totalBlobs:rows.length,totalBytes,referenced:kept,
    recentlyCreated:protectedRecent,missingOnDisk:missing,
    candidates,deletedCount:0,deletedBytes:0,limit,graceDays:7};
  }
  const inspection=scan();
  if(dryRun)return inspection;
  const removed=[];
  for(const item of inspection.candidates){
   const deleted=writeTransaction(db,()=>{
    if(blobStore.hasActiveUploads())throw fail("gc_upload_in_progress");
    if(blobReferenceLedgerStatus(db).dirty)throw fail('gc_reference_ledger_dirty');
    if(referencedBlobHashes(db).has(item.id)||persistedBlobReferences(db).has(item.id))return false;
    const row=db.prepare("SELECT byte_size FROM blobs WHERE id=? AND status='ready'").get(item.id);
    if(!row)return false;
    const path=blobStore.pathFor(item.id),info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size!==row.byte_size)
     throw fail("gc_blob_integrity_error",503);
    if(Math.max(info.birthtimeMs,info.mtimeMs)>now-7*DAY)return false;
    // Verify all FK constraints before removing bytes.
    const result=db.prepare("DELETE FROM blobs WHERE id=? AND status='ready'").run(item.id);
    if(result.changes!==1)throw fail("gc_delete_race",409);
    unlinkSync(path); // the row rolls back if filesystem removal fails
    return true;
   });
   if(deleted)removed.push(item);
  }
  return {...inspection,dryRun:false,candidates:removed,deletedCount:removed.length,
   deletedBytes:removed.reduce((n,x)=>n+x.bytes,0)};
 }
 return {sweep};
}
