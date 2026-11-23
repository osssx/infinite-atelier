import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {Readable} from "node:stream";
import {createBlobStore} from "./blob-store.mjs";
import {createProjectArchive} from "./project-archive.mjs";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,validateProjectDocument,emitProjectEvent,saveSingleUserCanvas} from "./projects.mjs";
import {readCreativePayload} from "./creative-payloads.mjs";
import {insertTextVersions,patchDramaShotDraft,readDramaRevisionScope} from "./canvas-text-versions.mjs";
import {buildApp} from "./app.mjs";

const asset=(id,kind,variants=[])=>({id,kind,name:id,description:id,sourceRefs:[],
 variants:variants.map(v=>({id:v,name:v,description:v}))});
const shots=Array.from({length:100},(_,i)=>({id:"shot-"+i,
 episodeId:i<50?"episode-one":"episode-two",order:i,
 description:"Original frame "+i+" ".repeat(350),
 characterVariantIds:[],propIds:[],keyPropIds:[],
 sequenceId:i<50?"seq-one":"seq-two"}));
const assetBody=JSON.stringify({assets:[
 asset("hero","character",["hero-day"]),asset("room","scene",["room-day"]),asset("lamp","prop"),
]});
const episodeBody=JSON.stringify({episodes:[
 {id:"episode-one",title:"Episode one",synopsis:"A",ending:"A",events:[],sourceRefs:[],
  sequences:[{id:"seq-one",title:"Opening"}]},
 {id:"episode-two",title:"Episode two",synopsis:"B",ending:"B",events:[],sourceRefs:[],
  sequences:[{id:"seq-two",title:"Ending"}]},
]});
const oldBody=JSON.stringify({shots:shots.map((shot,i)=>i===75?
 {...shot,description:"Frozen media reference frame"}:shot)});
const shotBody=JSON.stringify({shots});
const graph=()=>({title:"CAS editing 200-node project",nodes:[
 {id:"assets",type:"drama:assets",metadata:{dramaConfirmed:assetBody,dramaDraft:assetBody}},
 {id:"episodes",type:"drama:episodes",metadata:{dramaConfirmed:episodeBody,dramaDraft:episodeBody}},
 {id:"board",type:"drama:storyboard",metadata:{
  dramaDraft:shotBody,dramaConfirmed:shotBody,dramaConfirmedVersionId:"confirmed-2026"}},
 {id:"video-config",type:"config",metadata:{generationMode:"video",
  dramaVideoSource:{nodeId:"board",revisionId:"confirmed-2026",shotId:"shot-75",
   prompt:"Manual video prompt",referenceKeys:[]}}},
 ...Array.from({length:196},(_,i)=>({id:"text-"+i,type:"text",metadata:{content:"User canvas note"}})),
],connections:[{id:"a-board",fromNodeId:"assets",toNodeId:"board"},
 {id:"e-board",fromNodeId:"episodes",toNodeId:"board"},
 {id:"board-video",fromNodeId:"board",toNodeId:"video-config"}]});
const digestFor=(db,id)=>readDramaRevisionScope(db,"cas","board",{
 draft:true,entryId:id,limit:1}).entryDigests[0].digest;
const revision=db=>getProject(db,"cas",{compact:true}).revision;
const payload=db=>readCreativePayload(db,"cas","board");
const createFixture=t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"cas",document:graph()});
 insertTextVersions(db,"cas",[{nodeId:"board",id:"confirmed-2026",
  source:"confirmation",createdAt:"2026-11-22T00:00:00Z",content:oldBody}]);
 return db;
};
const apply=(db,shotId,op,changes,expectedDigest=digestFor(db,shotId),
 validate=validateProjectDocument,emit=emitProjectEvent)=>{
 patchDramaShotDraft(db,"cas","board",{operationId:op,shotId,expectedDigest,changes},validate,emit);
};

