import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createCanvasMaterializer} from "./canvas-materializer.mjs";
import {createProject,getProject,patchProject} from "./projects.mjs";
import {fingerprintSource,fingerprintSourceLegacy,submitJob,appendArtifact,transitionJob,readEventsAfter} from "./repository.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {createBackendWorker} from "./worker.mjs";
import {createLocalBackend} from "./runtime.mjs";
import {buildApp} from "./app.mjs";
import {randomUUID} from "node:crypto";

const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,73,72,68,82]);
const mp4=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const wav=Buffer.from("524946460800000057415645666d7420","hex");
const kinds=[["image","image",png,"image/png","IMAGE"],["video","video",mp4,"video/mp4","VIDEO"],["audio","audio",wav,"audio/wav","AUDIO"],["text","result",Buffer.from("hello"),"text/plain","STRING"]];
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"atelier-materialization-")),db=new DatabaseSync(":memory:");
 initializeSchema(db);
 const blobStore=createBlobStore({dataDir:dir,db});
 const materializer=createCanvasMaterializer({db,blobStore});
 const source={id:"wf-1",type:"comfy:workflow",title:"Comfy",position:{x:12,y:24},width:400,height:300,metadata:{
  comfyPorts:kinds.map(([kind,port,, ,valueKind])=>({id:port,label:port,direction:"source",valueKind}))}};
 const doc={nodes:[source],connections:[]};
 createProject(db,{id:"project-1",document:doc});
 const fingerprint=fingerprintSource(doc,"wf-1");
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 async function addArtifacts({key="job1",count=kinds.length}={}){
  const jobId=submitJob(db,{projectId:"project-1",targetNodeId:"wf-1",expectedProjectRevision:1,sourceNodeFingerprint:fingerprint,
   idempotencyKey:key,requestFingerprint:key,executionMode:"poll",snapshot:{adapterKind:"comfy",instanceId:"comfy-local"}}).jobId;
  const created=[];
  for(let index=0;index<count;index++){
   const [kind,port,bytes,mime]=kinds[index];
   const blob=await blobStore.put([bytes],{mime});
   const artifactId="a-"+key+"-"+index;
   appendArtifact(db,{id:artifactId,jobId,portId:port,itemKey:"item-"+index,blobId:blob.blobId,kind,mime,sha256:blob.sha256,
    metadata:{comfyArtifact:{runId:jobId,artifactId,workflowNodeId:"wf-1",portId:port,kind,index}}});
   created.push(artifactId);
  }
  db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
  return {jobId,created};
 }
 return {db,blobStore,materializer,source,doc,fingerprint,addArtifacts};
}
test("four artifact kinds become typed connected nodes and project revision advances atomically",async t=>{
 const f=fixture(t);
 const {jobId,created}=await f.addArtifacts();
 const result=await f.materializer.runOnce();
 assert.equal(result.length,4);
 assert.ok(result.every(r=>r.status==="materialized"));
 const project=getProject(f.db,"project-1");
 assert.equal(project.revision,5);
 assert.equal(project.document.nodes.length,5);
 assert.equal(project.document.connections.length,4);
 for(const [i,artifactId] of created.entries()){
  const output=project.document.nodes.find(n=>n.id==="artifact-"+artifactId);
  const [kind,port,,,] = kinds[i];
  assert.equal(output.type,kind);
  assert.equal(output.metadata.comfyArtifact.artifactId,artifactId);
  assert.equal(output.metadata.comfyArtifact.workflowNodeId,"wf-1");
  assert.equal(output.metadata.comfyArtifact.portId,port);
  assert.equal(output.metadata.status,"success");
  const edge=project.document.connections.find(e=>e.toNodeId===output.id);
  assert.equal(edge.fromNodeId,"wf-1");
  assert.equal(edge.fromPortId,port);
  assert.equal(edge.toPortId,"comfy-artifact");
  if(kind==="text")assert.equal(output.metadata.content,"hello");
  else assert.match(output.metadata.content,/^\/api\/v1\/blobs\/[a-f0-9]{64}$/);
 }
 assert.equal(f.materializer.status({jobId}).length,4);
 assert.equal((await f.materializer.runOnce()).length,0);
 assert.equal(getProject(f.db,"project-1").revision,5);
 assert.equal(readEventsAfter(f.db,0).filter(e=>e.kind==="artifact_materialized").length,4);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id=? AND kind=?").get("project-1","materialized").n,4);
});
test("materializer replays after interruption; doesn't duplicate nodes/connections",async t=>{
 const f=fixture(t),{jobId}=await f.addArtifacts();
 await f.materializer.runOnce({maxItems:1});
 const restart=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 assert.equal((await restart.runOnce()).length,3);
 assert.equal((await restart.runOnce()).length,0);
 assert.equal(getProject(f.db,"project-1").document.nodes.length,5);
 assert.equal(restart.status({jobId}).filter(x=>x.status==="materialized").length,4);
});
test("source mutation blocks materialization while GPU success and artifacts remain durable",async t=>{
 const f=fixture(t),{jobId,created}=await f.addArtifacts({count:1});
 const doc=getProject(f.db,"project-1");
 doc.document.nodes[0].metadata.comfyPorts[0].valueKind="STRING";
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:doc.document});
 const blocked=await f.materializer.runOnce();
 assert.equal(blocked[0].status,"blocked");
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
 assert.equal(getProject(f.db,"project-1").document.nodes.length,1);
 assert.equal((await f.materializer.runOnce()).length,0);
 const info=f.materializer.status({jobId})[0];
 assert.equal(info.status,"blocked");
 assert.equal(f.materializer.retryBlocked({projectId:"project-1",artifactId:created[0]}),true);
 const fixed=getProject(f.db,"project-1");
 fixed.document.nodes[0].metadata.comfyPorts[0].valueKind="IMAGE";
 patchProject(f.db,{id:"project-1",expectedRevision:2,document:fixed.document});
 const result=await f.materializer.runOnce();
 assert.equal(result[0].status,"materialized");
 assert.equal(getProject(f.db,"project-1").document.nodes.length,2);
});
test("cosmetic source changes during GPU work do not block v2 materialization",async t=>{
 const f=fixture(t),{jobId}=await f.addArtifacts({count:1});
 const value=getProject(f.db,"project-1");
 value.document.nodes[0].position={x:777,y:222};
 value.document.nodes[0].width=650;
 value.document.nodes[0].title="Moved after GPU submit";
 value.document.nodes[0].metadata.comfyExecution={runId:jobId,status:"running"};
 value.document.nodes[0].metadata.status="loading";
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:value.document});
 const result=await f.materializer.runOnce();
 assert.equal(result[0].status,"materialized");
 assert.equal(getProject(f.db,"project-1").document.nodes.length,2);
});
test("already-blocked legacy standalone Comfy artifact retries after cosmetic changes, without GPU work",async t=>{
 const f=fixture(t);
 const doc=getProject(f.db,"project-1").document;
 doc.nodes[0].metadata.comfyWorkflow={templateId:"saved",templateRevision:"r1",
  bindingState:"bound",inputOverrides:{prompt:"unchanged",seed:1}};
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:doc});
 const oldFingerprint=fingerprintSourceLegacy(doc,"wf-1");
 const frozen={adapterKind:"comfy",instanceId:"comfy-local",comfyTemplate:{id:"saved",revision:"r1"},
  comfyRequest:{instanceId:"comfy-local",nodes:[{id:"wf-1",templateId:"saved",templateRevision:"r1",
   inputOverrides:{prompt:"unchanged",seed:1}}],edges:[],externalInputs:[]}};
 const jobId=submitJob(f.db,{projectId:"project-1",targetNodeId:"wf-1",expectedProjectRevision:2,
  sourceNodeFingerprint:oldFingerprint,idempotencyKey:"old-job",requestFingerprint:"old-job",
  executionMode:"poll",snapshot:frozen}).jobId;
 const blob=await f.blobStore.put([png],{mime:"image/png"});
 const artifactId="old-artifact";
 appendArtifact(f.db,{id:artifactId,jobId,portId:"image",itemKey:"image-0",blobId:blob.blobId,
  kind:"image",mime:"image/png",sha256:blob.sha256,
  metadata:{comfyArtifact:{runId:jobId,artifactId,workflowNodeId:"wf-1",portId:"image",kind:"image",index:0}}});
 f.db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
 const changed=getProject(f.db,"project-1").document;
 changed.nodes[0].position.x=777;
 changed.nodes[0].metadata.comfyWorkflow.inputOverrides.seed=2;
 patchProject(f.db,{id:"project-1",expectedRevision:2,document:changed});
 assert.equal((await f.materializer.runOnce())[0].reason,"materialization_source_changed");
 assert.equal(f.materializer.status({jobId})[0].status,"blocked");
 const restored=getProject(f.db,"project-1").document;
 restored.nodes[0].metadata.comfyWorkflow.inputOverrides.seed=1;
 patchProject(f.db,{id:"project-1",expectedRevision:3,document:restored});
 assert.equal(f.materializer.retryBlocked({projectId:"project-1",artifactId}),true);
 assert.equal((await f.materializer.runOnce())[0].status,"materialized");
 assert.equal(getProject(f.db,"project-1").document.nodes.length,2);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,1,
  "recovery must not submit another GPU job");
});
test("P4.7 pending artifact recover processes only stored Blob, never generates again",async t=>{
 const f=fixture(t),{jobId,created}=await f.addArtifacts({count:1});
 const app=buildApp({db:f.db,materializer:f.materializer,
  authorize:req=>req.headers["x-test-owner"]==="owner"});
 t.after(async()=>app.close());
 const call=(project="project-1",headers={"x-test-owner":"owner"})=>app.inject({
  method:"POST",url:"/api/v1/projects/"+project+"/materializations/"+created[0]+"/recover",
  headers,payload:{}
 });
 assert.equal((await call("another-project")).statusCode,409);
 assert.equal((await call("project-1",{})).statusCode,401);
 assert.equal((await call("project-1",{"x-test-owner":"owner",origin:"https://other.example"})).statusCode,403);
 f.db.prepare("UPDATE jobs SET status='submission_unknown' WHERE id=?").run(jobId);
 assert.equal((await call()).statusCode,409,"ambiguous remote submission cannot materialize");
 f.db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
 const first=await call();
 assert.equal(first.statusCode,200,first.body);
 assert.equal(first.json().status,"materialized");
 assert.equal((await call()).statusCode,409,"already materialized cannot run twice");
 assert.equal(getProject(f.db,"project-1").document.nodes.length,2);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
});
test("P4.7 retry endpoint only requeues a succeeded blocked artifact, never GPU submission",async t=>{
 const f=fixture(t),{jobId,created}=await f.addArtifacts({count:1});
 const current=getProject(f.db,"project-1");
 current.document.nodes[0].metadata.comfyPorts[0].valueKind="STRING";
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:current.document});
 assert.equal((await f.materializer.runOnce())[0].status,"blocked");
 const app=buildApp({db:f.db,materializer:f.materializer,
  authorize:req=>req.headers["x-test-owner"]==="owner"});
 t.after(async()=>app.close());
 const post=(project="project-1",headers={"x-test-owner":"owner"})=>app.inject({
  method:"POST",url:"/api/v1/projects/"+project+"/materializations/"+created[0]+"/retry",
  headers,payload:{}
 });
 const before=(await app.inject({method:"GET",url:"/api/v1/projects/project-1/jobs",
  headers:{"x-test-owner":"owner"}})).json().jobs[0];
 assert.equal(before.artifacts[0].status,"blocked");
 assert.equal(before.artifacts[0].reason,"materialization_port_mismatch");
 assert.equal((await post("other-project")).statusCode,409);
 assert.equal((await post("project-1",{})).statusCode,401);
 assert.equal((await post("project-1",{"x-test-owner":"owner",origin:"https://attacker.example"})).statusCode,403);
 const fixed=getProject(f.db,"project-1");
 fixed.document.nodes[0].metadata.comfyPorts[0].valueKind="IMAGE";
 patchProject(f.db,{id:"project-1",expectedRevision:2,document:fixed.document});
 const retry=await post();
 assert.equal(retry.statusCode,200,retry.body);
 assert.equal(retry.json().requeued,true);
 assert.equal((await post()).statusCode,409,"double click cannot requeue twice");
 const requeued=(await app.inject({method:"GET",url:"/api/v1/projects/project-1/jobs",
  headers:{"x-test-owner":"owner"}})).json().jobs[0];
 assert.equal(requeued.artifacts[0].status,"retry");
 assert.equal((await f.materializer.runOnce())[0].status,"materialized");
 const restored=getProject(f.db,"project-1");
 assert.equal(restored.document.nodes.length,2);
 assert.equal(restored.document.connections.length,1);
 assert.equal((await f.materializer.runOnce()).length,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
 assert.equal(readEventsAfter(f.db,0).filter(x=>x.kind==="artifact_materialization_requeued").length,1);
});
test("deleted workflow or invalid port fails closed without rolling back generation",async t=>{
 const f=fixture(t),{jobId}=await f.addArtifacts({count:1});
 const doc=getProject(f.db,"project-1");
 doc.document.nodes=[];doc.document.connections=[];
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:doc.document});
 const result=await f.materializer.runOnce();
 assert.equal(result[0].status,"blocked");
 assert.equal(result[0].reason,"materialization_source_deleted");
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
});
test("poll backoff is persisted; restart polls only when due and never issues new submit",async t=>{
 const f=fixture(t);
 let now=10_000,submits=0,polls=0;
 const id=submitJob(f.db,{idempotencyKey:"poll",requestFingerprint:"poll",executionMode:"poll",
  snapshot:{adapterKind:"model"}}).jobId;
 const adapter={
  async submit(){submits++;return{kind:"accepted",remoteTaskId:"remote"}},
  async poll(){polls++;if(polls===1)throw Error("network outage");return{kind:"pending"}}
 };
 const opts={db:f.db,adapters:{model:adapter},clock:()=>now,
  retryPolicy:{pollMs:100,collectMs:250,maxMs:1000}};
 const c=createJobCoordinator(opts);c.recoverAtStartup();
 await c.tick();assert.equal(submits,1);assert.equal(polls,0);
 assert.equal(await c.tick(),0);
 now+=100;
 await c.tick();assert.equal(polls,1);
 assert.equal(f.db.prepare("SELECT poll_failures FROM job_schedules WHERE job_id=?").get(id).poll_failures,1);
 const resumed=createJobCoordinator(opts);resumed.recoverAtStartup();
 assert.equal(await resumed.tick(),0);
 now+=199;assert.equal(await resumed.tick(),0);
 now+=1;await resumed.tick();assert.equal(polls,2);assert.equal(submits,1);
});
test("collect retry delay grows and no repeated GPU submit",async t=>{
 const f=fixture(t);let now=10000,collects=0,posts=0;
 const id=submitJob(f.db,{idempotencyKey:"collect",requestFingerprint:"collect",executionMode:"immediate",snapshot:{adapterKind:"model"}}).jobId;
 const c=createJobCoordinator({db:f.db,clock:()=>now,
  retryPolicy:{pollMs:100,collectMs:200,maxMs:1000},adapters:{model:{
   async submit(){posts++;return{kind:"completed",receipt:{output:"saved"}}},
   async collect(){collects++;throw Error("storage offline")}
  }}});
 c.recoverAtStartup();await c.tick();
 assert.equal(collects,1);assert.equal(posts,1);
 assert.equal(await c.tick(),0);
 now+=399;assert.equal(await c.tick(),0);
 now++;await c.tick();
 assert.equal(collects,2);
 assert.equal(f.db.prepare("SELECT collect_failures FROM job_schedules WHERE job_id=?").get(id).collect_failures,2);
 assert.equal(posts,1);
});
test("opt-in worker serializes ticks and drains in-flight tasks",async t=>{
 const f=fixture(t),key=submitJob(f.db,{idempotencyKey:"w",requestFingerprint:"w",executionMode:"immediate",snapshot:{}}).jobId;
 let entered=0,release;
 const gate=new Promise(resolve=>release=resolve);
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:{
  async submit(){entered++;await gate;return{kind:"completed",receipt:{ok:true}}},
  async collect({job}){const blob=await f.blobStore.put([Buffer.from("text")],{mime:"text/plain"});
   appendArtifact(f.db,{jobId:job.id,blobId:blob.blobId,itemKey:"once",kind:"text",mime:"text/plain",sha256:blob.sha256})}
 }}});
 coordinator.recoverAtStartup();
 const worker=createBackendWorker({coordinator,materializer:f.materializer,intervalMs:25}).start();
 try{
  for(let i=0;i<100&&!entered;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(entered,1);
  const closing=worker.stop();
  release();await closing;await coordinator.stop();
  assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(key).status,"succeeded");
  assert.equal(entered,1);
 }finally{release();await worker.stop()}
});
test("autoDispatch completes HTTP job and persists typed canvas output without manual tick",async t=>{
 if(process.platform!=="win32")return;
 const dataDir=mkdtempSync(join(tmpdir(),"atelier-auto-e2e-"));
 let runtime,posts=0;
 try{
  const adapter={
   async submit(){posts++;return {kind:"completed",receipt:{output:"ready"}}},
   async collect({job,db}){
    const store=createBlobStore({dataDir,db});
    const data=Buffer.from("automatic text output");
    const blob=await store.put([data],{mime:"text/plain"});
    const artifactId=randomUUID();
    appendArtifact(db,{id:artifactId,jobId:job.id,portId:"result",itemKey:"text-0",
     blobId:blob.blobId,kind:"text",mime:"text/plain",sha256:blob.sha256,
     metadata:{comfyArtifact:{runId:job.id,artifactId,workflowNodeId:"wf-1",
      portId:"result",kind:"text",index:0}}});
   }
  };
  runtime=createLocalBackend({dataDir,adapters:{model:adapter},autoDispatch:true,dispatchIntervalMs:25});
  const app=runtime.app;
  assert.equal(runtime.worker.status().running,true);
  const auth=await app.inject({method:"POST",url:"/api/v1/session",payload:{},headers:{
   origin:"http://localhost",host:"localhost",authorization:"Bearer "+runtime.sessionAuth.bootstrapToken
  }});
  assert.equal(auth.statusCode,201);
  const headers={host:"localhost",origin:"http://localhost",
   cookie:auth.headers["set-cookie"].split(";")[0],"x-atelier-csrf":auth.json().csrfToken};
  const doc={nodes:[{id:"wf-1",type:"comfy:workflow",title:"workflow",
   position:{x:10,y:20},width:400,height:300,
   metadata:{comfyPorts:[{id:"result",label:"Text",direction:"source",valueKind:"STRING"}]}}],connections:[]};
  const created=await app.inject({method:"POST",url:"/api/v1/projects",
   headers,payload:{id:"project-1",document:doc}});
  assert.equal(created.statusCode,201,created.body);
  const jobResponse=await app.inject({method:"POST",url:"/api/v1/jobs",headers,
   payload:{projectId:"project-1",targetNodeId:"wf-1",expectedProjectRevision:1,
    sourceNodeFingerprint:fingerprintSource(doc,"wf-1"),
    idempotencyKey:"auto-e2e",requestFingerprint:"auto-e2e",executionMode:"immediate",
    snapshot:{adapterKind:"model"}}});
  assert.equal(jobResponse.statusCode,201,jobResponse.body);
  const jobId=jobResponse.json().id;
  let result;
  for(let i=0;i<160;i++){
   await new Promise(resolve=>setTimeout(resolve,25));
   result=await app.inject({method:"GET",url:"/api/v1/projects/project-1",headers});
   if(result.json().document.nodes.length===2)break;
  }
  assert.equal(result.statusCode,200);
  assert.equal(result.json().revision,2,JSON.stringify(result.json()));
  assert.equal(result.json().document.nodes[1].metadata.content,"automatic text output");
  assert.equal(result.json().document.connections[0].fromPortId,"result");
  assert.equal(result.json().document.connections[0].toPortId,"comfy-artifact");
  assert.equal(posts,1);
  const materials=await app.inject({method:"GET",url:"/api/v1/jobs/"+jobId+"/materializations",headers});
  assert.equal(materials.statusCode,200,materials.body);
  assert.equal(materials.json().materializations[0].status,"materialized");
  const snapshot=await app.inject({method:"GET",url:"/api/v1/worker/status",headers});
  assert.equal(snapshot.json().running,true);
 }finally{
  if(runtime)await runtime.close();
  rmSync(dataDir,{recursive:true,force:true});
 }
});

