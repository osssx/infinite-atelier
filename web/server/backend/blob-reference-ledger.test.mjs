import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createBlobGarbageCollector} from "./blob-gc.mjs";
import {createProject,patchProject} from "./projects.mjs";
import {blobReferenceLedgerStatus,rebuildBlobReferenceLedger,persistedBlobReferences} from "./blob-reference-ledger.mjs";

const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),"atelier-ledger-"));
 const db=new DatabaseSync(join(root,"db.sqlite"));initializeSchema(db);
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true})});
 return {db,blobStore:createBlobStore({db,dataDir:root})};
}
test("v10 ledger migration survives restart and source mutations mark dirty in same SQLite transaction",async t=>{
 const f=fixture(t);
 assert.equal(f.db.prepare("SELECT MAX(version) AS n FROM schema_migrations").get().n,14);
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 let row=rebuildBlobReferenceLedger(f.db);
 assert.equal(row.dirty,false);
 assert.equal(row.rebuild,true);
 const media=await f.blobStore.put([png],{mime:"image/png"});
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,false);
 const doc={nodes:[{id:"a",type:"image",metadata:{content:"/api/v1/blobs/"+media.blobId}}],connections:[]};
 createProject(f.db,{id:"a",document:doc});
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 const seq=blobReferenceLedgerStatus(f.db).changeSeq;
 f.db.exec("BEGIN IMMEDIATE");
 try{
  f.db.prepare("UPDATE projects SET document_json=? WHERE id='a'").run('{"nodes":[],"connections":[]}');
  assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 }finally{f.db.exec("ROLLBACK")}
 assert.equal(blobReferenceLedgerStatus(f.db).changeSeq,seq);
 const refreshed=rebuildBlobReferenceLedger(f.db);
 assert.equal(refreshed.dirty,false);
 assert.equal(refreshed.rebuiltSeq,seq);
 assert.equal(persistedBlobReferences(f.db).has(media.blobId),true);
 const reopened=new DatabaseSync(join(f.blobStore.pathFor(media.blobId),"..","..","..","db.sqlite"));
 try{assert.equal(persistedBlobReferences(reopened).has(media.blobId),true)}
 finally{reopened.close()}
 const current=f.db.prepare("SELECT revision FROM projects WHERE id='a'").get().revision;
 patchProject(f.db,{id:"a",expectedRevision:current,document:{nodes:[],connections:[]}});
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 rebuildBlobReferenceLedger(f.db);
 assert.equal(persistedBlobReferences(f.db).has(media.blobId),false);
});
test("GC v10 must retain live references during dirty update, frozen job, template and Ark media",async t=>{
 const f=fixture(t);
 const image=await f.blobStore.put([png],{mime:"image/png"});
 const orphan=await f.blobStore.put([Buffer.concat([Buffer.alloc(4),Buffer.from("ftyp"),Buffer.alloc(10)])],{mime:"video/mp4"});
 createProject(f.db,{id:"a",document:{nodes:[{id:"x",type:"image",metadata:{id:image.blobId}}],connections:[]}});
 const gc=createBlobGarbageCollector({db:f.db,blobStore:f.blobStore}),future=Date.now()+8*86400000;
 const dry=gc.sweep({now:future});
 assert.deepEqual(dry.candidates.map(v=>v.id),[orphan.blobId]);
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,false);
 assert.equal(persistedBlobReferences(f.db).has(image.blobId),true);
 const rev=f.db.prepare("SELECT revision FROM projects WHERE id='a'").get().revision;
 patchProject(f.db,{id:"a",expectedRevision:rev,document:{nodes:[],connections:[]}});
 f.db.prepare("INSERT INTO jobs(id,principal,project_scope,idempotency_key,request_fingerprint,snapshot_json,execution_mode,status,created_at,updated_at) VALUES('frozen','local','','k','f',?,'poll','succeeded',1,1)")
  .run(JSON.stringify({photo:image.blobId}));
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 assert.deepEqual(gc.sweep({now:future}).candidates.map(v=>v.id),[orphan.blobId]);
 f.db.prepare("INSERT INTO comfy_template_versions(template_id,revision,payload_json,created_at) VALUES(?,?,?,?)")
  .run("ref","sha",JSON.stringify({secret:image.blobId}),1);
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 assert.equal(gc.sweep({now:future}).candidates.length,1);
 assert.equal(gc.sweep({now:future,dryRun:false,confirmation:"DELETE_UNREFERENCED"}).deletedCount,1);
 assert.equal(existsSync(f.blobStore.pathFor(image.blobId)),true);
});
test("references recorded by artifacts and Ark assets persist, malformed ledger fails closed rather than unlinking",async t=>{
 const f=fixture(t);
 const media=await f.blobStore.put([png],{mime:"image/png"});
 f.db.prepare("INSERT INTO ark_asset_uploads(blob_id,bucket,project_name,group_id,status,object_key,updated_at) VALUES(?,?,?,?,?,?,?)")
  .run(media.blobId,"bucket","project","group","active","remote",Date.now());
 const gc=createBlobGarbageCollector({db:f.db,blobStore:f.blobStore});
 const future=Date.now()+8*86400000;
 assert.equal(gc.sweep({now:future}).candidates.length,0);
 assert.equal(persistedBlobReferences(f.db).has(media.blobId),true);
 f.db.exec("DROP TABLE blob_ref_ledger");
 assert.throws(()=>gc.sweep({now:future}),/no such table/);
 assert.equal(existsSync(f.blobStore.pathFor(media.blobId)),true);
});
