import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,saveSingleUserCanvas,validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {mutateTextVersions,readTextVersions} from "./canvas-text-versions.mjs";
import {createDramaRunService,initDramaRuns} from "./drama-runs.mjs";
import {createProjectArchive} from "./project-archive.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {canvasTextContentPatch} from "../canvas-text-content.mjs";
import {dramaDependencies} from "./drama-dependencies.mjs";
import {stableJson} from "./repository.mjs";

const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
const episode=(id)=>({id,title:id,synopsis:"Shared story",events:[],sourceRefs:[],ending:"End"});
const shot=(id,episodeId,description)=>({
 id,episodeId,order:1,description,characterVariantIds:["hero-day"],
 sceneId:"home",sceneVariantId:"home-day",propIds:[],keyPropIds:[],
});
const assetPlan={assets:[
 {id:"hero",kind:"character",name:"Hero",description:"Main character",sourceRefs:[],
  variants:[{id:"hero-day",name:"Everyday",description:"Blue coat"}]},
 {id:"home",kind:"scene",name:"Home",description:"Shared scene",sourceRefs:[],
  variants:[{id:"home-day",name:"Day",description:"Daylight"}]},
]};
function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const dir=mkdtempSync(join(tmpdir(),"atelier-drama-p1-"));
 const blobStore=createBlobStore({db,dataDir:dir,maxBlobBytes:10_000_000});
 const archive=createProjectArchive({db,blobStore});
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80});});
 return {db,blobStore,archive};
}
function confirm(db,projectId,nodeId,id){
 const revision=getProject(db,projectId).revision;
 return mutateTextVersions(db,projectId,nodeId,{operationId:id,action:"confirm",expectedRevision:revision},
  validateProjectDocument,emitProjectEvent);
}
function update(db,projectId,nodeId,patch){
 const current=getProject(db,projectId),node=current.document.nodes.find(item=>item.id===nodeId);
 assert.ok(node,"missing node: "+nodeId);
 node.metadata={...node.metadata,...patch};
 saveSingleUserCanvas(db,{id:projectId,expectedRevision:current.revision,document:current.document});
}
function node(document,id){return document.nodes.find(item=>item.id===id);}
function shotsIn(document){return JSON.parse(node(document,"board").metadata.dramaDraft).shots;}

test("P1: 50 manual snapshots do not block the 51st immutable publication",t=>{
 const {db}=fixture(t);
 const versions=Array.from({length:50},(_,i)=>({
  id:"manual-"+i,source:"manual",content:"manual snapshot "+i,
  createdAt:"2026-11-20T00:00:00.000Z",note:"history",
 }));
 createProject(db,{id:"p1-history",document:{title:"51 publications",nodes:[
  {id:"story",type:"drama:source",metadata:{dramaDraft:"Confirmed version 0",textVersions:versions}},
 ],connections:[]}});
 for(let i=0;i<51;i++){
  if(i)update(db,"p1-history","story",{dramaDraft:"Confirmed version "+i,content:"Confirmed version "+i});
  confirm(db,"p1-history","story","published-"+i);
 }
 const history=readTextVersions(db,"p1-history","story").versions;
 assert.equal(history.filter(item=>item.source==="manual").length,50);
 assert.equal(history.filter(item=>item.source==="confirmation").length,51);
 assert.equal(readTextVersions(db,"p1-history","story","published-0").version.content,"Confirmed version 0");
 assert.equal(readTextVersions(db,"p1-history","story","published-50").version.content,"Confirmed version 50");
 assert.equal(node(getProject(db,"p1-history").document,"story").metadata.dramaConfirmedVersionId,"published-50");
});

