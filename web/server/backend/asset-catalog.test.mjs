import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {getAssetCatalog,putAssetCatalog} from "./asset-catalog.mjs";
import {createBlobGarbageCollector} from "./blob-gc.mjs";
import {blobReferenceLedgerStatus,rebuildBlobReferenceLedger,persistedBlobReferences} from "./blob-reference-ledger.mjs";
function f(t){
 const dir=mkdtempSync(join(tmpdir(),"atelier-asset-catalog-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const blobStore=createBlobStore({dataDir:dir,db});
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="yes",blobStore});
 t.after(async()=>{await app.close();db.close()});
 const call=(method,url,payload,headers={})=>app.inject({method,url,headers:{"x-test-owner":"yes",...headers},
  ...(payload===undefined?{}:{payload})});
 return {db,blobStore,app,call};
}
const text=(id="txt")=>({id,kind:"text",title:"Note",coverUrl:"",tags:[],
 createdAt:"2026-01-01",updatedAt:"2026-01-01",data:{content:"safe text"}});
const image=(blob)=>({id:"img",kind:"image",title:"Photo",coverUrl:"/api/v1/blobs/"+blob.blobId,
 tags:[],createdAt:"2026-01-01",updatedAt:"2026-01-01",
 data:{storageKey:"cas:"+blob.blobId,dataUrl:"/api/v1/blobs/"+blob.blobId,
  width:12,height:8,bytes:blob.byteSize,mimeType:blob.mimeType}});
test("P5.4 asset metadata is an SQLite singleton, revision-CAS, and protected by backend auth/origin",async t=>{
 const x=f(t);
 assert.deepEqual(getAssetCatalog(x.db),{revision:1,assets:[]});
 assert.equal((await x.app.inject({method:"GET",url:"/api/v1/assets"})).statusCode,401);
 assert.equal((await x.call("GET","/api/v1/assets")).json().revision,1);
 assert.equal((await x.call("PUT","/api/v1/assets",{expectedRevision:1,assets:[text()]})).statusCode,200);
 assert.equal(getAssetCatalog(x.db).revision,2);
 const stale=await x.call("PUT","/api/v1/assets",{expectedRevision:1,assets:[]});
 assert.equal(stale.statusCode,409);assert.equal(stale.json().code,"asset_catalog_revision_conflict");
 assert.equal(getAssetCatalog(x.db).assets.length,1);
 const forbidden=await x.call("PUT","/api/v1/assets",{expectedRevision:2,assets:[]},
  {origin:"https://attacker.example",host:"localhost"});
 assert.equal(forbidden.statusCode,403);
 assert.equal(getAssetCatalog(x.db).revision,2);
});
test("P5.4 images and videos must be durable CAS references before SQLite accepts the asset",async t=>{
 const x=f(t);
 const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
 const blob=await x.blobStore.put([bytes],{mime:"image/png"});
 assert.equal((await x.call("PUT","/api/v1/assets",{expectedRevision:1,assets:[image(blob)]})).statusCode,200);
 assert.equal(getAssetCatalog(x.db).assets[0].data.storageKey,"cas:"+blob.blobId);
 assert.equal(blobReferenceLedgerStatus(x.db).dirty,true);
 rebuildBlobReferenceLedger(x.db);
 assert.equal(persistedBlobReferences(x.db).has(blob.blobId),true);
 assert.equal(createBlobGarbageCollector({db:x.db,blobStore:x.blobStore})
  .sweep({now:Date.now()+10*86400000}).candidates.length,0);
 for(const bad of [
  {...image(blob),data:{...image(blob).data,storageKey:"image:legacy"}},
  {...image(blob),data:{...image(blob).data,dataUrl:"blob:old-origin"}},
  {...image(blob),data:{...image(blob).data,bytes:blob.byteSize+1}},
  {...image(blob),data:{...image(blob).data,storageKey:"cas:"+"f".repeat(64),dataUrl:"/api/v1/blobs/"+"f".repeat(64)}}
 ]){
  const res=await x.call("PUT","/api/v1/assets",{expectedRevision:2,assets:[bad]});
  assert.equal(res.statusCode,422,res.body);
 }
 assert.equal(getAssetCatalog(x.db).revision,2);
});
test("P5.4 rollback, max length and duplicate IDs cannot partially overwrite a valid catalog",async t=>{
 const x=f(t);
 putAssetCatalog(x.db,{expectedRevision:1,assets:[text()]});
 assert.throws(()=>putAssetCatalog(x.db,{expectedRevision:2,assets:[text(),text()]}),/asset_catalog_invalid/);
 assert.throws(()=>putAssetCatalog(x.db,{expectedRevision:2,assets:[text("x"),{...text("y"),coverUrl:"data:image/png;base64,AAAA"}]}),/asset_catalog_invalid/);
 assert.equal(getAssetCatalog(x.db).revision,2);
 assert.deepEqual(getAssetCatalog(x.db).assets,[text()]);
});
