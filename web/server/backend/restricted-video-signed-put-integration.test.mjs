import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createRestrictedVideoAdapter} from "./restricted-video-adapter.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {submitJob} from "./repository.mjs";
import {createRestrictedSignedPut} from "./restricted-video-signed-put.mjs";
const media=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const signedUrl="https://storage.example.com/upload/video?signature=frozen-example";
const workflow=JSON.stringify({version:1,
 assetUpload:'const grant=await http.post("/assets/presign",{model,kind:params.asset.kind,mime:params.asset.mimeType});return {id:grant.id,uploadUrl:grant.upload_url};',
 submit:'const task=await http.post("/videos",{model,prompt,asset_ids:params.referenceVideoAssetIds});return task.id;',
 poll:'const task=await http.get("/videos/"+remoteTaskId);return {id:task.id,status:task.status,videoUrl:task.video_url};'
});
const json=body=>new Response(JSON.stringify(body),{status:200});
async function fixture(t,{presign,put}){
 const dir=mkdtempSync(join(tmpdir(),"signed-put-script-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const blobStore=createBlobStore({db,dataDir:dir});
 const vault=createCredentialVault({db,protector:{
  protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)
 }});
 const credential=vault.create({id:"signed-channel",provider:"openai_compatible",
  displayName:"Signed",apiKey:"SENSITIVE_VAULT_SECRET"});
 const blob=await blobStore.put([media],{mime:"video/mp4"});
 const snapshot={adapterKind:"model",provider:"openai_compatible",
  channelId:"signed-channel",secretVersionRef:credential.keyVersion,
  endpointBaseUrl:"http://127.0.0.1:8188/v1",
  task:{kind:"video",model:"video-1",prompt:"cat",script:workflow,references:[{
   kind:"video",role:"reference_video",blobId:blob.blobId,sha256:blob.sha256,mimeType:"video/mp4"
  }]}};
 const jobId=submitJob(db,{idempotencyKey:"signed-job",requestFingerprint:"signed-job",
  executionMode:"poll",snapshot}).jobId;
 const calls=[];
 const upstream=async(url,opts)=>{
  calls.push({url,opts});
  if(url.endsWith("/assets/presign"))return presign(url,opts);
  if(url.endsWith("/videos")&&opts.method==="POST"){
   assert.deepEqual(JSON.parse(opts.body).asset_ids,["uploaded_asset_1"]);
   return json({id:"video_task_1"});
  }
  return json({id:"video_task_1",status:"succeeded",
   video_url:"https://media.example.com/result.mp4"});
 };
 const signedPut=createRestrictedSignedPut({fetcher:put});
 const adapter=createRestrictedVideoAdapter({db,blobStore,vault,
  compatibleUpstreamCall:upstream,signedPut,
  mediaDownloader:{importUrl:async()=>blobStore.put([media],{mime:"video/mp4"})}});
 return {db,jobId,adapter,calls};
}
test("presign request carries Vault key, signed binary PUT carries none, verified remote ID survives restart",async t=>{
 let puts=0;
 const f=await fixture(t,{
  presign:async(url,opts)=>{
   assert.equal(opts.headers.authorization,"Bearer SENSITIVE_VAULT_SECRET");
   assert.ok(!JSON.stringify(opts.body).includes("data:"));
   return json({id:"uploaded_asset_1",upload_url:signedUrl});
  },
  put:async(url,opts)=>{
   puts++;assert.equal(url,signedUrl);
   assert.equal(opts.method,"PUT");
   assert.deepEqual(Buffer.from(opts.body),media);
   assert.deepEqual(opts.headers,{"content-type":"video/mp4"});
   assert.equal(opts.redirect,"manual");
   return new Response(null,{status:204});
  }
 });
 const job=f.db.prepare("SELECT * FROM jobs WHERE id=?").get(f.jobId);
 await f.adapter.prepare({job});
 assert.equal(puts,1);
 assert.equal(f.db.prepare("SELECT remote_asset_id FROM script_asset_uploads WHERE job_id=?").get(f.jobId).remote_asset_id,"uploaded_asset_1");
 await f.adapter.prepare({job}); // no presign or PUT on repeated prepare
 assert.equal(puts,1);
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(f.db.prepare("SELECT upstream_task_id FROM jobs WHERE id=?").get(f.jobId).upstream_task_id,"video_task_1");
 const restart=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 restart.recoverAtStartup();await restart.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(f.jobId).status,"succeeded");
 assert.equal(puts,1);
 assert.equal(f.calls.filter(x=>x.url.endsWith("/assets/presign")).length,1);
 assert.equal(f.calls.filter(x=>x.url.endsWith("/videos")&&x.opts.method==="POST").length,1);
 const snap=f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(f.jobId).snapshot_json;
 assert.ok(!snap.includes("SENSITIVE_VAULT_SECRET"));
 assert.ok(!snap.includes("uploaded_asset_1"));
 assert.ok(!snap.includes("storage.example.com"));
});
test("lost signed PUT reply leaves ambiguous upload and never repeats presign, PUT or video submit",async t=>{
 let puts=0;
 const f=await fixture(t,{
  presign:async()=>json({id:"uploaded_asset_1",upload_url:signedUrl}),
  put:async()=>{puts++;throw Error("lost reply")}
 });
 const run=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 run.recoverAtStartup();await run.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(f.jobId).status,"failed");
 assert.equal(f.db.prepare("SELECT status FROM script_asset_uploads WHERE job_id=?").get(f.jobId).status,"uploading");
 const resumed=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 resumed.recoverAtStartup();await resumed.tick();
 const job=f.db.prepare("SELECT * FROM jobs WHERE id=?").get(f.jobId);
 await assert.rejects(f.adapter.prepare({job}),/video_script_asset_upload_unknown/);
 assert.equal(puts,1);
 assert.equal(f.calls.filter(x=>x.url.endsWith("/assets/presign")).length,1);
 assert.equal(f.calls.filter(x=>x.url.endsWith("/videos")&&x.opts.method==="POST").length,0);
});
test("invalid or private presigned URL halts before the signed PUT and does not submit generation",async t=>{
 let puts=0;
 const f=await fixture(t,{
  presign:async()=>json({id:"uploaded_asset_1",
   upload_url:"http://169.254.169.254/latest/meta-data"}),
  put:async()=>{puts++;throw Error("must_not_upload")}
 });
 const run=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 run.recoverAtStartup();await run.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(f.jobId).status,"failed");
 assert.equal(puts,0);
 assert.equal(f.calls.filter(x=>x.url.endsWith("/videos")&&x.opts.method==="POST").length,0);
});
