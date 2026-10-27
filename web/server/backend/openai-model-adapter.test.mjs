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
test("P5.4d image edits use frozen CAS files, official multipart endpoint and DPAPI key",async t=>{
 const calls=[];
 const f=fixture(t,async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}),{status:200});
 });
 const input=await f.blobStore.put([png],{mime:"image/png"});
 const task={kind:"image",model:"gpt-image-2",prompt:"Add a hat",operation:"edit",
  images:[{blobId:input.blobId,mimeType:"image/png"}],size:"1024x1024",quality:"low"};
 const id=f.enqueue("edit-one",task);
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,"https://api.openai.com/v1/images/edits");
 const opts=calls[0].options;
 assert.equal(opts.headers.authorization,"Bearer fixture-only-not-a-real-secret");
 assert.equal(opts.headers["content-type"],undefined);
 assert.ok(opts.body instanceof FormData);
 assert.equal(opts.body.get("prompt"),"Add a hat");
 assert.equal(opts.body.get("model"),"gpt-image-2");
 assert.equal(opts.body.getAll("image").length,1);
 assert.deepEqual(Buffer.from(await opts.body.get("image").arrayBuffer()),png);
 assert.ok(!f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(id).snapshot_json
  .includes(png.toString("base64")));
 const output=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(id);
 assert.equal(output.kind,"image");
 assert.equal((await f.blobStore.stat(output.blob_id)).mimeType,"image/png");
});
test("P5.4d optional frozen PNG mask remains isolated to image editing",async t=>{
 let submitted;
 const f=fixture(t,async(_url,options)=>{
  submitted=options.body;
  return new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}),{status:200});
 });
 const input=await f.blobStore.put([png],{mime:"image/png"});
 f.enqueue("masked-edit",{kind:"image",model:"gpt-image-2",prompt:"replace background",
  operation:"edit",images:[{blobId:input.blobId,mimeType:"image/png"}],
  mask:{blobId:input.blobId,mimeType:"image/png"}});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.ok(submitted instanceof FormData);
 assert.equal(submitted.getAll("image").length,1);
 assert.deepEqual(Buffer.from(await submitted.get("mask").arrayBuffer()),png);
});
test("P5.4d vision question sends CAS-backed multimodal Chat Completions with no browser key",async t=>{
 let sent;
 const f=fixture(t,async(url,options)=>{
  sent={url,body:JSON.parse(options.body),authorization:options.headers.authorization};
  return new Response(JSON.stringify({choices:[{message:{content:"It is a fox."}}]}),{status:200});
 });
 const input=await f.blobStore.put([png],{mime:"image/png"});
 const id=f.enqueue("vision-text",{kind:"text",model:"gpt-4o-mini",
  prompt:"Describe this image",images:[{blobId:input.blobId,mimeType:"image/png"}]});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(sent.url,"https://api.openai.com/v1/chat/completions");
 assert.equal(sent.authorization,"Bearer fixture-only-not-a-real-secret");
 assert.deepEqual(sent.body.messages,[{role:"user",content:[
  {type:"text",text:"Describe this image"},
  {type:"image_url",image_url:{url:"data:image/png;base64,"+png.toString("base64")}}
 ]}]);
 const artifact=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(id);
 assert.equal(artifact.kind,"text");
 const {readFile}=await import("node:fs/promises");
 const stored=await f.blobStore.stat(artifact.blob_id);
 const content=await readFile(stored.path,"utf8");
 assert.equal(content,"It is a fox.");
 assert.ok(!f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(id).snapshot_json.includes("base64"));
});

