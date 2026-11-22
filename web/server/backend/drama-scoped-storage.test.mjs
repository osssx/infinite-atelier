import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,saveSingleUserCanvas,validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {insertTextVersions,patchDramaShotDraft,readDramaRevisionScope} from "./canvas-text-versions.mjs";
import {readPagedDramaScope} from "./drama-scoped-storage.mjs";
import {buildApp} from "./app.mjs";

const shot=(index,description="Shot "+index)=>({
 id:"shot-"+index,episodeId:index<50?"episode-one":"episode-two",
 sequenceId:index<25?"one":index<50?"two":index<75?"three":"four",
 order:index,description,characterVariantIds:[],propIds:[],keyPropIds:[],
});
const stories=Array.from({length:100},(_,index)=>shot(index,"Description "+index+" ".repeat(1000)));
const assets=Array.from({length:50},(_,index)=>({id:"prop-"+index,kind:"prop",
 name:"Prop "+index,description:"Description "+index,sourceRefs:[]}));
const episodes=[{id:"episode-one",title:"One",synopsis:"A",ending:"Done",events:[],sourceRefs:[],
  sequences:[{id:"one",title:"森林初遇"},{id:"two",title:"河边约定"}]},
 {id:"episode-two",title:"Two",synopsis:"B",ending:"Done",events:[],sourceRefs:[],
  sequences:[{id:"three",title:"寻找灯塔"},{id:"four",title:"风暴夜"}]}];
const node=(id,type,metadata)=>({id,type,metadata});
const projectDocument=()=>({title:"Paged scenes",nodes:[
 node("assets","drama:assets",{dramaDraft:JSON.stringify({assets}),dramaConfirmed:JSON.stringify({assets})}),
 node("episodes","drama:episodes",{dramaDraft:JSON.stringify({episodes}),dramaConfirmed:JSON.stringify({episodes})}),
 node("board","drama:storyboard",{dramaDraft:JSON.stringify({shots:stories}),
  dramaConfirmed:JSON.stringify({shots:stories}),dramaConfirmedVersionId:"published-old"}),
 ...Array.from({length:197},(_,index)=>node("text-"+index,"text",{content:"ordinary graph node"})),
],connections:[{id:"link-assets",fromNodeId:"assets",toNodeId:"board"},
 {id:"link-episodes",fromNodeId:"episodes",toNodeId:"board"}]});
