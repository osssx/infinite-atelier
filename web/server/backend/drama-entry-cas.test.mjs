import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,emitProjectEvent,validateProjectDocument,saveSingleUserCanvas} from "./projects.mjs";
import {readCreativePayload} from "./creative-payloads.mjs";
import {readDramaRevisionScope,insertTextVersions} from "./canvas-text-versions.mjs";
import {patchDramaEntryDraft} from "./drama-entry-cas.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createProjectArchive} from "./project-archive.mjs";
import {buildApp} from "./app.mjs";

const asset=(id,kind="prop")=>({id,kind,name:"Name "+id,description:"Description "+id,
 sourceRefs:[],...(kind==="character"?{variants:[{id:id+"-day",name:"Day",description:"Day outfit"}]}:{})});
const assets=[asset("hero","character"),...Array.from({length:49},(_,i)=>asset("prop-"+i))];
const episodes=Array.from({length:4},(_,i)=>({id:"ep-"+i,title:"Episode "+i,
 synopsis:"Synopsis "+i,ending:"Ending "+i,
 events:["Event "+i],eventItems:[{id:"event-"+i,text:"Event "+i}],sourceRefs:[],
 sequences:[{id:"seq-"+i+"-a",title:"Scene A",sourceRefs:[],eventRefs:["event-"+i]},
 {id:"seq-"+i+"-b",title:"Scene B",sourceRefs:[],eventRefs:[]}]}));
const shots=Array.from({length:100},(_,i)=>({id:"shot-"+i,episodeId:"ep-"+Math.floor(i/25),
 sequenceId:"seq-"+Math.floor(i/25)+"-a",order:i,description:"Frame "+i,
 characterVariantIds:["hero-day"],propIds:[],keyPropIds:[]}));
const assetJson=JSON.stringify({assets}),episodeJson=JSON.stringify({episodes}),shotJson=JSON.stringify({shots});
const makeGraph=()=>({title:"P3.3d CAS",nodes:[
 {id:"assets",type:"drama:assets",metadata:{dramaDraft:assetJson,dramaConfirmed:assetJson}},
 {id:"episodes",type:"drama:episodes",metadata:{dramaDraft:episodeJson,dramaConfirmed:episodeJson}},
 {id:"board",type:"drama:storyboard",metadata:{dramaDraft:shotJson,dramaConfirmed:shotJson}},
 {id:"config",type:"config",metadata:{dramaVideoSource:{nodeId:"board",revisionId:"frozen-shots",
  shotId:"shot-75",prompt:"Hold the shot",referenceKeys:[]}}},
 ...Array.from({length:196},(_,i)=>({id:"text-"+i,type:"text",metadata:{content:"Notes"}})),
],connections:[{id:"asset-board",fromNodeId:"assets",toNodeId:"board"},
 {id:"episode-board",fromNodeId:"episodes",toNodeId:"board"},
 {id:"board-config",fromNodeId:"board",toNodeId:"config"}]});
function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"entry",document:makeGraph()});
 insertTextVersions(db,"entry",[
 {nodeId:"assets",id:"frozen-assets",source:"confirmation",createdAt:"2026-11-22T00:00:00Z",content:assetJson},
 {nodeId:"episodes",id:"frozen-episodes",source:"confirmation",createdAt:"2026-11-22T00:00:00Z",content:episodeJson},
 {nodeId:"board",id:"frozen-shots",source:"confirmation",createdAt:"2026-11-22T00:00:00Z",content:shotJson},
 ]);
 return db;
}
const scope=(db,nodeId,entryId)=>readDramaRevisionScope(db,"entry",nodeId,{draft:true,entryId,limit:1});
const revision=db=>getProject(db,"entry",{compact:true}).revision;
const edit=(db,kind,entryId,changes,op,options={})=>patchDramaEntryDraft(db,"entry",{
 nodeId:kind,kind,entryId,expectedDigest:scope(db,kind,entryId).entryDigests[0].digest,
 operationId:op,changes,...options,
},validateProjectDocument,emitProjectEvent);
const body=(db,nodeId)=>JSON.parse(readCreativePayload(db,"entry",nodeId).payload.dramaDraft);

