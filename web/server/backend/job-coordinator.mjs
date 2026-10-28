import {randomUUID} from "node:crypto";
import {assertJobTransition} from "./contracts.mjs";
import {writeTransaction,stableJson,assertNoRawCredentials} from "./repository.mjs";

const blocked=code=>Object.assign(Error(code),{code,statusCode:409});
function route(row){
 const snap=JSON.parse(row.snapshot_json);
 const kind=snap.adapterKind??"model";
 if(kind==="model")return {key:"model",kind,instanceId:null};
 if(kind==="comfy"&&typeof snap.instanceId==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(snap.instanceId))
  return {key:"comfy:"+snap.instanceId,kind,instanceId:snap.instanceId};
 throw blocked("invalid_job_adapter_route");
}
const parse=row=>({...row,snapshot:JSON.parse(row.snapshot_json)});
function event(db,jobId,kind,payload){
 db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
   .run(jobId,kind,stableJson(payload),Date.now());
}
function transition(db,row,to,evidence={}){
 assertJobTransition(row.status,to,{executionMode:row.execution_mode,...evidence});
 db.prepare("UPDATE jobs SET status=?,updated_at=? WHERE id=?").run(to,Date.now(),row.id);
 event(db,row.id,"job_status",{from:row.status,to});
}
function mustOwn(db,jobId,lease){
 const row=db.prepare("SELECT * FROM jobs WHERE id=? AND lease_owner=?").get(jobId,lease);
 if(!row)throw blocked("job_lease_lost");
 return row;
}
function saveReceipt(receipt){
 if(!receipt||typeof receipt!=="object"||Array.isArray(receipt))throw blocked("invalid_adapter_receipt");
 assertNoRawCredentials(receipt);
 const json=stableJson(receipt);
 if(Buffer.byteLength(json)>8192)throw blocked("adapter_receipt_too_large");
 return json;
}
function credentialAvailable(db,snapshot){
 if(snapshot.channelId===undefined&&snapshot.secretVersionRef===undefined)return true;
 if(typeof snapshot.channelId!=="string"||typeof snapshot.secretVersionRef!=="string")return false;
 const row=db.prepare("SELECT channel_id,revoked_at FROM credential_versions WHERE id=?")
   .get(snapshot.secretVersionRef);
 return !!row&&row.channel_id===snapshot.channelId&&row.revoked_at===null;
}
/** A persistent, explicitly driven coordinator; no existing Comfy API is called.
 * Adapter contract:
 *   prepare({job}) => Promise<void> (idempotent, cannot issue generation POST)
 *   submit({job,attemptId,submitMarker}) =>
 *      {kind:"accepted",remoteTaskId:string} OR {kind:"completed",receipt:object}
 *   poll({job,remoteTaskId}) => {kind:"pending"|"failed"|"completed",receipt?:object}
 *   collect({job,remoteTaskId,receipt,db}) => must persist >=1 artifact before success
 * Unknown submit outcomes are NEVER automatically resubmitted.
 */
