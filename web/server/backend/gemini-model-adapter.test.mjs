import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {DatabaseSync} from "node:sqlite";
import {createBlobStore} from "./blob-store.mjs";
import {initializeSchema} from "./schema.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createGeminiModelAdapter,validateGeminiModelSnapshot} from "./gemini-model-adapter.mjs";
import {compatEndpointFingerprint,normalizeOpenAiCompatBaseUrl} from "./openai-compat-endpoints.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {submitJob} from "./repository.mjs";
import {buildApp} from "./app.mjs";
import {fingerprintSource} from "./repository.mjs";
import {createCanvasMaterializer} from "./canvas-materializer.mjs";

const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082","hex");
const protector={protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)};
function fixture(t,upstreamCall=async()=>new Response("{}")){
 const dir=mkdtempSync(join(tmpdir(),"atelier-gemini-adapter-")),db=new DatabaseSync(":memory:");
 initializeSchema(db);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const vault=createCredentialVault({db,protector});
 const channel=vault.create({id:"gemini-channel",provider:"google_gemini",displayName:"Gemini",apiKey:"gemini-test-secret"});
 const blobStore=createBlobStore({dataDir:dir,db}),adapter=createGeminiModelAdapter({db,blobStore,vault,upstreamCall});
 const snapshot=(task,endpointBaseUrl="https://generativelanguage.googleapis.com/v1beta")=>{
  const endpoint=normalizeOpenAiCompatBaseUrl(endpointBaseUrl);
  return {adapterKind:"model",provider:"google_gemini",channelId:channel.id,
   secretVersionRef:channel.keyVersion,endpointBaseUrl:endpoint,
   endpointFingerprint:compatEndpointFingerprint(endpoint),task};
 };
 const enqueue=(key,task)=>submitJob(db,{idempotencyKey:key,requestFingerprint:key,executionMode:"immediate",snapshot:snapshot(task)}).jobId;
 return {db,vault,channel,blobStore,adapter,snapshot,enqueue};
}
const modelTask={kind:"text",model:"gemini-2.5-flash",prompt:"What is here?",
 messages:[{role:"user",content:"What is here?"}],images:[],stream:false};

test("Gemini snapshots have their own provider, URL and task boundary",t=>{
 const f=fixture(t);
 assert.equal(validateGeminiModelSnapshot(f.snapshot(modelTask)),modelTask);
 assert.throws(()=>validateGeminiModelSnapshot({...f.snapshot(modelTask),provider:"openai"}),/gemini_model_snapshot_invalid/);
 assert.throws(()=>validateGeminiModelSnapshot({...f.snapshot(modelTask),endpointBaseUrl:"https://attacker.invalid"}),/gemini_model_endpoint_invalid/);
 assert.throws(()=>validateGeminiModelSnapshot({...f.snapshot(modelTask),endpointFingerprint:"sha256:forged"}),/gemini_model_endpoint_invalid/);
 assert.throws(()=>f.snapshot(modelTask,"https://169.254.169.254/latest"),/model_endpoint_config_invalid/);
 for(const bad of [
  {...modelTask,apiKey:"leak"},{...modelTask,kind:"audio"},
  {...modelTask,stream:true},{...modelTask,messages:[{role:"assistant",content:"no"}]},
  {...modelTask,model:"../private"},
  {kind:"image",model:"gemini-2.5-flash",prompt:"draw",count:11},
  {kind:"image",model:"gemini-2.5-flash",prompt:"draw",operation:"edit",images:[]}
 ])assert.throws(()=>validateGeminiModelSnapshot(f.snapshot(bad)),/gemini_model_task_invalid/);
});

