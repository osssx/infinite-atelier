import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createOpenAiVideoAdapter,validateOpenAiVideoSnapshot} from "./openai-video-adapter.mjs";
import {compatEndpointFingerprint} from "./openai-compat-endpoints.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {submitJob} from "./repository.mjs";
import {buildApp} from "./app.mjs";
import {fingerprintSource} from "./repository.mjs";
import {createCanvasMaterializer} from "./canvas-materializer.mjs";

const mp4=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082","hex");
const json=value=>new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}});

function fixture(t,{provider="openai",endpoint="https://api.openai.com/v1",upstreamCall=async()=>{throw Error("no upstream fixture")}}={}){
 const dir=mkdtempSync(join(tmpdir(),"atelier-openai-video-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const vault=createCredentialVault({db,protector:{protect:bytes=>Buffer.from(bytes),unprotect:bytes=>Buffer.from(bytes)}});
 const channel=vault.create({id:"video-channel",provider,displayName:"Video",apiKey:"fixture-key-not-for-snapshot"});
 const blobStore=createBlobStore({dataDir:dir,db});
 const task={kind:"video",model:"sora-2",prompt:"A small red fox crosses a snowy path",duration:8,
  ratio:"16:9",resolution:"720p",generateAudio:false,watermark:false};
 const snapshot=overrides=>({adapterKind:"model",provider,channelId:channel.id,
  secretVersionRef:channel.keyVersion,
  ...(provider==="openai_compatible"?{endpointBaseUrl:endpoint,endpointFingerprint:compatEndpointFingerprint(endpoint)}:{}),
  task:{...task,...overrides}});
 const adapter=overrides=>createOpenAiVideoAdapter({db,vault,blobStore,upstreamCall,
  ...(provider==="openai_compatible"?{compatibleUpstreamCall:upstreamCall}:{})});
 const enqueue=(name,overrides)=>submitJob(db,{idempotencyKey:name,requestFingerprint:name,
  executionMode:"poll",snapshot:snapshot(overrides)}).jobId;
 return {db,dir,vault,channel,blobStore,task,snapshot,adapter,enqueue};
}

test("video snapshot is strict about provider, input references, and endpoint fingerprint",t=>{
 const f=fixture(t,{provider:"openai_compatible",endpoint:"https://video.example/v1"});
 assert.equal(validateOpenAiVideoSnapshot(f.snapshot({images:[]})).kind,"video");
 assert.throws(()=>validateOpenAiVideoSnapshot({...f.snapshot({}),provider:"google_gemini"}),/snapshot_invalid/);
 const bad={...f.snapshot({}),endpointFingerprint:"sha256:"+"0".repeat(64)};
 assert.throws(()=>validateOpenAiVideoSnapshot(bad),/endpoint_invalid/);
 assert.throws(()=>validateOpenAiVideoSnapshot(f.snapshot({images:[{blobId:"x",mimeType:"image/png"}]})),/images_invalid/);
 assert.throws(()=>validateOpenAiVideoSnapshot(f.snapshot({duration:0})),/task_invalid/);
});

test("submit POSTs frozen multipart input, persists task id, polls and collects video once to CAS",async t=>{
 const calls=[];let polls=0,formFields=[];
 const f=fixture(t,{provider:"openai_compatible",endpoint:"https://video.example/v1",upstreamCall:async(url,init)=>{
  calls.push({url,method:init.method});
  assert.equal(init.headers.authorization,"Bearer fixture-key-not-for-snapshot");
  if(init.method==="POST"){
   formFields=[...init.body.entries()];
   return json({id:"video_task_123",status:"queued"});
  }
  if(url.endsWith("/videos/video_task_123"))return json({id:"video_task_123",status:++polls===1?"in_progress":"completed"});
  if(url.endsWith("/videos/video_task_123/content"))return new Response(mp4,{status:200,headers:{"content-type":"video/mp4"}});
  throw Error("unexpected URL");
 }});
 const image=await f.blobStore.put([png],{mime:"image/png"});
 const id=f.enqueue("sora-job",{images:[{blobId:image.blobId,mimeType:"image/png"}]});
 const adapter=f.adapter();
 const coord=createJobCoordinator({db:f.db,adapters:{model:adapter}});coord.recoverAtStartup();
 await coord.tick();
 let row=f.db.prepare("SELECT status,upstream_task_id,snapshot_json FROM jobs WHERE id=?").get(id);
 assert.equal(row.status,"running");assert.equal(row.upstream_task_id,"video_task_123");
 assert.ok(!row.snapshot_json.includes("fixture-key-not-for-snapshot"));
 assert.equal(calls.filter(call=>call.method==="POST").length,1);
 assert.equal(formFields.find(([name])=>name==="seconds")[1],"8");
 assert.equal(formFields.find(([name])=>name==="size")[1],"1280x720");
 const input=formFields.find(([name])=>name==="input_reference")[1];
 assert.equal(input.type,"image/png");assert.equal(Buffer.from(await input.arrayBuffer()).toString("hex"),png.toString("hex"));
 await coord.tick();assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"running");
 const restarted=createJobCoordinator({db:f.db,adapters:{model:f.adapter()}});restarted.recoverAtStartup();await restarted.tick();
 row=f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id);assert.equal(row.status,"succeeded");
 assert.equal(calls.filter(call=>call.method==="POST").length,1);
 const artifact=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(id);
 assert.equal(artifact.kind,"video");assert.equal(artifact.mime,"video/mp4");
 const stat=await f.blobStore.stat(artifact.blob_id);assert.equal(stat.byteSize,mp4.length);
 assert.equal(calls.filter(call=>call.url.endsWith("/content")).length,1);
});

