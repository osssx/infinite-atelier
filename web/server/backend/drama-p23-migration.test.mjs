import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,saveSingleUserCanvas,validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {mutateTextVersions} from "./canvas-text-versions.mjs";
import {readEpisodeDraft} from "../canvas-text-content.mjs";
import {normalizeEpisodeEvents,reconcileEventItems,unresolvedEventRefs} from "../drama-episode-links.mjs";
import {splitEpisodeSequence,mergeEpisodeSequences} from "../drama-sequence-relations.mjs";
import {previewDramaSequenceMigration,applyDramaSequenceMigration} from "./drama-sequence-migration.mjs";
import {buildApp} from "./app.mjs";
import {dramaDependencies} from "./drama-dependencies.mjs";
import {previewDramaImpact} from "./drama-impact.mjs";

const episode=(id,sequenceIds)=>({id,title:id,synopsis:"Episode",events:["Find star","Bring home"],
 sourceRefs:[],ending:"End",sequences:sequenceIds.map((s,i)=>({id:s,title:s,eventRefs:[i?"Bring home":"Find star"]}))});
const shot=(id,episodeId,sequenceId)=>({id,episodeId,sequenceId,order:1,description:"Shot "+id,
 characterVariantIds:[],propIds:[],keyPropIds:[]});