export function createJobCoordinator({
 db,adapters={},modelConcurrency=2,comfyConcurrency=1,
 leaseMs=120000,clock=()=>Date.now(),retryPolicy=null
}={}){
 if(!db||!Number.isSafeInteger(modelConcurrency)||modelConcurrency<1||
    !Number.isSafeInteger(comfyConcurrency)||comfyConcurrency<1||
    !Number.isSafeInteger(leaseMs)||leaseMs<1000)throw Error("invalid_coordinator_config");
 let recovered=false,stopping=false;
 const inFlight=new Map(),instanceId=randomUUID();
 const limit=lane=>lane.kind==="model"?modelConcurrency:comfyConcurrency;
 const adapterFor=lane=>lane.kind==="model"?adapters.model:adapters.comfy?.[lane.instanceId];
 const policy=retryPolicy?{
  pollMs:retryPolicy.pollMs??500,collectMs:retryPolicy.collectMs??1000,
  maxMs:retryPolicy.maxMs??60000
 }:null;
 if(policy&&(!Number.isSafeInteger(policy.pollMs)||policy.pollMs<1||
  !Number.isSafeInteger(policy.collectMs)||policy.collectMs<1||
  !Number.isSafeInteger(policy.maxMs)||policy.maxMs<Math.max(policy.pollMs,policy.collectMs)))
  throw Error("invalid_coordinator_retry_policy");
 function schedule(jobId,phase,failed){
  if(!policy)return;
  const previous=db.prepare("SELECT poll_failures,collect_failures FROM job_schedules WHERE job_id=?").get(jobId);
  const failures=failed?(phase==="poll"?previous?.poll_failures??0:previous?.collect_failures??0)+1:0;
  const task=db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(jobId);
  const isArkVideo=task&&JSON.parse(task.snapshot_json).provider==="volcengine_ark";
  const base=phase==="poll"&&isArkVideo?Math.max(policy.pollMs,10000):
   phase==="poll"?policy.pollMs:policy.collectMs;
  const delay=Math.min(policy.maxMs,base*2**Math.min(20,failures));
  db.prepare("INSERT INTO job_schedules(job_id,due_at,poll_failures,collect_failures,last_reason) VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET due_at=excluded.due_at,poll_failures=excluded.poll_failures,collect_failures=excluded.collect_failures,last_reason=excluded.last_reason")
    .run(jobId,clock()+delay,phase==="poll"?failures:previous?.poll_failures??0,
     phase==="collect"?failures:previous?.collect_failures??0,phase+(failed?"_error":"_pending"));
 }

 function recoverAtStartup(){
  if(recovered||inFlight.size)throw blocked("coordinator_already_started");
  const recoveredJobs=writeTransaction(db,()=>{
   // Clear orphan leases even on terminal/blocked/unknown jobs: a process may
   // crash after persisting the final status but before its attempt cleanup.
   const rows=db.prepare("SELECT * FROM jobs WHERE status IN ('queued','preparing','submitting','running','collecting') OR lease_owner IS NOT NULL ORDER BY created_at,id").all();
   const results=[];
   for(const row of rows){
    let next=row.status;
    if(row.status==="preparing")next=row.submission_started_at?"submission_unknown":"queued";
    if(row.status==="submitting"){
     next=row.recovery_receipt_json?"collecting":
       row.upstream_task_id&&row.execution_mode!=="immediate"?"running":"submission_unknown";
    }
    if(row.status==="running"&&!row.upstream_task_id)next="submission_unknown";
    if(row.status==="collecting"&&!row.recovery_receipt_json&&!row.upstream_task_id)next="submission_unknown";
    if(row.attempt_id){
     db.prepare("UPDATE job_attempts SET finished_at=COALESCE(finished_at,?),outcome=COALESCE(outcome,'process_restarted') WHERE id=?")
       .run(clock(),row.attempt_id);
    }
    db.prepare("UPDATE jobs SET status=?,lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,attempt_id=NULL,updated_at=? WHERE id=?")
      .run(next,clock(),row.id);
    if(next!==row.status)event(db,row.id,"job_recovered",{from:row.status,to:next});
    results.push({jobId:row.id,from:row.status,to:next});
   }
   return results;
  });
  recovered=true;return recoveredJobs;
 }
 function claim(){
  return writeTransaction(db,()=>{
   // Polling/collection of confirmed remote work must not trigger a fresh POST.
   const rows=db.prepare("SELECT jobs.* FROM jobs LEFT JOIN job_schedules s ON s.job_id=jobs.id WHERE jobs.status IN ('queued','running','collecting') AND jobs.lease_owner IS NULL AND (s.due_at IS NULL OR s.due_at<=?) ORDER BY jobs.created_at,jobs.id").all(clock());
   const occupied=new Map();
   const others=db.prepare("SELECT * FROM jobs WHERE status IN ('preparing','submitting','running','collecting')").all();
   for(const row of others){
    const lane=route(row).key;
    occupied.set(lane,(occupied.get(lane)||0)+1);
   }
   const resumed=rows.find(row=>(row.status==="running"||row.status==="collecting")&&adapterFor(route(row)));
   const target=resumed??rows.find(row=>{
    if(row.status!=="queued")return false;
    const lane=route(row);
    return adapterFor(lane)&&(occupied.get(lane.key)||0)<limit(lane);
   });
   if(!target)return null;
   const lease=randomUUID(),attemptId=randomUUID(),now=clock();
   const next=target.status==="queued"?"preparing":target.status;
   const changed=db.prepare("UPDATE jobs SET status=?,lease_owner=?,lease_acquired_at=?,lease_expires_at=?,attempt_id=?,updated_at=? WHERE id=? AND lease_owner IS NULL AND status=?")
    .run(next,lease,now,now+leaseMs,attemptId,now,target.id,target.status);
   if(changed.changes!==1)throw blocked("job_claim_race");
   db.prepare("INSERT INTO job_attempts(id,job_id,phase,secret_version_ref,upstream_task_id,started_at) VALUES(?,?,?,?,?,?)")
    .run(attemptId,target.id,next==="preparing"?"preparing":next,
      JSON.parse(target.snapshot_json).secretVersionRef??null,target.upstream_task_id,now);
   event(db,target.id,next==="preparing"?"job_claimed":"job_resumed",
     {status:next,attemptId});
   return {jobId:target.id,lease,attemptId,status:next,adapter:adapterFor(route(target))};
  });
 }
 function modify(jobId,lease,callback){
  return writeTransaction(db,()=>callback(mustOwn(db,jobId,lease)));
 }
 function finish(jobId,lease,outcome){
  return modify(jobId,lease,row=>{
   db.prepare("UPDATE job_attempts SET finished_at=?,outcome=? WHERE id=?")
     .run(clock(),outcome,row.attempt_id);
   db.prepare("UPDATE jobs SET lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,attempt_id=NULL,updated_at=? WHERE id=?")
     .run(clock(),row.id);
   return row.status;
  });
 }
 function move(jobId,lease,next,evidence={}){
  return modify(jobId,lease,row=>transition(db,row,next,evidence));
 }
 function enterSubmitting(jobId,lease){
  return modify(jobId,lease,row=>{
   if(row.status!=="preparing"||row.submission_started_at!==null)throw blocked("unsafe_submit_barrier");
   const snap=JSON.parse(row.snapshot_json);
   if(!credentialAvailable(db,snap)){
    transition(db,row,"blocked_credential");
    return null;
   }
   const marker=randomUUID(),now=clock();
   assertJobTransition(row.status,"submitting",{executionMode:row.execution_mode});
   db.prepare("UPDATE jobs SET status='submitting',submit_marker=?,submission_started_at=?,updated_at=? WHERE id=?")
     .run(marker,now,now,row.id);
   db.prepare("UPDATE job_attempts SET phase='submitting' WHERE id=?").run(row.attempt_id);
   event(db,row.id,"job_submit_barrier",{attemptId:row.attempt_id,submitMarker:marker});
   return marker;
  });
 }
 function markSubmitted(jobId,lease,result){
  return modify(jobId,lease,row=>{
   if(row.status!=="submitting")throw blocked("unexpected_job_status");
   if(result?.kind==="accepted"&&typeof result.remoteTaskId==="string"&&result.remoteTaskId.length&&
      row.execution_mode!=="immediate"){
    assertJobTransition(row.status,"running",{executionMode:row.execution_mode});
    db.prepare("UPDATE jobs SET upstream_task_id=?,status='running',updated_at=? WHERE id=?")
     .run(result.remoteTaskId,clock(),row.id);
    db.prepare("UPDATE job_attempts SET upstream_task_id=?,phase='running' WHERE id=?")
     .run(result.remoteTaskId,row.attempt_id);
    event(db,row.id,"job_status",{from:"submitting",to:"running"});
    return "running";
   }
   if(result?.kind==="completed"&&result.receipt&&typeof result.receipt==="object"&&!Array.isArray(result.receipt)){
    let receipt;
    try{receipt=saveReceipt(result.receipt)}
    catch{transition(db,row,"submission_unknown");return "submission_unknown"}
    assertJobTransition(row.status,"collecting",{executionMode:row.execution_mode});
    db.prepare("UPDATE jobs SET recovery_receipt_json=?,status='collecting',updated_at=? WHERE id=?")
     .run(receipt,clock(),row.id);
    db.prepare("UPDATE job_attempts SET phase='collecting' WHERE id=?").run(row.attempt_id);
    event(db,row.id,"job_status",{from:"submitting",to:"collecting"});
    return "collecting";
   }
   transition(db,row,"submission_unknown");return "submission_unknown";
  });
 }
 function recordPolled(jobId,lease,result){
  return modify(jobId,lease,row=>{
   if(row.status!=="running"||!row.upstream_task_id)throw blocked("unsafe_remote_poll");
   if(result?.kind==="pending")return "running";
   if(result?.kind==="failed"){
    transition(db,row,"failed");return "failed";
   }
   if(result?.kind==="cancelled"){
    transition(db,row,"cancelled");return "cancelled";
   }
   if(result?.kind==="completed"){
    const receipt=saveReceipt(result.receipt??{remoteTaskId:row.upstream_task_id});
    db.prepare("UPDATE jobs SET recovery_receipt_json=?,status='collecting',updated_at=? WHERE id=?")
     .run(receipt,clock(),row.id);
    db.prepare("UPDATE job_attempts SET phase='collecting' WHERE id=?").run(row.attempt_id);
    event(db,row.id,"job_status",{from:"running",to:"collecting"});
    return "collecting";
   }
   return "running";
  });
 }
 function confirmCollection(jobId,lease){
  return modify(jobId,lease,row=>{
   if(row.status!=="collecting")throw blocked("unexpected_job_status");
   const count=db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(jobId).n;
   if(count<1)throw blocked("required_artifacts_missing");
   transition(db,row,"succeeded");
   db.prepare("DELETE FROM job_schedules WHERE job_id=?").run(jobId);
   return "succeeded";
  });
 }
 async function perform(claimed){
  const {jobId,lease,attemptId,adapter}=claimed;
  let outcome="interrupted";
  const heartbeat=setInterval(()=>{
   try{
    db.prepare("UPDATE jobs SET lease_expires_at=? WHERE id=? AND lease_owner=?")
      .run(clock()+leaseMs,jobId,lease);
   }catch{/* startup recovery remains fail-closed */}
  },Math.max(250,Math.floor(leaseMs/3)));
  heartbeat.unref?.();
  try{
   let job=parse(mustOwn(db,jobId,lease));
   if(job.status==="preparing"){
    if(!credentialAvailable(db,job.snapshot)){
     move(jobId,lease,"blocked_credential");outcome="blocked_credential";return;
    }
    try{await adapter.prepare?.({job})}
    catch{move(jobId,lease,"failed");outcome="prepare_failed";return}
    const marker=enterSubmitting(jobId,lease);
    if(!marker){outcome="blocked_credential";return}
    job=parse(mustOwn(db,jobId,lease));
    let result;
    try{result=await adapter.submit({job,attemptId,submitMarker:marker})}
    catch(err){
     // Only an explicit, verified "not accepted" proof permits failed.
     const safe=err?.confirmedNotAccepted===true;
     move(jobId,lease,safe?"failed":"submission_unknown",
       {confirmedNotAccepted:safe});
     outcome=safe?"not_accepted":"submission_unknown";return;
    }
    const next=markSubmitted(jobId,lease,result);
    if(next==="submission_unknown"){outcome="submission_unknown";return}
    if(next==="running"){schedule(jobId,"poll",false);outcome="remote_pending";return}
   }
   job=parse(mustOwn(db,jobId,lease));
   if(job.status==="running"){
    if(!job.upstream_task_id){
     move(jobId,lease,"submission_unknown");outcome="submission_unknown";return;
    }
    if(!credentialAvailable(db,job.snapshot)){
     move(jobId,lease,"blocked_credential",{confirmedNotAccepted:true});
     outcome="blocked_credential";return;
    }
    let result;
    try{result=await adapter.poll({job,remoteTaskId:job.upstream_task_id})}
    catch{schedule(jobId,"poll",true);outcome="poll_failed";return}
    const next=recordPolled(jobId,lease,result);
    if(next!=="collecting"){
     if(next==="running")schedule(jobId,"poll",false);
     outcome=next==="failed"?"remote_failed":"remote_pending";return
    }
   }
   job=parse(mustOwn(db,jobId,lease));
   if(job.status==="collecting"){
    if(!job.recovery_receipt_json&&!job.upstream_task_id){
     move(jobId,lease,"submission_unknown");outcome="submission_unknown";return;
    }
    try{
     await adapter.collect({job,remoteTaskId:job.upstream_task_id,
       receipt:job.recovery_receipt_json?JSON.parse(job.recovery_receipt_json):null,db});
     confirmCollection(jobId,lease);
     outcome="succeeded";
    }catch{schedule(jobId,"collect",true);outcome="collect_pending"} // retry download only
   }
  }finally{
   clearInterval(heartbeat);
   try{finish(jobId,lease,outcome)}catch{/* an explicit startup recovery owns it now */}
  }
 }
 async function tick({maxClaims=32}={}){
  if(!recovered)throw blocked("coordinator_recovery_required");
  if(stopping)throw blocked("coordinator_stopping");
  if(!Number.isSafeInteger(maxClaims)||maxClaims<1||maxClaims>100)throw Error("invalid_dispatch_budget");
  const work=[];
  for(let n=0;n<maxClaims&&!stopping;n++){
   const selected=claim();
   if(!selected)break;
   const promise=perform(selected);
   inFlight.set(selected.jobId,promise);
   const remove=()=>{if(inFlight.get(selected.jobId)===promise)inFlight.delete(selected.jobId)};
   promise.then(remove,remove);
   work.push(promise);
  }
  await Promise.all(work);
  return work.length;
 }

 /** Human-supplied task identity is NEVER sufficient by itself.
  * Only the Comfy adapter can attest remote history against the original
  * immutable graph + 128-bit submit marker. No adapter.submit is reachable.
  * Unknown/mismatching evidence remains unknown, even after a network error.
  */
 async function reconcileUnknown({jobId,projectId,remoteTaskId}={}){
  if(typeof jobId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)||
     typeof projectId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)||
     typeof remoteTaskId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(remoteTaskId))
   throw blocked("reconciliation_invalid_input");
  const row=db.prepare("SELECT * FROM jobs WHERE id=? AND project_id=?").get(jobId,projectId);
  if(!row)throw Object.assign(Error("job_not_found"),{code:"job_not_found",statusCode:404});
  if(!recovered||stopping||row.status!=="submission_unknown"||row.lease_owner||
     row.execution_mode!=="poll"||!row.submit_marker||!row.submission_started_at)
   throw blocked("reconciliation_not_eligible");
  const lane=route(row);
  if(lane.kind!=="comfy")throw blocked("reconciliation_provider_unsupported");
  if(!db.prepare("SELECT 1 FROM comfy_job_preparations WHERE job_id=?").get(jobId))
   throw blocked("reconciliation_not_eligible");
  const adapter=adapterFor(lane);
  if(typeof adapter?.reconcile!=="function"||typeof adapter.poll!=="function")
   throw blocked("reconciliation_adapter_unavailable");
  let proof;
  try{proof=await adapter.reconcile({job:parse(row),remoteTaskId})}
  catch{throw Object.assign(Error("reconciliation_upstream_unavailable"),
   {code:"reconciliation_upstream_unavailable",statusCode:503})}
  return writeTransaction(db,()=>{
   const current=db.prepare("SELECT * FROM jobs WHERE id=? AND project_id=?").get(jobId,projectId);
   if(!current||current.status!=="submission_unknown"||current.lease_owner||
      current.submit_marker!==row.submit_marker||current.updated_at!==row.updated_at)
    throw blocked("reconciliation_state_changed");
   if(!["pending","completed","failed"].includes(proof?.kind)){
    const reason=proof?.kind==="mismatch"?"remote_evidence_mismatch":"remote_evidence_absent";
    event(db,jobId,"job_reconciliation_checked",{verified:false,reason});
    return {verified:false,status:"submission_unknown",reason};
   }
   const linked=db.prepare("SELECT id FROM jobs WHERE upstream_task_id=? AND id<>? LIMIT 1").get(remoteTaskId,jobId);
   if(linked)throw blocked("reconciliation_remote_already_linked");
   const next=proof.kind==="pending"?"running":
     proof.kind==="completed"?"collecting":"failed";
   assertJobTransition(current.status,next,{
    executionMode:current.execution_mode,trustedRemoteMatch:true
   });
   const receipt=next==="collecting"?saveReceipt({remoteTaskId}):null;
   db.prepare("UPDATE jobs SET status=?,upstream_task_id=?,recovery_receipt_json=?,updated_at=? WHERE id=?")
    .run(next,remoteTaskId,receipt,clock(),jobId);
   // Clear stale schedules: this job's next tick is a read-only poll
   // or artifact collection. It can never re-enter the 'queued' path.
   db.prepare("DELETE FROM job_schedules WHERE job_id=?").run(jobId);
   event(db,jobId,"job_reconciliation_verified",{verified:true,from:"submission_unknown",
    to:next,remoteTaskVerified:true});
   return {verified:true,status:next};
  });
 }
 /** Cancel a queued local job atomically or confirm Ark remote cancellation.
  * A temporary lease prevents dispatch while we check remote queued status.
  * Never mark a running video cancelled unless upstream DELETE confirms it.
  */
 async function cancel(jobId){
  const lease=randomUUID();
  const reserved=writeTransaction(db,()=>{
   const row=db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
   if(!row)throw Object.assign(Error("job_not_found"),{code:"job_not_found",statusCode:404});
   if(row.status==="queued"&&!row.lease_owner){
    transition(db,row,"cancelled");
    db.prepare("DELETE FROM job_schedules WHERE job_id=?").run(jobId);
    return {state:"cancelled"};
   }
   if(row.status!=="running"||row.lease_owner||!row.upstream_task_id)
    return {state:"not_cancellable",reason:"job_not_queued"};
   const snapshot=JSON.parse(row.snapshot_json);
   if(snapshot.provider!=="volcengine_ark"||snapshot.task?.kind!=="video")
    return {state:"not_cancellable",reason:"remote_cancel_not_supported"};
   const instance=adapterFor(route(row));
   if(typeof instance?.cancel!=="function")
    return {state:"not_cancellable",reason:"remote_cancel_not_available"};
   const updated=db.prepare("UPDATE jobs SET lease_owner=?,lease_acquired_at=?,lease_expires_at=? WHERE id=? AND lease_owner IS NULL AND status='running'")
    .run(lease,clock(),clock()+leaseMs,jobId);
   if(!updated.changes)return {state:"not_cancellable",reason:"job_busy"};
   return {state:"reserved",job:parse({...row,lease_owner:lease}),instance};
  });
  if(reserved.state==="cancelled")return {cancelled:true,remoteCancelled:false};
  if(reserved.state!=="reserved")return {cancelled:false,reason:reserved.reason};
  try{
   let confirmed=false,reason="remote_cancel_unconfirmed";
   try{
    const result=await reserved.instance.cancel({job:reserved.job,remoteTaskId:reserved.job.upstream_task_id});
    confirmed=result?.cancelled===true;
    if(!confirmed)reason=result?.reason??reason;
   }catch{reason="remote_cancel_unconfirmed"}
   return writeTransaction(db,()=>{
    const current=db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
    if(!current||current.lease_owner!==lease||current.status!=="running")
     return {cancelled:false,reason:"cancel_lease_lost"};
    if(confirmed){
     transition(db,current,"cancelled");
     db.prepare("DELETE FROM job_schedules WHERE job_id=?").run(jobId);
    }
    return {cancelled:confirmed,remoteCancelled:confirmed,reason:confirmed?undefined:reason};
   });
  }finally{
   writeTransaction(db,()=>{
    db.prepare("UPDATE jobs SET lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL WHERE id=? AND lease_owner=?")
     .run(jobId,lease);
   });
  }
 }
 /** Human-triggered provider read-only audit. No task submit or PUT here. */
 async function reconcileChunkUpload({projectId,jobId,index,expectedUpdatedAt}){
  const row=db.prepare("SELECT * FROM jobs WHERE id=? AND project_id=? AND project_scope=?")
   .get(jobId,projectId,projectId);
  if(!row)throw Object.assign(Error("script_asset_job_not_found"),
   {code:"script_asset_job_not_found",statusCode:404});
  if(row.status!=="failed"||row.lease_owner!==null||
     row.submission_started_at!==null||row.submit_marker!==null||
     row.upstream_task_id!==null||row.recovery_receipt_json!==null)
   throw blocked("script_asset_reconcile_not_eligible");
  const adapter=adapterFor(route(row));
  if(typeof adapter?.reconcileChunkUpload!=="function")
   throw blocked("script_asset_chunk_audit_unavailable");
  return adapter.reconcileChunkUpload({job:parse(row),index,expectedUpdatedAt});
 }
 async function stop(){
  stopping=true; // stop new claims, then settle existing adapter calls before DB closes.
  await Promise.allSettled([...inFlight.values()]);
 }
 function status(){
  const rows=db.prepare("SELECT status,COUNT(*) AS n FROM jobs GROUP BY status").all();
  return {activeInProcess:inFlight.size,byStatus:Object.fromEntries(rows.map(row=>[row.status,row.n]))};
 }
 function attempts(jobId){
  return db.prepare("SELECT id,job_id,phase,upstream_task_id,started_at,finished_at,outcome FROM job_attempts WHERE job_id=? ORDER BY started_at,id")
   .all(jobId);
 }
 return {instanceId,recoverAtStartup,tick,status,attempts,cancel,reconcileUnknown,reconcileChunkUpload,stop};
}
