import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {fingerprintSource,submitJob,appendArtifact} from "./repository.mjs";
import {buildApp} from "./app.mjs";
import {listProjectJobs,hideProjectJobHistory} from "./project-job-history.mjs";

const doc={nodes:[{id:"producer",type:"text",metadata:{prompt:"source"},
 position:{x:0,y:0},width:300,height:200}],connections:[]};
function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 createProject(db,{id:"p1",document:doc});
 createProject(db,{id:"p2",document:doc});
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner"});
 t.after(async()=>{await app.close();db.close()});
 const call=(url,headers={"x-test-owner":"owner"})=>app.inject({method:"GET",url,headers});
 const make=(key,projectId="p1",task="image")=>{
  const jobId=submitJob(db,{projectId,targetNodeId:"producer",
   expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"producer"),
   idempotencyKey:key,requestFingerprint:key,executionMode:"immediate",
   snapshot:{adapterKind:"model",provider:"openai",
    task:{kind:task,prompt:"PRIVATE PROMPT NEVER RETURN",model:"test"}}}).jobId;
  db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
  return jobId;
 };
 return {db,app,call,make};
}
test("P4.7 project-scoped history pages by (createdAt,id), excludes prompts and other projects",async t=>{
 const f=fixture(t);
 for(let i=0;i<25;i++){
  const id=f.make("key-"+i);
  // same-millisecond timestamps exercise the secondary stable ID cursor.
  f.db.prepare("UPDATE jobs SET created_at=1000 WHERE id=?").run(id);
 }
 f.make("other-project","p2");
 const first=await f.call("/api/v1/projects/p1/jobs?limit=10");
 assert.equal(first.statusCode,200,first.body);
 const a=first.json();
 assert.equal(a.jobs.length,10);
 assert.ok(a.nextBefore);
 assert.ok(a.jobs.every(job=>job.projectId==="p1"&&job.kind==="model"&&job.modelKind==="image"));
 const second=await f.call("/api/v1/projects/p1/jobs?limit=10&before="+a.nextBefore);
 assert.equal(second.statusCode,200,second.body);
 const third=await f.call("/api/v1/projects/p1/jobs?limit=10&before="+second.json().nextBefore);
 assert.equal(third.statusCode,200,third.body);
 const merged=[...a.jobs,...second.json().jobs,...third.json().jobs];
 assert.equal(merged.length,25);
 assert.equal(new Set(merged.map(x=>x.id)).size,25);
 assert.equal(third.json().nextBefore,null);
 assert.ok(merged.every(x=>x.artifacts.length===0));
 assert.doesNotMatch(JSON.stringify({a,b:second.json(),c:third.json()}),/PRIVATE PROMPT|secretVersionRef|snapshot_json/);
 assert.equal((await f.call("/api/v1/projects/p1/jobs?limit=1000")).statusCode,400);
 assert.equal((await f.call("/api/v1/projects/p1/jobs?before=no-such-job")).statusCode,400);
 assert.equal((await f.call("/api/v1/projects/missing/jobs")).statusCode,404);
 assert.equal((await f.app.inject({method:"GET",url:"/api/v1/projects/p1/jobs"})).statusCode,401);
 assert.equal((await f.call("/api/v1/projects/p1/jobs",{"x-test-owner":"owner",origin:"http://attacker.test"})).statusCode,200);
});
test("P4.7 job diagnostics whitelist coordinator outcomes but never arbitrary secrets",async t=>{
 const f=fixture(t),jobId=f.make("diagnostic");
 f.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(jobId);
 const attempt=f.db.prepare("INSERT INTO job_attempts(id,job_id,phase,started_at,outcome) VALUES(?,?,?,?,?)");
 attempt.run("a1",jobId,"submitting",1,"not_accepted");
 assert.equal((await f.call("/api/v1/projects/p1/jobs")).json().jobs[0].lastOutcome,"not_accepted");
 attempt.run("a2",jobId,"collecting",2,"SECRET_TOKEN_98765");
 const response=await f.call("/api/v1/projects/p1/jobs");
 assert.equal(response.json().jobs[0].lastOutcome,null);
 assert.doesNotMatch(response.body,/SECRET_TOKEN_98765|PRIVATE PROMPT/);
});
test("history DELETE is project-scoped, authorized, terminal-only and hides without deleting durable task state",async t=>{
 const f=fixture(t),finished=f.make("finished"),foreign=f.make("foreign","p2");
 const active=f.make("active");
 f.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(active);
 f.db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,?,?,?,?)")
  .run("b-history","b-history",1,"image/png","blob-history","ready");
 appendArtifact(f.db,{id:"a-history",jobId:finished,portId:"image",itemKey:"image-0",blobId:"b-history",
  kind:"image",mime:"image/png",sha256:"b-history"});
 f.db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,reason) VALUES(?,?,?,?,?,?)")
  .run("m-history",finished,"a-history","p1","blocked","materialization_source_changed");
 const prefix="/api/v1/projects/p1/jobs/",suffix="/history";
 const del=(url,headers={"x-test-owner":"owner"})=>f.app.inject({method:"DELETE",url,headers});
 assert.equal((await del(prefix+finished+suffix,{})).statusCode,401);
 assert.equal((await del(prefix+finished+suffix,{"x-test-owner":"owner",origin:"https://attacker.example"})).statusCode,403);
 assert.equal((await del(prefix+foreign+suffix)).statusCode,404);
 assert.equal((await del("/api/v1/projects/missing/jobs/"+finished+suffix)).statusCode,404);
 assert.equal((await del(prefix+active+suffix)).statusCode,409);
 for(const status of ["submission_unknown","blocked_credential","collecting"]){
  f.db.prepare("UPDATE jobs SET status=? WHERE id=?").run(status,active);
  assert.equal((await del(prefix+active+suffix)).statusCode,409);
 }
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM job_history_hidden").get().n,0);
 const result=await del(prefix+finished+suffix);
 assert.equal(result.statusCode,200,result.body);
 assert.deepEqual(result.json(),{hidden:true,jobId:finished});
 assert.equal((await del(prefix+finished+suffix)).statusCode,200,"idempotent history removal");
 const items=(await f.call("/api/v1/projects/p1/jobs")).json().jobs;
 assert.deepEqual(items.map(x=>x.id),[active]);
 assert.equal((await f.call("/api/v1/projects/p2/jobs")).json().jobs[0].id,foreign);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(finished).status,"succeeded");
 assert.equal(f.db.prepare("SELECT status FROM materializations WHERE job_id=?").get(finished).status,"blocked");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM artifacts WHERE job_id=?").get(finished).n,1);
 assert.ok(f.db.prepare("SELECT id FROM blobs WHERE id=?").get("b-history"));
 assert.equal((await f.call("/api/v1/jobs/"+finished)).statusCode,200);
 const replay=submitJob(f.db,{projectId:"p1",targetNodeId:"producer",expectedProjectRevision:1,
  sourceNodeFingerprint:fingerprintSource(doc,"producer"),idempotencyKey:"finished",
  requestFingerprint:"finished",executionMode:"immediate",snapshot:{adapterKind:"model",provider:"openai",
   task:{kind:"image",prompt:"PRIVATE PROMPT NEVER RETURN",model:"test"}}});
 assert.equal(replay.existing,true,"same idempotency key cannot submit a second paid job");
 assert.equal(replay.jobId,finished);
});