test("P3.3c SQL CAS edits one authoritative JSON shot; compact graph, independent shots and frozen media survive",t=>{
 const db=createFixture(t);
 const beforeGraph=db.prepare("SELECT document_json FROM projects WHERE id='cas'").get().document_json;
 const configBefore=getProject(db,"cas").document.nodes.find(n=>n.id==="video-config");
 let compactValidated=false;
 apply(db,"shot-75","cas-first",{description:"Edited only selected frame"},undefined,doc=>{
  compactValidated=true;
  assert.equal(doc.nodes.find(n=>n.id==="board").metadata.dramaDraft,undefined);
  assert.equal(doc.nodes.length,200);
  return validateProjectDocument(doc);
 });
 assert.equal(compactValidated,true,"the fast path must validate the compact graph, not hydrate 100 shots in JS");
 assert.equal(db.prepare("SELECT document_json FROM projects WHERE id='cas'").get().document_json,beforeGraph);
 assert.equal(revision(db),2);
 assert.equal(payload(db).revision,2);
 const restored=getProject(db,"cas").document;
 const node=restored.nodes.find(n=>n.id==="board");
 assert.equal(typeof node.metadata.dramaDraft,"string","SQLite json_set must retain the existing string schema");
 const parsed=JSON.parse(node.metadata.dramaDraft).shots;
 assert.equal(parsed[75].description,"Edited only selected frame");
 assert.deepEqual(parsed.filter((_,i)=>i!==75),shots.filter((_,i)=>i!==75));
 assert.equal(restored.nodes.find(n=>n.id==="video-config").metadata.dramaVideoSource.prompt,
  configBefore.metadata.dramaVideoSource.prompt);
 assert.deepEqual(restored.nodes.find(n=>n.id==="video-config"),configBefore);
 assert.equal(readDramaRevisionScope(db,"cas","board",{entryId:"shot-75"}).entries[0].description,
  "Frozen media reference frame");
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM creative_scope_entry_index WHERE "+
  "project_id='cas' AND node_id='board' AND stage='draft'").get().n,100);
 const receipt=db.prepare("SELECT graph_revision FROM canvas_text_version_operations WHERE "+
  "project_id='cas' AND node_id='board' AND id='cas-first'").get();
 assert.equal(receipt.graph_revision,2);
 const summary=readDramaRevisionScope(db,"cas","board",{draft:true,summaryOnly:true});
 assert.equal(summary.total,100);
});

test("P3.3c CAS is per shot: disjoint edits survive; stale digest fails; operation receipt is idempotent",t=>{
 const db=createFixture(t);
 const oldA=digestFor(db,"shot-20"),oldB=digestFor(db,"shot-75");
 const changes={description:"Modified A"};
 apply(db,"shot-20","edit-a",changes,oldA);
 const afterA=revision(db);
 apply(db,"shot-20","edit-a",changes,oldA);
 assert.equal(revision(db),afterA);
 assert.throws(()=>apply(db,"shot-20","edit-a",{description:"conflicting replay"},oldA),
  /text_version_operation_conflict/);
 assert.throws(()=>apply(db,"shot-20","stale-a",{description:"stale edit"},oldA),
  /drama_candidate_conflict/);
 assert.equal(revision(db),afterA);
 apply(db,"shot-75","edit-b",{camera:"Slow pan"},oldB);
 assert.equal(revision(db),afterA+1);
 assert.equal(readDramaRevisionScope(db,"cas","board",{draft:true,entryId:"shot-20"}).entries[0].description,
  "Modified A");
 assert.equal(readDramaRevisionScope(db,"cas","board",{draft:true,entryId:"shot-75"}).entries[0].camera,
  "Slow pan");
});