test("HTTP-submitted Gemini text job runs through JobCoordinator and materializes the frozen source",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-gemini-http-job-")),db=new DatabaseSync(":memory:");
 initializeSchema(db);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const vault=createCredentialVault({db,protector});
 const channel=vault.create({id:"http-gemini",provider:"google_gemini",displayName:"Gemini",apiKey:"http-fixture-key"});
 const blobStore=createBlobStore({dataDir:dir,db});
 const adapter=createGeminiModelAdapter({db,blobStore,vault,upstreamCall:async(url,init)=>{
  assert.match(url,/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(init.headers["x-goog-api-key"],"http-fixture-key");
  return new Response(JSON.stringify({candidates:[{content:{parts:[{text:"Backend Gemini result"}]}}]}),
   {status:200,headers:{"content-type":"application/json"}});
 }});
 const coordinator=createJobCoordinator({db,adapters:{model:adapter}});coordinator.recoverAtStartup();
 const materializer=createCanvasMaterializer({db,blobStore});
 const app=buildApp({db,vault,blobStore,coordinator,materializer,modelKinds:["image","text"],
  authorize:req=>req.headers["x-test-owner"]==="owner"});
 t.after(async()=>{await app.close();await coordinator.stop()});
 const headers={"x-test-owner":"owner"};
 const doc={nodes:[{id:"gemini-text",type:"text",title:"Prompt",position:{x:0,y:0},width:320,height:180,
  metadata:{content:"",prompt:"Describe this"}}],connections:[]};
 const created=await app.inject({method:"POST",url:"/api/v1/projects",headers,
  payload:{id:"gemini-http-project",document:doc}});
 assert.equal(created.statusCode,201,created.body);
 const endpoint="https://generativelanguage.googleapis.com/v1beta";
 const submitted=await app.inject({method:"POST",url:"/api/v1/jobs",headers,payload:{
  projectId:"gemini-http-project",targetNodeId:"gemini-text",expectedProjectRevision:1,
  sourceNodeFingerprint:fingerprintSource(doc,"gemini-text"),idempotencyKey:"gemini-http-job",
  requestFingerprint:"gemini-http-job",executionMode:"immediate",snapshot:{adapterKind:"model",
   provider:"google_gemini",channelId:channel.id,secretVersionRef:channel.keyVersion,
   endpointBaseUrl:endpoint,endpointFingerprint:compatEndpointFingerprint(endpoint),
   task:{kind:"text",model:"gemini-2.5-flash",prompt:"Describe this",
    messages:[{role:"user",content:"Describe this"}],images:[],stream:false}}
 }});
 assert.equal(submitted.statusCode,201,submitted.body);
 await coordinator.tick();
 const job=await app.inject({method:"GET",url:"/api/v1/jobs/"+submitted.json().id,headers});
 assert.equal(job.json().status,"succeeded");
 assert.equal((await materializer.runOnce()).length,1);
 const project=await app.inject({method:"GET",url:"/api/v1/projects/gemini-http-project",headers});
 assert.equal(project.json().document.nodes[0].metadata.content,"Backend Gemini result");
 assert.equal(project.json().document.nodes[0].metadata.modelArtifact.kind,"text");
});

test("Gemini image generation stores each candidate in CAS and freezes channel auth",async t=>{
 const calls=[];const f=fixture(t,async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify({candidates:[0,1].map(()=>({content:{parts:[{inlineData:{mimeType:"image/png",data:png.toString("base64")}}]}}))}),{status:200});
 });
 const id=f.enqueue("gemini-image",{kind:"image",model:"gemini-3-pro-image-preview",prompt:"A blue house",count:2,size:"1024x1024",quality:"high"});
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,"https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent");
 assert.equal(calls[0].options.headers["x-goog-api-key"],"gemini-test-secret");
 assert.equal(calls[0].options.redirect,"manual");
 assert.ok(!calls[0].url.includes("gemini-test-secret"));
 const body=JSON.parse(calls[0].options.body);
 assert.deepEqual(body.contents,[{role:"user",parts:[{text:"A blue house"}]}]);
 assert.deepEqual(body.generationConfig,{responseModalities:["TEXT","IMAGE"],candidateCount:2,
  responseFormat:{image:{aspectRatio:"1:1",imageSize:"4K"}}});
 const artifacts=f.db.prepare("SELECT * FROM artifacts WHERE job_id=? ORDER BY item_key").all(id);
 assert.equal(artifacts.length,2);
 for(const artifact of artifacts){
  assert.equal(artifact.kind,"image");assert.equal(artifact.port_id,"image");
  const blob=await f.blobStore.stat(artifact.blob_id);assert.equal(blob.mimeType,"image/png");assert.deepEqual(await import("node:fs/promises").then(fs=>fs.readFile(blob.path)),png);
 }
 assert.ok(!f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(id).snapshot_json.includes("gemini-test-secret"));
});