test("explicit, authenticated risk acknowledgment closes only unverified model job and unblocks new source job",async t=>{
 const f=fixture(t),old=f.make("unverified-model"),foreign=f.make("foreign-close","p2");
 f.db.prepare("UPDATE jobs SET status='submission_unknown',submission_started_at=5,submit_marker='original-marker',updated_at=1234 WHERE id=?").run(old);
 f.db.prepare("INSERT INTO job_attempts(id,job_id,phase,started_at,finished_at,outcome) VALUES(?,?,?,?,?,?)")
  .run("old-attempt",old,"submitting",100,200,"submission_unknown");
 const url="/api/v1/projects/p1/jobs/"+old+"/close-unverified";
 const post=(path=url,payload={confirmationJobId:old,expectedUpdatedAt:1234,acknowledgePossibleCharge:true},headers={"x-test-owner":"owner"})=>
  f.app.inject({method:"POST",url:path,headers,payload});
 const makeNew=key=>submitJob(f.db,{projectId:"p1",targetNodeId:"producer",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"producer"),
  idempotencyKey:key,requestFingerprint:key,executionMode:"immediate",
  snapshot:{adapterKind:"model",provider:"openai",task:{kind:"image",model:"new",prompt:"new prompt"}}});
 assert.throws(()=>makeNew("next"),/backend_prior_job_not_terminal/);
 assert.equal((await post(url,undefined,{})).statusCode,401);
 assert.equal((await post(url,undefined,{"x-test-owner":"owner",origin:"https://attacker.invalid"})).statusCode,403);
 assert.equal((await post("/api/v1/projects/p2/jobs/"+old+"/close-unverified")).statusCode,404);
 assert.equal((await post(url,{confirmationJobId:"wrong",expectedUpdatedAt:1234,acknowledgePossibleCharge:true})).statusCode,400);
 assert.equal((await post(url,{confirmationJobId:old,expectedUpdatedAt:1234,acknowledgePossibleCharge:false})).statusCode,400);
 assert.equal((await post(url,{confirmationJobId:old,expectedUpdatedAt:1233,acknowledgePossibleCharge:true})).statusCode,409);
 assert.equal((await post("/api/v1/projects/p2/jobs/"+foreign+"/close-unverified",
  {confirmationJobId:foreign,expectedUpdatedAt:1234,acknowledgePossibleCharge:true})).statusCode,409);
 f.db.prepare("UPDATE jobs SET lease_owner='still-running' WHERE id=?").run(old);
 assert.equal((await post()).statusCode,409);
 f.db.prepare("UPDATE jobs SET lease_owner=NULL WHERE id=?").run(old);
 f.db.prepare("UPDATE jobs SET upstream_task_id='remote-existing' WHERE id=?").run(old);
 assert.equal((await post()).statusCode,409,"known remote tasks require provider reconciliation, not local closure");
 f.db.prepare("UPDATE jobs SET upstream_task_id=NULL WHERE id=?").run(old);
 const before=(await f.call("/api/v1/projects/p1/jobs")).json().jobs.find(j=>j.id===old);
 assert.equal(before.status,"submission_unknown");assert.equal(before.closureEligible,true);
 const closed=await post();
 assert.equal(closed.statusCode,200,closed.body);
 assert.deepEqual(closed.json(),{closed:true,existing:false,jobId:old,status:"failed"});
 assert.equal((await post()).json().existing,true,"lost admin response is idempotent");
 const row=f.db.prepare("SELECT status,submit_marker,submission_started_at FROM jobs WHERE id=?").get(old);
 assert.equal(row.status,"failed");
 assert.equal(row.submit_marker,"original-marker");
 assert.equal(row.submission_started_at,5);
 assert.equal(f.db.prepare("SELECT outcome FROM job_attempts WHERE job_id=?").get(old).outcome,"submission_unknown");
 const audit=f.db.prepare("SELECT kind,payload_json FROM job_events WHERE job_id=? AND kind='job_operator_closed_unverified'").all(old);
 assert.equal(audit.length,1);assert.equal(JSON.parse(audit[0].payload_json).possibleCharge,true);
 const after=(await f.call("/api/v1/projects/p1/jobs")).json().jobs.find(j=>j.id===old);
 assert.equal(after.operatorClosedUnverified,true);
 assert.equal(after.lastOutcome,"submission_unknown");
 assert.equal(after.closureEligible,false);
 assert.doesNotMatch(JSON.stringify(after),/new prompt|PRIVATE PROMPT|original-marker/);
 const newJob=makeNew("next");
 assert.equal(newJob.existing,false);
 assert.notEqual(newJob.jobId,old);
 assert.equal(makeNew("next").jobId,newJob.jobId,"original idempotency replay preserved");
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE id=?").get(old).n,1);
});
test("history pagination excludes hidden records across page boundaries",async t=>{
 const f=fixture(t),ids=[];
 for(let i=0;i<8;i++){
  ids.push(f.make("pagination-"+i));
  f.db.prepare("UPDATE jobs SET created_at=? WHERE id=?").run(100+i,ids[i]);
 }
 const del=(id)=>f.app.inject({method:"DELETE",url:"/api/v1/projects/p1/jobs/"+id+"/history",
  headers:{"x-test-owner":"owner"}});
 assert.equal((await del(ids[6])).statusCode,200);
 assert.equal((await del(ids[4])).statusCode,200);
 const first=(await f.call("/api/v1/projects/p1/jobs?limit=3")).json();
 const second=(await f.call("/api/v1/projects/p1/jobs?limit=3&before="+first.nextBefore)).json();
 assert.deepEqual([...first.jobs,...second.jobs].map(x=>x.id),[ids[7],ids[5],ids[3],ids[2],ids[1],ids[0]]);
 assert.equal(second.nextBefore,null);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM job_history_hidden").get().n,2);
 initializeSchema(f.db);
 assert.equal((await f.call("/api/v1/projects/p1/jobs")).json().jobs.length,6);
});
test("v15 database migrates to v16 and remembers removed history after reopening disk",t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-history-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,"history.sqlite");
 let db=new DatabaseSync(file);
 try{
  initializeSchema(db);
  createProject(db,{id:"p1",document:doc});
  const id=submitJob(db,{projectId:"p1",targetNodeId:"producer",expectedProjectRevision:1,
   sourceNodeFingerprint:fingerprintSource(doc,"producer"),idempotencyKey:"disk",
   requestFingerprint:"disk",executionMode:"immediate",snapshot:{adapterKind:"model"}}).jobId;
  db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(id);
  // Simulate opening an existing v15 database without this new table.
  db.exec("DROP TABLE job_history_hidden");
  db.prepare("DELETE FROM schema_migrations WHERE version=19").run();
  db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(15,1)").run();
  db.close();db=new DatabaseSync(file);
  initializeSchema(db);
  assert.equal(db.prepare("SELECT MAX(version) v FROM schema_migrations").get().v,19);
  assert.equal(listProjectJobs(db,{projectId:"p1"}).jobs.length,1);
  assert.deepEqual(hideProjectJobHistory(db,{projectId:"p1",jobId:id}),{hidden:true,jobId:id});
  db.close();db=new DatabaseSync(file);
  initializeSchema(db);
  assert.equal(listProjectJobs(db,{projectId:"p1"}).jobs.length,0);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"failed");
 }finally{db.close()}
});
test("P4.8 authenticated project-scoped human reconciliation remains read-only until verified",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 createProject(db,{id:"p1",document:doc});
 createProject(db,{id:"p2",document:doc});
 const jobId=submitJob(db,{projectId:"p1",targetNodeId:"producer",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"producer"),
  idempotencyKey:"unknown-prompt",requestFingerprint:"unknown-prompt",executionMode:"poll",
  snapshot:{adapterKind:"comfy",instanceId:"local",
   privatePrompt:"PRIVATE PROMPT NEVER RETURN"}}).jobId;
 db.prepare("INSERT INTO comfy_job_preparations(job_id,graph_json,capture_map_json,graph_hash,image_files_json,workflow_node_id,created_at) VALUES(?,?,?,?,?,?,?)")
  .run(jobId,"{}","[]","digest","{}","producer",1);
 db.prepare("UPDATE jobs SET status='submission_unknown',submit_marker='original-marker',submission_started_at=1000 WHERE id=?")
  .run(jobId);
 let proof="unverified",remoteChecks=0,posts=0;
 const {createJobCoordinator}=await import("./job-coordinator.mjs");
 const coordinator=createJobCoordinator({db,adapters:{comfy:{local:{
  async reconcile({remoteTaskId,job}){
   remoteChecks++;assert.equal(remoteTaskId,"remote-1");
   assert.equal(job.submit_marker,"original-marker");return {kind:proof};
  },
  async poll(){return {kind:"pending"}},
  async submit(){posts++;throw Error("never called")}
 }}}});
 coordinator.recoverAtStartup();
 const app=buildApp({db,coordinator,authorize:req=>req.headers["x-test-owner"]==="owner"});
 t.after(async()=>{await app.close();db.close()});
 const url="/api/v1/projects/p1/jobs/"+jobId+"/reconcile";
 const post=(path=url,headers={"x-test-owner":"owner"},payload={remoteTaskId:"remote-1"})=>
  app.inject({method:"POST",url:path,headers,payload});
 const history=await app.inject({method:"GET",url:"/api/v1/projects/p1/jobs",
  headers:{"x-test-owner":"owner"}});
 assert.equal(history.statusCode,200);
 assert.equal(history.json().jobs[0].reconciliationEligible,true);
 assert.doesNotMatch(history.body,/PRIVATE PROMPT|original-marker/);
 assert.equal((await post(url,{})).statusCode,401);
 assert.equal((await post(url,{"x-test-owner":"owner",origin:"https://attacker.example"})).statusCode,403);
 assert.equal((await post("/api/v1/projects/p2/jobs/"+jobId+"/reconcile")).statusCode,404);
 assert.equal((await post(url,{"x-test-owner":"owner"},{remoteTaskId:"../wrong"})).statusCode,400);
 const unknown=await post();
 assert.equal(unknown.statusCode,200,unknown.body);
 assert.deepEqual(unknown.json(),{verified:false,status:"submission_unknown",reason:"remote_evidence_absent"});
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"submission_unknown");
 proof="completed";
 const verified=await post();
 assert.equal(verified.statusCode,200,verified.body);
 assert.deepEqual(verified.json(),{verified:true,status:"collecting"});
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"collecting");
 assert.equal((await post()).statusCode,409);
 assert.equal(posts,0);assert.equal(remoteChecks,2);
});
test("P4.7 history reports blocked, retry and pending materializations without modifying successful jobs",async t=>{
 const f=fixture(t),jobId=f.make("succeeded");
 f.db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,?,?,?,?)")
  .run("b1","b1",1,"image/png","blob1","ready");
 const add=id=>appendArtifact(f.db,{id,jobId,portId:"image",itemKey:id,blobId:"b1",
  kind:"image",mime:"image/png",sha256:"b1"});
 add("artifact-a");add("artifact-b");add("artifact-c");
 f.db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,reason) VALUES(?,?,?,?,?,?)")
  .run("mat-a",jobId,"artifact-a","p1","blocked","materialization_source_changed");
 f.db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,next_due_at) VALUES(?,?,?,?,?,?)")
  .run("mat-b",jobId,"artifact-b","p1","retry",Date.now()+1000);
 const response=(await f.call("/api/v1/projects/p1/jobs")).json();
 const j=response.jobs[0];
 assert.equal(j.status,"succeeded");
 assert.deepEqual(j.artifacts.map(x=>[x.artifactId,x.status,x.reason]),[
  ["artifact-a","blocked","materialization_source_changed"],
  ["artifact-b","retry",null],
  ["artifact-c","pending",null]
 ]);
 assert.ok(j.artifacts.every(x=>!Object.hasOwn(x,"sha256")&&!Object.hasOwn(x,"blobId")));
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
});