test("P3 field editor clears optional shot fields atomically with nullable CAS",t=>{
 const db=createFixture(t);
 const oldConfig=getProject(db,"cas").document.nodes.find(node=>node.id==="video-config");
 apply(db,"shot-75","optional-values",{camera:"Pan",shotSize:"近景",action:"走动",dialogue:"你好"});
 apply(db,"shot-75","clear-optional-values",{
  camera:null,shotSize:null,action:null,dialogue:null,sequenceId:null
 });
 const result=readDramaRevisionScope(db,"cas","board",{draft:true,entryId:"shot-75"}).entries[0];
 for(const key of ["camera","shotSize","action","dialogue","sequenceId"])
  assert.equal(Object.hasOwn(result,key),false,key+" should be absent after nullable CAS");
 assert.deepEqual(getProject(db,"cas").document.nodes.find(node=>node.id==="video-config"),oldConfig);
 assert.equal(revision(db),3);
});
test("P3.3c validates only linked reference parents and rejects foreign/invalid assets without side effects",t=>{
 const db=createFixture(t);
 const revisionBefore=revision(db);
 assert.throws(()=>apply(db,"shot-75","invalid-actor",{characterVariantIds:["unknown"]}),
  /drama_draft_invalid/);
 assert.throws(()=>apply(db,"shot-75","invalid-scene",{sceneId:"wrong-scene",sceneVariantId:"room-day"}),
  /drama_draft_invalid/);
 assert.throws(()=>apply(db,"shot-75","invalid-episode",{id:"invented"}),
  /drama_draft_invalid/);
 assert.throws(()=>apply(db,"shot-75","invalid-keys",{keyPropIds:["not-on-shot"]}),
  /drama_draft_invalid/);
 assert.equal(revision(db),revisionBefore);
 const changes={characterVariantIds:["hero-day"],sceneId:"room",sceneVariantId:"room-day",
  propIds:["lamp"],keyPropIds:["lamp"],durationSec:8};
 apply(db,"shot-75","valid-refs",changes);
 const updated=readDramaRevisionScope(db,"cas","board",{draft:true,entryId:"shot-75"}).entries[0];
 for(const [key,value] of Object.entries(changes))assert.deepEqual(updated[key],value);
 assert.equal(revision(db),revisionBefore+1);
});

test("P3.3c errors roll back the payload, index, project revision, receipt and project event together",t=>{
 const db=createFixture(t),before=payload(db).payload;
 const count=()=>db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id='cas'").get().n;
 const n=count();
 assert.throws(()=>apply(db,"shot-75","rollback-test",{description:"Not persisted"},
  undefined,validateProjectDocument,()=>{throw Error("event_failed")}),/event_failed/);
 assert.equal(revision(db),1);
 assert.deepEqual(payload(db).payload,before);
 assert.equal(readDramaRevisionScope(db,"cas","board",{draft:true,entryId:"shot-75"}).entries[0].description,
  shots[75].description);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canvas_text_version_operations WHERE "+
  "project_id='cas' AND id='rollback-test'").get().n,0);
 assert.equal(count(),n);
 apply(db,"shot-75","rollback-test",{description:"Not persisted"});
 assert.equal(revision(db),2);
});

test("P3.3c compact-graph autosave after CAS keeps new authoritative draft; fallback accepts legacy fenced inline",t=>{
 const db=createFixture(t);
 apply(db,"shot-75","before-autosave",{description:"Edited via CAS"});
 const compact=getProject(db,"cas",{compact:true});
 compact.document.nodes.find(n=>n.id==="board").position={x:33,y:44};
 saveSingleUserCanvas(db,{id:"cas",expectedRevision:compact.revision,document:compact.document});
 assert.equal(getProject(db,"cas").document.nodes.find(n=>n.id==="board").metadata.dramaDraft.includes("Edited via CAS"),true);
 // Simulate a pre-pointer legacy import without touching the user's production store.
 db.exec("DROP TRIGGER creative_payload_update");
 const raw=getProject(db,"cas",{compact:true}).document;
 const board=raw.nodes.find(n=>n.id==="board");
 delete board.metadata.creativePayloadRef;
 board.metadata.dramaDraft="\`\`\`json\n"+shotBody+"\n\`\`\`";
 db.prepare("UPDATE projects SET document_json=? WHERE id='cas'").run(JSON.stringify(raw));
 let usedLegacy=false;
 apply(db,"shot-75","legacy-edit",{description:"Legacy path restored"},undefined,doc=>{
  usedLegacy=Boolean(doc.nodes.find(n=>n.id==="board").metadata.dramaDraft);
  return validateProjectDocument(doc);
 });
 assert.equal(usedLegacy,true);
 assert.equal(readDramaRevisionScope(db,"cas","board",{draft:true,entryId:"shot-75"}).entries[0].description,
  "Legacy path restored");
});