test("Gemini question freezes image CAS and maps text history to native contents",async t=>{
 const calls=[];const f=fixture(t,async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify({candidates:[{content:{parts:[{text:"A small cat."}]}}]}),{status:200});
 });
 const source=await f.blobStore.put([png],{mime:"image/png"});
 const task={kind:"text",model:"gemini-2.5-flash",prompt:"Describe this picture.",
  messages:[{role:"system",content:"Be concise."},{role:"user",content:"Describe this picture."}],
  images:[{blobId:source.blobId,mimeType:"image/png"}],stream:false};
 const id=f.enqueue("gemini-question",task),coordinator=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 const body=JSON.parse(calls[0].options.body);
 assert.deepEqual(body.systemInstruction,{parts:[{text:"Be concise."}]});
 assert.deepEqual(body.contents,[{role:"user",parts:[{text:"Describe this picture."},{inlineData:{mimeType:"image/png",data:png.toString("base64")}}]}]);
 const artifact=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(id);
 assert.equal(artifact.kind,"text");
 assert.equal(await f.blobStore.stat(artifact.blob_id).then(async blob=>await import("node:fs/promises").then(fs=>fs.readFile(blob.path,"utf8"))),"A small cat.");
});

test("Gemini submit uncertainty is durable and never silently re-posted",async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;throw Error("connection reset after send")});
 const id=f.enqueue("gemini-unknown",modelTask),coordinator=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"submission_unknown");
 const restarted=createJobCoordinator({db:f.db,adapters:{model:createGeminiModelAdapter({db:f.db,blobStore:f.blobStore,vault:f.vault,upstreamCall:async()=>{calls++;return new Response("{}")}})}});
 restarted.recoverAtStartup();await restarted.tick();
 assert.equal(calls,1);
});

test("Gemini model catalog returns only generation-capable models and keeps the key out of URL",async t=>{
 const calls=[];const f=fixture(t,async(url,options)=>{
  calls.push({url,options});return new Response(JSON.stringify({models:[
   {name:"models/gemini-a",supportedGenerationMethods:["generateContent"]},
   {name:"models/embed-x",supportedGenerationMethods:["embedContent"]},
   {name:"models/gemini-b",supportedGenerationMethods:["generateContent"]}
  ]}),{status:200});
 });
 assert.deepEqual(await f.adapter.listModels({channelId:f.channel.id,endpointBaseUrl:"https://generativelanguage.googleapis.com/v1beta"}),{models:["gemini-a","gemini-b"]});
 assert.equal(calls[0].options.method,"GET");
 assert.equal(calls[0].options.headers["x-goog-api-key"],"gemini-test-secret");
 assert.ok(!calls[0].url.includes("gemini-test-secret"));
});

test("Gemini custom endpoint is frozen and fingerprinted, and image count supports ten",async t=>{
 const calls=[];const f=fixture(t,async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith("/models"))return new Response(JSON.stringify({models:[]}),{status:200});
  return new Response(JSON.stringify({candidates:Array.from({length:10},()=>({content:{parts:[
   {inlineData:{mimeType:"image/png",data:png.toString("base64")}}
  ]}}))}),{status:200});
 });
 const endpoint="https://gemini-proxy.example.test/gemini/v1beta";
 const task={kind:"image",model:"gemini-2.5-flash-image",prompt:"ten variations",count:10};
 const snapshot=f.snapshot(task,endpoint);
 assert.equal(validateGeminiModelSnapshot(snapshot),task);
 const id=submitJob(f.db,{idempotencyKey:"gemini-custom-ten",requestFingerprint:"gemini-custom-ten",
  executionMode:"immediate",snapshot}).jobId;
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(calls[0].url,endpoint+"/models/gemini-2.5-flash-image:generateContent");
 assert.equal(JSON.parse(calls[0].options.body).generationConfig.candidateCount,10);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(id).n,10);
 await f.adapter.listModels({channelId:f.channel.id,endpointBaseUrl:endpoint});
 assert.equal(calls[1].url,endpoint+"/models");
});
