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

const bytes=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const script=JSON.stringify({version:1,
 assetUpload:'const r=await http.multipart("/assets",{fileField:"media",fields:{model,role:params.asset.role}});return r.id;',
 submit:'const r=await http.post("/videos",{model,ids:params.referenceVideoAssetIds});return r.id;',
 poll:'const r=await http.get("/videos/"+remoteTaskId);return {id:r.id,status:r.status,videoUrl:r.url};'});
const json=data=>new Response(JSON.stringify(data),{status:200});
async function setup(t,network){
 const dir=mkdtempSync(join(tmpdir(),"form-upload-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const blobStore=createBlobStore({db,dataDir:dir});
 const vault=createCredentialVault({db,protector:{
  protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)
 }});
 const ch=vault.create({id:"channel-form",provider:"openai_compatible",
  displayName:"Form",apiKey:"TEST_KEY_VALUE"});
 const blob=await blobStore.put([bytes],{mime:"video/mp4"});
 const snapshot={adapterKind:"model",provider:"openai_compatible",
  channelId:"channel-form",secretVersionRef:ch.keyVersion,
  endpointBaseUrl:"http://127.0.0.1:8188/v1",
  task:{kind:"video",model:"vid",prompt:"test",script,references:[{
   kind:"video",role:"reference_video",blobId:blob.blobId,sha256:blob.sha256,mimeType:"video/mp4"
  }]}};
 const jobId=submitJob(db,{idempotencyKey:"form-1",requestFingerprint:"form-1",
  executionMode:"poll",snapshot}).jobId;
 const adapter=createRestrictedVideoAdapter({db,blobStore,vault,
  compatibleUpstreamCall:network,
  mediaDownloader:{importUrl:async()=>blobStore.put([bytes],{mime:"video/mp4"})}});
 return {db,jobId,adapter};
}
test("one multipart upload persists remote ID, resuming preparation only reuses the ID",async t=>{
 let uploads=0,submits=0;
 const network=async(url,init)=>{
  if(url.endsWith("/assets")){
   uploads++;
   assert.ok(init.body instanceof FormData);
   assert.equal(init.headers.authorization,"Bearer TEST_KEY_VALUE");
   assert.equal(init.headers["content-type"],undefined);
   assert.equal(init.body.get("model"),"vid");
   assert.equal(init.body.get("role"),"reference_video");
   const file=init.body.get("media");
   assert.equal(file.type,"video/mp4");
   assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);
   return json({id:"remote_form_1"});
  }
  if(url.endsWith("/videos")&&init.method==="POST"){
   submits++;
   assert.deepEqual(JSON.parse(init.body).ids,["remote_form_1"]);
   return json({id:"generated_form_1"});
  }
  return json({id:"generated_form_1",status:"succeeded",
   url:"https://cdn.example.com/video.mp4"});
 };
 const f=await setup(t,network);
 const job=f.db.prepare("SELECT * FROM jobs WHERE id=?").get(f.jobId);
 await f.adapter.prepare({job});
 await f.adapter.prepare({job});
 assert.equal(uploads,1);
 assert.equal(f.db.prepare("SELECT remote_asset_id FROM script_asset_uploads WHERE job_id=?")
  .get(f.jobId).remote_asset_id,"remote_form_1");
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(submits,1);assert.equal(uploads,1);
 assert.equal(f.db.prepare("SELECT upstream_task_id FROM jobs WHERE id=?")
  .get(f.jobId).upstream_task_id,"generated_form_1");
 const restarted=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 restarted.recoverAtStartup();await restarted.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(f.jobId).status,"succeeded");
 assert.equal(uploads,1);assert.equal(submits,1);
});
test("lost multipart response blocks replay and leaves video unsubmitted",async t=>{
 let uploads=0,submits=0;
 const f=await setup(t,async(url)=>{
  if(url.endsWith("/assets")){uploads++;throw Error("network interruption")}
  submits++;return json({id:"unexpected"});
 });
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(f.jobId).status,"failed");
 assert.equal(f.db.prepare("SELECT status FROM script_asset_uploads WHERE job_id=?")
  .get(f.jobId).status,"uploading");
 const second=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 second.recoverAtStartup();await second.tick();
 const job=f.db.prepare("SELECT * FROM jobs WHERE id=?").get(f.jobId);
 await assert.rejects(f.adapter.prepare({job}),/video_script_asset_upload_unknown/);
 assert.equal(uploads,1);assert.equal(submits,0);
});
