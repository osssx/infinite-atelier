import {randomUUID,createHash} from "node:crypto";
import {writeTransaction} from "./repository.mjs";
import {getAuthorizedSkillCatalog} from "./sqlite-skill-registry.mjs";
// Production binds a file-backed registry per backend instance. Legacy direct
// buildApp fixtures without a registry retain their isolated SQL test path.
const fileRegistries=new WeakMap();
export function bindFileSkillRegistry(db,registry){fileRegistries.set(db,registry)}
function authorizedCatalog(db,selection){return fileRegistries.get(db)?.authorized(db,selection)??getAuthorizedSkillCatalog(db,selection)}
function activeRevision(db){return fileRegistries.get(db)?.revision()??db.prepare("SELECT revision FROM skill_registry_state WHERE id=1").get().revision}
function assertDiskCurrent(db){fileRegistries.get(db)?.assertCurrent()}
const reject=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const shaId=/^[a-f0-9]{64}$/;
const idPattern=/^[0-9a-f-]{36}$/;
const TEN_MINUTES=10*60*1000;

const PRUNE_GRACE_MS=24*60*60*1000;
function deleteExpiredUnclaimedInTransaction(db,{now,limit,graceMs}){
 const cutoff=now-graceMs;
 const result=db.prepare(`DELETE FROM skill_job_grants WHERE id IN (
  SELECT id FROM skill_job_grants
  WHERE job_id IS NULL AND expires_at<?
  ORDER BY expires_at,id LIMIT ?
 )`).run(cutoff,limit);
 return result.changes;
}
/** Limited SQLite-only collection. Never delete granted/referenced job rows
 * or CAS blobs (blobs may be shared by historical snapshots).
 */
export function pruneExpiredUnclaimedSkillGrants(db,{
 now=Date.now(),limit=100,graceMs=PRUNE_GRACE_MS
}={}){
 if(!Number.isSafeInteger(now)||now<0||
    !Number.isSafeInteger(limit)||limit<1||limit>500||
    !Number.isSafeInteger(graceMs)||graceMs<0)
  throw reject("skill_grant_gc_invalid",400);
 return writeTransaction(db,()=>({removed:deleteExpiredUnclaimedInTransaction(db,{
  now,limit,graceMs
 })}));
}
/** The server, not the browser, writes the sole authorized Skill CAS.
 * Recheck the registry revision inside the grant write transaction after
 * asynchronous filesystem publishing; stale data can never be granted.
 */
export async function freezeAuthorizedSkillGrant(db,blobStore,selection){
 if(!blobStore)throw reject("skill_freeze_unavailable",503);
 const authorized=authorizedCatalog(db,selection);
 const body=Buffer.from(JSON.stringify({
  format:"atelier-skill-snapshot-v1",entries:authorized.entries
 }),"utf8");
 if(body.length>1024*1024)throw reject("skill_snapshot_limit_exceeded",413);
 const stored=await blobStore.put([body],{mime:"text/plain"});
 if(stored.mimeType!=="text/plain"||!shaId.test(stored.blobId)||
  stored.byteSize!==body.length||
  stored.blobId!==createHash("sha256").update(body).digest("hex"))
  throw reject("skill_freeze_integrity_failed",422);
 return writeTransaction(db,()=>{
  // Concurrent scope, enabled or version changes invalidate this grant.
  authorizedCatalog(db,selection);
  // At most 100 unclaimed expired grants per successful freeze; this is
  // scoped to metadata, never removes CAS bytes or committed job references.
  deleteExpiredUnclaimedInTransaction(db,{now:Date.now(),limit:100,
   graceMs:PRUNE_GRACE_MS});
  const id=randomUUID(),now=Date.now();
  db.prepare("INSERT INTO skill_job_grants(id,project_id,blob_id,registry_revision,issued_at,expires_at) VALUES(?,?,?,?,?,?)")
   .run(id,selection.projectId,stored.blobId,selection.expectedRevision,now,now+TEN_MINUTES);
  return {blobId:stored.blobId,authorizationId:id,revision:selection.expectedRevision};
 });
}
/** Called only inside repository.submitJob's writeTransaction. */
export function claimSkillJobGrant(db,{
 projectId,snapshot,skillAuthorizationId,jobId
}){
 const ref=snapshot?.task?.skills;
 if(!ref){
  if(skillAuthorizationId!==undefined&&skillAuthorizationId!==null)
   throw reject("skill_grant_not_applicable",400);
  return;
 }
 if(snapshot.adapterKind!=="model"||snapshot.provider!=="openai"||
  snapshot.task.kind!=="text"||!projectId||
  typeof ref.blobId!=="string"||!shaId.test(ref.blobId)||
  typeof skillAuthorizationId!=="string"||!idPattern.test(skillAuthorizationId))
  throw reject("skill_grant_required");
 const row=db.prepare("SELECT project_id,blob_id,registry_revision,expires_at,job_id FROM skill_job_grants WHERE id=?")
  .get(skillAuthorizationId);
 if(!row||row.project_id!==projectId||row.blob_id!==ref.blobId)
  throw reject("skill_grant_invalid");
 if(row.job_id!==null)throw reject("skill_grant_already_used");
 if(Date.now()>row.expires_at)throw reject("skill_grant_expired");
 const current=activeRevision(db);
 if(current!==row.registry_revision)throw reject("skill_grant_stale");
 assertDiskCurrent(db);
 const result=db.prepare("UPDATE skill_job_grants SET job_id=? WHERE id=? AND job_id IS NULL")
  .run(jobId,skillAuthorizationId);
 if(result.changes!==1)throw reject("skill_grant_already_used");
}
