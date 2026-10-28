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
import {buildApp} from "./app.mjs";
import {submitJob,fingerprintSource} from "./repository.mjs";
import {createProject} from "./projects.mjs";

const media=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const doc={nodes:[{id:"source-a",type:"video",metadata:{prompt:"fox"}}],connections:[]};
const parts=(s="x")=>[1,2,3].map(partNumber=>({
 partNumber,uploadUrl:"https://store.example.com/uploads/part"+partNumber+"?sig="+s
}));
const spec=JSON.stringify({version:1,
 assetUpload:'const x=await http.post("/assets/multipart",{model,mime:params.asset.mimeType});return {id:x.id,partSize:x.part_size,parts:x.parts};',
 assetPartUrls:'const x=await http.get("/assets/parts/"+params.asset.remoteAssetId);return {id:x.id,parts:x.parts};',
 assetPartAudit:'const x=await http.get("/assets/parts/status/"+params.asset.remoteAssetId);return {id:x.id,parts:x.parts};',
 assetFinalize:'const x=await http.post("/assets/"+params.asset.remoteAssetId+"/complete",{id:params.asset.remoteAssetId,parts:params.asset.partEtags});return x.id;',
 submit:'const x=await http.post("/videos",{model,ids:params.referenceVideoAssetIds});return x.id;',
 poll:'const x=await http.get("/videos/"+remoteTaskId);return {id:x.id,status:x.status,videoUrl:x.video_url};'
});
const json=value=>new Response(JSON.stringify(value),{status:200});
async function fixture(t,{audit}={}){
 const dir=mkdtempSync(join(tmpdir(),"script-chunk-audit-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const store=createBlobStore({db,dataDir:dir});
 const vault=createCredentialVault({db,protector:{
  protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)
 }});
 const channel=vault.create({id:"chunk-audit-channel",provider:"openai_compatible",
  displayName:"Chunk audit",apiKey:"TEST_ONLY_VAULT_SECRET"});
 createProject(db,{id:"project-a",document:doc});
 createProject(db,{id:"project-b",document:doc});
 const blob=await store.put([media],{mime:"video/mp4"});
 const snapshot={adapterKind:"model",provider:"openai_compatible",
  channelId:"chunk-audit-channel",secretVersionRef:channel.keyVersion,
  endpointBaseUrl:"http://127.0.0.1:8188/v1",
  task:{kind:"video",model:"chunk-v",prompt:"fox",script:spec,references:[{
   kind:"video",role:"reference_video",blobId:blob.blobId,
   sha256:blob.sha256,mimeType:"video/mp4"
  }]}};
 const jobId=submitJob(db,{projectId:"project-a",targetNodeId:"source-a",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"source-a"),
  idempotencyKey:"chunk-audit-job",requestFingerprint:"chunk-audit-job",
  executionMode:"poll",snapshot}).jobId;
 const counts={grants:0,audits:0,refresh:0,puts:[],finalize:0,submit:0};
 const network=async(url,init)=>{
  if(url.endsWith("/assets/multipart")){
   counts.grants++;
   return json({id:"remote-chunk-one",part_size:8,parts:parts()});
  }
  if(url.endsWith("/assets/parts/status/remote-chunk-one")){
   assert.equal(init.method,"GET");
   assert.equal(init.headers.authorization,"Bearer TEST_ONLY_VAULT_SECRET");
   counts.audits++;
   return json(audit?audit():{id:"remote-chunk-one",parts:[
    {partNumber:1,etag:'"ETAG-1"'},{partNumber:2,etag:'"ETAG-2"'}
   ]});
  }
  if(url.endsWith("/assets/parts/remote-chunk-one")){
   counts.refresh++;
   assert.equal(init.method,"GET");
   return json({id:"remote-chunk-one",parts:parts("refreshed")});
  }
  if(url.endsWith("/assets/remote-chunk-one/complete")){
   counts.finalize++;
   assert.deepEqual(JSON.parse(init.body).parts,[1,2,3].map(n=>({
    partNumber:n,etag:'"ETAG-'+n+'"'
   })));
   return json({id:"remote-chunk-one"});
  }
  if(url.endsWith("/videos")&&init.method==="POST"){
   counts.submit++;
   assert.deepEqual(JSON.parse(init.body).ids,["remote-chunk-one"]);
   return json({id:"video-one"});
  }
  return json({id:"video-one",status:"completed",
   video_url:"https://cdn.example.com/video.mp4"});
 };
 const adapter=createRestrictedVideoAdapter({db,blobStore:store,vault,
  compatibleUpstreamCall:network,
  signedPut:async({uploadUrl,asset})=>{
   const n=Number(uploadUrl.match(/part(\d+)/)?.[1]);
   counts.puts.push(n);
   if(n===2&&counts.puts.filter(p=>p===2).length===1)
    throw Error("network reply lost");
   return {uploaded:true,etag:'"ETAG-'+n+'"'};
  },
  mediaDownloader:{importUrl:async()=>store.put([media],{mime:"video/mp4"})}});
 const coordinator=createJobCoordinator({db,adapters:{model:adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"failed");
 assert.deepEqual(counts.puts,[1,2]);
 const app=buildApp({db,coordinator,blobStore:store,vault,
  authorize:async req=>req.headers["x-owner"]==="yes"});
 t.after(()=>app.close());
 const url="/api/v1/projects/project-a/jobs/"+jobId;
 const call=(method,path,payload,authorized=true)=>app.inject({
  method,url:path,headers:authorized?{"x-owner":"yes"}:{},
  ...(payload!==undefined?{payload}:{})
 });
 return {db,jobId,coordinator,counts,call,url};
}
test("read-only ETag evidence clears unknown chunk; explicit resume only uploads ready chunk and finalizes once",async t=>{
 const f=await fixture(t);
 const before=(await f.call("GET",f.url+"/assets")).json();
 assert.equal(before.canResume,false);
 assert.equal(before.assets[0].chunkProgress.uncertain,1);
 assert.equal((await f.call("POST",f.url+"/assets/0/audit-chunks",
  {expectedUpdatedAt:before.assets[0].updatedAt},false)).statusCode,401);
 assert.equal((await f.call("POST",f.url.replace("project-a","project-b")+"/assets/0/audit-chunks",
  {expectedUpdatedAt:before.assets[0].updatedAt})).statusCode,404);
 const verified=await f.call("POST",f.url+"/assets/0/audit-chunks",{
  expectedUpdatedAt:before.assets[0].updatedAt
 });
 assert.equal(verified.statusCode,200,verified.body);
 assert.deepEqual(verified.json(),{verified:true,verifiedParts:1,readyParts:1,assetId:"remote-chunk-one"});
 const refreshed=(await f.call("GET",f.url+"/assets")).json();
 assert.equal(refreshed.canResumePreparation,true);
 assert.equal(refreshed.canResume,true);
 assert.equal(refreshed.assets[0].chunkProgress.uncertain,0);
 assert.equal(refreshed.assets[0].chunkProgress.uploaded,2);
 const second=await f.call("POST",f.url+"/assets/0/audit-chunks",{
  expectedUpdatedAt:before.assets[0].updatedAt
 });
 assert.equal(second.statusCode,422,second.body);
 const resume=await f.call("POST",f.url+"/resume-assets",{});
 assert.equal(resume.statusCode,200,resume.body);
 assert.equal(resume.json().status,"queued");
 assert.equal((await f.call("POST",f.url+"/resume-assets",{})).statusCode,409);
 await f.coordinator.tick();
 assert.equal(f.counts.grants,1);
 assert.equal(f.counts.audits,1);
 assert.equal(f.counts.refresh,1);
 assert.deepEqual(f.counts.puts,[1,2,3]);
 assert.equal(f.counts.finalize,1);
 assert.equal(f.counts.submit,1);
 const finished=f.db.prepare("SELECT status FROM script_asset_uploads WHERE job_id=?").get(f.jobId);
 assert.equal(finished.status,"active");
 const ev=f.db.prepare("SELECT payload_json FROM job_events WHERE job_id=? AND kind='script_asset_chunks_verified'").get(f.jobId);
 assert.ok(ev.payload_json.includes('"provider_read_only"'));
 assert.ok(!ev.payload_json.includes("store.example.com"));
 await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(f.jobId).status,"succeeded");
});
test("missing unknown part evidence never permits resume, PUT or finalize",async t=>{
 const f=await fixture(t,{audit:()=>({id:"remote-chunk-one",parts:[{partNumber:1,etag:'"ETAG-1"'}]})});
 const before=(await f.call("GET",f.url+"/assets")).json().assets[0];
 const result=await f.call("POST",f.url+"/assets/0/audit-chunks",{expectedUpdatedAt:before.updatedAt});
 assert.equal(result.statusCode,200,result.body);
 assert.equal(result.json().verified,false);
 assert.equal((await f.call("POST",f.url+"/resume-assets",{})).statusCode,409);
 assert.equal(f.counts.puts.length,2);
 assert.equal(f.counts.finalize,0);assert.equal(f.counts.submit,0);
});
test("wrong remote id, changed known ETag and forged ready part block whole audit",async t=>{
 for(const remote of [
  {id:"different-id",parts:[{partNumber:2,etag:'"ETAG-2"'}]},
  {id:"remote-chunk-one",parts:[{partNumber:1,etag:'"EVIL"'},{partNumber:2,etag:'"ETAG-2"'}]},
  {id:"remote-chunk-one",parts:[{partNumber:2,etag:'"ETAG-2"'},{partNumber:3,etag:'"FORGED"'}]}
 ]){
  const f=await fixture(t,{audit:()=>remote});
  const asset=(await f.call("GET",f.url+"/assets")).json().assets[0];
  const result=await f.call("POST",f.url+"/assets/0/audit-chunks",{expectedUpdatedAt:asset.updatedAt});
  assert.equal(result.statusCode,422,result.body);
  const rows=f.db.prepare("SELECT status FROM script_asset_chunks WHERE job_id=? ORDER BY part_number").all(f.jobId);
  assert.deepEqual(rows.map(x=>x.status),["uploaded","uploading","ready"]);
  assert.equal(f.counts.puts.length,2);
  assert.equal(f.counts.finalize,0);assert.equal(f.counts.submit,0);
 }
});
