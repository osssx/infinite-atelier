import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema,INITIAL_SCHEMA_SQL,CREDENTIAL_SCHEMA_SQL} from "./schema.mjs";
import {submitJob,appendArtifact,readEventsAfter,fingerprintSource} from "./repository.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {createLocalBackend} from "./runtime.mjs";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 const queued=(name,options={})=>submitJob(db,{
   idempotencyKey:name,requestFingerprint:name,executionMode:options.executionMode??"immediate",
   snapshot:{adapterKind:options.kind??"model",...(options.instanceId?{instanceId:options.instanceId}:{}),
     ...(options.channelId?{channelId:options.channelId,secretVersionRef:options.secretVersionRef}:{})}
 }).jobId;
 const row=id=>db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
 const addArtifact=id=>{
  const blob="b-"+id;
  db.prepare("INSERT OR IGNORE INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,?,?,?,?)")
   .run(blob,blob,1,"text/plain",blob,"ready");
  appendArtifact(db,{jobId:id,itemKey:"0",blobId:blob,kind:"text",mime:"text/plain",sha256:blob});
 };
 return {db,queued,row,addArtifact};
}
const done=addArtifact=>({
 async prepare(){},
 async submit(){return {kind:"completed",receipt:{objectId:"test-only-output"}}},
 async collect({job}){addArtifact(job.id)}
});
test("schema v2 migrates through v3-v11 preserving prior jobs",t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());
 db.exec(INITIAL_SCHEMA_SQL);db.exec(CREDENTIAL_SCHEMA_SQL);
 db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(1,1),(2,2)").run();
 db.prepare("INSERT INTO projects(id,document_json,revision) VALUES('old','{\"nodes\":[],\"connections\":[]}',19)").run();
 initializeSchema(db);initializeSchema(db);
 assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,11);
 assert.equal(db.prepare("SELECT revision FROM projects WHERE id='old'").get().revision,19);
 for(const column of ["lease_owner","lease_acquired_at","lease_expires_at","recovery_receipt_json"])
  assert.ok(db.prepare("PRAGMA table_info(jobs)").all().some(item=>item.name===column));
 assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='comfy_job_preparations'").get());
 assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='ark_asset_uploads'").get());
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n,3);
});
test("immediate submit barrier is durable BEFORE model call; success requires saved artifacts",async t=>{
 const f=fixture(t);const jobId=f.queued("immediate");
 const calls=[];
 const adapter={
  async prepare({job}){calls.push("prepare:"+job.status)},
  async submit({job,attemptId,submitMarker}){
   const record=f.row(jobId);
   assert.equal(record.status,"submitting");
   assert.equal(record.submit_marker,submitMarker);
   assert.equal(record.attempt_id,attemptId);
   assert.ok(record.submission_started_at>0);
   assert.ok(f.db.prepare("SELECT id FROM job_attempts WHERE id=? AND phase='submitting'").get(attemptId));
   calls.push("submit");
   return {kind:"completed",receipt:{output:"tmp"}};
  },
  async collect({job}){calls.push("collect");f.addArtifact(job.id)}
 };
 const c=createJobCoordinator({db:f.db,adapters:{model:adapter}});
 await assert.rejects(c.tick(),/coordinator_recovery_required/);
 c.recoverAtStartup();
 assert.equal(await c.tick(),1);
 assert.equal(f.row(jobId).status,"succeeded");
 assert.deepEqual(calls,["prepare:preparing","submit","collect"]);
 assert.equal(f.row(jobId).lease_owner,null);
 assert.equal(c.attempts(jobId).length,1);
 assert.equal(c.attempts(jobId)[0].outcome,"succeeded");
 const events=readEventsAfter(f.db,0).filter(event=>event.job_id===jobId);
 assert.ok(events.find(event=>event.kind==="job_submit_barrier"));
 assert.ok(events.some(event=>JSON.parse(event.payload_json).to==="succeeded"));
 assert.equal(await c.tick(),0);
});
test("lost immediate response conservatively enters submission_unknown and is NEVER reissued",async t=>{
 const f=fixture(t),id=f.queued("unknown");let submits=0;
 const adapter={async submit(){submits++;throw Error("network_disconnected_after_post")}};
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(f.row(id).status,"submission_unknown");assert.equal(submits,1);
 assert.equal(coordinator.attempts(id)[0].outcome,"submission_unknown");
 await coordinator.tick();
 const after=createJobCoordinator({db:f.db,adapters:{model:adapter}});
 after.recoverAtStartup();await after.tick();
 assert.equal(submits,1);
 assert.equal(f.row(id).status,"submission_unknown");
});
test("provider attestation of rejection permits failed, but ambiguous results never retry",async t=>{
 const f=fixture(t),a=f.queued("rejected"),b=f.queued("ambiguous");
 let count=0;
 const adapter={async submit({job}){
  count++;
  if(job.id===a)throw Object.assign(Error("invalid_input"),{confirmedNotAccepted:true});
  return {kind:"unknown"};
 }};
 const c=createJobCoordinator({db:f.db,adapters:{model:adapter}});
 c.recoverAtStartup();await c.tick();
 assert.equal(f.row(a).status,"failed");
 assert.equal(f.row(b).status,"submission_unknown");
 assert.equal(count,2);
});
const projectJob=(f,key,{executionMode="poll",kind="comfy",instanceId="local"}={})=>{
 const graph={nodes:[{id:"node",type:"text",metadata:{prompt:"reconcile"}}],connections:[]};
 f.db.prepare("INSERT OR IGNORE INTO projects(id,document_json,revision) VALUES(?,?,?)")
  .run("p",JSON.stringify(graph),1);
 const result=submitJob(f.db,{
  projectId:"p",targetNodeId:"node",expectedProjectRevision:1,
  sourceNodeFingerprint:fingerprintSource(graph,"node"),
  idempotencyKey:key,requestFingerprint:key,executionMode,
  snapshot:{adapterKind:kind,...(kind==="comfy"?{instanceId}:{})}
 }).jobId;
 if(kind==="comfy")f.db.prepare("INSERT INTO comfy_job_preparations(job_id,graph_json,capture_map_json,graph_hash,image_files_json,workflow_node_id,created_at) VALUES(?,?,?,?,?,?,?)")
  .run(result,"{}","[]","digest","{}","node",Date.now());
 return result;
};
test("P4.8 manual reconciliation requires attested Comfy evidence; never submits twice",async t=>{
 const f=fixture(t);
 const id=projectJob(f,"proof",{executionMode:"poll",kind:"comfy",instanceId:"local"});
 let submits=0,polls=0,collects=0,proof="unverified",remoteCalls=0;
 const adapter={
  async submit(){submits++;throw Error("submit response lost")},
  async reconcile({job,remoteTaskId}){
   remoteCalls++;
   assert.equal(job.id,id);
   assert.equal(remoteTaskId,"remote-1");
   return {kind:proof};
  },
  async poll(){polls++;return {kind:"completed",receipt:{remoteTaskId:"remote-1"}}},
  async collect({job}){collects++;f.addArtifact(job.id)}
 };
 const c=createJobCoordinator({db:f.db,adapters:{comfy:{local:adapter}}});
 c.recoverAtStartup();await c.tick();
 assert.equal(f.row(id).status,"submission_unknown");
 assert.equal(submits,1);
 assert.equal((await c.reconcileUnknown({jobId:id,projectId:"p",remoteTaskId:"remote-1"})).verified,false);
 assert.equal(f.row(id).status,"submission_unknown");
 await assert.rejects(c.reconcileUnknown({jobId:id,projectId:"p",remoteTaskId:"remote/evil"}),/reconciliation_invalid_input/);
 proof="mismatch";
 assert.equal((await c.reconcileUnknown({jobId:id,projectId:"p",remoteTaskId:"remote-1"})).reason,"remote_evidence_mismatch");
 assert.equal(f.row(id).status,"submission_unknown");
 proof="pending";
 assert.equal((await c.reconcileUnknown({jobId:id,projectId:"p",remoteTaskId:"remote-1"})).status,"running");
 assert.equal(f.row(id).upstream_task_id,"remote-1");
 assert.equal(f.row(id).status,"running");
 await assert.rejects(c.reconcileUnknown({jobId:id,projectId:"p",remoteTaskId:"remote-1"}),/reconciliation_not_eligible/);
 await c.tick();
 assert.equal(f.row(id).status,"succeeded");
 assert.equal(submits,1);assert.equal(polls,1);assert.equal(collects,1);
 assert.equal(remoteCalls,3);
 const events=readEventsAfter(f.db,0).filter(x=>x.job_id===id);
 assert.equal(events.filter(x=>x.kind==="job_reconciliation_checked").length,2);
 assert.equal(events.filter(x=>x.kind==="job_reconciliation_verified").length,1);
});
test("P4.8 denies unsupported provider, immediate mode, cross-project and unmarked unknown jobs",async t=>{
 const f=fixture(t),now=projectJob(f,"model",{executionMode:"poll",kind:"model"});
 let checks=0;
 const c=createJobCoordinator({db:f.db,adapters:{model:{async submit(){throw Error("lost")},async reconcile(){checks++}}}});
 c.recoverAtStartup();await c.tick();
 assert.equal(f.row(now).status,"submission_unknown");
 await assert.rejects(c.reconcileUnknown({jobId:now,projectId:"wrong",remoteTaskId:"task-1"}),/job_not_found/);
 await assert.rejects(c.reconcileUnknown({jobId:now,projectId:"p",remoteTaskId:"task-1"}),/reconciliation_provider_unsupported/);
 assert.equal(checks,0);
 const id=projectJob(f,"immediate",{executionMode:"immediate",kind:"comfy",instanceId:"local"});
 f.db.prepare("UPDATE jobs SET status='submission_unknown',submit_marker='marker',submission_started_at=123 WHERE id=?").run(id);
 await assert.rejects(c.reconcileUnknown({jobId:id,projectId:"p",remoteTaskId:"task-1"}),/reconciliation_not_eligible/);
 const poll=projectJob(f,"no-marker",{kind:"comfy",instanceId:"local",executionMode:"poll"});
 f.db.prepare("UPDATE jobs SET status='submission_unknown' WHERE id=?").run(poll);
 await assert.rejects(c.reconcileUnknown({jobId:poll,projectId:"p",remoteTaskId:"task-1"}),/reconciliation_not_eligible/);
});
test("asynchronous remote task resumes polling and collection after restart; no resubmit",async t=>{
 const f=fixture(t),id=f.queued("poll",{executionMode:"poll"});let posts=0,polls=0,collects=0;
 const adapter={
  async submit(){posts++;return{kind:"accepted",remoteTaskId:"remote-42"}},
  async poll(){polls++;return polls===1?{kind:"pending"}:{kind:"completed",receipt:{remoteId:"remote-42"}}},
  async collect({job}){collects++;f.addArtifact(job.id)}
 };
 const c=createJobCoordinator({db:f.db,adapters:{model:adapter}});
 c.recoverAtStartup();await c.tick();
 assert.equal(f.row(id).status,"running");
 assert.equal(f.row(id).upstream_task_id,"remote-42");
 // Restart classification preserves trusted ID and permits only status queries.
 const restarted=createJobCoordinator({db:f.db,adapters:{model:adapter}});
 assert.equal(restarted.recoverAtStartup()[0].to,"running");
 await restarted.tick();assert.equal(f.row(id).status,"running");
 await restarted.tick();assert.equal(f.row(id).status,"succeeded");
 assert.equal(posts,1);assert.equal(polls,2);assert.equal(collects,1);
 assert.equal(restarted.attempts(id).length,3);
});
test("startup recovery never repeats a generation whose submitting barrier survived but response did not",async t=>{
 const f=fixture(t),id=f.queued("crashed");
 f.db.prepare("UPDATE jobs SET status='submitting',submit_marker='sent-on-wire',submission_started_at=123,lease_owner='dead-process' WHERE id=?").run(id);
 let posts=0;
 const c=createJobCoordinator({db:f.db,adapters:{model:{async submit(){posts++}}}});
 const recovery=c.recoverAtStartup();
 assert.equal(recovery[0].to,"submission_unknown");
 assert.equal(f.row(id).submit_marker,"sent-on-wire");
 assert.equal(f.row(id).status,"submission_unknown");
 await c.tick();assert.equal(posts,0);
});
test("recovery rolls back preparation safely; but immediate collecting without receipt becomes unknown",async t=>{
 const f=fixture(t);
 const before=f.queued("preparing"),after=f.queued("collecting");
 f.db.prepare("UPDATE jobs SET status='preparing',lease_owner='dead' WHERE id=?").run(before);
 f.db.prepare("UPDATE jobs SET status='collecting',lease_owner='dead' WHERE id=?").run(after);
 const c=createJobCoordinator({db:f.db,adapters:{model:done(f.addArtifact)}});
 const recovered=new Map(c.recoverAtStartup().map(x=>[x.jobId,x.to]));
 assert.equal(recovered.get(before),"queued");
 assert.equal(recovered.get(after),"submission_unknown");
 await c.tick();
 assert.equal(f.row(before).status,"succeeded");
 assert.equal(f.row(after).status,"submission_unknown");
});
test("collection failure preserves collecting state, retries only collection (not generation)",async t=>{
 const f=fixture(t),id=f.queued("collect");let submissions=0,collections=0;
 const c=createJobCoordinator({db:f.db,adapters:{model:{
  async submit(){submissions++;return {kind:"completed",receipt:{file:"capture"}}},
  async collect({job}){collections++;if(collections===1)throw Error("network_io");f.addArtifact(job.id)}
 }}});
 c.recoverAtStartup();
 await c.tick();assert.equal(f.row(id).status,"collecting");
 assert.equal(f.row(id).recovery_receipt_json,'{"file":"capture"}');
 await c.tick();assert.equal(f.row(id).status,"succeeded");
 assert.equal(submissions,1);assert.equal(collections,2);
 assert.deepEqual(c.attempts(id).map(x=>x.outcome),["collect_pending","succeeded"]);
});
test("collect cannot claim GPU success without a persisted artifact",async t=>{
 const f=fixture(t),id=f.queued("no-artifact");
 const c=createJobCoordinator({db:f.db,adapters:{model:{
  async submit(){return{kind:"completed",receipt:{ready:true}}},
  async collect(){} // no persisted proof
 }}});
 c.recoverAtStartup();await c.tick();
 assert.equal(f.row(id).status,"collecting");
 assert.equal(c.attempts(id)[0].outcome,"collect_pending");
});
test("model lane enforces concurrency=2, third job remains queued until slots free",async t=>{
 const f=fixture(t),ids=["a","b","c"].map(name=>f.queued(name));
 let started=0;let release;
 const gate=new Promise(resolve=>release=resolve);
 const c=createJobCoordinator({db:f.db,modelConcurrency:2,adapters:{model:{
  async submit(){started++;await gate;return{kind:"completed",receipt:{ok:true}}},
  async collect({job}){f.addArtifact(job.id)}
 }}});
 c.recoverAtStartup();
 const working=c.tick();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(started,2);
 assert.deepEqual(ids.map(id=>f.row(id).status).sort(),["queued","submitting","submitting"]);
 release();await working;
 assert.deepEqual(ids.map(id=>f.row(id).status).sort(),["queued","succeeded","succeeded"]);
 await c.tick();assert.equal(started,3);
 assert.deepEqual(ids.map(id=>f.row(id).status),["succeeded","succeeded","succeeded"]);
});
test("Comfy concurrency=1 per instance; different Comfy instances run concurrently",async t=>{
 const f=fixture(t);
 const a1=f.queued("a1",{kind:"comfy",instanceId:"A",executionMode:"poll"});
 const a2=f.queued("a2",{kind:"comfy",instanceId:"A",executionMode:"poll"});
 const b=f.queued("b",{kind:"comfy",instanceId:"B",executionMode:"poll"});
 let submits=[];let release;
 const gate=new Promise(resolve=>release=resolve);
 const adapter={async submit({job}){submits.push(job.id);await gate;return{kind:"accepted",remoteTaskId:job.id}}};
 const c=createJobCoordinator({db:f.db,adapters:{comfy:{A:adapter,B:adapter}}});
 c.recoverAtStartup();
 const pending=c.tick();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(submits.length,2);
 assert.ok(submits.includes(b));
 assert.equal([a1,a2].filter(id=>submits.includes(id)).length,1);
 const waiting=[a1,a2].find(id=>!submits.includes(id));
 assert.equal(f.row(waiting).status,"queued");
 release();await pending;
 await c.tick(); // original remote tasks remain running; same GPU lane stays reserved
 assert.equal(submits.length,2);assert.equal(f.row(waiting).status,"queued");
});
test("credential revoked after enqueue is blocked_credential BEFORE any upstream submit",async t=>{
 const f=fixture(t),channelId="ch",ref="v1";
 f.db.prepare("INSERT INTO channels(id,provider,display_name,created_at,updated_at) VALUES(?,?,?,?,?)")
  .run(channelId,"openai","example",1,1);
 f.db.prepare("INSERT INTO credential_versions(id,channel_id,version_num,ciphertext,created_at) VALUES(?,?,?,?,?)")
  .run(ref,channelId,1,Buffer.from("fake-encrypted"),1);
 const id=f.queued("cred",{channelId,secretVersionRef:ref});
 f.db.prepare("UPDATE credential_versions SET revoked_at=123 WHERE id=?").run(ref);
 let posts=0;
 const c=createJobCoordinator({db:f.db,adapters:{model:{async submit(){posts++}}}});
 c.recoverAtStartup();await c.tick();
 assert.equal(f.row(id).status,"blocked_credential");assert.equal(posts,0);
});
test("adapter contract violation after POST cannot initiate a second request",async t=>{
 const f=fixture(t),id=f.queued("malformed-adapter");let posts=0;
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:{
  async submit(){posts++;return{kind:"completed",receipt:{apiKey:"NEVER_SAVE_ME"}}}
 }}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(f.row(id).status,"submission_unknown");
 assert.equal(f.db.prepare("SELECT recovery_receipt_json AS receipt FROM jobs WHERE id=?").get(id).receipt,null);
 await coordinator.tick();
 assert.equal(posts,1);
});
test("runtime opt-in dispatch is accessible through authenticated job API and attempt history",async t=>{
 if(process.platform!=="win32")return;
 const dataDir=mkdtempSync(join(tmpdir(),"atelier-scheduler-http-"));
 let backend;
 try{
  backend=createLocalBackend({dataDir,adapters:{model:{
   async submit(){return{kind:"completed",receipt:{output:"stored"}}},
   async collect({job,db}){
    const blob="artifact-"+job.id;
    db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,?,?,?,?)")
      .run(blob,blob,1,"text/plain",blob,"ready");
    appendArtifact(db,{jobId:job.id,itemKey:"0",blobId:blob,kind:"text",mime:"text/plain",sha256:blob});
   }
  }}});
  assert.ok(backend.coordinator);
  const bootstrap=backend.sessionAuth.bootstrapToken;
  const auth=await backend.app.inject({method:"POST",url:"/api/v1/session",payload:{},
   headers:{host:"localhost",origin:"http://localhost",authorization:"Bearer "+bootstrap}});
  assert.equal(auth.statusCode,201);
  const cookie=auth.headers["set-cookie"].split(";")[0];
  const headers={host:"localhost",cookie,origin:"http://localhost","x-atelier-csrf":auth.json().csrfToken};
  const item=await backend.app.inject({method:"POST",url:"/api/v1/jobs",headers,
   payload:{idempotencyKey:"http-1",requestFingerprint:"http-1",executionMode:"immediate",
    snapshot:{adapterKind:"model",prompt:"hello"}}});
  assert.equal(item.statusCode,201,item.body);
  const id=item.json().id;
  assert.equal((await backend.app.inject({method:"GET",url:"/api/v1/coordinator/status",headers})).json().byStatus.queued,1);
  assert.equal(await backend.coordinator.tick(),1);
  const persisted=await backend.app.inject({method:"GET",url:"/api/v1/jobs/"+id,headers});
  assert.equal(persisted.statusCode,200);
  assert.equal(persisted.json().status,"succeeded");
  assert.ok(persisted.json().submitMarker);
  assert.ok(persisted.json().submissionStartedAt>0);
  const attempts=await backend.app.inject({method:"GET",url:"/api/v1/jobs/"+id+"/attempts",headers});
  assert.equal(attempts.statusCode,200);
  assert.equal(attempts.json().attempts.length,1);
  assert.equal(attempts.json().attempts[0].outcome,"succeeded");
  assert.equal(attempts.body.includes("secretVersionRef"),false);
  assert.equal((await backend.app.inject({method:"GET",url:"/api/v1/jobs/"+id+"/attempts"})).statusCode,401);
 }finally{if(backend)await backend.close();rmSync(dataDir,{recursive:true,force:true})}
});
test("startup cleanup retains terminal success even when lease release was interrupted",async t=>{
 const f=fixture(t),id=f.queued("terminal");
 f.db.prepare("UPDATE jobs SET status='succeeded',lease_owner='dead-worker',lease_acquired_at=1,lease_expires_at=2 WHERE id=?").run(id);
 let submissions=0;
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:{async submit(){submissions++}}}});
 assert.equal(coordinator.recoverAtStartup()[0].to,"succeeded");
 assert.equal(f.row(id).lease_owner,null);
 await coordinator.tick();
 assert.equal(f.row(id).status,"succeeded");assert.equal(submissions,0);
});
test("coordinator stop drains an already-submitting request and refuses new claims",async t=>{
 const f=fixture(t),id=f.queued("stopping");
 let enter,release;
 const started=new Promise(resolve=>enter=resolve);
 const gate=new Promise(resolve=>release=resolve);
 const c=createJobCoordinator({db:f.db,adapters:{model:{
  async submit(){enter();await gate;return{kind:"completed",receipt:{ok:true}}},
  async collect({job}){f.addArtifact(job.id)}
 }}});
 c.recoverAtStartup();
 const dispatch=c.tick();await started;
 assert.equal(f.row(id).status,"submitting");
 let stopped=false;
 const stopping=c.stop().then(()=>{stopped=true});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(stopped,false);
 await assert.rejects(c.tick(),/coordinator_stopping/);
 release();await dispatch;await stopping;
 assert.equal(stopped,true);
 assert.equal(f.row(id).status,"succeeded");
 assert.equal(f.row(id).lease_owner,null);
});


