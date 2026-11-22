import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,validateProjectDocument,emitProjectEvent,saveSingleUserCanvas} from "./projects.mjs";
import {readDramaRevisionScope,insertTextVersions} from "./canvas-text-versions.mjs";
import {readCreativePayload} from "./creative-payloads.mjs";
import {patchDramaScopedBatch} from "./drama-scoped-batch-cas.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createProjectArchive} from "./project-archive.mjs";
import {buildApp} from "./app.mjs";

const assets=[{id:"hero",kind:"character",name:"Hero",description:"Main character",sourceRefs:[],
 variants:[{id:"hero-day",name:"Day",description:"Blue outfit"}]},
 ...Array.from({length:49},(_,i)=>({id:"prop-"+i,kind:"prop",
  name:"Prop "+i,description:"Prop description "+i,sourceRefs:[]}))];
const episodes=Array.from({length:4},(_,i)=>({id:"ep-"+i,title:"Episode "+i,
 synopsis:"Synopsis "+i,ending:"Ending "+i,events:["Event "+i],
 eventItems:[{id:"event-"+i,text:"Event "+i}],sourceRefs:[],
 sequences:[{id:"seq-"+i,title:"Scene "+i,eventRefs:["event-"+i]}]}));
const shots=Array.from({length:100},(_,i)=>({id:"shot-"+i,
 episodeId:"ep-"+Math.floor(i/25),sequenceId:"seq-"+Math.floor(i/25),order:i,
 description:"Shot description "+i,characterVariantIds:["hero-day"],
 propIds:[],keyPropIds:[]}));
const json={assets:JSON.stringify({assets}),episodes:JSON.stringify({episodes}),shots:JSON.stringify({shots})};
const document=()=>({title:"Batch 200 nodes",nodes:[
 {id:"assets",type:"drama:assets",metadata:{dramaDraft:json.assets,dramaConfirmed:json.assets}},
 {id:"episodes",type:"drama:episodes",metadata:{dramaDraft:json.episodes,dramaConfirmed:json.episodes}},
 {id:"board",type:"drama:storyboard",metadata:{dramaDraft:json.shots,dramaConfirmed:json.shots}},
 {id:"video-config",type:"config",metadata:{dramaVideoSource:{nodeId:"board",
  revisionId:"frozen-board",shotId:"shot-75",prompt:"Manual prompt",referenceKeys:[]}}},
 ...Array.from({length:196},(_,i)=>({id:"text-"+i,type:"text",metadata:{content:"Text node"}}))
],connections:[{id:"assets-board",fromNodeId:"assets",toNodeId:"board"},
 {id:"episodes-board",fromNodeId:"episodes",toNodeId:"board"},
 {id:"board-config",fromNodeId:"board",toNodeId:"video-config"}]});
function createFixture(db){
 initializeSchema(db);
 createProject(db,{id:"batch",document:document()});
 insertTextVersions(db,"batch",[
  {nodeId:"assets",id:"frozen-assets",createdAt:"2026-11-22T00:00:00Z",source:"confirmation",content:json.assets},
  {nodeId:"episodes",id:"frozen-episodes",createdAt:"2026-11-22T00:00:00Z",source:"confirmation",content:json.episodes},
  {nodeId:"board",id:"frozen-board",createdAt:"2026-11-22T00:00:00Z",source:"confirmation",content:json.shots}
 ]);
 return db;
}
const fixture=t=>{const db=createFixture(new DatabaseSync(":memory:"));t.after(()=>db.close());return db};
const revision=db=>getProject(db,"batch",{compact:true}).revision;
const digest=(db,nodeId,entryId)=>readDramaRevisionScope(db,"batch",nodeId,
 {draft:true,entryId,limit:1}).entryDigests[0].digest;
const makeEdits=db=>[
 {nodeId:"assets",kind:"assets",entryId:"hero",expectedDigest:digest(db,"assets","hero"),
  changes:{name:"Renamed hero",description:"Still main character"}},
 {nodeId:"episodes",kind:"episodes",entryId:"ep-3",expectedDigest:digest(db,"episodes","ep-3"),
  changes:{synopsis:"Revised third episode summary"}},
 {nodeId:"board",kind:"shots",entryId:"shot-75",expectedDigest:digest(db,"board","shot-75"),
  changes:{description:"Revised shot 75"}},
];
const run=(db,command,emit=emitProjectEvent)=>patchDramaScopedBatch(db,"batch",command,validateProjectDocument,emit);
const batch=(db,operationId="batch-1")=>({operationId,expectedRevision:revision(db),edits:makeEdits(db)});
const values=(db,nodeId)=>JSON.parse(readCreativePayload(db,"batch",nodeId).payload.dramaDraft);
const events=db=>db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id='batch'").get().n;
const receipt=(db,id)=>db.prepare("SELECT * FROM drama_scope_batch_operations WHERE project_id='batch' AND operation_id=?").get(id);

