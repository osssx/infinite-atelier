import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,saveSingleUserCanvas,validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {buildApp} from "./app.mjs";
import {dramaDependencies} from "./drama-dependencies.mjs";
import {previewDramaImpact} from "./drama-impact.mjs";
import {readEpisodeDraft} from "../canvas-text-content.mjs";
import {mutateTextVersions} from "./canvas-text-versions.mjs";

const episode=(id,ref,sequenceId)=>({id,title:id,synopsis:id,
 events:["Enter forest","Return home"],sourceRefs:[ref],ending:"End",
 sequences:[{id:sequenceId,title:sequenceId,sourceRefs:[ref],eventRefs:["Return home"]}]});
const shot=(id,episodeId,sequenceId,variantId)=>({
 id,episodeId,sequenceId,order:1,description:"Shot "+id,
 sceneId:"home",sceneVariantId:variantId,characterVariantIds:[],
 propIds:[],keyPropIds:[],sourceRefs:[],
});
const p1="p-1",p2="p-2";
const blueprint=()=>({
 nodes:[
  {id:"story",type:"drama:source",metadata:{
   dramaConfirmed:"Intro\nReturn",dramaConfirmedVersionId:"story-v1",
   dramaSourceParagraphs:[{id:p1,text:"Intro",line:1,status:"located"},
    {id:p2,text:"Return",line:2,status:"located"}],
  }},
  {id:"assets",type:"drama:assets",metadata:{
   dramaConfirmed:JSON.stringify({assets:[{id:"home",kind:"scene",name:"Shared home",description:"House",
    sourceRefs:[p1],variants:[{id:"home-blue",name:"Blue",description:"Morning"},
     {id:"home-red",name:"Red",description:"Evening"}]}]}),
   dramaConfirmedVersionId:"assets-v1",dramaAssetReferenceRevisionId:"media-v1",
   dramaAssetReferenceEntries:[{id:"home-blue",digest:"old-blue"},{id:"home-red",digest:"old-red"}],
  }},
  {id:"episodes",type:"drama:episodes",metadata:{
   dramaConfirmed:JSON.stringify({episodes:[
    episode("ep-one",p1,"seq-one"),episode("ep-two",p2,"seq-two"),
   ]}),dramaConfirmedVersionId:"episodes-v1",
  }},
  {id:"board",type:"drama:storyboard",metadata:{
   dramaConfirmed:JSON.stringify({shots:[
    shot("shot-blue","ep-one","seq-one","home-blue"),
    shot("shot-red","ep-two","seq-two","home-red"),
   ]}),dramaConfirmedVersionId:"board-v1",
  }},
  {id:"config-blue",type:"config",metadata:{dramaShotId:"shot-blue",videoMode:"omni_reference",
   dramaVideoSource:{nodeId:"board",referenceKeys:["cas:"+"a".repeat(64)],prompt:"Blue"}}},
  {id:"config-red",type:"config",metadata:{dramaShotId:"shot-red",videoMode:"omni_reference",
   dramaVideoSource:{nodeId:"board",referenceKeys:["cas:"+"b".repeat(64)],prompt:"Red"}}},
  {id:"config-manual-first",type:"config",metadata:{dramaShotId:"shot-blue",videoMode:"first_frame",
   dramaVideoSource:{nodeId:"board",referenceKeys:["cas:"+"c".repeat(64)],prompt:"Human"}}},
 ],
 connections:[["story","assets"],["story","episodes"],["assets","board"],["episodes","board"],
  ["board","config-blue"],["board","config-red"],["board","config-manual-first"]]
  .map(([fromNodeId,toNodeId],i)=>({id:"edge-"+i,fromNodeId,toNodeId})),
});
const locate=(document,id)=>document.nodes.find(node=>node.id===id);
function confirmedGraph(){
 const graph=blueprint();
 for(const id of ["assets","episodes","board"])
  locate(graph,id).metadata.dramaInputDependencies=dramaDependencies(graph,id);
 return graph;
}
const update=(document,id,callback)=>{
 const node=locate(document,id);
 const value=JSON.parse(node.metadata.dramaConfirmed);
 callback(value);
 node.metadata.dramaConfirmed=JSON.stringify(value);
};
test("P2: one variant image revision affects only matching media inputs, not storyboards or manual first frames",()=>{
 const graph=confirmedGraph(),assets=locate(graph,"assets");
 assets.metadata.dramaAssetReferenceRevisionId="media-v2";
 assets.metadata.dramaAssetReferenceEntries=[
  {id:"home-blue",digest:"new-blue"},{id:"home-red",digest:"old-red"}];
 const report=previewDramaImpact(graph,"board");
 assert.equal(report.status,"stale");
 assert.deepEqual(report.impact.shotIds,[]);
 assert.deepEqual(report.impact.mediaShotIds,["shot-blue"]);
 assert.deepEqual(report.impact.configIds,["config-blue"]);
 assert.deepEqual(report.impact.needsReview,[]);
 assert.equal(report.changes.find(change=>change.kind==="references_updated").entryIds.join(","),"home-blue");
});
test("P2: changed variant definition follows only shots using that variant, across episodes",()=>{
 const graph=confirmedGraph();
 update(graph,"assets",value=>value.assets[0].variants[1].description="Dusk light");
 const report=previewDramaImpact(graph,"board");
 assert.deepEqual(report.impact.assetIds,["home"]);
 assert.deepEqual(report.impact.shotIds,["shot-red"]);
 assert.deepEqual(report.impact.configIds,["config-red"]);
 const changed=report.changes.find(change=>change.kind==="updated").entryDetails[0];
 assert.equal(changed.bodyChanged,false);
 assert.deepEqual(changed.variantIds,["home-red"]);
});
test("P2: only changed episode sequence affects its shots, not reused scene or other sequences",()=>{
 const graph=confirmedGraph();
 update(graph,"episodes",value=>value.episodes[1].sequences[0].title="Return at sunset");
 const report=previewDramaImpact(graph,"board");
 assert.deepEqual(report.impact.episodeIds,["ep-two"]);
 assert.deepEqual(report.impact.sequenceIds,["ep-two/seq-two"]);
 assert.deepEqual(report.impact.shotIds,["shot-red"]);
 assert.deepEqual(report.impact.configIds,["config-red"]);
});
test("P2: source paragraph delta affects only linked episodes and sequences",()=>{
 const graph=confirmedGraph(),source=locate(graph,"story");
 source.metadata.dramaConfirmed="Intro\nReturn at sunset";
 source.metadata.dramaSourceParagraphs[1].text="Return at sunset";
 source.metadata.dramaConfirmedVersionId="story-v2";
 const report=previewDramaImpact(graph,"episodes");
 assert.equal(report.status,"stale");
 assert.deepEqual(report.impact.episodeIds,["ep-two"]);
 assert.deepEqual(report.impact.sequenceIds,["ep-two/seq-two"]);
 assert.deepEqual(report.impact.needsReview,[]);
});
test("P2: paragraph split retains legacy refs for review instead of treating them as unaffected",()=>{
 const graph=confirmedGraph(),source=locate(graph,"story");
 source.metadata.dramaConfirmed="Intro\nReturn to forest\nReturn to home";
 source.metadata.dramaSourceParagraphs=[
  source.metadata.dramaSourceParagraphs[0],
  {id:"p-2-a",text:"Return to forest",line:2,status:"needs_review",replaces:[p2]},
  {id:"p-2-b",text:"Return to home",line:3,status:"needs_review",replaces:[p2]},
 ];
 const report=previewDramaImpact(graph,"episodes");
 assert.deepEqual(report.impact.episodeIds,["ep-two"]);
 assert.deepEqual(report.impact.sequenceIds,["ep-two/seq-two"]);
 assert.deepEqual(report.impact.needsReview,["paragraph:p-2-a","paragraph:p-2-b"]);
});
test("P2: old snapshots without variant signatures are conservative and old episodes accept optional sequence refs",()=>{
 const graph=confirmedGraph(),board=locate(graph,"board");
 board.metadata.dramaInputDependencies=board.metadata.dramaInputDependencies.map(dependency=>({
  ...dependency,entries:dependency.entries.map(entry=>({id:entry.id,digest:entry.digest})),
 }));
 update(graph,"assets",value=>value.assets[0].variants[0].description="Cloudy light");
 const report=previewDramaImpact(graph,"board");
 assert.deepEqual(report.impact.shotIds,["shot-blue","shot-red"]);
 const old=readEpisodeDraft(JSON.stringify({episodes:[{id:"legacy",title:"Legacy",synopsis:"",
  ending:"End",events:[],sourceRefs:[],sequences:[{id:"s",title:"Old scene"}]}]}));
 assert.equal(old.episodes[0].sequences[0].title,"Old scene");
 const modern=readEpisodeDraft(JSON.stringify({episodes:[{id:"modern",title:"Modern",synopsis:"",
  ending:"End",events:["Event"],sourceRefs:[],
  sequences:[{id:"s",title:"New scene",sourceRefs:["p-1"],eventRefs:["Event"]}]}]}));
 assert.deepEqual(modern.episodes[0].sequences[0].sourceRefs,["p-1"]);
 assert.equal(readEpisodeDraft(JSON.stringify({episodes:[{...modern.episodes[0],
  sequences:[{id:"s",title:"Bad",sourceRefs:[1]}]}]})),null);
});
test("P2: unreferenced old episodes receive an explicit review notice",()=>{
 const graph=confirmedGraph(),source=locate(graph,"story");
 update(graph,"episodes",value=>{value.episodes[1].sourceRefs=[];value.episodes[1].sequences[0].sourceRefs=[];});
 locate(graph,"episodes").metadata.dramaInputDependencies=dramaDependencies(graph,"episodes");
 source.metadata.dramaConfirmed="Intro\nChanged";
 source.metadata.dramaSourceParagraphs[1].text="Changed";
 const report=previewDramaImpact(graph,"episodes");
 assert.deepEqual(report.impact.episodeIds,[]);
 assert.deepEqual(report.impact.needsReview,["source-unmapped:ep-two"]);
});
test("P2: source edits propagate as pending shots and Configs without changing confirmed storyboard",()=>{
 const graph=confirmedGraph(),source=locate(graph,"story");
 source.metadata.dramaConfirmed="Intro\nChanged return";
 source.metadata.dramaSourceParagraphs[1].text="Changed return";
 const report=previewDramaImpact(graph,"board");
 assert.equal(report.status,"current","the confirmed storyboard still matches confirmed episode/asset inputs");
 assert.deepEqual(report.impact.shotIds,[]);
 assert.deepEqual(report.impact.configIds,[]);
 assert.deepEqual(report.impact.pending.episodeIds,["ep-two"]);
 assert.deepEqual(report.impact.pending.sequenceIds,["ep-two/seq-two"]);
 assert.deepEqual(report.impact.pending.shotIds,["shot-red"]);
 assert.deepEqual(report.impact.pending.configIds,["config-red"]);
 assert.deepEqual(report.impact.pending.assetIds,[]);
});
test("P2: unmapped legacy paragraphs surface pending manual review downstream",()=>{
 const graph=confirmedGraph(),source=locate(graph,"story");
 update(graph,"episodes",value=>{value.episodes[1].sourceRefs=[];value.episodes[1].sequences[0].sourceRefs=[];});
 locate(graph,"board").metadata.dramaInputDependencies=dramaDependencies(graph,"board");
 locate(graph,"episodes").metadata.dramaInputDependencies=dramaDependencies(graph,"episodes");
 source.metadata.dramaConfirmed="Intro\nChanged";
 source.metadata.dramaSourceParagraphs[1].text="Changed";
 const report=previewDramaImpact(graph,"board");
 assert.equal(report.status,"current");
 assert.ok(report.impact.pending.needsReview.includes("episodes:source-unmapped:ep-two"));
});
test("P2: pure variant/sequence reordering cannot silently appear unaffected",()=>{
 const variants=confirmedGraph();
 update(variants,"assets",value=>value.assets[0].variants.reverse());
 const byVariant=previewDramaImpact(variants,"board");
 assert.deepEqual(byVariant.impact.shotIds,["shot-blue","shot-red"]);
 const sequences=confirmedGraph();
 update(sequences,"episodes",value=>value.episodes[1].sequences.push({id:"seq-alt",title:"Alternate"}));
 locate(sequences,"board").metadata.dramaInputDependencies=dramaDependencies(sequences,"board");
 update(sequences,"episodes",value=>value.episodes[1].sequences.reverse());
 const bySequence=previewDramaImpact(sequences,"board");
 assert.deepEqual(bySequence.impact.shotIds,["shot-red"]);
});
test("P2: changed media revision without usable slot signatures is explicitly uncertain",()=>{
 const graph=confirmedGraph();
 locate(graph,"assets").metadata.dramaAssetReferenceRevisionId="media-v2";
 const report=previewDramaImpact(graph,"board");
 assert.equal(report.status,"stale");
 assert.deepEqual(report.impact.configIds,[]);
 assert.deepEqual(report.impact.needsReview,["reference-scope-unknown:assets"]);
});
test("P2: real confirmation transaction changes one reference slot without republishing definition or another Config",t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 const graph=blueprint(),ref=id=>({
  assetId:"home",variantId:id,imageStorageKeys:["cas:"+("home-blue"===id?"a":"b").repeat(64)],
  requiredForRendering:true,
 });
 for(const id of ["story","assets","episodes","board"]){
  const metadata=locate(graph,id).metadata;
  metadata.dramaDraft=metadata.dramaConfirmed;
  delete metadata.dramaConfirmed;
  delete metadata.dramaConfirmedVersionId;
  delete metadata.dramaAssetReferenceRevisionId;
  delete metadata.dramaAssetReferenceEntries;
  delete metadata.dramaInputDependencies;
 }
 locate(graph,"assets").metadata.dramaAssetReferences=[ref("home-blue"),ref("home-red")];
 createProject(db,{id:"p2-real-confirm",document:graph});
 for(const id of ["story","assets","episodes","board"]){
  const revision=getProject(db,"p2-real-confirm").revision;
  mutateTextVersions(db,"p2-real-confirm",id,{
   action:"confirm",operationId:id+"-v1",expectedRevision:revision,
  },validateProjectDocument,emitProjectEvent);
 }
 const pinned=getProject(db,"p2-real-confirm");
 assert.equal(previewDramaImpact(pinned.document,"board").status,"current");
 const source=locate(pinned.document,"assets");
 source.metadata.dramaAssetReferences[0].imageStorageKeys=["cas:"+"c".repeat(64)];
 saveSingleUserCanvas(db,{id:"p2-real-confirm",expectedRevision:pinned.revision,document:pinned.document});
 const current=getProject(db,"p2-real-confirm");
 mutateTextVersions(db,"p2-real-confirm","assets",{
  action:"confirm",operationId:"refs-v2",expectedRevision:current.revision,
 },validateProjectDocument,emitProjectEvent);
 const result=getProject(db,"p2-real-confirm");
 assert.equal(locate(result.document,"assets").metadata.dramaConfirmedVersionId,"assets-v1");
 assert.equal(locate(result.document,"assets").metadata.dramaAssetReferenceRevisionId,"refs-v2");
 assert.equal(previewDramaImpact(result.document,"board").status,"stale");
 assert.deepEqual(previewDramaImpact(result.document,"board").impact.shotIds,[]);
 assert.deepEqual(previewDramaImpact(result.document,"board").impact.mediaShotIds,["shot-blue"]);
 assert.deepEqual(previewDramaImpact(result.document,"board").impact.configIds,["config-blue"]);
});
test("P2.5: confirmed visual style change flags only Configs that adopted the earlier style",()=>{
 const graph=blueprint(),source=locate(graph,"story");
 source.metadata.dramaConfirmedVisual={artDirection:{},visualStyle:"Noir"};
 for(const id of ["assets","episodes","board"])
  locate(graph,id).metadata.dramaInputDependencies=dramaDependencies(graph,id);
 locate(graph,"config-blue").metadata.dramaVideoSource.visualStyle="Noir";
 locate(graph,"config-red").metadata.dramaVideoSource.visualStyle="Watercolor";
 source.metadata.dramaConfirmedVisual={artDirection:{},visualStyle:"Sketch"};
 const report=previewDramaImpact(graph,"board");
 assert.equal(report.status,"current","storyboard content has not changed");
 assert.deepEqual(report.impact.shotIds,[]);
 assert.deepEqual(report.impact.pending.visualConfigIds,["config-blue"]);
 assert.deepEqual(report.impact.pending.configIds,["config-blue"]);
 assert.ok(report.impact.pending.needsReview.some(item=>item==="visual-config-unknown:config-manual-first"));
 assert.ok(!report.impact.pending.configIds.includes("config-red"));
});
test("P2.5: old visual snapshots without style provenance stay review-only, no guessed Config rewrite",()=>{
 const graph=blueprint(),source=locate(graph,"story");
 source.metadata.dramaConfirmedVisual={artDirection:{},visualStyle:"Noir"};
 for(const id of ["assets","episodes","board"]){
  locate(graph,id).metadata.dramaInputDependencies=dramaDependencies(graph,id).map(dep=>{
   const {visualStyle:_,...legacy}=dep;
   return legacy;
  });
 }
 source.metadata.dramaConfirmedVisual={artDirection:{},visualStyle:"New"};
 const report=previewDramaImpact(graph,"board");
 assert.deepEqual(report.impact.pending.visualConfigIds,[]);
 assert.ok(report.impact.pending.needsReview.includes("visual-scope-unknown:story"));
});
test("P2: real authenticated dependency endpoint returns fine-grained impact",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const graph=confirmedGraph();
 locate(graph,"assets").metadata.dramaAssetReferenceRevisionId="media-v2";
 locate(graph,"assets").metadata.dramaAssetReferenceEntries[0].digest="new-blue";
 createProject(db,{id:"p2-impact",document:graph});
 const app=buildApp({db,authorize:req=>req.headers["x-p2-owner"]==="yes"});
 t.after(async()=>{await app.close();db.close();});
 const denied=await app.inject({method:"GET",url:"/api/v1/projects/p2-impact/drama-pipeline/dependencies?nodeId=board"});
 assert.equal(denied.statusCode,401);
 const allowed=await app.inject({method:"GET",url:"/api/v1/projects/p2-impact/drama-pipeline/dependencies?nodeId=board",
  headers:{"x-p2-owner":"yes"}});
 assert.equal(allowed.statusCode,200,allowed.body);
 assert.deepEqual(allowed.json().impact.mediaShotIds,["shot-blue"]);
 assert.deepEqual(allowed.json().impact.configIds,["config-blue"]);
});
