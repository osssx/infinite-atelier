import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync,existsSync} from "node:fs";
import {writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createMediaPreviewStore} from "./media-preview.mjs";
import {createBlobGarbageCollector} from "./blob-gc.mjs";
import {createProject,patchProject,deleteProject} from "./projects.mjs";
import {buildApp} from "./app.mjs";
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
const mp4=Buffer.concat([Buffer.alloc(4),Buffer.from("ftyp"),Buffer.from("isom0000"),Buffer.alloc(20,3)]);
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"atelier-p3-lifecycle-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const blobStore=createBlobStore({db,dataDir:dir});
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true,maxRetries:4,retryDelay:80})});
 return {db,dir,blobStore};
}
const graph=(key)=>({nodes:[{id:"image-1",type:"image",title:"Img",metadata:{
 storageKey:"cas:"+key,content:"/api/v1/blobs/"+key}}],connections:[]});
test("preview returns one lazily rendered PNG for duplicate concurrent requests",async t=>{
 const{db,dir,blobStore}=await fixture(t);
 const source=await blobStore.put([mp4],{mime:"video/mp4"});
 let renders=0;
 const preview=createMediaPreviewStore({dataDir:dir,blobStore,render:async(_src,dst)=>{
  renders++;await new Promise(r=>setTimeout(r,20));await writeFile(dst,png);
 }});
 const app=buildApp({db,authorize:()=>true,blobStore,mediaPreview:preview});
 t.after(()=>app.close());
 const uri="/api/v1/blobs/"+source.blobId+"/preview";
 const [a,b]=await Promise.all([app.inject({method:"GET",url:uri}),app.inject({method:"GET",url:uri})]);
 assert.equal(a.statusCode,200,a.body);assert.equal(b.statusCode,200,b.body);
 assert.equal(a.headers["content-type"],"image/png");
 assert.ok(a.rawPayload.equals(png));assert.ok(b.rawPayload.equals(png));
 assert.equal(renders,1);
 assert.equal((await app.inject({method:"GET",url:uri})).statusCode,200);assert.equal(renders,1);
 const text=await blobStore.put([Buffer.from("hi")],{mime:"text/plain"});
 assert.equal((await app.inject({method:"GET",url:"/api/v1/blobs/"+text.blobId+"/preview"})).statusCode,415);
 assert.equal((await app.inject({method:"GET",url:uri,headers:{host:"attacker.net"}})).statusCode,403);
});
test("GC retains shared live project and frozen job references",async t=>{
 const {db,blobStore}=await fixture(t);
 const shared=await blobStore.put([png],{mime:"image/png"});
 const orphan=await blobStore.put([mp4],{mime:"video/mp4"});
 createProject(db,{id:"first",document:graph(shared.blobId)});
 createProject(db,{id:"second",document:graph(shared.blobId)});
 deleteProject(db,"first");
 const gc=createBlobGarbageCollector({db,blobStore});
 const future=Date.now()+8*86400000;
 const dry=gc.sweep({now:future});
 assert.equal(dry.deletedCount,0);assert.deepEqual(dry.candidates.map(x=>x.id),[orphan.blobId]);
 assert.throws(()=>gc.sweep({now:future,dryRun:false}),/gc_confirmation_required/);
 const done=gc.sweep({now:future,dryRun:false,confirmation:"DELETE_UNREFERENCED"});
 assert.equal(done.deletedCount,1);
 assert.equal(existsSync(blobStore.pathFor(orphan.blobId)),false);
 assert.equal(existsSync(blobStore.pathFor(shared.blobId)),true);
 const row=db.prepare("SELECT revision FROM projects WHERE id='second'").get();
 patchProject(db,{id:"second",expectedRevision:row.revision,document:{nodes:[],connections:[]}});
 db.prepare(`INSERT INTO jobs(id,principal,project_scope,idempotency_key,request_fingerprint,snapshot_json,execution_mode,status,created_at,updated_at)
 VALUES('task','local','','key','fingerprint',?,'poll','succeeded',1,1)`)
 .run(JSON.stringify({assetId:shared.blobId}));
 assert.equal(gc.sweep({now:future}).candidates.length,0);
});
test("GC fails closed when an unknown foreign key protects a blob",async t=>{
 const {db,blobStore}=await fixture(t);
 const orphan=await blobStore.put([png],{mime:"image/png"});
 db.exec("CREATE TABLE third_party_pins(blob_id TEXT NOT NULL REFERENCES blobs(id))");
 db.prepare("INSERT INTO third_party_pins(blob_id) VALUES(?)").run(orphan.blobId);
 const gc=createBlobGarbageCollector({db,blobStore});
 assert.throws(()=>gc.sweep({now:Date.now()+8*86400000,dryRun:false,
  confirmation:"DELETE_UNREFERENCED"}),/FOREIGN KEY/);
 assert.equal(existsSync(blobStore.pathFor(orphan.blobId)),true);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM blobs").get().n,1);
});
test("GC blocks active uploads and requires explicit HTTP confirmation",async t=>{
 const {db,blobStore}=await fixture(t);
 const gc=createBlobGarbageCollector({db,blobStore});
 let release,signal;
 const resumed=new Promise(r=>{signal=r}),blocked=new Promise(r=>{release=r});
 const pending=blobStore.put((async function*(){yield png.subarray(0,4);signal();await blocked;yield png.subarray(4)})(),{mime:"image/png"});
 await resumed;
 assert.throws(()=>gc.sweep(),/gc_upload_in_progress/);
 release();await pending;
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="yes",blobStore,blobGc:gc});
 t.after(()=>app.close());
 assert.equal((await app.inject({method:"POST",url:"/api/v1/storage/gc",payload:{}})).statusCode,401);
 const dry=await app.inject({method:"POST",url:"/api/v1/storage/gc",payload:{},headers:{"x-test-owner":"yes"}});
 assert.equal(dry.statusCode,200);assert.equal(dry.json().deletedCount,0);
 assert.equal((await app.inject({method:"POST",url:"/api/v1/storage/gc",payload:{dryRun:false},
  headers:{"x-test-owner":"yes"}})).statusCode,400);
});