test("P3.3e: a 3-node 3-kind batch atomically edits only chosen entries, records ONE revision and ONE event",t=>{
 const db=fixture(t),cmd=batch(db);
 const compactBefore=db.prepare("SELECT document_json FROM projects WHERE id='batch'").get().document_json;
 const configBefore=getProject(db,"batch").document.nodes.find(item=>item.id==="video-config");
 const e=events(db),result=run(db,cmd);
 assert.deepEqual(result,{existing:false,projectRevision:2,applied:3});
 assert.equal(revision(db),2);assert.equal(events(db),e+1);
 assert.equal(receipt(db,cmd.operationId).project_revision,2);
 assert.equal(db.prepare("SELECT document_json FROM projects WHERE id='batch'").get().document_json,compactBefore);
 assert.equal(values(db,"assets").assets[0].name,"Renamed hero");
 assert.deepEqual(values(db,"assets").assets.slice(1),assets.slice(1));
 assert.equal(values(db,"episodes").episodes[3].synopsis,"Revised third episode summary");
 assert.deepEqual(values(db,"episodes").episodes.slice(0,3),episodes.slice(0,3));
 assert.equal(values(db,"board").shots[75].description,"Revised shot 75");
 assert.deepEqual(values(db,"board").shots.filter((_,i)=>i!==75),shots.filter((_,i)=>i!==75));
 for(const nodeId of ["assets","episodes","board"])
  assert.equal(readCreativePayload(db,"batch",nodeId).revision,2);
 assert.deepEqual(getProject(db,"batch").document.nodes.find(item=>item.id==="video-config"),configBefore);
 assert.equal(readDramaRevisionScope(db,"batch","board",{versionId:"frozen-board",entryId:"shot-75"}).entries[0].description,shots[75].description);
 for(const [nodeId,entryId] of [["assets","hero"],["episodes","ep-3"],["board","shot-75"]]){
  const changed=readDramaRevisionScope(db,"batch",nodeId,{draft:true,entryId});
  assert.equal(changed.total,1);assert.equal(changed.entryDigests.length,1);
 }
});

test("P3.3e: stale third edit rolls back first two payloads, indexes, revision and receipt",t=>{
 const db=fixture(t),before=new Map(["assets","episodes","board"].map(id=>[id,readCreativePayload(db,"batch",id).payload]));
 const cmd=batch(db,"stale-third");cmd.edits[2].expectedDigest="a".repeat(64);
 const e=events(db);
 assert.throws(()=>run(db,cmd),/drama_candidate_conflict/);
 assert.equal(revision(db),1);assert.equal(events(db),e);assert.equal(receipt(db,cmd.operationId),undefined);
 for(const id of before.keys())assert.deepEqual(readCreativePayload(db,"batch",id).payload,before.get(id));
 assert.equal(readDramaRevisionScope(db,"batch","assets",{draft:true,entryId:"hero"}).entries[0].name,"Hero");
});

test("P3.3e: duplicate entry within same node and nested variant of same parent are forbidden",t=>{
 const db=fixture(t),one=batch(db).edits[0],baselineEvents=events(db);
 assert.throws(()=>run(db,{operationId:"duplicate-parent",expectedRevision:1,edits:[
  one,{...one,variantId:"hero-day",changes:{name:"Day one"}}]}),/drama_batch_duplicate_target/);
 assert.equal(revision(db),1);
 assert.equal(events(db),baselineEvents);
});

test("P3.3e: batch receipt is idempotent after graph revision advances; changed request rejected",t=>{
 const db=fixture(t),command=batch(db);
 assert.equal(run(db,command).existing,false);
 assert.equal(run(db,command).existing,true);
 assert.equal(revision(db),2);
 assert.throws(()=>run(db,{...command,edits:[{...command.edits[0],changes:{name:"other"}}]}),
  /drama_batch_operation_conflict/);
 const second={operationId:"independent-batch",expectedRevision:2,edits:[
  {nodeId:"assets",kind:"assets",entryId:"prop-40",
   expectedDigest:digest(db,"assets","prop-40"),changes:{description:"Next set"}}
 ]};
 run(db,second);
 assert.equal(revision(db),3);
 assert.equal(run(db,command).projectRevision,2,"replay returns original receipt, not current project revision");
 assert.equal(revision(db),3);
});

test("P3.3e: revision mismatch and invalid reference roll back all, including when first edit is valid",t=>{
 const db=fixture(t),command=batch(db),baselineEvents=events(db);
 assert.throws(()=>run(db,{...command,expectedRevision:2}),/project_revision_conflict/);
 command.edits[2].changes={characterVariantIds:["invented-variant"]};
 assert.throws(()=>run(db,command),/drama_draft_invalid/);
 assert.equal(revision(db),1);
 assert.equal(values(db,"assets").assets[0].name,"Hero");
 assert.equal(events(db),baselineEvents);
});

test("P3.3e: unsupported inline drafts fail closed without changing legacy content or project",t=>{
 const db=fixture(t),old=getProject(db,"batch",{compact:true}).document;
 const board=old.nodes.find(item=>item.id==="board");
 delete board.metadata.creativePayloadRef;
 board.metadata.dramaDraft=json.shots;
 db.exec("DROP TRIGGER creative_payload_update");
 db.prepare("UPDATE projects SET document_json=? WHERE id='batch'").run(JSON.stringify(old));
 const cmd=batch(db); // draft digest still exists in old index, but pointer is invalid
 assert.throws(()=>run(db,cmd),/creative_payload_reference_invalid|drama_draft_invalid|drama_batch_index_required/);
 assert.equal(revision(db),1);
});