test("P3.3c rejects invalid unselected shots even if the target's indexed entry looks valid",t=>{
 const db=createFixture(t);
 const original=payload(db).payload;
 const changed=JSON.parse(original.dramaDraft);
 changed.shots[92].characterVariantIds=null; // Another page is invalid.
 const update={...original,dramaDraft:JSON.stringify(changed)};
 db.prepare("UPDATE creative_node_payloads SET payload_json=? WHERE project_id='cas' AND node_id='board'")
  .run(JSON.stringify(update));
 const oldDigest=digestFor(db,"shot-75");
 assert.throws(()=>apply(db,"shot-75","reject-other-page",{description:"Should not be applied"},oldDigest),
  /drama_(draft_invalid|candidate_conflict)/);
 assert.equal(revision(db),1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canvas_text_version_operations WHERE "+
  "project_id='cas' AND id='reject-other-page'").get().n,0);
});

test("P3.3c promotes confirmed JSON to a new draft only when draft is absent, retaining confirmed text",t=>{
 const db=createFixture(t),original=payload(db).payload;
 db.prepare("UPDATE creative_node_payloads SET payload_json=? WHERE project_id='cas' AND node_id='board'")
  .run(JSON.stringify({...original,dramaDraft:null}));
 const digest=digestFor(db,"shot-75");
 apply(db,"shot-75","confirm-to-draft",{description:"Promoted to editable draft"},digest);
 const after=payload(db).payload;
 assert.equal(typeof after.dramaDraft,"string");
 assert.equal(JSON.parse(after.dramaDraft).shots[75].description,"Promoted to editable draft");
 assert.equal(after.dramaConfirmed,original.dramaConfirmed);
 assert.equal(readDramaRevisionScope(db,"cas","board",{entryId:"shot-75"}).entries[0].description,
  "Frozen media reference frame");
});

test("P3.3c CAS receipt, indexes and creative payload survive SQLite restart and replay",t=>{
 const dir=mkdtempSync(path.join(tmpdir(),"atelier-cas-restart-"));
 const location=path.join(dir,"canvas.sqlite");
 let db=new DatabaseSync(location);
 t.after(()=>{try{db.close();}finally{rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80});}});
 initializeSchema(db);
 createProject(db,{id:"cas",document:graph()});
 const originalDigest=digestFor(db,"shot-75");
 apply(db,"shot-75","restart-cas",{description:"Persisted after restart"},originalDigest);
 db.close();
 db=new DatabaseSync(location);
 initializeSchema(db);
 assert.equal(revision(db),2);
 assert.equal(digestFor(db,"shot-75")!==originalDigest,true);
 assert.equal(getProject(db,"cas").document.nodes.find(n=>n.id==="board").metadata.dramaDraft.includes("Persisted after restart"),true);
 apply(db,"shot-75","restart-cas",{description:"Persisted after restart"},originalDigest);
 assert.equal(revision(db),2);
 assert.throws(()=>apply(db,"shot-75","restart-stale",{description:"Retry with stale source"},originalDigest),
  /drama_candidate_conflict/);
 assert.equal(db.prepare("SELECT entry_count FROM creative_scope_index_state WHERE "+
  "project_id='cas' AND node_id='board' AND stage='draft' AND kind='shots'").get().entry_count,100);
});

