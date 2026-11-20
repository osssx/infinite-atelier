import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {createReadStream,createWriteStream} from "node:fs";
import {open,stat} from "node:fs/promises";
import {pipeline} from "node:stream/promises";
import {zipSync,unzipSync,strToU8} from "fflate";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createProjectArchive,ARCHIVE_MAX_BYTES} from "./project-archive.mjs";
import {createProject,deleteProject,getProject,saveSingleUserCanvas} from "./projects.mjs";
import {getCanvasViewport,getCanvasChats} from "./canvas-state.mjs";
import {buildApp} from "./app.mjs";

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"atelier-archive-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const blobStore=createBlobStore({db,dataDir:dir,maxBlobBytes:2_000_000_000});
 const archive=createProjectArchive({db,blobStore});
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80})});
 return {db,dir,blobStore,archive};
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

test("merged drama asset references survive archive export and restore without separate image nodes",async t=>{
 const f=await fixture(t);
 const img=await f.blobStore.put([png],{mime:"image/png"});
 const assets={id:"assets",type:"drama:assets",metadata:{dramaAssetReferences:[
  {assetId:"hero",variantId:"hero-day",imageStorageKeys:["cas:"+img.blobId],requiredForRendering:true},
 ]}};
 createProject(f.db,{id:"drama",document:{title:"Drama",nodes:[assets],connections:[]}});
 const archive=await f.archive.exportProject("drama");
 const imported=await f.archive.importProject(archive.stream);
 assert.equal(imported.mediaCount,1);
 assert.deepEqual(getProject(f.db,imported.id).document.nodes,[assets]);
});

test("shot groups restore ordered nodes and selected CAS takes without recreating batches",async t=>{
 const f=await fixture(t);
 const take=await f.blobStore.put([mp4],{mime:"video/mp4"});
 const group={id:"shots",type:"group",metadata:{shotGroup:{shots:[
  {shotId:"first",generationNodeId:"a",mode:"independent",take:{storageKey:"cas:"+take.blobId}},
  {shotId:"second",generationNodeId:"b",mode:"continuity"}
 ]}}};
 const original=createProject(f.db,{document:{title:"Shots",nodes:[group,
  {id:"a",type:"video",metadata:{groupId:group.id}},{id:"b",type:"video",metadata:{groupId:group.id}}
 ],connections:[]}});
 const archive=await f.archive.exportProject(original.id);
 const imported=await f.archive.importProject(archive.stream);
 assert.equal(imported.mediaCount,1);
 assert.deepEqual(getProject(f.db,imported.id).document.nodes,original.document.nodes);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM local_shot_batches WHERE project_id=?").get(imported.id).n,0);
});

