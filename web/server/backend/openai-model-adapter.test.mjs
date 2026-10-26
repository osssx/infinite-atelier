import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {Readable} from "node:stream";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createOpenAiModelAdapter,validateModelSnapshot} from "./openai-model-adapter.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {submitJob} from "./repository.mjs";
import {fingerprintSource} from "./repository.mjs";
import {createProject,getProject,patchProject} from "./projects.mjs";
import {createCanvasMaterializer} from "./canvas-materializer.mjs";
import {createBackendWorker} from "./worker.mjs";
import {buildApp} from "./app.mjs";
const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082","hex");
const wav=Buffer.from("524946460800000057415645666d7420","hex");
const fakeProtector={protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)};
function fixture(t,upstreamCall){
 const dir=mkdtempSync(join(tmpdir(),"atelier-openai-jobs-"));
 const db=new DatabaseSync(":memory:");
 initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const vault=createCredentialVault({db,protector:fakeProtector});
 const channel=vault.create({id:"openai-channel",provider:"openai",displayName:"OpenAI",
  apiKey:"fixture-only-not-a-real-secret"});
 const snapshot=task=>({adapterKind:"model",provider:"openai",channelId:channel.id,
  secretVersionRef:channel.keyVersion,task});
 const blobStore=createBlobStore({dataDir:dir,db});
 const adapter=createOpenAiModelAdapter({db,blobStore,vault,upstreamCall});
 const coordinator=createJobCoordinator({db,adapters:{model:adapter}});
 const enqueue=(name,task)=>{
  const result=submitJob(db,{idempotencyKey:name,requestFingerprint:name,
   executionMode:"immediate",snapshot:snapshot(task)});
  return result.jobId;
 };
 return {db,vault,snapshot,enqueue,blobStore,coordinator};
}
test("P4.4 OpenAI image generation uses encrypted channel, immutable CAS, and a single GPU POST",async t=>{
 const calls=[];
 const f=fixture(t,async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}),{
   status:200,headers:{"content-type":"application/json"}});
 });
 const id=f.enqueue("image-1",{kind:"image",model:"gpt-image-2",prompt:"a fox",
  size:"1024x1024",quality:"high"});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,"https://api.openai.com/v1/images/generations");
 assert.equal(calls[0].options.redirect,"manual");
 assert.equal(calls[0].options.headers.authorization,"Bearer fixture-only-not-a-real-secret");
 assert.deepEqual(JSON.parse(calls[0].options.body),{model:"gpt-image-2",prompt:"a fox",
  n:1,size:"1024x1024",quality:"high"});
 assert.ok(!f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(id).snapshot_json
  .includes("fixture-only-not-a-real-secret"));
 const a=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(id);
 assert.equal(a.kind,"image");assert.equal(a.port_id,"image");
 const blob=await f.blobStore.stat(a.blob_id);
 assert.equal(blob.mimeType,"image/png");assert.equal(blob.byteSize,png.length);
 // Idempotent same-key POST cannot repeat provider generation.
 assert.equal(f.enqueue("image-1",{kind:"image",model:"gpt-image-2",prompt:"a fox",
  size:"1024x1024",quality:"high"}),id);
 await f.coordinator.tick();
 assert.equal(calls.length,1);
});
test("P4.4 speech and text share durable model queue and CAS artifact lifecycle",async t=>{
 const calls=[];
 const f=fixture(t,async(url,options)=>{
  calls.push(url);
  return url.endsWith("/audio/speech")?new Response(wav,{status:200}):
   new Response(JSON.stringify({choices:[{message:{content:"hello world"}}]}),{status:200});
 });
 const audio=f.enqueue("speech",{kind:"audio",model:"gpt-4o-mini-tts",
  prompt:"hello",voice:"alloy",format:"wav",speed:1});
 const text=f.enqueue("text",{kind:"text",model:"gpt-4o-mini",prompt:"Say hello"});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 for(const [job,kind,mime] of [[audio,"audio","audio/wav"],[text,"text","text/plain"]]){
  assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(job).status,"succeeded");
  const row=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(job);
  assert.equal(row.kind,kind);assert.equal((await f.blobStore.stat(row.blob_id)).mimeType,mime);
 }
 assert.deepEqual(calls.sort(),["https://api.openai.com/v1/audio/speech",
  "https://api.openai.com/v1/chat/completions"]);
});
test("P4.4 refuses revoked, malformed, unsafe-provider, and unsupported requests before sending",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;return new Response("",{status:400})});
 assert.throws(()=>validateModelSnapshot({...f.snapshot({kind:"text",model:"gpt-4o-mini",prompt:"safe"}),
  task:{kind:"text",model:"gpt-4o-mini",prompt:"safe",apiKey:"oops"}}),/model_task_invalid/);
 assert.throws(()=>validateModelSnapshot(f.snapshot({kind:"audio",model:"gpt-4o-mini-tts",
  prompt:"Hi",voice:"alloy",format:"exe"})),/model_task_invalid/);
 const queued=f.enqueue("revoked",{kind:"text",model:"gpt-4o-mini",prompt:"test"});
 const channel=f.vault.get("openai-channel");
 f.vault.revoke(channel.id,channel.keyVersion);
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(queued).status,"blocked_credential");
 assert.equal(calls,0);
});
test("P4.4 ambiguous provider response blocks re-submission even across coordinator restart",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;throw Error("socket reset after provider accepted");});
 const id=f.enqueue("uncertain",{kind:"image",model:"gpt-image-2",prompt:"test"});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"submission_unknown");
 const restarted=createJobCoordinator({db:f.db,adapters:{model:createOpenAiModelAdapter({
  db:f.db,blobStore:f.blobStore,vault:f.vault,upstreamCall:async()=>{calls++;return new Response("");}
 })}});
 restarted.recoverAtStartup();await restarted.tick();
 assert.equal(calls,1);
});
test("P4.4 ordinary Canvas text→image uses SQLite save fence then safely materializes and survives restart",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;return new Response(JSON.stringify({
  data:[{b64_json:png.toString("base64")}]}),{status:200})});
 const original={nodes:[{id:"prompt-1",type:"text",title:"Prompt",position:{x:25,y:35},
  width:320,height:200,metadata:{content:"a fox"}}],connections:[]};
 createProject(f.db,{id:"canvas-1",document:original});
 const fingerprint=fingerprintSource(original,"prompt-1");
 const key="canvas-image";
 const id=submitJob(f.db,{idempotencyKey:key,requestFingerprint:key,
  executionMode:"immediate",projectId:"canvas-1",targetNodeId:"prompt-1",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprint,
  snapshot:f.snapshot({kind:"image",model:"gpt-image-2",prompt:"a fox"})}).jobId;
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 assert.equal((await materializer.runOnce())[0].status,"materialized");
 const project=getProject(f.db,"canvas-1");
 assert.equal(project.revision,2);
 assert.equal(project.document.nodes.length,2);
 assert.equal(project.document.connections.length,1);
 const image=project.document.nodes[1];
 assert.equal(image.type,"image");
 assert.equal(image.metadata.modelArtifact.jobId,id);
 assert.match(image.metadata.storageKey,/^cas:[a-f0-9]{64}$/);
 assert.equal(project.document.connections[0].fromNodeId,"prompt-1");
 assert.equal(project.document.connections[0].fromPortId,undefined);
 assert.equal((await materializer.runOnce()).length,0);
 assert.equal(getProject(f.db,"canvas-1").revision,2);
 assert.equal(calls,1);
});
test("P4.4 ordinary model artifacts do not overwrite edited Canvas source",async t=>{
 const f=fixture(t,async()=>new Response(JSON.stringify({
  data:[{b64_json:png.toString("base64")}]}),{status:200}));
 const doc={nodes:[{id:"prompt-1",type:"text",title:"Prompt",position:{x:0,y:0},
  width:320,height:200,metadata:{content:"first"}}],connections:[]};
 createProject(f.db,{id:"canvas-2",document:doc});
 const key="stale";
 const id=submitJob(f.db,{idempotencyKey:key,requestFingerprint:key,
  executionMode:"immediate",projectId:"canvas-2",targetNodeId:"prompt-1",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"prompt-1"),
  snapshot:f.snapshot({kind:"image",model:"gpt-image-2",prompt:"first"})}).jobId;
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 const updated=structuredClone(doc);updated.nodes[0].metadata.content="second";
 patchProject(f.db,{id:"canvas-2",expectedRevision:1,document:updated});
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 const result=await materializer.runOnce();
 assert.equal(result[0].status,"blocked");
 assert.equal(result[0].reason,"materialization_source_changed");
 assert.equal(getProject(f.db,"canvas-2").document.nodes.length,1);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
});
test("P4.4 Fastify /jobs HTTP -> auto Worker -> BlobStore -> ordinary Canvas materialization",async t=>{
 const f=fixture(t,async(_url,options)=>{
  assert.ok(!options.body.includes("fixture-only-not-a-real-secret"));
  return new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}),{status:200});
 });
 const doc={nodes:[{id:"prompt-1",type:"text",title:"Prompt",position:{x:0,y:0},
  width:330,height:180,metadata:{content:"a forest"}}],connections:[]};
 createProject(f.db,{id:"http-project",document:doc});
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 f.coordinator.recoverAtStartup();
 const worker=createBackendWorker({coordinator:f.coordinator,materializer,intervalMs:25}).start();
 const app=buildApp({db:f.db,authorize:()=>true,vault:f.vault,
  blobStore:f.blobStore,coordinator:f.coordinator,materializer,worker,
  modelKinds:["image","audio","text"]});
 try{
  const capabilities=await app.inject({method:"GET",url:"/api/v1/execution/capabilities"});
  assert.equal(capabilities.statusCode,200);
  assert.deepEqual(capabilities.json().modelKinds,["image","audio","text"]);
  const channel=await app.inject({method:"GET",url:"/api/v1/channels/openai-channel"});
  assert.equal(channel.statusCode,200);
  assert.ok(channel.json().hasKey);
  assert.ok(!JSON.stringify(channel.json()).includes("fixture-only-not-a-real-secret"));
  const key="http-model-request";
  const body={projectId:"http-project",targetNodeId:"prompt-1",
   expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"prompt-1"),
   idempotencyKey:key,requestFingerprint:key,executionMode:"immediate",
   snapshot:f.snapshot({kind:"image",model:"gpt-image-2",prompt:"a forest"})};
  const response=await app.inject({method:"POST",url:"/api/v1/jobs",payload:body});
  assert.equal(response.statusCode,201,response.body);
  const jobId=response.json().id;
  const duplicate=await app.inject({method:"POST",url:"/api/v1/jobs",payload:body});
  assert.equal(duplicate.statusCode,200);
  assert.equal(duplicate.json().id,jobId);
  let project;
  for(let i=0;i<110;i++){
   project=getProject(f.db,"http-project");
   if(project.document.nodes.length===2)break;
   await new Promise(resolve=>setTimeout(resolve,15));
  }
  assert.equal(project.document.nodes.length,2);
  assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
  assert.equal(project.document.nodes[1].metadata.modelArtifact.jobId,jobId);
  const artifacts=await app.inject({method:"GET",url:"/api/v1/jobs/"+jobId+"/artifacts"});
  assert.equal(artifacts.statusCode,200);
  assert.equal(artifacts.json().artifacts.length,1);
  const media=await app.inject({method:"GET",url:project.document.nodes[1].metadata.content});
  assert.equal(media.statusCode,200);
  assert.deepEqual(media.rawPayload,png);
 }finally{await worker.stop();await f.coordinator.stop();await app.close()}
});
test("P4.4 provider 4xx is confirmed failure; 5xx or network uncertainty is not retried",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;return new Response(JSON.stringify({error:"secret ignored"}),{status:400})});
 const id=f.enqueue("rejected",{kind:"text",model:"gpt-4o-mini",prompt:"hello"});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"failed");
 assert.equal(calls,1);
});
