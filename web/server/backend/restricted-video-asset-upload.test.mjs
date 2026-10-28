import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createScriptAssetUploadManager} from "./restricted-video-asset-upload.mjs";
import {submitJob} from "./repository.mjs";
import {scanBlobReferenceSources,blobReferenceLedgerStatus} from "./blob-reference-ledger.mjs";

const mp4=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"atelier-upload-barrier-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const blobStore=createBlobStore({db,dataDir:dir});
 return {db,blobStore};
}
async function entry(f,key){
 const saved=await f.blobStore.put([mp4],{mime:"video/mp4"});
 const jobId=submitJob(f.db,{idempotencyKey:key,requestFingerprint:key,
  executionMode:"poll",snapshot:{adapterKind:"model",task:{kind:"video",references:[
   {kind:"video",role:"reference_video",blobId:saved.blobId,sha256:saved.sha256,mimeType:"video/mp4"}
  ]}}}).jobId;
 return {job:{id:jobId},ref:{blobId:saved.blobId},index:0,script:"const a=await http.post('/assets', {model});return a.id;"};
}
test("v17 schema upgrades existing DB and reserves CAS owners for uploaded assets",async t=>{
 const f=fixture(t);
 assert.equal(SCHEMA_VERSION,17);
 f.db.exec("DROP TABLE script_asset_uploads;DELETE FROM schema_migrations WHERE version=17;");
 f.db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(16,?)").run(Date.now());
 initializeSchema(f.db);
 assert.equal(f.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,17);
 const x=await entry(f,"schema-asset-1");
 const manager=createScriptAssetUploadManager({db:f.db});
 assert.equal(await manager.ensureReady({...x,upload:async()=>({id:"remote_asset_1"})}),
  "remote_asset_1");
 const rows=[];
 scanBlobReferenceSources(f.db,(source,owner,hash)=>{
  if(source==="script_asset")rows.push({source,owner,hash});
 });
 assert.deepEqual(rows,[{source:"script_asset",owner:x.job.id+":0",hash:x.ref.blobId}]);
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
});
test("definitive provider 4xx rejection is persisted and is not automatically retried",async t=>{
 const f=fixture(t),x=await entry(f,"rejected-asset-1");
 const manager=createScriptAssetUploadManager({db:f.db});
 let count=0;
 const rejected=Object.assign(Error("upstream rejected"),{confirmedNotAccepted:true});
 await assert.rejects(manager.ensureReady({...x,upload:async()=>{count++;throw rejected}}),
  /upstream rejected/);
 assert.equal(manager.row(x.job.id,0).status,"rejected");
 await assert.rejects(manager.ensureReady({...x,upload:async()=>{count++;return "ignored"}}),
  /video_script_asset_upload_rejected/);
 assert.equal(count,1);
});
test("unknown upload status is a permanent no-replay barrier and conflicting identity fails closed",async t=>{
 const f=fixture(t),x=await entry(f,"unknown-asset-1");
 const manager=createScriptAssetUploadManager({db:f.db});
 let count=0;
 await assert.rejects(manager.ensureReady({...x,upload:async()=>{count++;throw Error("timeout")}}),
  /timeout/);
 assert.equal(manager.row(x.job.id,0).status,"uploading");
 await assert.rejects(manager.ensureReady({...x,upload:async()=>{count++;return "unsafe"}}),
  /video_script_asset_upload_unknown/);
 await assert.rejects(manager.ensureReady({...x,script:"different",upload:async()=>{count++}}),
  /video_script_asset_identity_conflict/);
 assert.equal(count,1);
});
