import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {fingerprintSource,submitJob,appendArtifact} from "./repository.mjs";
import {buildApp} from "./app.mjs";
import {listProjectJobs} from "./project-job-history.mjs";

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
