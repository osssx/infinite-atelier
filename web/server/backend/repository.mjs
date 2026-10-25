import{randomUUID,createHash}from"node:crypto";
import{EXECUTION_MODES,assertJobTransition}from"./contracts.mjs";
const problem=code=>Object.assign(new Error(code),{code,statusCode:409});
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
/** Conservative one-hop source projection. Deeper dependencies will require a full graph snapshot in P2. */
export function fingerprintSource(document,targetNodeId){
 if(!Array.isArray(document?.nodes)||!Array.isArray(document?.connections))throw problem("invalid_project_document");
 const target=document.nodes.find(n=>n.id===targetNodeId);
 if(!target)throw problem("stale_generation_source");
 const incoming=document.connections.filter(e=>e.toNodeId===targetNodeId).sort((a,b)=>stableJson(a).localeCompare(stableJson(b)));
 const ids=new Set([targetNodeId,...incoming.map(e=>e.fromNodeId)]);
 const nodes=document.nodes.filter(n=>ids.has(n.id)).sort((a,b)=>a.id.localeCompare(b.id));
 if(nodes.length!==ids.size)throw problem("stale_generation_source");
 return createHash("sha256").update(stableJson({nodes,incoming})).digest("hex");
}
const emit=(db,jobId,kind,payload)=>db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)").run(jobId,kind,stableJson(payload),Date.now());
export function submitJob(db,{jobId=randomUUID(),principal="local-owner",projectId=null,targetNodeId=null,expectedProjectRevision=null,sourceNodeFingerprint=null,idempotencyKey,requestFingerprint,executionMode,snapshot}){
 if(!idempotencyKey||!requestFingerprint||!EXECUTION_MODES.includes(executionMode)||!snapshot||typeof snapshot!=="object")throw Error("invalid_job_request");
 if(projectId===null&&(targetNodeId!==null||expectedProjectRevision!==null||sourceNodeFingerprint!==null))throw Error("invalid_project_reference");
 if(projectId!==null&&(!targetNodeId||!Number.isSafeInteger(expectedProjectRevision)||!sourceNodeFingerprint))throw Error("generation_save_barrier_required");
 return writeTransaction(db,()=>{
  const scope=projectId??"";
  const existing=db.prepare("SELECT id,request_fingerprint,execution_mode,snapshot_json,target_node_id,expected_project_revision,source_fingerprint FROM jobs WHERE principal=? AND project_scope=? AND idempotency_key=?").get(principal,scope,idempotencyKey);
  // Do not trust only the caller-provided request fingerprint: compare the actual frozen payload and source fence.
  if(existing){if(existing.request_fingerprint!==requestFingerprint||existing.execution_mode!==executionMode||existing.snapshot_json!==stableJson(snapshot)||existing.target_node_id!==targetNodeId||existing.expected_project_revision!==expectedProjectRevision||existing.source_fingerprint!==sourceNodeFingerprint)throw problem("idempotency_key_conflict");return{jobId:existing.id,existing:true}}
  if(projectId!==null){
   const project=db.prepare("SELECT document_json,revision,deleted_at FROM projects WHERE id=?").get(projectId);
   if(!project||project.deleted_at!==null||project.revision!==expectedProjectRevision||fingerprintSource(JSON.parse(project.document_json),targetNodeId)!==sourceNodeFingerprint)throw problem("stale_generation_source");
  }
  const now=Date.now();
  db.prepare(`INSERT INTO jobs(id,principal,project_scope,project_id,target_node_id,expected_project_revision,source_fingerprint,idempotency_key,request_fingerprint,snapshot_json,execution_mode,status,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(jobId,principal,scope,projectId,targetNodeId,expectedProjectRevision,sourceNodeFingerprint,idempotencyKey,requestFingerprint,stableJson(snapshot),executionMode,now,now);
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
