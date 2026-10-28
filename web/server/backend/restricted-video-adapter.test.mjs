import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {submitJob} from "./repository.mjs";
import {createRestrictedVideoAdapter,parseRestrictedVideoScript,
 validateRestrictedVideoSnapshot} from "./restricted-video-adapter.mjs";
import {createRestrictedVideoDownloader} from "./restricted-video-download.mjs";

const mp4=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const mediaUrl="https://media.example.net/generated/result.mp4?signature=fake";
const script=JSON.stringify({version:1,
 submit:'const data=await http.post("/videos",{model,prompt,seconds:params.duration});return data.id;',
 poll:'const data=await http.get("/videos/"+remoteTaskId);return {id:data.id,status:data.status,videoUrl:data.video_url};'
});
const response=value=>new Response(JSON.stringify(value),{status:200,
 headers:{"content-type":"application/json"}});
function fixture(t,upstream,downloader){
 const dir=mkdtempSync(join(tmpdir(),"atelier-script-video-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const vault=createCredentialVault({db,protector:{
  protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)
 }});
 const credential=vault.create({id:"custom-video",provider:"openai_compatible",
  displayName:"Video",apiKey:"fake-SECRET-123"});
 const blobStore=createBlobStore({db,dataDir:dir});
 const adapter=createRestrictedVideoAdapter({db,blobStore,vault,compatibleUpstreamCall:upstream,
  ...(downloader?{mediaDownloader:downloader}:{})});
 const snapshot={adapterKind:"model",provider:"openai_compatible",channelId:"custom-video",
  secretVersionRef:credential.keyVersion,endpointBaseUrl:"http://127.0.0.1:8188/v1",
  task:{kind:"video",model:"custom-1",prompt:"cinematic cat",duration:6,
   ratio:"16:9",resolution:"720p",generateAudio:true,watermark:false,script}};
 const add=(key="video-1")=>submitJob(db,{idempotencyKey:key,requestFingerprint:key,
  executionMode:"poll",snapshot}).jobId;
 return {db,vault,blobStore,adapter,snapshot,add};
}
test("restricted async video script validates two phases and forbids unsafe AST",()=>{
 const valid=parseRestrictedVideoScript(script);
 assert.equal(valid.version,1);
 assert.throws(()=>parseRestrictedVideoScript(JSON.stringify({version:1,
  submit:"return process.env;",poll:valid.poll})),/model_script/);
 assert.throws(()=>parseRestrictedVideoScript(JSON.stringify({version:1,
  submit:valid.submit,poll:'const x=await http.get("/admin");return x.status;'})),
  /video_script_remote_id_missing/);
 assert.throws(()=>parseRestrictedVideoScript(JSON.stringify({version:1,
  submit:valid.submit,poll:valid.poll,other:"arbitrary"})),/video_script_invalid/);
 const f={adapterKind:"model",provider:"openai_compatible",channelId:"custom-video",
  secretVersionRef:"v1",endpointBaseUrl:"http://127.0.0.1:8188/v1",
  task:{kind:"video",model:"x",prompt:"x",script}};
 assert.equal(validateRestrictedVideoSnapshot(f).task.kind,"video");
 assert.throws(()=>validateRestrictedVideoSnapshot({...f,endpointBaseUrl:"http://169.254.169.254/v1"}),
  /video_script_endpoint_invalid/);
 assert.throws(()=>validateRestrictedVideoSnapshot({...f,task:{...f.task,
  references:[{kind:"image",url:"https://unsafe.example/1"}]}}),/video_script_images_invalid/);
});
test("SQLite video POST once, persists remote ID, resumes GET after restart and writes CAS",async t=>{
 const calls=[],id="video_task_abc123";let polls=0,downloads=0;
 const upstream=async(url,init)=>{
  calls.push({url,method:init.method,headers:init.headers,body:init.body});
  if(url==="http://127.0.0.1:8188/v1/videos"&&init.method==="POST")
   return response({id,status:"queued"});
  if(url==="http://127.0.0.1:8188/v1/videos/"+id&&init.method==="GET"){
   polls++;
   return response({id,status:polls===1?"running":"succeeded",video_url:mediaUrl});
  }
  throw Error("unexpected request "+init.method+" "+url);
 };
 const f=fixture(t,upstream,{importUrl:async(url,opts)=>{
  assert.equal(url,mediaUrl);
  assert.equal(opts.endpointBaseUrl,"http://127.0.0.1:8188/v1");
  downloads++;
  return f.blobStore.put([mp4],{mime:"video/mp4"});
 }});
 const jobId=f.add();
 const first=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 first.recoverAtStartup();await first.tick();
 const frozen=f.db.prepare("SELECT status,upstream_task_id,snapshot_json FROM jobs WHERE id=?").get(jobId);
 assert.equal(frozen.status,"running");
 assert.equal(frozen.upstream_task_id,id);
 assert.ok(!frozen.snapshot_json.includes("fake-SECRET-123"));
 assert.equal(calls.filter(call=>call.method==="POST").length,1);
 await first.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"running");
 const restarted=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 restarted.recoverAtStartup();await restarted.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
 assert.equal(calls.filter(call=>call.method==="POST").length,1);
 assert.ok(calls.filter(call=>call.method==="GET").length>=3);
 assert.equal(downloads,1);
 const artifact=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(jobId);
 assert.equal(artifact.kind,"video");
 assert.equal((await f.blobStore.stat(artifact.blob_id)).mimeType,"video/mp4");
 assert.equal(f.add(),jobId);
});
test("first/last/reference images are frozen as CAS refs and materialized only for submit",async t=>{
 const calls=[],id="video_frame_task",png=Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082","hex");
 const upstream=async(url,init)=>{
  calls.push({url,method:init.method,body:init.body});
  if(init.method==="POST")return response({id,status:"queued"});
  return response({id,status:"succeeded",video_url:mediaUrl});
 };
 const f=fixture(t,upstream,{importUrl:async()=>f.blobStore.put([mp4],{mime:"video/mp4"})});
 const image=await f.blobStore.put([png],{mime:"image/png"});
 const refs=["first_frame","last_frame","reference_image"].map(role=>({
  kind:"image",role,blobId:image.blobId,sha256:image.sha256,mimeType:"image/png"
 }));
 const spec=JSON.stringify({version:1,
  submit:'const data=await http.post("/videos",{model,prompt,first_frame:params.firstFrame,last_frame:params.lastFrame,reference_images:params.referenceImages});return data.id;',
  poll:'const data=await http.get("/videos/"+remoteTaskId);return {id:data.id,status:data.status,videoUrl:data.video_url};'});
 const snapshot={...f.snapshot,task:{...f.snapshot.task,script:spec,references:refs}};
 const jobId=submitJob(f.db,{idempotencyKey:"frame-job",requestFingerprint:"frame-job",
  executionMode:"poll",snapshot}).jobId;
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 const frozen=f.db.prepare("SELECT snapshot_json,upstream_task_id FROM jobs WHERE id=?").get(jobId);
 assert.equal(frozen.upstream_task_id,id);
 assert.equal(JSON.parse(frozen.snapshot_json).task.references.length,3);
 assert.ok(!frozen.snapshot_json.includes("data:image"));
 const payload=JSON.parse(calls.find(call=>call.method==="POST").body);
 const dataUrl="data:image/png;base64,"+png.toString("base64");
 assert.equal(payload.first_frame,dataUrl);
 assert.equal(payload.last_frame,dataUrl);
 assert.deepEqual(payload.reference_images,[dataUrl]);
 await coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
 assert.equal(calls.filter(call=>call.method==="POST").length,1);
 const broken={...snapshot,task:{...snapshot.task,references:[{
  ...refs[0],sha256:"a".repeat(64)
 }]}};
 assert.throws(()=>validateRestrictedVideoSnapshot(broken),/video_script_images_invalid/);
 const missing={...snapshot,task:{...snapshot.task,references:[{
  ...refs[0],blobId:"a".repeat(64),sha256:"a".repeat(64)
 }]}};
 await assert.rejects(f.adapter.prepare({job:{id:"missing",snapshot:missing}}),/blob_not_found/);
});
test("ambiguous submit is not resent across coordinator restart",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;throw Error("network lost")});
 const jobId=f.add(),first=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 first.recoverAtStartup();await first.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"submission_unknown");
 const restarted=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 restarted.recoverAtStartup();await restarted.tick();
 assert.equal(calls,1);
});
test("optional cancel requires remote queued then a confirmed cancelled state",async t=>{
 const id="task_1",calls=[];let cancelled=false;
 const spec=JSON.stringify({...JSON.parse(script),
  cancel:'const data=await http.delete("/videos/"+remoteTaskId);return data.status;'});
 const upstream=async(url,init)=>{
  calls.push(init.method);
  if(init.method==="GET")return response({id,status:cancelled?"cancelled":"queued"});
  if(init.method==="DELETE"){cancelled=true;return response({id,status:"cancelled"})}
  throw Error("unexpected method");
 };
 const f=fixture(t,upstream);
 const job={id:"test",snapshot:{...f.snapshot,task:{...f.snapshot.task,script:spec}}};
 assert.deepEqual(await f.adapter.cancel({job,remoteTaskId:id}),{cancelled:true});
 assert.deepEqual(calls,["GET","DELETE","GET"]);
 assert.deepEqual(await f.adapter.cancel({job:{id:"test",snapshot:f.snapshot},remoteTaskId:id}),
  {cancelled:false,reason:"video_script_cancel_not_configured"});
});
test("media downloader accepts signed public HTTPS without credentials; blocks metadata and bad media",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const dir=mkdtempSync(join(tmpdir(),"atelier-video-download-"));
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const blobStore=createBlobStore({db,dataDir:dir});
 const calls=[];
 const download=createRestrictedVideoDownloader({blobStore,fetcher:async(url,opts)=>{
  calls.push({url,opts});
  return new Response(mp4,{status:200,headers:{"content-type":"video/mp4"}});
 }});
 const stored=await download.importUrl(mediaUrl,{endpointBaseUrl:"http://127.0.0.1:8188/v1"});
 assert.equal((await blobStore.stat(stored.blobId)).byteSize,mp4.length);
 assert.equal(calls.length,1);
 assert.equal(calls[0].opts.redirect,"manual");
 assert.ok(calls[0].opts.dispatcher);
 assert.ok(!JSON.stringify(calls[0].opts).includes("Bearer"));
 await assert.rejects(download.importUrl("http://169.254.169.254/latest/meta-data",
  {endpointBaseUrl:"http://127.0.0.1:8188/v1"}),/video_download_destination_forbidden/);
 await assert.rejects(download.importUrl("https://user:pass@media.example.net/file.mp4",
  {endpointBaseUrl:"http://127.0.0.1:8188/v1"}),/video_download_url_invalid/);
 const fragmented=createRestrictedVideoDownloader({blobStore,fetcher:async()=>
  new Response(new ReadableStream({
   start(controller){for(const byte of mp4)controller.enqueue(Uint8Array.of(byte));controller.close()}
  }),{status:200,headers:{"content-type":"video/mp4"}})});
 const fragmentedStored=await fragmented.importUrl(mediaUrl,{endpointBaseUrl:"http://127.0.0.1:8188/v1"});
 assert.equal((await blobStore.stat(fragmentedStored.blobId)).byteSize,mp4.length);
 const invalid=createRestrictedVideoDownloader({blobStore,fetcher:async()=>
  new Response(Buffer.from("not video"),{status:200,headers:{"content-type":"video/mp4"}})});
 await assert.rejects(invalid.importUrl(mediaUrl,{endpointBaseUrl:"http://127.0.0.1:8188/v1"}),
  /video_download_invalid_media/);
});
