import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {zipSync,unzipSync,strToU8} from "fflate";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createProjectArchive,ARCHIVE_MAX_BYTES} from "./project-archive.mjs";
import {createProject,deleteProject,getProject} from "./projects.mjs";
import {getCanvasViewport,getCanvasChats} from "./canvas-state.mjs";
import {buildApp} from "./app.mjs";

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"atelier-archive-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const blobStore=createBlobStore({db,dataDir:dir});
 const archive=createProjectArchive({db,blobStore});
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80})});
 return {db,blobStore,archive};
}
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
const mp4=Buffer.concat([Buffer.alloc(4),Buffer.from("ftyp"),Buffer.from("isom0000"),Buffer.alloc(20,3)]);
async function seed(f){
 const img=await f.blobStore.put([png],{mime:"image/png"});
 const vid=await f.blobStore.put([mp4],{mime:"video/mp4"});
 const graph={
  title:"SQLite restore",nodes:[{id:"img",type:"image",metadata:{storageKey:"cas:"+img.blobId,
   content:"/api/v1/blobs/"+img.blobId}},{id:"video",type:"video",
   metadata:{storageKey:"cas:"+vid.blobId,content:"/api/v1/blobs/"+vid.blobId}}],
  connections:[],viewport:{x:180,y:25,k:0.85},
  chatSessions:[{id:"chat",title:"Session",createdAt:"now",updatedAt:"now",messages:[
   {id:"msg",role:"user",content:"hello"}]}],activeChatId:"chat"
 };
 createProject(f.db,{id:"original",document:graph});
 return {img,vid,graph};
}
test("complete ZIP roundtrip restores graph, separate viewport/chat and both media with a new project ID",async t=>{
 const f=await fixture(t),{img,vid,graph}=await seed(f);
 const archive=await f.archive.exportProject("original");
 assert.match(archive.fileName,/original.atelier.zip/);
 const zip=Buffer.concat(await Array.fromAsync(archive.stream));
 const members=unzipSync(zip);
 assert.equal(Object.keys(members).length,3);
 assert.equal(JSON.parse(Buffer.from(members["manifest.json"]).toString()).media.length,2);
 const first=await f.archive.importProject(Readable.from([zip]));
 assert.notEqual(first.id,"original");assert.equal(first.revision,1);
 assert.equal(first.mediaCount,2);
 const restored=getProject(f.db,first.id);
 assert.deepEqual(restored.document.nodes,graph.nodes);
 assert.deepEqual(getCanvasViewport(f.db,first.id).viewport,graph.viewport);
 assert.deepEqual(getCanvasChats(f.db,first.id).sessions,graph.chatSessions);
 assert.equal(getCanvasChats(f.db,first.id).activeChatId,"chat");
 const recovered=await f.blobStore.stat(img.blobId);
 assert.equal(recovered.byteSize,png.length);
 deleteProject(f.db,"original");
 const secondExport=await f.archive.exportProject(first.id);
 assert.equal(secondExport.fileName,first.id+".atelier.zip");
 assert.ok(Buffer.concat(await Array.fromAsync(secondExport.stream)).length>0);
 assert.deepEqual((await f.blobStore.stat(vid.blobId)).byteSize,mp4.length);
});
test("rejects missing media and altered bytes before making any SQLite project",async t=>{
 const f=await fixture(t);await seed(f);
 const bytes=Buffer.concat(await Array.fromAsync((await f.archive.exportProject("original")).stream));
 const files=unzipSync(bytes);
 const missing={...files};delete missing[Object.keys(missing).find(k=>k.startsWith("blobs/"))];
 const before=f.db.prepare("SELECT count(*) AS n FROM projects").get().n;
 await assert.rejects(()=>f.archive.importProject(Readable.from([Buffer.from(zipSync(missing,{level:0}))])),/archive_unexpected_files|archive_media_integrity_error/);
 const changed={...files};
 const media=Object.keys(files).find(k=>k.startsWith("blobs/"));
 changed[media]=new Uint8Array([...files[media]]);changed[media][changed[media].length-1]^=0xff;
 await assert.rejects(()=>f.archive.importProject(Readable.from([Buffer.from(zipSync(changed,{level:0}))])),/archive_media_integrity_error/);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM projects").get().n,before);
});
test("rejects path traversal, unrecognized entries and compressed payloads",async t=>{
 const f=await fixture(t);
 for(const files of [
  {"../hijack":strToU8("no")},
  {"manifest.json":strToU8("{}"),"bad/evil":strToU8("evil")}
 ]){
  await assert.rejects(()=>f.archive.importProject(Readable.from([Buffer.from(zipSync(files,{level:0}))])),/archive_invalid_entry/);
 }
 await assert.rejects(()=>f.archive.importProject(Readable.from([
  Buffer.from(zipSync({"manifest.json":strToU8("{}")},{level:9}))
 ])),/archive_invalid_entry|archive_invalid_manifest/);
});
test("rejects a truncated ZIP and never creates a project from it",async t=>{
 const f=await fixture(t);await seed(f);
 const archive=Buffer.concat(await Array.fromAsync((await f.archive.exportProject("original")).stream));
 const before=f.db.prepare("SELECT count(*) AS n FROM projects").get().n;
 await assert.rejects(()=>f.archive.importProject(Readable.from([archive.subarray(0,archive.length-49)])),/archive_/);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM projects").get().n,before);
});
test("nonportable browser-only keys fail closed rather than producing a misleading backup",async t=>{
 const f=await fixture(t);
 createProject(f.db,{id:"broken",document:{nodes:[{id:"legacy",type:"image",
  metadata:{storageKey:"image:origin-local-asset"}}],connections:[]}});
 await assert.rejects(()=>f.archive.exportProject("broken"),/archive_nonportable_media_reference/);
});
test("authenticated ZIP endpoints export/import and keep project scoped",async t=>{
 const f=await fixture(t);await seed(f);
 const app=buildApp({db:f.db,blobStore:f.blobStore,projectArchive:f.archive,
  authorize:req=>req.headers["x-test-owner"]==="yes"});
 t.after(()=>app.close());
 const url="/api/v1/projects/original/archive";
 assert.equal((await app.inject({method:"GET",url})).statusCode,401);
 const get=await app.inject({method:"GET",url,headers:{"x-test-owner":"yes"}});
 assert.equal(get.statusCode,200,get.body);
 assert.equal(get.headers["content-type"],"application/zip");
 const post=await app.inject({method:"POST",url:"/api/v1/projects/import-archive",
  headers:{"x-test-owner":"yes","content-type":"application/zip"},payload:get.rawPayload});
 assert.equal(post.statusCode,201,post.body);
 const result=post.json();assert.notEqual(result.id,"original");
 assert.equal(getProject(f.db,result.id).document.nodes.length,2);
 assert.equal((await app.inject({method:"GET",url:"/api/v1/projects/missing/archive",headers:{"x-test-owner":"yes"}})).statusCode,404);
});