test("P3.3e: injected failure on event writes rolls back all three nodes and returns no receipt",t=>{
 const db=fixture(t),command=batch(db,"fail-event"),baselineEvents=events(db);
 assert.throws(()=>run(db,command,()=>{throw Error("injected_event_failure")}),/injected_event_failure/);
 assert.equal(revision(db),1);assert.equal(events(db),baselineEvents);assert.equal(receipt(db,command.operationId),undefined);
 for(const [nodeId,entryId,field,expected] of [
  ["assets","hero","name","Hero"],["episodes","ep-3","synopsis","Synopsis 3"],
  ["board","shot-75","description","Shot description 75"]])
  assert.equal(readDramaRevisionScope(db,"batch",nodeId,{draft:true,entryId}).entries[0][field],expected);
 run(db,command);
 assert.equal(revision(db),2);
});

test("P3.3e: restart and archive preserve batch result, original history, and the exact idempotency record",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-batch-restart-")),location=join(dir,"data.sqlite");
 let db=new DatabaseSync(location);
 t.after(()=>{try{db.close();}finally{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:80});}});
 createFixture(db);
 const command=batch(db,"disk-batch");run(db,command);
 db.close();db=new DatabaseSync(location);initializeSchema(db);
 assert.equal(revision(db),2);assert.equal(run(db,command).existing,true);
 assert.equal(revision(db),2);assert.equal(receipt(db,"disk-batch").project_revision,2);
 const blobStore=createBlobStore({db,dataDir:dir,maxBlobBytes:100_000_000});
 const archive=createProjectArchive({db,blobStore});
 const bytes=Buffer.concat(await Array.fromAsync((await archive.exportProject("batch")).stream));
 const imported=await archive.importProject(Readable.from([bytes]));
 assert.equal(readDramaRevisionScope(db,imported.id,"assets",{draft:true,entryId:"hero"}).entries[0].name,"Renamed hero");
 assert.equal(readDramaRevisionScope(db,imported.id,"episodes",{draft:true,entryId:"ep-3"}).entries[0].synopsis,
  "Revised third episode summary");
 assert.equal(readDramaRevisionScope(db,imported.id,"board",{draft:true,entryId:"shot-75"}).entries[0].description,
  "Revised shot 75");
 assert.equal(readDramaRevisionScope(db,imported.id,"board",{versionId:"frozen-board",entryId:"shot-75"}).entries[0].description,
  shots[75].description);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM drama_scope_batch_operations WHERE project_id=?").get(imported.id).n,0,
  "batch receipts are project-local, not a portable archive of approval");
 const compact=getProject(db,imported.id,{compact:true});
 saveSingleUserCanvas(db,{id:imported.id,document:compact.document,expectedRevision:compact.revision});
 assert.equal(readDramaRevisionScope(db,imported.id,"assets",{draft:true,entryId:"hero"}).entries[0].name,"Renamed hero");
});

test("P3.3e: v42 to v43 migration adds batch ledger without touching existing graph or payload revisions",t=>{
 const db=fixture(t),before=getProject(db,"batch"),bodyBefore=readCreativePayload(db,"batch","assets").payload;
 db.exec("DROP TABLE drama_scope_batch_operations; UPDATE schema_migrations SET version=42 WHERE version=43");
 initializeSchema(db);
 assert.deepEqual(getProject(db,"batch"),before);
 assert.deepEqual(readCreativePayload(db,"batch","assets").payload,bodyBefore);
 assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='drama_scope_batch_operations'").get());
 initializeSchema(db);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM drama_scope_batch_operations").get().n,0);
});

test("P3.3e: authenticated batch HTTP emits one project revision and never creates a media job",async t=>{
 const db=fixture(t),app=buildApp({db,authorize:req=>req.headers["x-local-test"]==="yes"});
 t.after(async()=>app.close());
 const url="/api/v1/projects/batch/drama-pipeline/batch-draft",command=batch(db,"http-batch");
 const denied=await app.inject({method:"POST",url,payload:command});
 assert.equal(denied.statusCode,401);
 const done=await app.inject({method:"POST",url,payload:command,headers:{"x-local-test":"yes"}});
 assert.equal(done.statusCode,200,done.body);
 assert.equal(done.json().revision,2);
 assert.equal(done.json().document.nodes.find(node=>node.id==="board").metadata.dramaDraft,undefined);
 const repeated=await app.inject({method:"POST",url,payload:command,headers:{"x-local-test":"yes"}});
 assert.equal(repeated.statusCode,200);
 assert.equal(revision(db),2);
 const stale=await app.inject({method:"POST",url,payload:{...command,operationId:"new-stale-batch"},
  headers:{"x-local-test":"yes"}});
 assert.equal(stale.statusCode,409);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id='batch'").get().n,0);
});