function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 const first=episode("ep-one",["seq-one"]);
 const second=episode("ep-two",["seq-old","seq-two"]);
 const document={nodes:[
  {id:"story",type:"drama:source",metadata:{dramaDraft:"Find star\nBring home"}},
  {id:"assets",type:"drama:assets",metadata:{dramaDraft:JSON.stringify({assets:[]})}},
  {id:"episodes",type:"drama:episodes",metadata:{dramaDraft:JSON.stringify({episodes:[first,second]})}},
  {id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots:[
   shot("first","ep-one","seq-one"),shot("old","ep-two","seq-old"),shot("other","ep-two","seq-two")]})}},
  {id:"video-old",type:"config",metadata:{dramaShotId:"old",generationMode:"video",prompt:"Manual video",seconds:"8"}},
 ],connections:[["story","assets"],["story","episodes"],["assets","board"],["episodes","board"],
  ["board","video-old"]].map(([fromNodeId,toNodeId],i)=>({id:"edge-"+i,fromNodeId,toNodeId}))};
 createProject(db,{id:"p23",document});
 const get=()=>getProject(db,"p23"),node=(doc,id)=>doc.nodes.find(item=>item.id===id);
 for(const id of ["story","assets","episodes","board"]){
  mutateTextVersions(db,"p23",id,{action:"confirm",operationId:id+"-v1",expectedRevision:get().revision},
   validateProjectDocument,emitProjectEvent);
 }
 const update=(id,fn)=>{
  const current=get(),item=node(current.document,id),value=JSON.parse(item.metadata.dramaDraft);
  fn(value);
  item.metadata.dramaDraft=JSON.stringify(value);
  saveSingleUserCanvas(db,{id:"p23",expectedRevision:current.revision,document:current.document});
 };
 const confirm=(id,operationId)=>mutateTextVersions(db,"p23",id,{
  action:"confirm",operationId,expectedRevision:get().revision,
 },validateProjectDocument,emitProjectEvent);
 const service={db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent};
 return {db,get,node,update,confirm,service};
}
test("P2.3: old event text references acquire stable IDs, rename preserves identity",t=>{
 const {get,node,update,confirm}=fixture(t);
 const episodeBefore=JSON.parse(node(get().document,"episodes").metadata.dramaConfirmed).episodes[1];
 assert.deepEqual(episodeBefore.eventItems.map(item=>item.text),episodeBefore.events);
 assert.equal(episodeBefore.sequences[0].eventRefs[0],episodeBefore.eventItems[0].id);
 assert.equal(episodeBefore.sequences[1].eventRefs[0],episodeBefore.eventItems[1].id);
 const originalIds=episodeBefore.eventItems.map(item=>item.id);
 update("episodes",draft=>{
  const ep=draft.episodes[1];
  ep.events[0]="Find a glowing star";
  // Simulate editing a full legacy JSON document, without updating eventItems.
  delete ep.eventItems;
 });
 confirm("episodes","events-v2");
 const after=JSON.parse(node(get().document,"episodes").metadata.dramaConfirmed).episodes[1];
 assert.deepEqual(after.eventItems.map(item=>item.id),originalIds);
 assert.equal(after.eventItems[0].text,"Find a glowing star");
 assert.equal(after.sequences[0].eventRefs[0],originalIds[0]);
 assert.deepEqual(unresolvedEventRefs(after),[]);
});
test("P2.3: duplicate legacy event texts remain explicit unresolved references",()=>{
 const old={events:["Knock","Knock"],sequences:[{id:"a",title:"A",eventRefs:["Knock"]}]};
 const normalized=normalizeEpisodeEvents(old,old);
 assert.equal(new Set(normalized.eventItems.map(item=>item.id)).size,2);
 assert.deepEqual(unresolvedEventRefs(normalized),[{sequenceId:"a",ref:"Knock"}]);
 const changed=reconcileEventItems(["First","Second"],normalized.eventItems);
 assert.deepEqual(changed.map(item=>item.id),normalized.eventItems.map(item=>item.id));
});
test("P2.3: split creates explicit lineage and requires per-shot 1:N decision",async t=>{
 const {db,get,node,update,confirm,service}=fixture(t);
 const oldVideo=node(get().document,"video-old");
 update("episodes",draft=>{
  const ep=draft.episodes.find(item=>item.id==="ep-two");
  Object.assign(ep,splitEpisodeSequence(ep,"seq-old"));
 });
 confirm("episodes","split-v2");
 const current=JSON.parse(node(get().document,"episodes").metadata.dramaConfirmed).episodes[1];
 const descendants=current.sequences.filter(seq=>seq.replaces?.includes("seq-old"));
 assert.equal(descendants.length,2);
 assert.equal(new Set(descendants.map(item=>item.id)).size,2);
 const preview=previewDramaSequenceMigration(db,getProject,"p23",{nodeId:"board",episodeId:"ep-two"});
 const old=preview.rows.find(row=>row.shotId==="old");
 assert.equal(old.status,"choice_required");
 assert.deepEqual(new Set(old.possibleSequenceIds),new Set(descendants.map(item=>item.id)));
 assert.equal(preview.rows.some(row=>row.shotId==="first"),false);
 assert.equal(preview.rows.some(row=>row.shotId==="other"),false);
 const command={nodeId:"board",episodeId:"ep-two",expectedRevision:preview.projectRevision,
  episodeDigest:preview.episodeDigest,changes:[{
   shotId:"old",expectedShotDigest:old.shotDigest,sequenceId:descendants[1].id,
  }]};
 assert.throws(()=>applyDramaSequenceMigration(service,"p23",{...command,
  changes:[{...command.changes[0],sequenceId:"unrelated"}]}),/drama_sequence_migration_conflict/);
 const result=applyDramaSequenceMigration(service,"p23",command);
 assert.deepEqual(result.migratedShotIds,["old"]);
 assert.equal(node(get().document,"video-old").metadata.prompt,oldVideo.metadata.prompt);
 assert.deepEqual(node(get().document,"video-old"),oldVideo);
 const changed=JSON.parse(node(get().document,"board").metadata.dramaDraft).shots;
 assert.equal(changed.find(item=>item.id==="old").sequenceId,descendants[1].id);
 assert.equal(changed.find(item=>item.id==="first").sequenceId,"seq-one");
 assert.equal(changed.find(item=>item.id==="other").sequenceId,"seq-two");
 assert.throws(()=>applyDramaSequenceMigration(service,"p23",command),/drama_sequence_migration_conflict/);
 const app=buildApp({db,authorize:req=>req.headers["x-p23"]==="yes"});
 t.after(async()=>app.close());
 const base="/api/v1/projects/p23/drama-pipeline/sequence-migration";
 assert.equal((await app.inject({method:"GET",url:base+"?nodeId=board&episodeId=ep-two"})).statusCode,401);
 const ok=await app.inject({method:"GET",url:base+"?nodeId=board&episodeId=ep-two",headers:{"x-p23":"yes"}});
 assert.equal(ok.statusCode,200,ok.body);
 assert.equal(ok.json().rows.some(row=>row.shotId==="old"),false);
});
test("P2.3: merging two sequences maps their old shots to one shared new sequence",t=>{
 const {db,get,node,update,confirm,service}=fixture(t);
 update("episodes",draft=>{
  const ep=draft.episodes.find(item=>item.id==="ep-two");
  Object.assign(ep,mergeEpisodeSequences(ep,"seq-old","seq-two"));
 });
 confirm("episodes","merged-v2");
 const preview=previewDramaSequenceMigration(db,getProject,"p23",{nodeId:"board",episodeId:"ep-two"});
 assert.equal(preview.rows.length,2);
 const choices=preview.rows.map(row=>({
  shotId:row.shotId,expectedShotDigest:row.shotDigest,sequenceId:row.possibleSequenceIds[0]}));
 assert.equal(new Set(choices.map(row=>row.sequenceId)).size,1);
 applyDramaSequenceMigration(service,"p23",{nodeId:"board",episodeId:"ep-two",
  expectedRevision:preview.projectRevision,episodeDigest:preview.episodeDigest,changes:choices});
 const shots=JSON.parse(node(get().document,"board").metadata.dramaDraft).shots;
 assert.equal(shots.filter(item=>item.episodeId==="ep-two"&&item.sequenceId===choices[0].sequenceId).length,2);
});
test("P2.3: changing a stable event affects only its referenced sequence",t=>{
 const {get,update,confirm}=fixture(t);
 const before=get(),board=before.document.nodes.find(item=>item.id==="board");
 assert.ok(board.metadata.dramaInputDependencies?.length);
 update("episodes",draft=>{
  const ep=draft.episodes.find(item=>item.id==="ep-two");
  ep.events[0]="Find a brighter star";
  delete ep.eventItems;
 });
 confirm("episodes","renamed-event-v2");
 const report=previewDramaImpact(get().document,"board");
 assert.equal(report.status,"stale");
 assert.deepEqual(report.impact.episodeIds,["ep-two"]);
 assert.deepEqual(report.impact.sequenceIds,["ep-two/seq-old"]);
 assert.deepEqual(report.impact.shotIds,["old"]);
 assert.deepEqual(report.impact.needsReview,[]);
});