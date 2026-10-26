import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createArkAssetManager,readArkAssetConfig,signArkAction} from "./ark-asset-manager.mjs";
const mp4=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const config={accessKeyId:"AKLTTESTONLY123",secretAccessKey:"secret_for_tests_only",groupId:"group-test",bucket:"atelier-testing",projectName:"default"};
const res=body=>new Response(JSON.stringify(body),{status:200,headers:{"content-type":"application/json"}});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),"ark-assets-test-")),db=new DatabaseSync(":memory:");
 initializeSchema(db);t.after(()=>{db.close();rmSync(root,{force:true,recursive:true})});
 return {db,blobStore:createBlobStore({dataDir:root,db})};
}
function mockTos(){
 const puts=[];return {puts,client:{
  uploadFile:async options=>{puts.push(options);return {data:{}}},
  getPreSignedUrl:({bucket,key})=>"https://"+bucket+".tos-cn-beijing.volces.com/"+key+"?X-Tos-Signature=test-only"
 }};
}
test("Local video CAS -> private TOS -> CreateAsset -> Active; reuse persisted asset after restart",async t=>{
 const f=fixture(t),blob=await f.blobStore.put([mp4],{mime:"video/mp4"});
 const ref={blobId:blob.blobId,sha256:blob.sha256,mimeType:"video/mp4"};
 const {client,puts}=mockTos();const calls=[];let polls=0;
 const upstreamCall=async(url,init)=>{
  calls.push({url,init});
  assert.match(init.headers.authorization,/^HMAC-SHA256 Credential=AKLTTESTONLY123\//);
  assert.doesNotMatch(JSON.stringify(init),/secret_for_tests_only/);
  assert.equal(init.redirect,"manual");
  if(url.includes("Action=CreateAsset")){
   const body=JSON.parse(init.body);
   assert.equal(body.AssetType,"Video");assert.equal(body.GroupId,"group-test");
   assert.equal(body.URL,"https://atelier-testing.tos-cn-beijing.volces.com/"+puts[0].key+"?X-Tos-Signature=test-only");
   return res({Result:{Id:"asset-test001"}});
  }
  if(url.includes("Action=GetAsset")){
   polls++;return res({Result:{Id:"asset-test001",Status:polls===1?"Processing":"Active"}});
  }
  throw Error("unexpected Ark API");
 };
 const manager=createArkAssetManager({db:f.db,blobStore:f.blobStore,config,client,upstreamCall,
  delay:async()=>{},maxPolls:5,pollIntervalMs:1});
 assert.equal(await manager.ensureReady(ref),"asset://asset-test001");
 assert.equal(puts.length,1);
 assert.equal(puts[0].file,(await f.blobStore.stat(ref.blobId)).path);
 assert.equal(polls,2);
 assert.equal(manager.record(ref.blobId).status,"active");
 assert.ok(!JSON.stringify(manager.record(ref.blobId)).includes("X-Tos-Signature"));
 const restarted=createArkAssetManager({db:f.db,blobStore:f.blobStore,config,client,upstreamCall});
 assert.equal(await restarted.ensureReady(ref),"asset://asset-test001");
 assert.equal(puts.length,1);
 assert.equal(calls.filter(x=>x.url.includes("CreateAsset")).length,1);
});
test("Unknown CreateAsset response is a durable barrier: never POST CreateAsset twice",async t=>{
 const f=fixture(t),blob=await f.blobStore.put([mp4],{mime:"video/mp4"});
 const {client}=mockTos();let creates=0;
 const upstreamCall=async url=>{if(url.includes("CreateAsset")){creates++;throw Error("socket disconnected")}};
 const ref={blobId:blob.blobId,sha256:blob.sha256,mimeType:"video/mp4"};
 const first=createArkAssetManager({db:f.db,blobStore:f.blobStore,config,client,upstreamCall});
 await assert.rejects(first.ensureReady(ref),/ark_asset_remote_unknown/);
 assert.equal(first.record(ref.blobId).status,"creating");
 const next=createArkAssetManager({db:f.db,blobStore:f.blobStore,config,client,upstreamCall});
 await assert.rejects(next.ensureReady(ref),/ark_asset_creation_unknown/);
 assert.equal(creates,1);
});
test("Processing Asset resumes GetAsset after restart without re-upload or new CreateAsset",async t=>{
 const f=fixture(t),blob=await f.blobStore.put([mp4],{mime:"video/mp4"});
 const {client,puts}=mockTos();let creates=0,polls=0;
 const upstreamCall=async url=>{
  if(url.includes("CreateAsset")){creates++;return res({Result:{Id:"asset-resume"}})}
  polls++;return res({Result:{Id:"asset-resume",Status:polls===1?"Processing":"Active"}});
 };
 const ref={blobId:blob.blobId,sha256:blob.sha256,mimeType:"video/mp4"};
 const first=createArkAssetManager({db:f.db,blobStore:f.blobStore,config,client,upstreamCall,
  maxPolls:1,delay:async()=>{},pollIntervalMs:1});
 await assert.rejects(first.ensureReady(ref),/ark_asset_still_processing/);
 assert.equal(first.record(ref.blobId).status,"processing");
 const second=createArkAssetManager({db:f.db,blobStore:f.blobStore,config,client,upstreamCall,
  maxPolls:3,delay:async()=>{},pollIntervalMs:1});
 assert.equal(await second.ensureReady(ref),"asset://asset-resume");
 assert.equal(creates,1);assert.equal(puts.length,1);
});
test("Ark V4 signer and configuration are strict; no partial upload credentials",()=>{
 const signed=signArkAction({action:"GetAsset",body:'{"Id":"asset-demo"}',
  accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey,
  date:new Date("2026-10-26T08:09:10.000Z")});
 assert.match(signed.url,/Action=GetAsset&Version=2024-01-01/);
 assert.equal(signed.headers["x-date"],"20261026T080910Z");
 assert.match(signed.headers.authorization,/cn-beijing\/ark\/request/);
 assert.doesNotMatch(signed.headers.authorization,/secret_for_tests_only/);
 assert.throws(()=>signArkAction({action:"DeleteAsset",body:"{}",...config}));
 assert.equal(readArkAssetConfig({}),null);
 assert.throws(()=>readArkAssetConfig({ATELIER_ARK_ASSET_AK:"AKLT"}),/ark_asset_config_incomplete/);
 assert.deepEqual(readArkAssetConfig({
  ATELIER_ARK_ASSET_AK:config.accessKeyId,ATELIER_ARK_ASSET_SK:config.secretAccessKey,
  ATELIER_ARK_ASSET_GROUP_ID:config.groupId,ATELIER_ARK_TOS_BUCKET:config.bucket
 }),config);
});

test("HTTP 200 Ark business errors are rejected and never interpreted as successful asset creation",async t=>{
 const f=fixture(t),blob=await f.blobStore.put([mp4],{mime:"video/mp4"});
 const ref={blobId:blob.blobId,sha256:blob.sha256,mimeType:"video/mp4"};
 const {client}=mockTos();let attempts=0;
 const upstreamCall=async()=>{attempts++;return res({ResponseMetadata:{Error:{Code:"InvalidParameter.GroupId",Message:"invalid group"}}})};
 const manager=createArkAssetManager({db:f.db,blobStore:f.blobStore,config,client,upstreamCall});
 await assert.rejects(manager.ensureReady(ref),/ark_asset_remote_rejected/);
 assert.equal(manager.record(ref.blobId).status,"creating");
 await assert.rejects(manager.ensureReady(ref),/ark_asset_creation_unknown/);
 assert.equal(attempts,1);
});

test("GetAsset identity mismatch cannot publish an unrelated asset to video generation",async t=>{
 const f=fixture(t),blob=await f.blobStore.put([mp4],{mime:"video/mp4"});
 const ref={blobId:blob.blobId,sha256:blob.sha256,mimeType:"video/mp4"};
 const {client}=mockTos();let creates=0;
 const upstreamCall=async url=>url.includes("CreateAsset")
  ?(creates++,res({Result:{Id:"asset-other-group"}}))
  :res({Result:{Id:"asset-other-group",GroupId:"unrelated-group",AssetType:"Video",Status:"Active"}});
 const manager=createArkAssetManager({db:f.db,blobStore:f.blobStore,config,client,upstreamCall});
 await assert.rejects(manager.ensureReady(ref),/ark_asset_poll_identity_mismatch/);
 assert.equal(manager.record(ref.blobId).status,"processing");
 assert.throws(()=>manager.readyUrl(ref),/ark_asset_not_ready/);
 await assert.rejects(manager.ensureReady(ref),/ark_asset_poll_identity_mismatch/);
 assert.equal(creates,1);
});

test("staged asset rejects an altered pre-signed object URL before CreateAsset",async t=>{
 const f=fixture(t),blob=await f.blobStore.put([mp4],{mime:"video/mp4"});
 const ref={blobId:blob.blobId,sha256:blob.sha256,mimeType:"video/mp4"};
 const {client}=mockTos();client.getPreSignedUrl=()=>"https://atelier-testing.tos-cn-beijing.volces.com/wrong.mp4?X-Tos-Signature=invalid";
 let calls=0;
 const manager=createArkAssetManager({db:f.db,blobStore:f.blobStore,config,client,upstreamCall:async()=>{calls++}});
 await assert.rejects(manager.ensureReady(ref),/ark_asset_signed_url_invalid/);
 assert.equal(manager.record(ref.blobId).status,"staged");
 assert.equal(calls,0);
});

test("active cache must contain a valid Ark asset ID",async t=>{
 const f=fixture(t),blob=await f.blobStore.put([mp4],{mime:"video/mp4"});
 const ref={blobId:blob.blobId,sha256:blob.sha256,mimeType:"video/mp4"};
 f.db.prepare("INSERT INTO ark_asset_uploads(blob_id,bucket,project_name,group_id,status,object_key,asset_id,updated_at) VALUES(?,?,?,?,?,?,?,?)")
  .run(ref.blobId,config.bucket,config.projectName,config.groupId,"active","fixed.mp4","???",Date.now());
 const {client}=mockTos();
 const manager=createArkAssetManager({db:f.db,blobStore:f.blobStore,config,client});
 assert.throws(()=>manager.readyUrl(ref),/ark_asset_not_ready/);
 await assert.rejects(manager.ensureReady(ref),/ark_asset_object_conflict|ark_asset_id_invalid/);
});