test("ambiguous POST is recorded as submission_unknown and never retried",async t=>{
 let posts=0;
 const f=fixture(t,{provider:"openai_compatible",endpoint:"https://video.example/v1",upstreamCall:async(_url,init)=>{if(init.method==="POST"){posts++;throw Error("response lost after remote acceptance")}throw Error("poll should not happen")}});
 const id=f.enqueue("sora-unknown",{});
 const first=createJobCoordinator({db:f.db,adapters:{model:f.adapter()}});first.recoverAtStartup();await first.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"submission_unknown");
 const restarted=createJobCoordinator({db:f.db,adapters:{model:f.adapter()}});restarted.recoverAtStartup();await restarted.tick();
 assert.equal(posts,1);assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"submission_unknown");
});

test("cancel never DELETEs a video resource because that endpoint deletes the record",async t=>{
 let deletes=0;
 const f=fixture(t,{upstreamCall:async(_url,init)=>{if(init.method==="DELETE")deletes++;return json({})}});
 const job={snapshot:f.snapshot({})};
 const result=await f.adapter().cancel({job,remoteTaskId:"video_task_123"});
 assert.deepEqual(result,{cancelled:false,reason:"openai_video_remote_cancel_unsupported"});assert.equal(deletes,0);
});
test("official OpenAI Video endpoint fails closed after service retirement",async t=>{
 let calls=0;
 const f=fixture(t,{upstreamCall:async()=>{calls++;throw Error("must not be called")}});
 await assert.rejects(f.adapter().prepare({job:{snapshot:f.snapshot({})}}),error=>
  error.code==="openai_video_api_retired"&&error.statusCode===410);
 assert.equal(calls,0);
});
test("HTTP-submitted compatible video job polls, collects to CAS and materializes",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-video-http-job-")),db=new DatabaseSync(":memory:");
 initializeSchema(db);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const vault=createCredentialVault({db,protector:{protect:bytes=>Buffer.from(bytes),unprotect:bytes=>Buffer.from(bytes)}});
 const channel=vault.create({id:"http-video",provider:"openai_compatible",displayName:"Video",apiKey:"http-video-key"});
 const blobStore=createBlobStore({dataDir:dir,db});let polls=0,posts=0;
 const upstreamCall=async(url,init)=>{
  if(init.method==="POST"){posts++;assert.equal(init.headers.authorization,"Bearer http-video-key");return json({id:"http-video-1",status:"queued"})}
  if(url.endsWith("/videos/http-video-1"))return json({id:"http-video-1",status:++polls>0?"completed":"in_progress"});
  if(url.endsWith("/videos/http-video-1/content"))return new Response(mp4,{status:200,headers:{"content-type":"video/mp4"}});
  throw Error("unexpected video URL");
 };
 const adapter=createOpenAiVideoAdapter({db,vault,blobStore,upstreamCall,compatibleUpstreamCall:upstreamCall});
 const coordinator=createJobCoordinator({db,adapters:{model:adapter}});coordinator.recoverAtStartup();
 const materializer=createCanvasMaterializer({db,blobStore});
 const app=buildApp({db,vault,blobStore,coordinator,materializer,modelKinds:["video"],
  authorize:req=>req.headers["x-test-owner"]==="owner"});
 t.after(async()=>{await app.close();await coordinator.stop()});
 const headers={"x-test-owner":"owner"};
 const doc={nodes:[{id:"video-prompt",type:"text",title:"Prompt",position:{x:0,y:0},width:320,height:180,
  metadata:{content:"A red fox crosses the snow"}}],connections:[]};
 assert.equal((await app.inject({method:"POST",url:"/api/v1/projects",headers,
  payload:{id:"video-http-project",document:doc}})).statusCode,201);
 const endpoint="https://video.example/v1";
 const submitted=await app.inject({method:"POST",url:"/api/v1/jobs",headers,payload:{
  projectId:"video-http-project",targetNodeId:"video-prompt",expectedProjectRevision:1,
  sourceNodeFingerprint:fingerprintSource(doc,"video-prompt"),idempotencyKey:"video-http-job",
  requestFingerprint:"video-http-job",executionMode:"poll",snapshot:{adapterKind:"model",
   provider:"openai_compatible",channelId:channel.id,secretVersionRef:channel.keyVersion,
   endpointBaseUrl:endpoint,endpointFingerprint:compatEndpointFingerprint(endpoint),
   task:{kind:"video",model:"sora-compatible",prompt:"A red fox crosses the snow",duration:8,
    ratio:"16:9",resolution:"720p",generateAudio:false,watermark:false}}
 }});
 assert.equal(submitted.statusCode,201,submitted.body);
 await coordinator.tick();
 assert.equal((await app.inject({method:"GET",url:"/api/v1/jobs/"+submitted.json().id,headers})).json().status,"running");
 await coordinator.tick();
 const status=await app.inject({method:"GET",url:"/api/v1/jobs/"+submitted.json().id,headers});
 assert.equal(status.json().status,"succeeded");assert.equal(posts,1);
 assert.equal((await materializer.runOnce()).length,1);
 const project=await app.inject({method:"GET",url:"/api/v1/projects/video-http-project",headers});
 assert.equal(project.json().document.nodes.length,2);
 assert.equal(project.json().document.nodes[1].metadata.modelArtifact.kind,"video");
 assert.equal(project.json().document.nodes[1].metadata.mimeType,"video/mp4");
});