test("P3.3c ZIP export/import retains locally edited draft, frozen confirmation and independent video Config",async t=>{
 const db=createFixture(t);
 const dir=mkdtempSync(path.join(tmpdir(),"atelier-cas-zip-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:50}));
 const blobStore=createBlobStore({db,dataDir:dir,maxBlobBytes:100_000_000});
 const archive=createProjectArchive({db,blobStore});
 apply(db,"shot-75","zip-edit",{description:"Exported local edit",camera:"Close-up"});
 const archiveFile=await archive.exportProject("cas");
 const bytes=Buffer.concat(await Array.fromAsync(archiveFile.stream));
 assert.ok(bytes.length>100);
 const imported=await archive.importProject(Readable.from([bytes]));
 const restored=getProject(db,imported.id);
 const board=restored.document.nodes.find(n=>n.id==="board");
 assert.equal(JSON.parse(board.metadata.dramaDraft).shots[75].description,"Exported local edit");
 assert.equal(JSON.parse(board.metadata.dramaConfirmed).shots[75].description,shots[75].description);
 assert.equal(restored.document.nodes.find(n=>n.id==="video-config").metadata.dramaVideoSource.prompt,
  "Manual video prompt");
 assert.equal(db.prepare("SELECT entry_count FROM creative_scope_index_state "+
  "WHERE project_id=? AND node_id='board' AND stage='draft' AND kind='shots'").get(imported.id).entry_count,100);
 const pinned=readDramaRevisionScope(db,imported.id,"board",{entryId:"shot-75"});
 assert.equal(pinned.versionId,"confirmed-2026");
 assert.equal(pinned.entries[0].description,"Frozen media reference frame");
});
test("P3.3c rejects ambiguous inline+pointer content and a receipt for a removed node",t=>{
 const db=createFixture(t);
 const compact=getProject(db,"cas",{compact:true});
 const poisoned=compact.document;
 poisoned.nodes.find(n=>n.id==="board").metadata.dramaDraft=JSON.stringify({shots:[]});
 db.prepare("UPDATE projects SET document_json=? WHERE id='cas'").run(JSON.stringify(poisoned));
 assert.throws(()=>apply(db,"shot-75","inline-conflict",{description:"Never write"}),/creative_payload_reference_invalid/);
 assert.equal(revision(db),1);
 // Repair the simulated legacy import then write and delete the board.
 delete poisoned.nodes.find(n=>n.id==="board").metadata.dramaDraft;
 db.prepare("UPDATE projects SET document_json=? WHERE id='cas'").run(JSON.stringify(poisoned));
 const digest=digestFor(db,"shot-75");
 apply(db,"shot-75","prior-receipt",{description:"Was saved before node deletion"},digest);
 const next=getProject(db,"cas",{compact:true});
 const after={...next.document,nodes:next.document.nodes.filter(n=>n.id!=="board"),
  connections:next.document.connections.filter(edge=>edge.fromNodeId!=="board"&&edge.toNodeId!=="board")};
 saveSingleUserCanvas(db,{id:"cas",expectedRevision:next.revision,document:after});
 assert.throws(()=>apply(db,"shot-75","prior-receipt",{description:"Was saved before node deletion"},digest),
  /text_node_not_found/);
});
test("P3.3c authenticated HTTP returns compact graph, enforces digest, and does not submit video jobs",async t=>{
 const db=createFixture(t);
 const app=buildApp({db,authorize:req=>req.headers["x-owner"]==="yes"});
 t.after(async()=>app.close());
 const route="/api/v1/projects/cas/drama-pipeline/shot-draft";
 const body={nodeId:"board",shotId:"shot-75",operationId:"api-cas",
  expectedDigest:digestFor(db,"shot-75"),changes:{description:"HTTP edit only"}};
 const denied=await app.inject({method:"PATCH",url:route,payload:body});
 assert.equal(denied.statusCode,401);
 const ok=await app.inject({method:"PATCH",url:route,payload:body,headers:{"x-owner":"yes"}});
 assert.equal(ok.statusCode,200,ok.body);
 assert.equal(ok.json().document.nodes.find(n=>n.id==="board").metadata.dramaDraft,undefined);
 assert.equal(getProject(db,"cas").document.nodes.find(n=>n.id==="board").metadata.dramaDraft.includes("HTTP edit only"),true);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id='cas'").get().n,0);
 const repeat=await app.inject({method:"PATCH",url:route,payload:body,headers:{"x-owner":"yes"}});
 assert.equal(repeat.statusCode,200,repeat.body);
 assert.equal(revision(db),2);
 const stale=await app.inject({method:"PATCH",url:route,payload:{...body,operationId:"api-stale"},headers:{"x-owner":"yes"}});
 assert.equal(stale.statusCode,409);
});