test("P3.3d: assets and nested variants update only their own canonical draft entry",t=>{
 const db=setup(t),raw=db.prepare("SELECT document_json FROM projects WHERE id='entry'").get().document_json;
 const version=getProject(db,"entry").document.nodes.find(n=>n.id==="config");
 edit(db,"assets","hero",{name:"The Hero",description:"Main actor"},"asset-name");
 edit(db,"assets","hero",{name:"Raincoat",description:"Night raincoat"},"variant-name",{variantId:"hero-day"});
 const after=body(db,"assets").assets;
 assert.equal(after[0].name,"The Hero");
 assert.equal(after[0].variants[0].name,"Raincoat");
 assert.deepEqual(after.slice(1),assets.slice(1));
 assert.equal(typeof readCreativePayload(db,"entry","assets").payload.dramaDraft,"string");
 assert.equal(db.prepare("SELECT document_json FROM projects WHERE id='entry'").get().document_json,raw);
 assert.deepEqual(getProject(db,"entry").document.nodes.find(n=>n.id==="config"),version);
 assert.deepEqual(readDramaRevisionScope(db,"entry","assets",{versionId:"frozen-assets",entryId:"hero"}).entries[0],assets[0]);
 assert.equal(db.prepare("SELECT entry_count FROM creative_scope_index_state WHERE project_id='entry' "+
  "AND node_id='assets' AND stage='draft' AND kind='assets'").get().entry_count,50);
});
test("P3.3d: episode content and stable sequence title edit preserve event identity and shot links",t=>{
 const db=setup(t);
 const baseline=getProject(db,"entry").document.nodes.find(n=>n.id==="board").metadata.dramaDraft;
 edit(db,"episodes","ep-3",{title:"Episode Four",synopsis:"New plot summary"},"episode-edit");
 edit(db,"episodes","ep-3",{title:"New scene title"},"sequence-edit",{sequenceId:"seq-3-b"});
 const result=body(db,"episodes").episodes;
 assert.equal(result[3].title,"Episode Four");
 assert.equal(result[3].sequences[1].title,"New scene title");
 assert.deepEqual(result[3].eventItems,episodes[3].eventItems);
 assert.deepEqual(result[3].sequences[0],episodes[3].sequences[0]);
 assert.deepEqual(result.slice(0,3),episodes.slice(0,3));
 assert.equal(getProject(db,"entry").document.nodes.find(n=>n.id==="board").metadata.dramaDraft,baseline);
 assert.deepEqual(readDramaRevisionScope(db,"entry","episodes",{versionId:"frozen-episodes",entryId:"ep-3"}).entries[0],episodes[3]);
});
test("P3.3d: independent entries commute while stale same-entry digests and operation replays fail closed",t=>{
 const db=setup(t);
 const digestA=scope(db,"assets","hero").entryDigests[0].digest;
 const digestB=scope(db,"assets","prop-35").entryDigests[0].digest;
 const command={nodeId:"assets",kind:"assets",entryId:"hero",operationId:"idempotent-a",
  expectedDigest:digestA,changes:{description:"First change"}};
 patchDramaEntryDraft(db,"entry",command,validateProjectDocument,emitProjectEvent);
 const rev=revision(db);
 patchDramaEntryDraft(db,"entry",command,validateProjectDocument,emitProjectEvent);
 assert.equal(revision(db),rev);
 assert.throws(()=>patchDramaEntryDraft(db,"entry",{...command,changes:{description:"Different"}},
  validateProjectDocument,emitProjectEvent),/text_version_operation_conflict/);
 assert.throws(()=>patchDramaEntryDraft(db,"entry",{...command,operationId:"stale-a"},
  validateProjectDocument,emitProjectEvent),/drama_candidate_conflict/);
 patchDramaEntryDraft(db,"entry",{...command,operationId:"edit-b",entryId:"prop-35",
  expectedDigest:digestB,changes:{description:"Independent asset"}},validateProjectDocument,emitProjectEvent);
 assert.equal(revision(db),rev+1);
 assert.equal(body(db,"assets").assets[0].description,"First change");
 assert.equal(body(db,"assets").assets.at(-14).description,"Independent asset");
});
test("P3.3d: identity migration, event edits and illegal nested targets are not accepted by metadata CAS",t=>{
 const db=setup(t),rev=revision(db);
 assert.throws(()=>edit(db,"assets","hero",{id:"renamed"},"illegal-id"),/drama_draft_invalid/);
 assert.throws(()=>edit(db,"assets","hero",{kind:"scene"},"illegal-kind"),/drama_draft_invalid/);
 assert.throws(()=>edit(db,"assets","hero",{sourceRefs:["paragraph"]},"illegal-source"),/drama_draft_invalid/);
 assert.throws(()=>edit(db,"episodes","ep-1",{events:["changed"]},"illegal-events"),/drama_draft_invalid/);
 assert.throws(()=>edit(db,"episodes","ep-1",{sequences:[]},"illegal-split"),/drama_draft_invalid/);
 assert.throws(()=>edit(db,"episodes","ep-1",{title:"No"},"bad-seq",{sequenceId:"unknown"}),/drama_entry_target_not_found/);
 assert.throws(()=>edit(db,"assets","hero",{description:"No"},"bad-variant",{variantId:"unknown"}),/drama_entry_target_not_found/);
 assert.equal(revision(db),rev);
});
test("P3.3d: malformed another page or cross-asset duplicate variant ID is not silently rewritten",t=>{
 const db=setup(t),original=readCreativePayload(db,"entry","assets").payload;
 const parsed=JSON.parse(original.dramaDraft);
 parsed.assets[47].sourceRefs=null;
 db.prepare("UPDATE creative_node_payloads SET payload_json=? WHERE project_id='entry' AND node_id='assets'")
  .run(JSON.stringify({...original,dramaDraft:JSON.stringify(parsed)}));
 assert.throws(()=>edit(db,"assets","hero",{name:"Rejected"},"bad-other-page"),/drama_draft_invalid/);
 parsed.assets[47].sourceRefs=[];
 parsed.assets[47].variants=[{id:"hero-day",name:"Duplicate",description:"Duplicate"}];
 db.prepare("UPDATE creative_node_payloads SET payload_json=? WHERE project_id='entry' AND node_id='assets'")
  .run(JSON.stringify({...original,dramaDraft:JSON.stringify(parsed)}));
 assert.throws(()=>edit(db,"assets","hero",{name:"Rejected"},"bad-variant-duplicate"),/drama_draft_invalid/);
 assert.equal(revision(db),1);
});
test("P3.3d: transaction rollback restores payloads, entry indexes, receipts, events and revision",t=>{
 const db=setup(t),before=readCreativePayload(db,"entry","episodes").payload;
 const count=()=>db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id='entry'").get().n;
 const n=count(),command={nodeId:"episodes",kind:"episodes",entryId:"ep-3",operationId:"roll-back",
  expectedDigest:scope(db,"episodes","ep-3").entryDigests[0].digest,changes:{title:"Temporary"}};
 assert.throws(()=>patchDramaEntryDraft(db,"entry",command,validateProjectDocument,
  ()=>{throw Error("event_write_failed")}),/event_write_failed/);
 assert.deepEqual(readCreativePayload(db,"entry","episodes").payload,before);
 assert.equal(revision(db),1);assert.equal(count(),n);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canvas_text_version_operations WHERE "+
  "project_id='entry' AND id='roll-back'").get().n,0);
 patchDramaEntryDraft(db,"entry",command,validateProjectDocument,emitProjectEvent);
 assert.equal(revision(db),2);
});
test("P3.3d: ZIP import and autosave retain local drafts, indexed entries and frozen revisions",async t=>{
 const db=setup(t),dir=mkdtempSync(join(tmpdir(),"atelier-entry-zip-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80}));
 const store=createBlobStore({db,dataDir:dir,maxBlobBytes:100_000_000});
 const archive=createProjectArchive({db,blobStore:store});
 const command={nodeId:"episodes",kind:"episodes",entryId:"ep-3",operationId:"zip-episode",
  expectedDigest:scope(db,"episodes","ep-3").entryDigests[0].digest,changes:{title:"Restored episode"}};
 patchDramaEntryDraft(db,"entry",command,validateProjectDocument,emitProjectEvent);
 edit(db,"assets","prop-48",{description:"Restored prop"},"zip-asset");
 const zipped=Buffer.concat(await Array.fromAsync((await archive.exportProject("entry")).stream));
 const imported=await archive.importProject(Readable.from([zipped]));
 assert.equal(readDramaRevisionScope(db,imported.id,"episodes",{draft:true,entryId:"ep-3"}).entries[0].title,
  "Restored episode");
 assert.equal(readDramaRevisionScope(db,imported.id,"assets",{draft:true,entryId:"prop-48"}).entries[0].description,
  "Restored prop");
 assert.equal(readDramaRevisionScope(db,imported.id,"episodes",{versionId:"frozen-episodes",entryId:"ep-3"}).entries[0].title,
  "Episode 3");
 assert.equal(db.prepare("SELECT entry_count FROM creative_scope_index_state WHERE project_id=? "+
  "AND node_id='assets' AND stage='draft'").get(imported.id).entry_count,50);
 const raw=getProject(db,"entry",{compact:true});
 saveSingleUserCanvas(db,{id:"entry",expectedRevision:raw.revision,document:raw.document});
 assert.equal(body(db,"episodes").episodes[3].title,"Restored episode");
 patchDramaEntryDraft(db,"entry",command,validateProjectDocument,emitProjectEvent);
 assert.equal(body(db,"episodes").episodes[3].title,"Restored episode");
});
test("P3.3d: a SQLite restart preserves CAS receipts and lets different entries advance independently",t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-entry-restart-")),location=join(dir,"project.sqlite");
 let db=new DatabaseSync(location);
 t.after(()=>{try{db.close();}finally{rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80});}});
 initializeSchema(db);
 createProject(db,{id:"entry",document:makeGraph()});
 const command={nodeId:"assets",kind:"assets",entryId:"hero",operationId:"before-restart",
  expectedDigest:scope(db,"assets","hero").entryDigests[0].digest,changes:{name:"Disk hero"}};
 const other=scope(db,"assets","prop-45").entryDigests[0].digest;
 patchDramaEntryDraft(db,"entry",command,validateProjectDocument,emitProjectEvent);
 db.close();
 db=new DatabaseSync(location);
 initializeSchema(db);
 assert.equal(revision(db),2);
 assert.equal(scope(db,"assets","hero").entries[0].name,"Disk hero");
 patchDramaEntryDraft(db,"entry",command,validateProjectDocument,emitProjectEvent);
 assert.equal(revision(db),2,"replay must not bump revision");
 patchDramaEntryDraft(db,"entry",{...command,entryId:"prop-45",expectedDigest:other,
  operationId:"after-restart",changes:{description:"Independent disk prop"}},validateProjectDocument,emitProjectEvent);
 assert.equal(revision(db),3);
 assert.equal(scope(db,"assets","prop-45").entries[0].description,"Independent disk prop");
 assert.throws(()=>patchDramaEntryDraft(db,"entry",{...command,operationId:"stale-after-restart"},
  validateProjectDocument,emitProjectEvent),/drama_candidate_conflict/);
});
test("P3.3d: malformed eventItems or duplicate scene IDs outside the requested episode block writes",t=>{
 const db=setup(t),original=readCreativePayload(db,"entry","episodes").payload;
 const bad=JSON.parse(original.dramaDraft);
 bad.episodes[3].eventItems[0].text="Mismatched event";
 db.prepare("UPDATE creative_node_payloads SET payload_json=? WHERE project_id='entry' AND node_id='episodes'")
  .run(JSON.stringify({...original,dramaDraft:JSON.stringify(bad)}));
 assert.throws(()=>edit(db,"episodes","ep-0",{title:"Blocked"},"bad-event-items"),/drama_draft_invalid/);
 bad.episodes[3].eventItems[0].text="Event 3";
 bad.episodes[3].sequences[1].id=bad.episodes[3].sequences[0].id;
 db.prepare("UPDATE creative_node_payloads SET payload_json=? WHERE project_id='entry' AND node_id='episodes'")
  .run(JSON.stringify({...original,dramaDraft:JSON.stringify(bad)}));
 assert.throws(()=>edit(db,"episodes","ep-0",{title:"Blocked"},"bad-duplicate-sequence"),/drama_draft_invalid/);
 assert.equal(revision(db),1);
});
test("P3.3d: HTTP rejects unauthenticated and stale changes; only compact graph is returned",async t=>{
 const db=setup(t),app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="yes"});
 t.after(async()=>app.close());
 const url="/api/v1/projects/entry/drama-pipeline/entry-draft";
 const request={nodeId:"assets",kind:"assets",entryId:"hero",operationId:"http-asset",
  expectedDigest:scope(db,"assets","hero").entryDigests[0].digest,changes:{name:"HTTP Hero"}};
 const denied=await app.inject({method:"PATCH",url,payload:request});
 assert.equal(denied.statusCode,401);
 const ok=await app.inject({method:"PATCH",url,payload:request,headers:{"x-test-owner":"yes"}});
 assert.equal(ok.statusCode,200,ok.body);
 assert.equal(ok.json().document.nodes.find(n=>n.id==="assets").metadata.dramaDraft,undefined);
 assert.equal(body(db,"assets").assets[0].name,"HTTP Hero");
 const repeat=await app.inject({method:"PATCH",url,payload:request,headers:{"x-test-owner":"yes"}});
 assert.equal(repeat.statusCode,200);
 assert.equal(revision(db),2);
 const stale=await app.inject({method:"PATCH",url,payload:{...request,operationId:"stale"},
  headers:{"x-test-owner":"yes"}});
 assert.equal(stale.statusCode,409);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id='entry'").get().n,0);
});