test("P1: two-episode shared assets, independent rerun, conflicts, config and historical-media ZIP",async t=>{
 const {db,blobStore,archive}=fixture(t);
 const older=await blobStore.put([png,Buffer.from("old")],{mime:"image/png"});
 const current=await blobStore.put([png,Buffer.from("new")],{mime:"image/png"});
 const manual=await blobStore.put([png,Buffer.from("manual")],{mime:"image/png"});
 const key=id=>"cas:"+id;
 const e1=shot("shot-one","ep-one","Original first episode");
 const e2=shot("shot-two","ep-two","Original second episode");
 const refs=id=>[
  {assetId:"hero",variantId:"hero-day",imageStorageKeys:[key(id)],requiredForRendering:true},
  {assetId:"home",variantId:"home-day",imageStorageKeys:[key(id)],requiredForRendering:true},
 ];
 const nodes=[
  {id:"story",type:"drama:source",metadata:{content:"Our shared story",dramaDraft:"Our shared story"}},
  {id:"assets",type:"drama:assets",metadata:{dramaDraft:JSON.stringify(assetPlan),dramaAssetReferences:refs(older.blobId)}},
  {id:"episodes",type:"drama:episodes",metadata:{dramaDraft:JSON.stringify({episodes:[episode("ep-one"),episode("ep-two")]})}},
  {id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots:[e1,e2]})}},
 ];
 const connections=[["story","assets"],["story","episodes"],["assets","board"],["episodes","board"]]
  .map(([fromNodeId,toNodeId],i)=>({id:"flow-"+i,fromNodeId,toNodeId}));
 createProject(db,{id:"p1-story",document:{title:"P1",nodes,connections}});
 confirm(db,"p1-story","story","story-v1");
 confirm(db,"p1-story","assets","assets-v1");
 confirm(db,"p1-story","episodes","episodes-v1");
 confirm(db,"p1-story","board","board-v1");
 const confirmed=node(getProject(db,"p1-story").document,"board").metadata;
 assert.equal(confirmed.dramaConfirmedVersionId,"board-v1");
 assert.equal(JSON.parse(confirmed.dramaConfirmed).shots.length,2);

 // Legacy image/input node and manually tuned Config must survive an unrelated episode rerun.
 const first=getProject(db,"p1-story");
 const config={id:"episode-one-config",type:"config",metadata:{
  generationMode:"video",dramaShotId:e1.id,dramaVideoSource:{
   nodeId:"board",revisionId:"board-v1",shot:JSON.stringify(e1),
   referenceKeys:[key(manual.blobId)],prompt:"Manual prompt",basePrompt:"Original first episode",
  },prompt:"Manual prompt",composerContent:"Manual prompt",seconds:"9",
  videoRatio:"4:3",videoMode:"first_frame",videoReferences:[{id:"legacy-image",kind:"image",role:"first_frame"}],
  model:"my-tuned-video-model",
 }};
 const legacy={id:"legacy-image",type:"image",metadata:{storageKey:key(manual.blobId),content:"/api/v1/blobs/"+manual.blobId}};
 first.document.nodes.push(legacy,config);
 first.document.connections.push({id:"board-to-config",fromNodeId:"board",toNodeId:config.id},
  {id:"manual-image-to-config",fromNodeId:legacy.id,toNodeId:config.id});
 saveSingleUserCanvas(db,{id:"p1-story",expectedRevision:first.revision,document:first.document});
 const configBefore=structuredClone(node(getProject(db,"p1-story").document,config.id));
 const linksBefore=getProject(db,"p1-story").document.connections.filter(edge=>edge.toNodeId===config.id);

 // A reference-only publication retains the definition revision and historical CAS.
 update(db,"p1-story","assets",{dramaAssetReferences:refs(current.blobId)});
 const preAssets=getProject(db,"p1-story");
 const beforeMeta=node(preAssets.document,"assets").metadata;
 assert.equal(beforeMeta.dramaConfirmedVersionId,"assets-v1","definition revision before image refresh");
 assert.equal(beforeMeta.dramaConfirmed,canvasTextContentPatch("drama:assets",beforeMeta.dramaDraft).dramaDraft,"only the reference slots should change");
 assert.deepEqual(beforeMeta.dramaInputDependencies,dramaDependencies(preAssets.document,"assets"),"dependency signatures should remain unchanged");
 assert.equal(stableJson(beforeMeta.dramaInputDependencies),stableJson(dramaDependencies(preAssets.document,"assets")));
 confirm(db,"p1-story","assets","assets-images-v2");
 const assets=node(getProject(db,"p1-story").document,"assets").metadata;
 assert.equal(assets.dramaConfirmedVersionId,"assets-v1");
 assert.equal(assets.dramaAssetReferenceRevisionId,"assets-images-v2");

 let generateCount=0;
 const service=createDramaRunService({db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent,
  async generate(config,input){
   generateCount++;
   assert.equal(input.episode.id,"ep-two");
   assert.equal(input.assets.length,2);
   return JSON.stringify({shots:[{...e2,description:"Regenerated episode two"}]});
  }});
 const request={requestId:"rerun-two",nodeId:"board",episodeId:"ep-two",
  channelId:"offline-stub",provider:"openai",model:"deterministic-fixture"};
 const result=await service.submit("p1-story",request);
 assert.equal(result.status,"ready");
 assert.equal(await service.submit("p1-story",request).then(item=>item.status),"ready");
 assert.equal(generateCount,1,"same request must not submit the model twice");
 await assert.rejects(service.submit("p1-story",{...request,model:"changed-model"}),/drama_run_id_conflict/);
 const frozen=JSON.parse(db.prepare("SELECT frozen FROM drama_runs WHERE project_id=? AND id=?")
  .get("p1-story",request.requestId).frozen);
 assert.equal(frozen.input.episode.id,"ep-two");
 assert.equal(frozen.revisions.length,3);

 const before=getProject(db,"p1-story");
 const human=JSON.parse(node(before.document,"board").metadata.dramaDraft);
 human.shots[0]={...human.shots[0],description:"Human first episode change"};
 update(db,"p1-story","board",{dramaDraft:JSON.stringify(human)});
 service.adopt("p1-story",request.requestId);
 const adopted=getProject(db,"p1-story");
 assert.deepEqual(shotsIn(adopted.document).map(item=>item.description),
  ["Human first episode change","Regenerated episode two"]);
 assert.equal(node(adopted.document,"board").metadata.dramaConfirmed,confirmed.dramaConfirmed,
  "candidate adoption must not silently publish a storyboard");
 assert.deepEqual(node(adopted.document,config.id),configBefore);
 assert.deepEqual(adopted.document.connections.filter(edge=>edge.toNodeId===config.id),linksBefore);
 assert.equal(service.adopt("p1-story",request.requestId).revision,adopted.revision);

 // Candidate for the same episode must remain available for conflict resolution.
 const pending=await service.submit("p1-story",{...request,requestId:"conflicting-two"});
 assert.equal(pending.status,"ready");
 const changed=JSON.parse(node(getProject(db,"p1-story").document,"board").metadata.dramaDraft);
 changed.shots[1]={...changed.shots[1],description:"Human second episode edit"};
 update(db,"p1-story","board",{dramaDraft:JSON.stringify(changed)});
 assert.throws(()=>service.adopt("p1-story","conflicting-two"),/drama_candidate_conflict/);
 assert.equal(service.get("p1-story","conflicting-two").status,"ready");
 assert.equal(shotsIn(getProject(db,"p1-story").document)[1].description,"Human second episode edit");
 assert.deepEqual(node(getProject(db,"p1-story").document,config.id),configBefore);

 const zip=Buffer.concat(await Array.fromAsync((await archive.exportProject("p1-story")).stream));
 assert.ok(zip.length>0);
 const restored=await archive.importProject(Readable.from([zip]));
 assert.equal(restored.mediaCount,3,"historical-only, current and legacy Config images must all survive");
 const back=getProject(db,restored.id);
 assert.deepEqual(shotsIn(back.document),shotsIn(getProject(db,"p1-story").document));
 assert.deepEqual(node(back.document,config.id),configBefore);
 assert.deepEqual(back.document.connections.filter(edge=>edge.toNodeId===config.id),linksBefore);
 assert.equal(readTextVersions(db,restored.id,"assets","assets-v1").version.provenance.references[0].imageStorageKeys[0],
  key(older.blobId));
 assert.equal(readTextVersions(db,restored.id,"board","board-v1").version.content,confirmed.dramaConfirmed);
 assert.equal(service.get(restored.id,"conflicting-two").status,"ready");
 assert.equal(service.get(restored.id,"conflicting-two").candidate.shots[0].description,"Regenerated episode two");
 for(const blob of [older,current,manual])assert.ok((await blobStore.stat(blob.blobId)).byteSize>0);
});