test("P4.5 project archive embeds immutable Comfy versions and restores them in another SQLite database",async t=>{
 const {createHash}=await import("node:crypto");
 const {createComfyRegistry}=await import("./comfy-registry.mjs");
 const payload={name:"Portable workflow",
  apiGraph:{"1":{class_type:"TestCapture",inputs:{seed:13}}},
  ports:[{id:"output",label:"Result",direction:"source",valueKind:"IMAGE",
   outputBinding:{nodeId:"1",outputIndex:0},capture:{kind:"none"}}],
  requirements:{classTypes:["TestCapture"]}};
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==="object"?
  Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 const revision=createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
 const tmpl={id:"portable-workflow",revision,...payload};
 const source=await fixture(t);
 createComfyRegistry(source.db).installMany([tmpl]);
 createProject(source.db,{id:"bound",document:{title:"Bound",nodes:[
  {id:"w",type:"comfy:workflow",
   metadata:{comfyWorkflow:{templateId:tmpl.id,templateRevision:tmpl.revision}}}
 ],connections:[]}});
 const zip=Buffer.concat(await Array.fromAsync((await source.archive.exportProject("bound")).stream));
 const entries=unzipSync(zip);
 const manifest=JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
 assert.deepEqual(manifest.templates,[tmpl]);
 const fresh=await fixture(t);
 await assert.rejects(()=>fresh.archive.importProject(Readable.from([Buffer.from(zipSync({
  ...entries,"manifest.json":strToU8(JSON.stringify({...manifest,templates:[]}))
 },{level:0}))])),/archive_template_missing/);
 assert.equal(fresh.db.prepare("SELECT COUNT(*) AS n FROM projects").get().n,0);
 const result=await fresh.archive.importProject(Readable.from([zip]));
 assert.equal(getProject(fresh.db,result.id).document.nodes[0].metadata.comfyWorkflow.templateRevision,revision);
 assert.deepEqual(createComfyRegistry(fresh.db).find(tmpl.id,revision),tmpl);
});
test("130 MiB video exports and restores with disk-streamed ZIP without in-RAM media arrays",async t=>{
 const f=await fixture(t);
 const video=join(f.dir,"large-video.mp4"),zipped=join(f.dir,"large-backup.zip");
 const file=await open(video,"w",0o600);
 try{
  await file.write(mp4);
  await file.truncate(130*1024*1024);
 }finally{await file.close()}
 const asset=await f.blobStore.put(createReadStream(video),{mime:"video/mp4"});
 createProject(f.db,{id:"large",document:{
  title:"Large",nodes:[{id:"v",type:"video",metadata:{
   storageKey:"cas:"+asset.blobId,content:"/api/v1/blobs/"+asset.blobId}}],connections:[],
  viewport:{x:50,y:12,k:1},chatSessions:[],activeChatId:null
 }});
 const backup=await f.archive.exportProject("large");
 await pipeline(backup.stream,createWriteStream(zipped));
 assert.ok((await stat(zipped)).size>128*1024*1024);
 const restored=await f.archive.importProject(createReadStream(zipped));
 assert.equal(restored.mediaCount,1);
 assert.equal(getProject(f.db,restored.id).document.nodes[0].metadata.storageKey,"cas:"+asset.blobId);
 assert.equal(getCanvasViewport(f.db,restored.id).viewport.x,50);
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

test("archives large text history separately from the graph and restores version order",async t=>{
 const {db,archive}=await fixture(t);
 const versions=Array.from({length:6},(_,index)=>({id:"v"+index,createdAt:"now",source:"manual",
  note:"note "+index,content:String(index).repeat(1024*1024)}));
 const document={title:"Large history",nodes:[{id:"story",type:"drama:source",metadata:{
  dramaDraft:"Current",textVersions:versions
 }}],connections:[]};
 createProject(db,{id:"large-history",document});
 const graph=getProject(db,"large-history").document;
 const edited=saveSingleUserCanvas(db,{id:"large-history",expectedRevision:1,document:{...graph,title:"Edited"}});
 assert.equal(edited.document.title,"Edited");
 assert.ok(!JSON.stringify(edited.document).includes("textVersions"));
 const exported=await archive.exportProject("large-history");
 const zip=Buffer.concat(await Array.fromAsync(exported.stream));
 const members=unzipSync(zip);
 const manifest=JSON.parse(Buffer.from(members["manifest.json"]).toString());
 assert.equal(manifest.version,3);
 assert.equal(manifest.project.document.nodes[0].metadata.textVersions,undefined);
 assert.ok(members["text-history.jsonl"].length>5*1024*1024);
 const imported=await archive.importProject(Readable.from([zip]));
 assert.equal(getProject(db,imported.id).document.nodes[0].metadata.dramaDraft,"Current");
 const rows=db.prepare("SELECT id,note,content FROM canvas_text_versions WHERE project_id=? ORDER BY seq DESC").all(imported.id);
 assert.deepEqual(rows.map(row=>({...row})),versions.map(({id,note,content})=>({id,note,content})));
});

test("imports legacy ZIP versions into SQLite",async t=>{
 const {db,archive}=await fixture(t);
 const version={id:"legacy",createdAt:"now",note:"First",source:"manual",content:"Earlier text"};
 const document={title:"Legacy",nodes:[{id:"text",type:"text",metadata:{content:"Current",textVersions:[version]}}],connections:[]};
 const manifest={app:"infinite-atelier",kind:"sqlite-canvas-project",version:1,
  project:{id:"old",title:"Legacy",document,viewport:{x:0,y:0,k:1},chats:{sessions:[],activeChatId:null}},media:[]};
 const zip=zipSync({"manifest.json":strToU8(JSON.stringify(manifest))},{level:0});
 const restored=await archive.importProject(Readable.from([zip]));
 assert.deepEqual(getProject(db,restored.id).document.nodes[0].metadata,{content:"Current"});
 const row=db.prepare("SELECT id, note, content FROM canvas_text_versions WHERE project_id=?").get(restored.id);
 assert.deepEqual({...row},{id:version.id,note:version.note,content:version.content});
});

test("rejects a v3 archive that combines inline and streamed text history",async t=>{
 const {db,archive}=await fixture(t);
 const version={id:"original",createdAt:"now",source:"manual",content:"Earlier"};
 const document={title:"History",nodes:[{id:"text",type:"text",metadata:{content:"Current",textVersions:[version]}}],connections:[]};
 createProject(db,{id:"history",document});
 const exported=await archive.exportProject("history");
 const members=unzipSync(Buffer.concat(await Array.fromAsync(exported.stream)));
 const manifest=JSON.parse(Buffer.from(members["manifest.json"]).toString());
 manifest.project.document.nodes[0].metadata.textVersions=[{...version,id:"embedded"}];
 members["manifest.json"]=strToU8(JSON.stringify(manifest));
 await assert.rejects(archive.importProject(Readable.from([zipSync(members,{level:0})])),/archive_invalid_text_history/);
 assert.equal(db.prepare("SELECT COUNT(*) AS count FROM projects").get().count,1);
});

test("exports and imports a blob referenced only by a text version",async t=>{
 const source=await fixture(t),destination=await fixture(t);
 const blob=await source.blobStore.put([png],{mime:"image/png"});
 const content="/api/v1/blobs/"+blob.blobId;
 createProject(source.db,{id:"history-media",document:{nodes:[{id:"text",type:"text",metadata:{
  content:"New",textVersions:[{id:"snapshot",content,source:"manual",createdAt:"now"}]
 }}],connections:[]}});
 const {stream}=await source.archive.exportProject("history-media");
 const restored=await destination.archive.importProject(stream);
 assert.equal(restored.mediaCount,1);
 assert.equal((await destination.blobStore.stat(blob.blobId)).byteSize,png.length);
 const version=destination.db.prepare("SELECT content FROM canvas_text_versions WHERE project_id=?").get(restored.id);
 assert.equal(version.content,content);
});
