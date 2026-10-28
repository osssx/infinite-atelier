import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {createRestrictedVideoAdapter,parseRestrictedVideoScript} from "./restricted-video-adapter.mjs";
import {createScriptAssetFinalizeManager} from "./restricted-video-asset-finalize.mjs";
import {submitJob} from "./repository.mjs";

const mp4=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const signed="https://upload.example.com/upload/file.mp4?signature=ephemeral";
const assetUpload='const g=await http.post("/assets/presign",{model,mime:params.asset.mimeType});return {id:g.id,uploadUrl:g.upload_url};';
const assetFinalize='const r=await http.post("/assets/"+params.asset.remoteAssetId+"/complete",{id:params.asset.remoteAssetId});return r.id;';
const script=JSON.stringify({version:1,assetUpload,assetFinalize,
 submit:'const r=await http.post("/videos",{model,ids:params.referenceVideoAssetIds});return r.id;',
 poll:'const r=await http.get("/videos/"+remoteTaskId);return {id:r.id,status:r.status,videoUrl:r.url};'});
const json=data=>new Response(JSON.stringify(data),{status:200});
async function setup(t,{onFinalize=()=>json({id:"asset_signed_1"}),onPut=async()=>({uploaded:true})}={}){
 const dir=mkdtempSync(join(tmpdir(),"finalize-asset-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const store=createBlobStore({db,dataDir:dir});
 const credentialVault=createCredentialVault({db,protector:{
  protect:bytes=>Buffer.from(bytes),unprotect:bytes=>Buffer.from(bytes)
 }});
 const credential=credentialVault.create({id:"finalize-provider",
  provider:"openai_compatible",displayName:"Finalize",apiKey:"VAULT_ONLY_SECRET"});
 const blob=await store.put([mp4],{mime:"video/mp4"});
 const ref={kind:"video",role:"reference_video",blobId:blob.blobId,
  sha256:blob.sha256,mimeType:"video/mp4"};
 const snapshot={adapterKind:"model",provider:"openai_compatible",
  channelId:"finalize-provider",secretVersionRef:credential.keyVersion,
  endpointBaseUrl:"http://127.0.0.1:8188/v1",
  task:{kind:"video",model:"custom-video",prompt:"fox",script,references:[ref]}};
 const jobId=submitJob(db,{idempotencyKey:"finalize-one",requestFingerprint:"finalize-one",
  executionMode:"poll",snapshot}).jobId;
 const requests=[],uploads=[];
 const network=async(url,opts)=>{
  requests.push({url,opts});
  if(url.endsWith("/assets/presign")){
   assert.equal(opts.headers.authorization,"Bearer VAULT_ONLY_SECRET");
   return json({id:"asset_signed_1",upload_url:signed});
  }
  if(url.endsWith("/assets/asset_signed_1/complete")){
   assert.equal(opts.method,"POST");
   assert.deepEqual(JSON.parse(opts.body),{id:"asset_signed_1"});
   assert.equal(opts.headers.authorization,"Bearer VAULT_ONLY_SECRET");
   return onFinalize();
  }
  if(url.endsWith("/videos")&&opts.method==="POST"){
   assert.deepEqual(JSON.parse(opts.body).ids,["asset_signed_1"]);
   return json({id:"generated_task_1"});
  }
  return json({id:"generated_task_1",status:"completed",url:"https://media.example.com/final.mp4"});
 };
 const adapter=createRestrictedVideoAdapter({db,blobStore:store,vault:credentialVault,
  compatibleUpstreamCall:network,signedPut:async arg=>{
   uploads.push(arg);
   assert.equal(arg.uploadUrl,signed);
   return onPut(arg);
  },mediaDownloader:{importUrl:async()=>store.put([mp4],{mime:"video/mp4"})}});
 return {db,jobId,ref,adapter,requests,uploads,script};
}
test("upgrade from v17 adds finalize staging without modifying existing upload rows",async t=>{
 const db=new DatabaseSync(":memory:");
 initializeSchema(db);
 t.after(()=>db.close());
 db.exec("DROP TABLE script_asset_chunks;DROP TABLE script_asset_chunk_sessions;DROP TABLE script_asset_finalizations;DELETE FROM schema_migrations WHERE version=19;");
 db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(17,?)").run(Date.now());
 assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,17);
 initializeSchema(db);
 assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,19);
 assert.deepEqual(db.prepare("PRAGMA table_info(script_asset_finalizations)").all()
  .map(column=>column.name).filter(name=>["asset_id","status"].includes(name)),
  ["asset_id","status"]);
});
test("v18 has durable stage table; succeeds presign PUT finalize then video without replay",async t=>{
 assert.equal(SCHEMA_VERSION,19);
 const f=await setup(t);
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(f.uploads.length,1);
 const upload=f.db.prepare("SELECT status,remote_asset_id FROM script_asset_uploads WHERE job_id=?")
  .get(f.jobId);
 const stage=f.db.prepare("SELECT status,asset_id FROM script_asset_finalizations WHERE job_id=?")
  .get(f.jobId);
 assert.deepEqual({...upload},{status:"active",remote_asset_id:"asset_signed_1"});
 assert.deepEqual({...stage},{status:"completed",asset_id:"asset_signed_1"});
 assert.equal(f.requests.filter(x=>x.url.endsWith("/assets/presign")).length,1);
 assert.equal(f.requests.filter(x=>x.url.endsWith("/complete")).length,1);
 assert.equal(f.requests.filter(x=>x.url.endsWith("/videos")&&x.opts.method==="POST").length,1);
 const snapshot=f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(f.jobId).snapshot_json;
 assert.ok(!snapshot.includes("upload.example.com"));
 assert.ok(!snapshot.includes("VAULT_ONLY_SECRET"));
 await coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(f.jobId).status,"succeeded");
 const recovery=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 recovery.recoverAtStartup();await recovery.tick();
 assert.equal(f.uploads.length,1);
 assert.equal(f.requests.filter(x=>x.url.endsWith("/complete")).length,1);
});
test("lost finalize response remains finalizing and is not retried after restart",async t=>{
 const f=await setup(t,{onFinalize:()=>{throw Error("response lost")}});
 const c=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 c.recoverAtStartup();await c.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(f.jobId).status,"failed");
 assert.equal(f.db.prepare("SELECT status FROM script_asset_finalizations WHERE job_id=?")
  .get(f.jobId).status,"finalizing");
 assert.equal(f.db.prepare("SELECT status FROM script_asset_uploads WHERE job_id=?")
  .get(f.jobId).status,"uploading");
 const restarted=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 restarted.recoverAtStartup();await restarted.tick();
 const job=f.db.prepare("SELECT * FROM jobs WHERE id=?").get(f.jobId);
 await assert.rejects(f.adapter.prepare({job}),/video_script_asset_upload_unknown/);
 assert.equal(f.uploads.length,1);
 assert.equal(f.requests.filter(x=>x.url.endsWith("/complete")).length,1);
 assert.equal(f.requests.filter(x=>x.url.endsWith("/videos")&&x.opts.method==="POST").length,0);
});
test("durably uploaded PUT resumes only finalize after restart, without grant or PUT replay",async t=>{
 const f=await setup(t);
 const job=f.db.prepare("SELECT * FROM jobs WHERE id=?").get(f.jobId);
 const now=Date.now(),fp=createHash("sha256").update(assetUpload).digest("hex");
 f.db.prepare("INSERT INTO script_asset_uploads(job_id,reference_index,blob_id,script_fingerprint,status,updated_at) VALUES(?,?,?,?,?,?)")
  .run(f.jobId,0,f.ref.blobId,fp,"uploading",now);
 const manager=createScriptAssetFinalizeManager({db:f.db});
 manager.recordUploaded({job,index:0,ref:f.ref,script:assetFinalize,assetId:"asset_signed_1"});
 assert.equal(manager.inspect(f.jobId,0).status,"uploaded");
 await f.adapter.prepare({job});
 assert.equal(f.uploads.length,0);
 assert.equal(f.requests.filter(x=>x.url.endsWith("/assets/presign")).length,0);
 assert.equal(f.requests.filter(x=>x.url.endsWith("/complete")).length,1);
 assert.equal(manager.inspect(f.jobId,0).status,"completed");
 await f.adapter.prepare({job});
 assert.equal(f.requests.filter(x=>x.url.endsWith("/complete")).length,1);
});
test("mismatched finalize ID never activates remote media and remains non-replayable",async t=>{
 const f=await setup(t,{onFinalize:()=>json({id:"wrong_id"})});
 const c=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 c.recoverAtStartup();await c.tick();
 assert.equal(f.db.prepare("SELECT status FROM script_asset_finalizations WHERE job_id=?")
  .get(f.jobId).status,"finalizing");
 assert.equal(f.db.prepare("SELECT status FROM script_asset_uploads WHERE job_id=?")
  .get(f.jobId).status,"uploading");
 assert.equal(f.requests.filter(x=>x.url.endsWith("/videos")&&x.opts.method==="POST").length,0);
});
test("finalize requires assetUpload and is forbidden in a standalone script",()=>{
 assert.throws(()=>parseRestrictedVideoScript(JSON.stringify({version:1,
  assetFinalize,submit:"const r=await http.post('/videos',{model});return r.id;",
  poll:"const r=await http.get('/videos/'+remoteTaskId);return r.status;"})),
  /video_script_invalid/);
});
