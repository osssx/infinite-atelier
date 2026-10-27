import{randomUUID,createHash}from"node:crypto";
import {claimSkillJobGrant} from "./skill-job-grants.mjs";
import{EXECUTION_MODES,assertJobTransition}from"./contracts.mjs";
const problem=code=>Object.assign(new Error(code),{code,statusCode:409});
const invalid=code=>Object.assign(new Error(code),{code,statusCode:400});
export function writeTransaction(db,fn){
 db.exec("BEGIN IMMEDIATE");
 try{
  const result=fn();
  if(result&&typeof result.then==="function")throw Error("async_transaction_forbidden");
  db.exec("COMMIT");return result;
 }catch(e){db.exec("ROLLBACK");throw e}
}
export function stableJson(value){
 if(Array.isArray(value))return"["+value.map(stableJson).join(",")+"]";
 if(value!==null&&typeof value==="object")return"{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stableJson(value[k])).join(",")+"}";
 if(value===undefined)throw Error("undefined_in_frozen_snapshot");
 return JSON.stringify(value);
}
/** The frozen job payload must not carry a provider key into the task database. */
export function assertNoRawCredentials(value,depth=0){
 if(depth>40)throw Object.assign(Error("invalid_job_request"),{code:"invalid_job_request",statusCode:400});
 if(!value||typeof value!=="object")return;
 if(Array.isArray(value)){for(const item of value)assertNoRawCredentials(item,depth+1);return}
 for(const [key,nested] of Object.entries(value)){
  if(/^(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|private[_-]?key|secret)$/i.test(key))
   throw Object.assign(Error("raw_credentials_forbidden"),{code:"raw_credentials_forbidden",statusCode:400});
  assertNoRawCredentials(nested,depth+1);
 }
}
/** Fingerprints the target plus every transitive input, independent of canvas array ordering. */
export function fingerprintSource(document,targetNodeId){
 if(!Array.isArray(document?.nodes)||!Array.isArray(document?.connections))throw problem("invalid_project_document");
 const byId=new Map(document.nodes.map(node=>[node.id,node]));
 if(byId.size!==document.nodes.length||!byId.has(targetNodeId))throw problem("stale_generation_source");
 const parents=new Map();
 for(const edge of document.connections){
  if(!byId.has(edge.fromNodeId)||!byId.has(edge.toNodeId))throw problem("stale_generation_source");
  const edges=parents.get(edge.toNodeId)||[];
  edges.push(edge);parents.set(edge.toNodeId,edges);
 }
 const ids=new Set(),visiting=new Set(),incoming=[];
 function visit(id){
  if(visiting.has(id))throw problem("cyclic_generation_source");
  if(ids.has(id))return;
  visiting.add(id);
  for(const edge of parents.get(id)||[]){
   incoming.push(edge);
   visit(edge.fromNodeId);
  }
  visiting.delete(id);ids.add(id);
 }
 visit(targetNodeId);
 const nodes=[...ids].sort().map(id=>byId.get(id));
 incoming.sort((a,b)=>stableJson(a).localeCompare(stableJson(b)));
 return createHash("sha256").update(stableJson({nodes,incoming})).digest("hex");
}
const emit=(db,jobId,kind,payload)=>db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)").run(jobId,kind,stableJson(payload),Date.now());
export function submitJob(db,{jobId=randomUUID(),principal="local-owner",projectId=null,targetNodeId=null,expectedProjectRevision=null,sourceNodeFingerprint=null,idempotencyKey,requestFingerprint,executionMode,snapshot,skillAuthorizationId,requireSkillGrant=false}){
 if(!idempotencyKey||!requestFingerprint||!EXECUTION_MODES.includes(executionMode)||!snapshot||typeof snapshot!=="object")throw invalid("invalid_job_request");
 assertNoRawCredentials(snapshot);
 if(projectId===null&&(targetNodeId!==null||expectedProjectRevision!==null||sourceNodeFingerprint!==null))throw invalid("invalid_project_reference");
 if(projectId!==null&&(!targetNodeId||!Number.isSafeInteger(expectedProjectRevision)||!sourceNodeFingerprint))throw invalid("generation_save_barrier_required");
 return writeTransaction(db,()=>{
  const scope=projectId??"";
  const existing=db.prepare("SELECT id,request_fingerprint,execution_mode,snapshot_json,target_node_id,expected_project_revision,source_fingerprint FROM jobs WHERE principal=? AND project_scope=? AND idempotency_key=?").get(principal,scope,idempotencyKey);
  // Do not trust only the caller-provided request fingerprint: compare the actual frozen payload and source fence.
  if(existing){if(existing.request_fingerprint!==requestFingerprint||existing.execution_mode!==executionMode||existing.snapshot_json!==stableJson(snapshot)||existing.target_node_id!==targetNodeId||existing.expected_project_revision!==expectedProjectRevision||existing.source_fingerprint!==sourceNodeFingerprint)throw problem("idempotency_key_conflict");return{jobId:existing.id,existing:true}}
  // P4.6: cross-tab model runs must never pass two independent client-side
  // "no active job" checks and both bill the same source. BEGIN IMMEDIATE
  // serializes this check with the insert across SQLite connections.
  // Existing idempotency replays above still recover their original job.
  if(projectId!==null&&snapshot.adapterKind==="model"){
   const active=db.prepare("SELECT id FROM jobs WHERE principal=? AND project_id=? AND target_node_id=? AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1")
    .get(principal,projectId,targetNodeId);
   if(active)throw problem("backend_prior_job_not_terminal");
  }
  // The immutable credential reference is checked under the same write
  // transaction as inserting the JobSnapshot, after idempotency lookup.
  if(snapshot.channelId!==undefined||snapshot.secretVersionRef!==undefined){
   if(typeof snapshot.channelId!=="string"||!snapshot.channelId||
      typeof snapshot.secretVersionRef!=="string"||!snapshot.secretVersionRef)
    throw invalid("credential_reference_required");
   const credential=db.prepare("SELECT channel_id,revoked_at FROM credential_versions WHERE id=?")
     .get(snapshot.secretVersionRef);
   if(!credential||credential.channel_id!==snapshot.channelId)
    throw Object.assign(Error("credential_missing"),{code:"credential_missing",statusCode:404});
   if(credential.revoked_at!==null)throw problem("credential_revoked");
  }
  if(projectId!==null){
   const project=db.prepare("SELECT document_json,revision,deleted_at FROM projects WHERE id=?").get(projectId);
   if(!project||project.deleted_at!==null||project.revision!==expectedProjectRevision||fingerprintSource(JSON.parse(project.document_json),targetNodeId)!==sourceNodeFingerprint)throw problem("stale_generation_source");
  }
  const now=Date.now();
  db.prepare(`INSERT INTO jobs(id,principal,project_scope,project_id,target_node_id,expected_project_revision,source_fingerprint,idempotency_key,request_fingerprint,snapshot_json,execution_mode,status,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(jobId,principal,scope,projectId,targetNodeId,expectedProjectRevision,sourceNodeFingerprint,idempotencyKey,requestFingerprint,stableJson(snapshot),executionMode,now,now);
  // The FK points to the new Job; both operations still commit or roll back together.
  if(requireSkillGrant)claimSkillJobGrant(db,{projectId,snapshot,skillAuthorizationId,jobId});
  emit(db,jobId,"job_queued",{status:"queued"});return{jobId,existing:false};
 });
}
export function transitionJob(db,jobId,next,evidence={}){
 return writeTransaction(db,()=>{
  const job=db.prepare("SELECT status,execution_mode FROM jobs WHERE id=?").get(jobId);
  if(!job)throw Error("job_not_found");
  assertJobTransition(job.status,next,{executionMode:job.execution_mode,...evidence});
  db.prepare("UPDATE jobs SET status=?,updated_at=? WHERE id=? AND status=?").run(next,Date.now(),jobId,job.status);
  emit(db,jobId,"job_status",{from:job.status,to:next});return next;
 });
}
export function appendArtifact(db,{id=randomUUID(),jobId,portId=null,itemKey,blobId,kind,mime,sha256,metadata={}}){
 if(portId==="")throw Error("empty_artifact_port");
 return writeTransaction(db,()=>{
  const old=db.prepare("SELECT id,sha256,blob_id FROM artifacts WHERE job_id=? AND port_id IS ? AND item_key=?").get(jobId,portId,itemKey);
  if(old){if(old.sha256!==sha256||old.blob_id!==blobId)throw problem("artifact_identity_conflict");return{artifactId:old.id,existing:true}}
  db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)").run(id,jobId,portId,itemKey,blobId,kind,mime,sha256,stableJson(metadata));
  return{artifactId:id,existing:false};
 });
}
/** The snapshot and cursor are read from one SQLite view. An SSE router must replay seq>cursor on registration. */
export function readJobsSnapshot(db,{statuses=null}={}){
 db.exec("BEGIN");
 try{
  const jobs=statuses===null?db.prepare("SELECT * FROM jobs ORDER BY created_at").all():statuses.length?db.prepare(`SELECT * FROM jobs WHERE status IN (${statuses.map(()=>"?").join(",")}) ORDER BY created_at`).all(...statuses):[];
  const eventCursor=db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM job_events").get().seq;
  db.exec("COMMIT");return{jobs,eventCursor};
 }catch(e){db.exec("ROLLBACK");throw e}
}
export function readEventsAfter(db,cursor,limit=200){
 if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error("invalid_event_cursor");
 return db.prepare("SELECT seq,job_id,kind,payload_json,created_at FROM job_events WHERE seq>? ORDER BY seq LIMIT ?").all(cursor,limit);
}