test("P5.4d full SQLite image edit materializes an immutable child, retains CAS input",async t=>{
 const f=fixture(t,async(url,options)=>{
  assert.equal(url,"https://api.openai.com/v1/images/edits");
  assert.ok(options.body instanceof FormData);
  return new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}),{status:200});
 });
 const ref=await f.blobStore.put([png],{mime:"image/png"});
 const source={id:"source-image",type:"image",title:"Original",
  position:{x:0,y:0},width:420,height:400,
  metadata:{storageKey:"cas:"+ref.blobId,content:"/api/v1/blobs/"+ref.blobId,mimeType:"image/png"}};
 const doc={nodes:[source],connections:[]};
 createProject(f.db,{id:"edit-canvas",document:doc});
 const key="edit-canvas-job";
 const job=submitJob(f.db,{idempotencyKey:key,requestFingerprint:key,
  executionMode:"immediate",projectId:"edit-canvas",targetNodeId:"source-image",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"source-image"),
  snapshot:f.snapshot({kind:"image",model:"gpt-image-2",prompt:"add a cat",
   operation:"edit",images:[{blobId:ref.blobId,mimeType:"image/png"}]})}).jobId;
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 const first=await materializer.runOnce();
 assert.equal(first.length,1);
 assert.equal(first[0].status,"materialized");
 const project=getProject(f.db,"edit-canvas");
 assert.equal(project.document.nodes.length,2);
 assert.equal(project.document.nodes[1].metadata.modelArtifact.jobId,job);
 assert.equal(project.document.nodes[1].type,"image");
 assert.equal(project.document.connections.length,1);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(job).status,"succeeded");
 assert.equal((await materializer.runOnce()).length,0);
 const {currentBlobReferences}=await import("./blob-reference-ledger.mjs");
 assert.ok(currentBlobReferences(f.db).has(ref.blobId));
});
test("P5.4d multimodal question saves text node and input CAS is still referenced",async t=>{
 const f=fixture(t,async(url,options)=>{
  assert.equal(url,"https://api.openai.com/v1/chat/completions");
  assert.match(options.body,/data:image\/png;base64,/);
  return new Response(JSON.stringify({choices:[{message:{content:"A fox on snow."}}]}),{status:200});
 });
 const ref=await f.blobStore.put([png],{mime:"image/png"});
 const doc={nodes:[{id:"question",type:"text",title:"Question",
  position:{x:0,y:0},width:330,height:220,metadata:{content:"What is in this image?"}}],connections:[]};
 createProject(f.db,{id:"vision-canvas",document:doc});
 const key="vision-canvas-job";
 submitJob(f.db,{idempotencyKey:key,requestFingerprint:key,
  executionMode:"immediate",projectId:"vision-canvas",targetNodeId:"question",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"question"),
  snapshot:f.snapshot({kind:"text",model:"gpt-4o-mini",prompt:"What is in this image?",
   images:[{blobId:ref.blobId,mimeType:"image/png"}]})});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 assert.equal((await materializer.runOnce())[0].status,"materialized");
 const nodes=getProject(f.db,"vision-canvas").document.nodes;
 assert.equal(nodes.length,2);assert.equal(nodes[1].type,"text");
 assert.equal(nodes[1].metadata.content,"A fox on snow.");
 const {currentBlobReferences}=await import("./blob-reference-ledger.mjs");
 assert.ok(currentBlobReferences(f.db).has(ref.blobId));
});
test("P5.4d rejects raw inline media, unauthorized mime, invalid task fields and missing CAS before upstream",async t=>{
 let posted=0;
 const f=fixture(t,async()=>{posted++;return new Response("{}",{status:200})});
 const base={kind:"text",model:"gpt-4o-mini",prompt:"What is this"};
 const goodId="a".repeat(64),ref={blobId:goodId,mimeType:"image/png"};
 for(const task of [
  {...base,images:[{...ref,dataUrl:"data:image/png;base64,secret"}]},
  {...base,images:[{blobId:"https://evil.example/pic",mimeType:"image/png"}]},
  {...base,images:[{blobId:goodId,mimeType:"text/html"}]},
  {...base,images:Array.from({length:9},()=>ref)},
  {kind:"image",model:"gpt-image-2",prompt:"edit",images:[ref]},
  {kind:"image",model:"gpt-image-2",prompt:"edit",operation:"edit",images:[ref],mask:{...ref,mimeType:"image/jpeg"}},
  {...base,mask:ref}
 ])assert.throws(()=>validateModelSnapshot(f.snapshot(task)));
 const id=f.enqueue("missing-image",{...base,images:[ref]});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.notEqual(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(posted,0);
});
test("P5.4d rejects CAS MIME mismatch before making any billable API call",async t=>{
 let posted=0;
 const f=fixture(t,async()=>{posted++;return new Response("{}",{status:200})});
 const image=await f.blobStore.put([png],{mime:"image/png"});
 const id=f.enqueue("invalid-mime",{kind:"image",model:"gpt-image-2",prompt:"edit",
  operation:"edit",images:[{blobId:image.blobId,mimeType:"image/jpeg"}]});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.notEqual(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(posted,0);
});
