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
const episodes=[{id:"episode-one",title:"One",synopsis:"A",ending:"Done",events:[],sourceRefs:[]},
 {id:"episode-two",title:"Two",synopsis:"B",ending:"Done",events:[],sourceRefs:[]}];
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
});
