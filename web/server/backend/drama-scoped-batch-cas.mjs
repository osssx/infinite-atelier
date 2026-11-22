/** P3.3e: one durable, explicit CAS batch across scoped creative entries.
 * This does NOT execute frozen Assistant Task plans or bypass their approval.
 * Each edit still uses the same validators as its existing single-entry route,
 * but the entire batch shares ONE SQLite transaction, revision and receipt.
 */
import {createHash} from "node:crypto";
import {validCanvasNodeId} from "../canvas-node-id.mjs";
import {writeTransaction,stableJson,assertNoRawCredentials} from "./repository.mjs";
import {applyDramaEntryDraftWithinTransaction} from "./drama-entry-cas.mjs";
import {tryPatchIndexedShotDraft} from "./drama-shot-cas.mjs";

const fail=(code,statusCode=422)=>Object.assign(Error(code),{code,statusCode});
const hash=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const opId=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const entryId=x=>typeof x==="string"&&x.length>0&&x.length<=256;
export const DRAMA_SCOPE_BATCH_SCHEMA=`
 CREATE TABLE IF NOT EXISTS drama_scope_batch_operations(
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  project_revision INTEGER NOT NULL CHECK(project_revision>=1),
  committed_at INTEGER NOT NULL,
  PRIMARY KEY(project_id,operation_id)
 );`;

export function patchDramaScopedBatch(db,projectId,command,validateDocument,emitEvent){
 const {operationId,expectedRevision,edits}=command??{};
 if(!opId(operationId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1||
  !Array.isArray(edits)||edits.length<1||edits.length>16)
  throw fail("drama_batch_invalid",400);
 const seen=new Set();
 for(const edit of edits){
  if(!edit||typeof edit!=="object"||Array.isArray(edit)||
   Object.keys(edit).some(key=>!["nodeId","kind","entryId","expectedDigest","changes","variantId","sequenceId"].includes(key))||
   !validCanvasNodeId(edit.nodeId)||!entryId(edit.entryId)||
   !["assets","episodes","shots"].includes(edit.kind)||
   typeof edit.expectedDigest!=="string"||!/^[a-f0-9]{64}$/.test(edit.expectedDigest)||
   !edit.changes||typeof edit.changes!=="object"||Array.isArray(edit.changes)||
   Object.keys(edit.changes).length===0||Object.keys(edit.changes).length>15||
   (edit.kind==="shots"&&(edit.variantId!==undefined||edit.sequenceId!==undefined)))
   throw fail("drama_batch_invalid",400);
  const target=stableJson([edit.nodeId,edit.kind,edit.entryId]);
  // Even distinct nested variants of one asset are one CAS unit: refuse a
  // second edit against the same frozen digest inside a single batch.
  if(seen.has(target))throw fail("drama_batch_duplicate_target",400);
  seen.add(target);
 }
 assertNoRawCredentials(edits);
 const fingerprint=hash({operationId,expectedRevision,edits});
 return writeTransaction(db,()=>{
  const existing=db.prepare(`SELECT fingerprint,project_revision FROM drama_scope_batch_operations
   WHERE project_id=? AND operation_id=?`).get(projectId,operationId);
  if(existing&&existing.fingerprint!==fingerprint)throw fail("drama_batch_operation_conflict",409);
  const project=db.prepare(`SELECT revision FROM projects WHERE id=? AND deleted_at IS NULL`).get(projectId);
  if(!project)throw fail("project_not_found",404);
  if(existing)return {existing:true,projectRevision:existing.project_revision,applied:edits.length};
  if(project.revision!==expectedRevision)throw fail("project_revision_conflict",409);
  for(const edit of edits){
   if(edit.kind==="shots"){
    const updated=tryPatchIndexedShotDraft(db,projectId,edit.nodeId,{
     shotId:edit.entryId,expectedDigest:edit.expectedDigest,changes:edit.changes
    },validateDocument,emitEvent,null,{deferProjectCommit:true});
    if(!updated)throw fail("drama_batch_index_required",409);
   }else applyDramaEntryDraftWithinTransaction(db,projectId,edit,validateDocument);
  }
  const revision=expectedRevision+1;
  const updated=db.prepare("UPDATE projects SET revision=? WHERE id=? AND revision=? AND deleted_at IS NULL")
   .run(revision,projectId,expectedRevision);
  if(updated.changes!==1)throw fail("project_revision_conflict",409);
  db.prepare(`INSERT INTO drama_scope_batch_operations
   (project_id,operation_id,fingerprint,project_revision,committed_at) VALUES(?,?,?,?,?)`)
   .run(projectId,operationId,fingerprint,revision,Date.now());
  emitEvent(db,{id:projectId,revision,kind:"updated"});
  return {existing:false,projectRevision:revision,applied:edits.length};
 });
}
