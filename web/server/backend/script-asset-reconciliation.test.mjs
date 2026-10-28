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
import {createRestrictedVideoAdapter} from "./restricted-video-adapter.mjs";
import {buildApp} from "./app.mjs";
import {submitJob,fingerprintSource} from "./repository.mjs";
import {createProject,patchProject} from "./projects.mjs";

const videoBytes=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const audioBytes=Buffer.from("524946460800000057415645666d7420","hex");
const projectDoc=(prompt="cat")=>({nodes:[{id:"video-source",type:"video",metadata:{prompt}}],connections:[]});
const mediaUrl="https://cdn.example.com/result.mp4?sig=example";
const spec=JSON.stringify({version:1,
 assetUpload:'const data=await http.post("/assets",{mime:params.asset.mimeType,role:params.asset.role,content:params.asset.dataUrl});return data.id;',
 submit:'const data=await http.post("/videos",{model,prompt,reference_video_asset_ids:params.referenceVideoAssetIds,reference_audio_asset_ids:params.referenceAudioAssetIds});return data.id;',
 poll:'const data=await http.get("/videos/"+remoteTaskId);return {id:data.id,status:data.status,videoUrl:data.video_url};'
});
function response(body){return new Response(JSON.stringify(body),{status:200,headers:{"content-type":"application/json"}})}
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"asset-reconcile-api-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const blobStore=createBlobStore({db,dataDir:dir});
 const vault=createCredentialVault({db,protector:{
  protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)
 }});
 const saved=vault.create({id:"video-channel",provider:"openai_compatible",
  displayName:"Script video",apiKey:"TEST_ONLY_NEVER_EXPOSE_KEY"});
 createProject(db,{id:"project-a",document:projectDoc()});
 createProject(db,{id:"project-b",document:projectDoc("other")});
 const video=await blobStore.put([videoBytes],{mime:"video/mp4"});
 const audio=await blobStore.put([audioBytes],{mime:"audio/wav"});
 const references=[
  {kind:"video",role:"reference_video",blobId:video.blobId,sha256:video.sha256,mimeType:"video/mp4"},
  {kind:"audio",role:"reference_audio",blobId:audio.blobId,sha256:audio.sha256,mimeType:"audio/wav"}
 ];
 const snapshot={adapterKind:"model",provider:"openai_compatible",
  channelId:"video-channel",secretVersionRef:saved.keyVersion,
  endpointBaseUrl:"http://127.0.0.1:8188/v1",
  task:{kind:"video",model:"video-model",prompt:"cat",script:spec,references}};
 const jobId=submitJob(db,{projectId:"project-a",targetNodeId:"video-source",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(projectDoc(),"video-source"),
  idempotencyKey:"asset-reconcile-one",requestFingerprint:"asset-reconcile-one",
  executionMode:"poll",snapshot}).jobId;
 let uploads=0,submits=0;
 const network=async(url,opts)=>{
  if(url.endsWith("/assets")){
   uploads++;
   if(uploads===1)return response({id:"remote_uploaded_video"});
   if(uploads===2)throw Error("simulated ambiguous upload");
   throw Error("upload must never replay");
  }
  if(url.endsWith("/videos")&&opts.method==="POST"){
   submits++;
   return response({id:"generated_video_1"});
  }
  if(url.endsWith("/videos/generated_video_1")&&opts.method==="GET")
   return response({id:"generated_video_1",status:"succeeded",video_url:mediaUrl});
  throw Error("unexpected request "+url);
 };
 const adapter=createRestrictedVideoAdapter({db,vault,blobStore,compatibleUpstreamCall:network,
  mediaDownloader:{importUrl:async()=>blobStore.put([videoBytes],{mime:"video/mp4"})}});
 const coordinator=createJobCoordinator({db,adapters:{model:adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"failed");
 assert.equal(uploads,2);assert.equal(submits,0);
 const app=buildApp({db,authorize:async(req)=>req.headers["x-owner"]==="yes",
  coordinator,blobStore,vault});
 t.after(()=>app.close());
 const call=(method,url,payload,owner=true)=>app.inject({
  method,url,headers:owner?{"x-owner":"yes"}:{},
  ...(payload!==undefined?{payload}:{})
 });
 const base="/api/v1/projects/project-a/jobs/"+jobId;
 return {db,app,call,base,jobId,blobStore,vault,coordinator,projectDoc,
  get uploads(){return uploads},get submits(){return submits}};
}
test("human reconciliation is authenticated, project scoped, stale-safe, and resumes only verified assets",async t=>{
 const f=await fixture(t);
 const read=await f.call("GET",f.base+"/assets");
 assert.equal(read.statusCode,200,read.body);
 const {assets,canResume,submissionNeverStarted}=read.json();
 assert.equal(canResume,false);
 assert.equal(submissionNeverStarted,true);
 assert.deepEqual(assets.map(x=>x.status),["active","uploading"]);
 assert.deepEqual(assets.map(x=>x.kind),["video","audio"]);
 assert.ok(!read.body.includes("TEST_ONLY_NEVER_EXPOSE_KEY"));
 assert.equal((await f.call("GET",f.base+"/assets",undefined,false)).statusCode,401);
 assert.equal((await f.call("GET",f.base.replace("project-a","project-b")+"/assets")).statusCode,404);
 const reconcileUrl=f.base+"/assets/1/reconcile";
 assert.equal((await f.call("POST",reconcileUrl,{
  action:"confirm",remoteAssetId:"manually_checked_audio",expectedUpdatedAt:assets[1].updatedAt,
  operatorConfirmed:false
 })).statusCode,400);
 assert.equal((await f.call("POST",reconcileUrl,{
  action:"confirm",remoteAssetId:"manually_checked_audio",expectedUpdatedAt:assets[1].updatedAt-1,
  operatorConfirmed:true
 })).statusCode,409);
 assert.equal((await f.call("POST",reconcileUrl,{
  action:"confirm",remoteAssetId:"remote_uploaded_video",expectedUpdatedAt:assets[1].updatedAt,
  operatorConfirmed:true
 })).statusCode,409);
 const confirmed=await f.call("POST",reconcileUrl,{
  action:"confirm",remoteAssetId:"manually_checked_audio",expectedUpdatedAt:assets[1].updatedAt,
  operatorConfirmed:true
 });
 assert.equal(confirmed.statusCode,200,confirmed.body);
 assert.equal(confirmed.json().status,"active");
 assert.equal((await f.call("POST",reconcileUrl,{
  action:"confirm",remoteAssetId:"manually_checked_audio",expectedUpdatedAt:assets[1].updatedAt,
  operatorConfirmed:true
 })).statusCode,409);
 const ready=await f.call("GET",f.base+"/assets");
 assert.equal(ready.json().canResume,true);
 const resumed=await f.call("POST",f.base+"/resume-assets",{});
 assert.equal(resumed.statusCode,200,resumed.body);
 assert.deepEqual(resumed.json(),{jobId:f.jobId,status:"queued",resumed:true,verifiedAssets:2});
 assert.equal((await f.call("POST",f.base+"/resume-assets",{})).statusCode,409);
 assert.equal(f.db.prepare("SELECT status,submission_started_at FROM jobs WHERE id=?")
  .get(f.jobId).status,"queued");
 await f.coordinator.tick();
 const row=f.db.prepare("SELECT status,upstream_task_id FROM jobs WHERE id=?").get(f.jobId);
 assert.equal(row.upstream_task_id,"generated_video_1");
 assert.equal(f.uploads,2);
 assert.equal(f.submits,1);
 // Reconciliation endpoints are no longer legal after a generation submit.
 assert.equal((await f.call("POST",f.base+"/resume-assets",{})).statusCode,409);
 assert.equal((await f.call("POST",reconcileUrl,{
  action:"confirm",remoteAssetId:"another",expectedUpdatedAt:assets[1].updatedAt,
  operatorConfirmed:true
 })).statusCode,409);
 const event=f.db.prepare("SELECT kind,payload_json FROM job_events WHERE job_id=? AND kind='script_asset_reconciled'").get(f.jobId);
 assert.equal(JSON.parse(event.payload_json).operatorAttested,true);
 assert.ok(!event.payload_json.includes("manually_checked_audio"));
});
test("manual rejection blocks resume; a changed project graph blocks generation even after confirmation",async t=>{
 const f=await fixture(t);
 const asset=(await f.call("GET",f.base+"/assets")).json().assets[1];
 const rejection=await f.call("POST",f.base+"/assets/1/reconcile",{
  action:"reject",expectedUpdatedAt:asset.updatedAt,operatorConfirmed:true
 });
 assert.equal(rejection.statusCode,200,rejection.body);
 assert.equal((await f.call("POST",f.base+"/resume-assets",{})).statusCode,409);
 assert.equal(f.submits,0);
 const second=await fixture(t);
 const original=(await second.call("GET",second.base+"/assets")).json().assets[1];
 const confirmed=await second.call("POST",second.base+"/assets/1/reconcile",{
  action:"confirm",remoteAssetId:"verified_audio_id",expectedUpdatedAt:original.updatedAt,
  operatorConfirmed:true
 });
 assert.equal(confirmed.statusCode,200);
 // A stale graph must never be submitted after the human has reconciled.
 const revision=second.db.prepare("SELECT revision FROM projects WHERE id='project-a'").get().revision;
 second.db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id='project-a'")
  .run(JSON.stringify(projectDoc("changed")),revision+1);
 const stale=await second.call("POST",second.base+"/resume-assets",{});
 assert.equal(stale.statusCode,409,stale.body);
 assert.equal(stale.json().code,"script_asset_source_changed");
 assert.equal(second.uploads,2);
 assert.equal(second.submits,0);
});
