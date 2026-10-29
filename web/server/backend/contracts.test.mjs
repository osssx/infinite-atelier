import test from"node:test";
import assert from"node:assert/strict";
import{DatabaseSync}from"node:sqlite";
import{randomUUID}from"node:crypto";
import{initializeSchema}from"./schema.mjs";
import{assertJobTransition,classifySubmissionFailure,credentialRecoveryPolicy}from"./contracts.mjs";
import{appendArtifact,fingerprintSource,readEventsAfter,readJobsSnapshot,submitJob,transitionJob}from"./repository.mjs";
const fixture=()=>{const db=new DatabaseSync(":memory:");initializeSchema(db);return db};
const bareJob=(db,key="x",mode="immediate")=>submitJob(db,{idempotencyKey:key,requestFingerprint:key,executionMode:mode,snapshot:{prompt:key}}).jobId;
const blob=(db,id)=>db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,?,?,?,?)").run(id,id,1,"text/plain",id,"ready");
test("schema migration and portless/ported unique indexes",(t)=>{
 const db=fixture();t.after(()=>db.close());initializeSchema(db);
 const j=bareJob(db);blob(db,"b1");blob(db,"b2");
 const a=appendArtifact(db,{jobId:j,itemKey:"0",blobId:"b1",kind:"text",mime:"text/plain",sha256:"b1"});
 assert.equal(appendArtifact(db,{jobId:j,itemKey:"0",blobId:"b1",kind:"text",mime:"text/plain",sha256:"b1"}).artifactId,a.artifactId);
 assert.throws(()=>appendArtifact(db,{jobId:j,itemKey:"0",blobId:"b2",kind:"text",mime:"text/plain",sha256:"b2"}),/artifact_identity_conflict/);
 const b=appendArtifact(db,{jobId:j,portId:"out",itemKey:"0",blobId:"b1",kind:"image",mime:"image/png",sha256:"b1"});
 assert.equal(appendArtifact(db,{jobId:j,portId:"out",itemKey:"0",blobId:"b1",kind:"image",mime:"image/png",sha256:"b1"}).artifactId,b.artifactId);
 assert.throws(()=>appendArtifact(db,{jobId:j,portId:"out",itemKey:"0",blobId:"b2",kind:"image",mime:"image/png",sha256:"b2"}),/artifact_identity_conflict/);
 appendArtifact(db,{jobId:j,portId:"other",itemKey:"0",blobId:"b1",kind:"video",mime:"video/mp4",sha256:"b1"});
 const ins=db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256) VALUES(?,?,?,?,?,?,?,?)");
 assert.throws(()=>ins.run(randomUUID(),j,null,"0","b1","text","text/plain","b1"),/UNIQUE constraint failed/);
 assert.throws(()=>ins.run(randomUUID(),j,"out","0","b1","image","image/png","b1"),/UNIQUE constraint failed/);
});
test("projectless idempotency and same-key payload conflict",t=>{
 const db=fixture();t.after(()=>db.close());const id=bareJob(db,"same");
 assert.equal(submitJob(db,{idempotencyKey:"same",requestFingerprint:"same",executionMode:"immediate",snapshot:{prompt:"same"}}).jobId,id);
 assert.throws(()=>submitJob(db,{idempotencyKey:"same",requestFingerprint:"changed",executionMode:"immediate",snapshot:{}}),/idempotency_key_conflict/);
 assert.throws(()=>submitJob(db,{idempotencyKey:"same",requestFingerprint:"same",executionMode:"immediate",snapshot:{prompt:"other"}}),/idempotency_key_conflict/);
 assert.throws(()=>submitJob(db,{idempotencyKey:"same",requestFingerprint:"same",executionMode:"poll",snapshot:{prompt:"same"}}),/idempotency_key_conflict/);
 assert.equal(readJobsSnapshot(db).jobs.length,1);
});
test("generation cannot enqueue until revision and frozen source match",t=>{
 const db=fixture();t.after(()=>db.close());
 const doc={nodes:[{id:"n",type:"text",metadata:{prompt:"hello"}}],connections:[]};
 db.prepare("INSERT INTO projects(id,document_json,revision) VALUES(?,?,?)").run("p",JSON.stringify(doc),7);
 const req={projectId:"p",targetNodeId:"n",expectedProjectRevision:7,sourceNodeFingerprint:fingerprintSource(doc,"n"),idempotencyKey:"k",requestFingerprint:"k",executionMode:"poll",snapshot:{}};
 assert.throws(()=>submitJob(db,{...req,expectedProjectRevision:6}),/stale_generation_source/);
 assert.throws(()=>submitJob(db,{...req,sourceNodeFingerprint:"bad"}),/stale_generation_source/);
 db.prepare("UPDATE projects SET revision=8 WHERE id='p'").run();
 assert.throws(()=>submitJob(db,req),/stale_generation_source/);
 assert.equal(readJobsSnapshot(db).jobs.length,0);
 db.prepare("UPDATE projects SET revision=7 WHERE id='p'").run();
 assert.equal(submitJob(db,req).existing,false);
});
test("P4.6 concurrent official model jobs are serialized per Canvas producer in SQLite",t=>{
 const db=fixture();t.after(()=>db.close());
 const graph={nodes:[{id:"source",type:"text",metadata:{prompt:"hello"}},
  {id:"other",type:"text",metadata:{prompt:"other"}}],connections:[]};
 db.prepare("INSERT INTO projects(id,document_json,revision) VALUES(?,?,?)")
  .run("canvas-p",JSON.stringify(graph),1);
 const make=(key,targetNodeId="source")=>({projectId:"canvas-p",targetNodeId,
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(graph,targetNodeId),
  idempotencyKey:key,requestFingerprint:key,executionMode:"immediate",
  snapshot:{adapterKind:"model",provider:"openai",task:{kind:"image",model:"test",prompt:"hello"}}});
 const first=submitJob(db,make("first"));
 assert.equal(first.existing,false);
 assert.equal(submitJob(db,make("first")).jobId,first.jobId);
 assert.throws(()=>submitJob(db,make("second")),/backend_prior_job_not_terminal/);
 assert.equal(submitJob(db,make("other","other")).existing,false);
 transitionJob(db,first.jobId,"cancelled");
 const second=submitJob(db,make("second"));
 assert.equal(second.existing,false);
 transitionJob(db,second.jobId,"preparing");
 transitionJob(db,second.jobId,"submitting");
 transitionJob(db,second.jobId,"submission_unknown");
 assert.throws(()=>submitJob(db,make("third")),/backend_prior_job_not_terminal/);
 assert.equal(submitJob(db,make("second")).jobId,second.jobId);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE target_node_id='source'").get().n,2);
});
test("each user-clicked text model request may submit despite previous unknown or active task",t=>{
 const db=fixture();t.after(()=>db.close());
 const graph={nodes:[{id:"source",type:"text",metadata:{prompt:"hello"}}],connections:[]};
 db.prepare("INSERT INTO projects(id,document_json,revision) VALUES(?,?,?)").run("p-text",JSON.stringify(graph),1);
 const make=(key,kind="text")=>({projectId:"p-text",targetNodeId:"source",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(graph,"source"),
  idempotencyKey:key,requestFingerprint:key,executionMode:"immediate",
  snapshot:{adapterKind:"model",provider:"openai",task:{kind,model:"deepseek/deepseek-v4.1-flash-1017",prompt:"hello"}}});
 const old=submitJob(db,make("old")).jobId;
 transitionJob(db,old,"preparing");
 transitionJob(db,old,"submitting");
 transitionJob(db,old,"submission_unknown");
 const next=submitJob(db,make("next"));
 assert.equal(next.existing,false);
 assert.notEqual(next.jobId,old);
 assert.equal(submitJob(db,make("next")).jobId,next.jobId,"same-click retries still use idempotency");
 const concurrent=submitJob(db,make("clicked-again"));
 assert.notEqual(concurrent.jobId,next.jobId,"text requests have no prior-job terminal requirement");
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(old).status,"submission_unknown");
 assert.throws(()=>submitJob(db,make("image-is-serialized","image")),/backend_prior_job_not_terminal/);
 assert.throws(()=>submitJob(db,{...make("bad-fence"),expectedProjectRevision:99}),/stale_generation_source/);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE project_id='p-text'").get().n,3);
});
test("mode and submission safety",()=>{
 assertJobTransition("submitting","collecting",{executionMode:"immediate"});
 assertJobTransition("submitting","running",{executionMode:"poll"});
 assertJobTransition("submitting","running",{executionMode:"stream"});
 assert.throws(()=>assertJobTransition("submitting","running",{executionMode:"immediate"}),/immediate_cannot_poll/);
 assert.throws(()=>assertJobTransition("submitting","failed",{executionMode:"poll"}),/submission_may_have_occurred/);
 assertJobTransition("submitting","failed",{executionMode:"poll",confirmedNotAccepted:true});
 assert.throws(()=>assertJobTransition("submission_unknown","running",{executionMode:"poll"}),/unverified_remote_task/);
 assertJobTransition("submission_unknown","running",{executionMode:"poll",trustedRemoteMatch:true});
 assert.equal(classifySubmissionFailure({}),"submission_unknown");
 assert.equal(classifySubmissionFailure({confirmedNotAccepted:true}),"failed");
});
test("credential recovery never silently sends a new generation",()=>{
 assert.equal(credentialRecoveryPolicy({submissionMayHaveOccurred:false}),"new_linked_job_required");
 assert.equal(credentialRecoveryPolicy({submissionMayHaveOccurred:true}),"reconcile_or_explicit_new_job");
 assert.equal(credentialRecoveryPolicy({submissionMayHaveOccurred:true,trustedRemoteTaskId:"task"}),"resume_existing_task_only");
 assert.throws(()=>assertJobTransition("blocked_credential","running",{executionMode:"poll",trustedRemoteMatch:true}),/credential_recovery_not_authorized/);
 assertJobTransition("blocked_credential","running",{executionMode:"poll",trustedRemoteMatch:true,recoveryCredentialAuthorized:true});
});
test("consistent snapshot event cursor; transaction rollback keeps event and state together",t=>{
 const db=fixture();t.after(()=>db.close());const j=bareJob(db);const snap=readJobsSnapshot(db);
 assert.equal(snap.jobs[0].status,"queued");assert.equal(snap.eventCursor,1);
 transitionJob(db,j,"preparing");transitionJob(db,j,"submitting");
 assert.deepEqual(readEventsAfter(db,snap.eventCursor).map(e=>e.seq),[2,3]);
 assert.throws(()=>transitionJob(db,j,"succeeded"),/illegal_job_transition/);
 assert.equal(readEventsAfter(db,3).length,0);
 assert.equal(readJobsSnapshot(db).jobs[0].status,"submitting");
});
