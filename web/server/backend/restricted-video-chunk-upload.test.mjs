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
import {createRestrictedVideoAdapter,parseRestrictedVideoScript} from "./restricted-video-adapter.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {submitJob} from "./repository.mjs";

const data=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const uploadScript='const x=await http.post("/assets/multipart",{model,mime:params.asset.mimeType});return {id:x.id,partSize:x.part_size,parts:x.parts};';
const refreshScript='const x=await http.get("/assets/parts/"+params.asset.remoteAssetId);return {id:x.id,parts:x.parts};';
const finalizeScript='const x=await http.post("/assets/"+params.asset.remoteAssetId+"/complete",{id:params.asset.remoteAssetId,parts:params.asset.partEtags});return x.id;';
const script=JSON.stringify({version:1,assetUpload:uploadScript,
 assetPartUrls:refreshScript,assetFinalize:finalizeScript,
 submit:'const x=await http.post("/videos",{model,ids:params.referenceVideoAssetIds});return x.id;',
 poll:'const x=await http.get("/videos/"+remoteTaskId);return {id:x.id,status:x.status,videoUrl:x.video_url};'});
const urls=(suffix="first")=>Array.from({length:3},(_,i)=>({
 partNumber:i+1,uploadUrl:"https://store.example.com/upload/part"+(i+1)+"?signature="+suffix
}));
const json=x=>new Response(JSON.stringify(x),{status:200});
async function fixture(t,{putResponse,grant,refresh,finalize}={}){
 const dir=mkdtempSync(join(tmpdir(),"video-chunk-stage-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const blobStore=createBlobStore({db,dataDir:dir});
 const vault=createCredentialVault({db,protector:{
  protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)
 }});
 const key=vault.create({id:"chunk-channel",provider:"openai_compatible",
  displayName:"Chunk test",apiKey:"TEST_ONLY_CHANNEL_SECRET"});
 const blob=await blobStore.put([data],{mime:"video/mp4"});
 const ref={kind:"video",role:"reference_video",blobId:blob.blobId,
  sha256:blob.sha256,mimeType:"video/mp4"};
 const snapshot={adapterKind:"model",provider:"openai_compatible",
  channelId:"chunk-channel",secretVersionRef:key.keyVersion,
  endpointBaseUrl:"http://127.0.0.1:8188/v1",
  task:{kind:"video",model:"chunk-video",prompt:"a fox",script,references:[ref]}};
 const jobId=submitJob(db,{idempotencyKey:"chunk-one",requestFingerprint:"chunk-one",
  executionMode:"poll",snapshot}).jobId;
 const calls={grant:0,refresh:0,finish:0,submit:0,put:[]};
 const upstream=async(url,opts)=>{
  if(url.endsWith("/assets/multipart")){
   calls.grant++;
   assert.equal(opts.headers.authorization,"Bearer TEST_ONLY_CHANNEL_SECRET");
   return grant?grant():json({id:"asset_chunks_1",part_size:8,parts:urls()});
  }
  if(url.endsWith("/assets/parts/asset_chunks_1")){
   calls.refresh++;
   assert.equal(opts.method,"GET");
   return refresh?refresh():json({id:"asset_chunks_1",parts:urls("refreshed")});
  }
  if(url.endsWith("/assets/asset_chunks_1/complete")){
   calls.finish++;
   assert.equal(opts.headers.authorization,"Bearer TEST_ONLY_CHANNEL_SECRET");
   const parts=JSON.parse(opts.body).parts;
   assert.deepEqual(parts,[1,2,3].map(partNumber=>({
    partNumber,etag:'"ETAG-'+partNumber+'"'
   })));
   return finalize?finalize():json({id:"asset_chunks_1"});
  }
  if(url.endsWith("/videos")&&opts.method==="POST"){
   calls.submit++;
   assert.deepEqual(JSON.parse(opts.body).ids,["asset_chunks_1"]);
   return json({id:"video_task_1"});
  }
  return json({id:"video_task_1",status:"completed",
   video_url:"https://cdn.example.com/video.mp4"});
 };
 const adapter=createRestrictedVideoAdapter({db,blobStore,vault,
  compatibleUpstreamCall:upstream,
  signedPut:async({uploadUrl,asset})=>{
   const bytes=Buffer.from(asset.dataUrl.split(",")[1],"base64");
   calls.put.push({uploadUrl,bytes});
   return putResponse?putResponse({uploadUrl,asset,calls}):{
    uploaded:true,etag:'"ETAG-'+uploadUrl.match(/part(\d+)/)?.[1]+'"'};
  },
  mediaDownloader:{importUrl:async()=>blobStore.put([data],{mime:"video/mp4"})}});
 return {db,jobId,adapter,calls,ref};
}
test("schema upgrades v18 to v19 with chunk tables and preserves prior asset-upload storage",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>db.close());
 db.exec("DROP TABLE script_asset_chunks;DROP TABLE script_asset_chunk_sessions;DELETE FROM schema_migrations WHERE version=19;");
 db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(18,?)").run(Date.now());
 assert.equal(db.prepare("SELECT MAX(version) v FROM schema_migrations").get().v,18);
 initializeSchema(db);
 assert.equal(db.prepare("SELECT MAX(version) v FROM schema_migrations").get().v,19);
 assert.ok(db.prepare("PRAGMA table_info(script_asset_chunk_sessions)").all().some(x=>x.name==="part_count"));
 assert.ok(db.prepare("PRAGMA table_info(script_asset_chunks)").all().some(x=>x.name==="etag"));
});
test("v19: three CAS chunks with ETag complete once; no signed URLs, secrets or raw media in job",async t=>{
 assert.equal(SCHEMA_VERSION,19);
 const f=await fixture(t);
 const coord=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 coord.recoverAtStartup();await coord.tick();
 assert.equal(f.calls.put.length,3);
 assert.deepEqual(f.calls.put.map(x=>x.bytes),[data.subarray(0,8),data.subarray(8,16),data.subarray(16)]);
 assert.equal(Buffer.concat(f.calls.put.map(x=>x.bytes)).toString("hex"),data.toString("hex"));
 assert.equal(f.calls.grant,1);assert.equal(f.calls.refresh,0);
 assert.equal(f.calls.finish,1);assert.equal(f.calls.submit,1);
 const parts=f.db.prepare("SELECT status,etag FROM script_asset_chunks WHERE job_id=? ORDER BY part_number").all(f.jobId);
 assert.deepEqual(parts.map(p=>p.status),["uploaded","uploaded","uploaded"]);
 assert.equal(f.db.prepare("SELECT status FROM script_asset_finalizations WHERE job_id=?").get(f.jobId).status,"completed");
 const snap=f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(f.jobId).snapshot_json;
 assert.ok(!snap.includes("store.example.com")&&!snap.includes("TEST_ONLY_CHANNEL_SECRET")&&!snap.includes("ETAG-"));
 await coord.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(f.jobId).status,"succeeded");
 const restored=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 restored.recoverAtStartup();await restored.tick();
 assert.equal(f.calls.put.length,3);assert.equal(f.calls.finish,1);assert.equal(f.calls.submit,1);
});
test("ambiguous second PUT never resends any chunk, grant or finalize after restart",async t=>{
 const f=await fixture(t,{putResponse:({calls})=>{
  if(calls.put.length===2)throw Error("response lost");
  return {uploaded:true,etag:'"ETAG-'+calls.put.length+'"'};
 }});
 const coord=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 coord.recoverAtStartup();await coord.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(f.jobId).status,"failed");
 assert.deepEqual(f.db.prepare("SELECT status FROM script_asset_chunks WHERE job_id=? ORDER BY part_number").all(f.jobId)
  .map(x=>x.status),["uploaded","uploading","ready"]);
 const recovered=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
 recovered.recoverAtStartup();await recovered.tick();
 const job=f.db.prepare("SELECT * FROM jobs WHERE id=?").get(f.jobId);
 await assert.rejects(f.adapter.prepare({job}),/video_script_chunk_outcome_unknown/);
 assert.equal(f.calls.put.length,2);
 assert.equal(f.calls.grant,1);assert.equal(f.calls.refresh,0);
 assert.equal(f.calls.finish,0);assert.equal(f.calls.submit,0);
});
test("after one completed chunk, a read-only URL refresh resumes pending chunks only",async t=>{
 const f=await fixture(t);
 const now=Date.now(),job=f.db.prepare("SELECT * FROM jobs WHERE id=?").get(f.jobId);
 f.db.prepare("INSERT INTO script_asset_uploads(job_id,reference_index,blob_id,script_fingerprint,status,updated_at) VALUES(?,?,?,?,?,?)")
  .run(f.jobId,0,f.ref.blobId,createHash("sha256").update(uploadScript).digest("hex"),"uploading",now);
 f.db.prepare("INSERT INTO script_asset_chunk_sessions(job_id,reference_index,blob_id,asset_id,grant_fingerprint,refresh_fingerprint,byte_size,part_size,part_count,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run(f.jobId,0,f.ref.blobId,"asset_chunks_1",
   createHash("sha256").update(uploadScript).digest("hex"),
   createHash("sha256").update(refreshScript).digest("hex"),data.length,8,3,now);
 for(let part=1;part<=3;part++)
  f.db.prepare("INSERT INTO script_asset_chunks(job_id,reference_index,part_number,status,etag,updated_at) VALUES(?,?,?,?,?,?)")
   .run(f.jobId,0,part,part===1?"uploaded":"ready",
    part===1?'"ETAG-1"':null,now);
 await f.adapter.prepare({job});
 assert.equal(f.calls.grant,0);assert.equal(f.calls.refresh,1);
 assert.deepEqual(f.calls.put.map(p=>p.bytes),[data.subarray(8,16),data.subarray(16)]);
 assert.equal(f.calls.finish,1);
 await f.adapter.prepare({job});
 assert.equal(f.calls.refresh,1);assert.equal(f.calls.put.length,2);assert.equal(f.calls.finish,1);
});
test("no ETag, invalid grant or mismatched count fail closed without generating",async t=>{
 const cases=[
  {putResponse:()=>({uploaded:true}),expected:1},
  {grant:()=>json({id:"asset_chunks_1",part_size:8,parts:urls().slice(0,2)}),expected:0},
  {grant:()=>json({id:"asset_chunks_1",part_size:8,parts:[
   {partNumber:1,uploadUrl:"http://169.254.169.254/private"},...urls().slice(1)
  ]}),expected:0}
 ];
 for(const c of cases){
  const f=await fixture(t,c);
  const run=createJobCoordinator({db:f.db,adapters:{model:f.adapter}});
  run.recoverAtStartup();await run.tick();
  assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(f.jobId).status,"failed");
  assert.equal(f.calls.put.length,c.expected);
  assert.equal(f.calls.finish,0);assert.equal(f.calls.submit,0);
 }
});
test("AST forbids separate chunk URL refresh without a signed grant and finalize",()=>{
 assert.throws(()=>parseRestrictedVideoScript(JSON.stringify({
  version:1,assetPartUrls:refreshScript,
  submit:'const x=await http.post("/videos",{model});return x.id;',
  poll:'const x=await http.get("/videos/"+remoteTaskId);return x.status;'
 })),/video_script_invalid/);
});