function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"large",document:projectDocument()});
 const immutable=stories.map((value,index)=>index===75?{...value,description:"Historical 75"}:value);
 insertTextVersions(db,"large",[{nodeId:"board",id:"published-old",createdAt:"2026-11-22T00:00:00Z",
  source:"confirmation",content:JSON.stringify({shots:immutable})}]);
 return db;
}
test("P3.3 200 nodes / 100 shots / 50 assets: SQLite filters one episode+sequence without hydrating whole graph",t=>{
 const db=fixture(t),stored=getProject(db,"large",{compact:true});
 assert.equal(stored.document.nodes.length,200);
 assert.equal(stored.document.nodes[2].metadata.dramaDraft,undefined);
 assert.equal(stored.document.nodes[2].metadata.creativePayloadRef.nodeId,"board");
 const page=readDramaRevisionScope(db,"large","board",{draft:true,episodeId:"episode-two",sequenceId:"four",
  offset:5,limit:5});
 assert.equal(page.total,25);
 assert.deepEqual(page.entries.map(item=>item.id),["shot-80","shot-81","shot-82","shot-83","shot-84"]);
 assert.equal(page.entryDigests.length,5);
 assert.equal(page.referenceChoices.length,50);
 assert.ok(Buffer.byteLength(JSON.stringify(page))<Buffer.byteLength(JSON.stringify({shots:stories}))/10);
 const summary=readDramaRevisionScope(db,"large","board",{draft:true,summaryOnly:true});
 assert.equal(summary.total,100);
 assert.equal(summary.entries.length,0);
 assert.equal(summary.referenceChoices.length,0);
 assert.deepEqual(summary.groups.map(item=>[item.episodeId,item.total,item.sequenceIds]),
  [["episode-one",50,["one","two"]],["episode-two",50,["three","four"]]]);
 assert.deepEqual(summary.groups.map(group=>group.sequenceTitles),
  [{one:"森林初遇",two:"河边约定"},{three:"寻找灯塔",four:"风暴夜"}]);
 const confirmed=readDramaRevisionScope(db,"large","board",{summaryOnly:true});
 assert.equal(confirmed.groups[1].sequenceTitles.four,"风暴夜");
 const historic=readPagedDramaScope(db,"large","board",{versionId:"published-old",summaryOnly:true});
 assert.equal(historic.groups[0].sequenceTitles.one,"森林初遇");
});
test("P3.3 confirmed, frozen history and draft remain distinct; editing a page preserves all other shots",t=>{
 const db=fixture(t);
 const confirmed=readDramaRevisionScope(db,"large","board",{episodeId:"episode-two",sequenceId:"four",
  offset:0,limit:1});
 assert.equal(confirmed.versionId,"published-old");
 assert.equal(confirmed.entries[0].description,"Historical 75");
 const draft=readDramaRevisionScope(db,"large","board",{draft:true,episodeId:"episode-two",sequenceId:"four",
  offset:0,limit:1});
 assert.notEqual(draft.entries[0].description,confirmed.entries[0].description);
 const command={operationId:"fix-75",shotId:draft.entries[0].id,expectedDigest:draft.entryDigests[0].digest,
  changes:{description:"Manual episode two update"}};
 patchDramaShotDraft(db,"large","board",command,validateProjectDocument,emitProjectEvent);
 const again=readDramaRevisionScope(db,"large","board",{draft:true,episodeId:"episode-two",sequenceId:"four",
  offset:0,limit:1});
 assert.equal(again.entries[0].description,"Manual episode two update");
 assert.equal(readDramaRevisionScope(db,"large","board",{episodeId:"episode-two",sequenceId:"four",
  offset:0,limit:1}).entries[0].description,"Historical 75");
 assert.equal(readDramaRevisionScope(db,"large","board",{draft:true,episodeId:"episode-one",
  offset:0,limit:1}).entries[0].description,stories[0].description);
 assert.throws(()=>patchDramaShotDraft(db,"large","board",{...command,operationId:"stale-75"},
  validateProjectDocument,emitProjectEvent),/drama_candidate_conflict/);
});
test("P3.3 scoped paging for assets and episodes uses separate payloads without opening full creative editor",t=>{
 const db=fixture(t);
 const assetPage=readPagedDramaScope(db,"large","assets",{draft:true,offset:45,limit:4});
 assert.equal(assetPage.total,50);
 assert.deepEqual(assetPage.entries.map(asset=>asset.id),["prop-45","prop-46","prop-47","prop-48"]);
 const episodePage=readPagedDramaScope(db,"large","episodes",{draft:true,episodeId:"episode-two",limit:2});
 assert.equal(episodePage.total,1);
 assert.equal(episodePage.entries[0].id,"episode-two");
 assert.equal(readDramaRevisionScope(db,"large","episodes",{draft:true,summaryOnly:true}).total,2);
 assert.equal(readPagedDramaScope(db,"large","board",{draft:true,episodeId:"missing"}).total,0);
 assert.throws(()=>readDramaRevisionScope(db,"large","board",{versionId:"missing"}),/text_version_not_found/);
});
test("P3.3 legacy inline fields, fenced JSON, invalid pointers and cross-page duplicate IDs",t=>{
 const db=fixture(t);
 db.exec("DROP TRIGGER creative_payload_update");
 const raw=getProject(db,"large",{compact:true}).document;
 const board=raw.nodes.find(item=>item.id==="board");
 delete board.metadata.creativePayloadRef;
 board.metadata.dramaDraft="```json\n"+JSON.stringify({shots:stories})+"\n```";
 db.prepare("UPDATE projects SET document_json=? WHERE id='large'").run(JSON.stringify(raw));
 assert.equal(readDramaRevisionScope(db,"large","board",{draft:true,episodeId:"episode-one",limit:1}).entries[0].id,
  "shot-0");
 board.metadata.creativePayloadRef={nodeId:"different",schemaVersion:1};
 db.prepare("UPDATE projects SET document_json=? WHERE id='large'").run(JSON.stringify(raw));
 assert.throws(()=>readDramaRevisionScope(db,"large","board",{draft:true}),/creative_payload_reference_invalid/);
 board.metadata.creativePayloadRef={nodeId:"board",schemaVersion:1};
 db.prepare("UPDATE projects SET document_json=? WHERE id='large'").run(JSON.stringify(raw));
 assert.equal(readDramaRevisionScope(db,"large","board",{draft:true,limit:1}).entries[0].id,"shot-0");
 db.prepare("UPDATE creative_node_payloads SET payload_json=? WHERE project_id='large' AND node_id='board'")
 .run(JSON.stringify({dramaDraft:JSON.stringify({shots:[...stories,{...shot(99),description:"duplicate"}]})}));
 assert.throws(()=>readDramaRevisionScope(db,"large","board",{draft:true,limit:1}),/drama_draft_invalid/);
});

test("P3.3b: indexed draft and confirmation entries are populated transactionally with compact graph unchanged",t=>{
 const db=fixture(t);
 const state=db.prepare("SELECT node_id,stage,kind,entry_count,unique_count FROM creative_scope_index_state "+
  "WHERE project_id='large' ORDER BY node_id,stage").all();
 assert.equal(state.length,6);
 assert.deepEqual({...state.find(row=>row.node_id==="board"&&row.stage==="draft")},
  {node_id:"board",stage:"draft",kind:"shots",entry_count:100,unique_count:100});
 assert.deepEqual({...state.find(row=>row.node_id==="assets"&&row.stage==="confirmed")},
  {node_id:"assets",stage:"confirmed",kind:"assets",entry_count:50,unique_count:50});
 const stored=getProject(db,"large",{compact:true});
 assert.ok(stored.document.nodes.find(item=>item.id==="board").metadata.creativePayloadRef);
 assert.equal(stored.document.nodes.find(item=>item.id==="board").metadata.dramaDraft,undefined);
 const plan=db.prepare("EXPLAIN QUERY PLAN SELECT entry_json FROM creative_scope_entry_index "+
  "WHERE project_id=? AND node_id=? AND stage=? AND kind=? AND episode_id=? AND sequence_id=? "+
  "ORDER BY ordinal LIMIT 10").all("large","board","draft","shots","episode-two","four");
 assert.ok(plan.some(row=>row.detail.includes("creative_scope_entries_by_episode")),JSON.stringify(plan));
 const indexed=readDramaRevisionScope(db,"large","board",{draft:true,episodeId:"episode-two",sequenceId:"four",limit:2});
 assert.deepEqual(indexed.entries.map(item=>item.id),["shot-75","shot-76"]);
 assert.equal(indexed.entryDigests.length,2);
});
test("P3.3b: draft edit, confirmed revision, deletion and rollback atomically update index rows",t=>{
 const db=fixture(t);
 const draft=readDramaRevisionScope(db,"large","board",{draft:true,episodeId:"episode-two",sequenceId:"four",limit:1});
 patchDramaShotDraft(db,"large","board",{shotId:"shot-75",operationId:"index-edit",
  expectedDigest:draft.entryDigests[0].digest,changes:{description:"Changed indexed shot"}},
  validateProjectDocument,emitProjectEvent);
 const row=db.prepare("SELECT entry_json FROM creative_scope_entry_index WHERE "+
  "project_id=? AND node_id=? AND stage='draft' AND entry_id='shot-75'").get("large","board");
 assert.equal(JSON.parse(row.entry_json).description,"Changed indexed shot");
 const old=db.prepare("SELECT entry_json FROM creative_scope_entry_index WHERE "+
  "project_id=? AND node_id=? AND stage='confirmed' AND entry_id='shot-75'").get("large","board");
 assert.equal(JSON.parse(old.entry_json).description,stories[75].description);
 db.exec("BEGIN");
 try{
  const payload=db.prepare("SELECT payload_json FROM creative_node_payloads WHERE project_id='large' AND node_id='board'").get().payload_json;
  const parsed=JSON.parse(payload);parsed.dramaDraft=JSON.stringify({shots:[shot(900,"Temporary")]});
  db.prepare("UPDATE creative_node_payloads SET payload_json=? WHERE project_id='large' AND node_id='board'")
   .run(JSON.stringify(parsed));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM creative_scope_entry_index WHERE "+
   "project_id='large' AND node_id='board' AND stage='draft'").get().n,1);
 }finally{db.exec("ROLLBACK")}
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM creative_scope_entry_index WHERE "+
  "project_id='large' AND node_id='board' AND stage='draft'").get().n,100);
 assert.equal(readDramaRevisionScope(db,"large","board",{draft:true,episodeId:"episode-two",limit:1}).total,50);
 const next=getProject(db,"large"),filtered={...next.document,
  nodes:next.document.nodes.filter(item=>item.id!=="board"),
  connections:next.document.connections.filter(item=>item.toNodeId!=="board")};
 saveSingleUserCanvas(db,{id:"large",expectedRevision:next.revision,document:filtered});
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM creative_scope_entry_index WHERE "+
  "project_id='large' AND node_id='board'").get().n,0);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM creative_scope_index_state WHERE "+
  "project_id='large' AND node_id='board'").get().n,0);
});
test("P3.3b: invalid drafts and duplicate IDs fail closed but do not prevent saving user edits",t=>{
 const db=fixture(t);
 const update=draft=>{
  const payload=JSON.parse(db.prepare("SELECT payload_json FROM creative_node_payloads WHERE "+
   "project_id='large' AND node_id='board'").get().payload_json);
  payload.dramaDraft=draft;
  db.prepare("UPDATE creative_node_payloads SET payload_json=? WHERE project_id='large' AND node_id='board'")
   .run(JSON.stringify(payload));
 };
 update("{ unfinished json");
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM creative_scope_index_state WHERE "+
  "project_id='large' AND node_id='board' AND stage='draft'").get().n,0);
 assert.throws(()=>readDramaRevisionScope(db,"large","board",{draft:true,limit:2}),/drama_draft_invalid/);
  // Incomplete editor state is still saveable; it cannot be treated as valid shots.
  update(JSON.stringify({shots:["rough draft",null,42]}));
  assert.deepEqual({...db.prepare("SELECT entry_count,unique_count FROM creative_scope_index_state WHERE "+
   "project_id='large' AND node_id='board' AND stage='draft'").get()},{entry_count:3,unique_count:0});
  assert.throws(()=>readDramaRevisionScope(db,"large","board",{draft:true,limit:1}),/drama_draft_invalid/);
 update(JSON.stringify({shots:[{...stories[0]}, {...stories[1],id:stories[0].id}]}));
 assert.deepEqual({...db.prepare("SELECT entry_count,unique_count FROM creative_scope_index_state WHERE "+
  "project_id='large' AND node_id='board' AND stage='draft'").get()},{entry_count:2,unique_count:1});
 assert.throws(()=>readDramaRevisionScope(db,"large","board",{draft:true,limit:1}),/drama_draft_invalid/);
 update(JSON.stringify({shots:[shot(0,"Recovered")]}));
 assert.equal(readDramaRevisionScope(db,"large","board",{draft:true,limit:1}).entries[0].description,"Recovered");
});
test("P3.3b: schema 41 to current backfills entry index without altering the project revision or original payloads",t=>{
 const db=fixture(t);
 const before=getProject(db,"large"),payload=db.prepare("SELECT payload_json FROM creative_node_payloads "+
  "WHERE project_id='large' AND node_id='board'").get().payload_json;
 db.exec("DROP TRIGGER creative_scope_payload_insert;DROP TRIGGER creative_scope_payload_update;"+
  "DROP TABLE creative_scope_entry_index;DROP TABLE creative_scope_index_state;"+
  "DROP TRIGGER creative_scope_history_insert;DROP TRIGGER creative_scope_history_update;"+
  "DROP TABLE creative_scope_history_entries;DROP TABLE creative_scope_history_state;"+
  "UPDATE schema_migrations SET version=41 WHERE version=(SELECT MAX(version) FROM schema_migrations)");
 initializeSchema(db);
 const after=getProject(db,"large");
 assert.equal(after.revision,before.revision);
 assert.deepEqual(after.document,before.document);
 assert.equal(db.prepare("SELECT payload_json FROM creative_node_payloads WHERE project_id='large' AND node_id='board'")
  .get().payload_json,payload);
 assert.equal(db.prepare("SELECT entry_count FROM creative_scope_index_state WHERE "+
  "project_id='large' AND node_id='board' AND stage='draft'").get().entry_count,100);
 assert.equal(db.prepare("SELECT entry_count FROM creative_scope_history_state WHERE "+
  "project_id='large' AND node_id='board' AND version_id='published-old'").get().entry_count,100);
 initializeSchema(db);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM creative_scope_entry_index WHERE "+
  "project_id='large' AND node_id='board' AND stage='draft'").get().n,100);
});
test("P3.3b: seek one entry by stable ID across draft, asset, episode and immutable history",t=>{
 const db=fixture(t);
 const shotPage=readDramaRevisionScope(db,"large","board",{
  draft:true,entryId:"shot-80",episodeId:"episode-two",sequenceId:"four",limit:5});
 assert.equal(shotPage.total,1);
 assert.deepEqual(shotPage.entries.map(item=>item.id),["shot-80"]);
 assert.equal(shotPage.entryDigests.length,1);
 const mismatch=readDramaRevisionScope(db,"large","board",{
  draft:true,entryId:"shot-80",episodeId:"episode-one",limit:5});
 assert.equal(mismatch.total,0);
 const asset=readDramaRevisionScope(db,"large","assets",{draft:true,entryId:"prop-49"});
 assert.equal(asset.total,1);assert.equal(asset.entries[0].id,"prop-49");
 const episode=readDramaRevisionScope(db,"large","episodes",{draft:true,entryId:"episode-two"});
 assert.equal(episode.total,1);assert.equal(episode.entries[0].id,"episode-two");
 const frozen=readDramaRevisionScope(db,"large","board",{entryId:"shot-75",limit:2});
 assert.equal(frozen.versionId,"published-old");
 assert.equal(frozen.total,1);
 assert.equal(frozen.entries[0].description,"Historical 75");
});
test("P3.3b: confirmation versions indexed but manual backups remain on-demand and cascade on deletion",t=>{
 const db=fixture(t);
 assert.deepEqual({...db.prepare("SELECT entry_count,unique_count FROM creative_scope_history_state WHERE "+
  "project_id='large' AND node_id='board' AND version_id='published-old' AND kind='shots'").get()},
  {entry_count:100,unique_count:100});
 const plan=db.prepare("EXPLAIN QUERY PLAN SELECT entry_json FROM creative_scope_history_entries WHERE "+
  "project_id=? AND node_id=? AND version_id=? AND kind=? AND episode_id=? AND sequence_id=? "+
  "ORDER BY ordinal LIMIT 10").all("large","board","published-old","shots","episode-two","four");
 assert.ok(plan.some(row=>row.detail.includes("creative_scope_history_by_episode")),JSON.stringify(plan));
 insertTextVersions(db,"large",[{nodeId:"board",id:"manual-backup",createdAt:"2026-11-22T10:00:00Z",
  source:"manual",content:JSON.stringify({shots:stories})}]);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM creative_scope_history_entries WHERE "+
  "project_id='large' AND node_id='board' AND version_id='manual-backup'").get().n,0);
 const fallback=readDramaRevisionScope(db,"large","board",{versionId:"manual-backup",entryId:"shot-75"});
 assert.equal(fallback.total,1);
 assert.equal(fallback.entries[0].description,stories[75].description);
 db.prepare("DELETE FROM canvas_text_versions WHERE project_id='large' AND node_id='board' AND id='published-old'").run();
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM creative_scope_history_entries WHERE "+
  "project_id='large' AND node_id='board' AND version_id='published-old'").get().n,0);
});
test("P3.3 scoped HTTP is authorized and returns only requested slice, not a whole stored script",async t=>{
 const db=fixture(t);
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner"});
 t.after(async()=>app.close());
 const path="/api/v1/projects/large/drama-pipeline/revision-scope?nodeId=board&draft=true&episodeId=episode-one&sequenceId=two&offset=5&limit=2";
 const denied=await app.inject({method:"GET",url:path});
 assert.equal(denied.statusCode,401);
 const allowed=await app.inject({method:"GET",url:path,headers:{"x-test-owner":"owner"}});
 assert.equal(allowed.statusCode,200,allowed.body);
 assert.deepEqual(allowed.json().entries.map(item=>item.id),["shot-30","shot-31"]);
 assert.ok(allowed.body.length<25000);
 const byId=await app.inject({method:"GET",url:
  "/api/v1/projects/large/drama-pipeline/revision-scope?nodeId=board&draft=true&entryId=shot-30",
  headers:{"x-test-owner":"owner"}});
 assert.equal(byId.statusCode,200,byId.body);
 assert.equal(byId.json().total,1);
 assert.deepEqual(byId.json().entries.map(item=>item.id),["shot-30"]);
});
