import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {adoptDramaAssetCandidates} from "./drama-asset-adoption.mjs";
import {buildApp} from "./app.mjs";
import {readAssetDraft,readStoryboardDraft} from "../canvas-text-content.mjs";

const makeAsset=(id,kind,name,variants=[])=>({id,kind,name,description:name,sourceRefs:[],
 ...(variants.length?{variants:variants.map(item=>({id:item.id,name:item.name,description:item.name}))}:{})});
const shot=(id,ep,variant,propIds=[])=>({id,episodeId:ep,order:1,description:id,
 characterVariantIds:[variant],sceneId:"home",sceneVariantId:"home-day",propIds,keyPropIds:[]});
const assets=[makeAsset("hero","character","兔子",[{id:"hero-day",name:"日常"}]),
 makeAsset("home","scene","小屋",[{id:"home-day",name:"白天"}])];
const suggested=[makeAsset("generated-hero","character","兔子",[{id:"blue-coat",name:"蓝衣"}]),
 makeAsset("generated-prop","prop","星星")];
function fixture(t,choices=suggested,references=[],boardShots){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 const base=JSON.stringify({assets});
 const board=JSON.stringify({shots:boardShots??[shot("old","ep-one","hero-day"),
  shot("new","ep-two","blue-coat",["generated-prop"]) ]});
 const nodes=[
  {id:"story",type:"drama:source",metadata:{content:"Story"}},
  {id:"assets",type:"drama:assets",metadata:{
   dramaDraft:base,dramaConfirmed:base,dramaAssetReferences:references,
   dramaAssetCandidate:{id:"candidate",baseline:base,assets:choices},
  }},
  {id:"board",type:"drama:storyboard",metadata:{dramaDraft:board,dramaConfirmed:board}},
  {id:"video",type:"config",metadata:{dramaShotId:"old",prompt:"Manual config",generationMode:"video"}},
 ];
 const links=[["assets","board"],["board","video"]].map(([fromNodeId,toNodeId],i)=>
  ({id:"edge-"+i,fromNodeId,toNodeId}));
 createProject(db,{id:"asset-p24",document:{title:"Asset adoption",nodes,connections:links}});
 const get=()=>getProject(db,"asset-p24"),find=id=>get().document.nodes.find(node=>node.id===id);
 const service={db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent};
 const command=decisions=>({nodeId:"assets",candidateId:"candidate",decisions});
 return {db,get,find,service,command};
}
test("P2.4: atomic asset merge keeps shared hero and remaps new coat + prop only in affected episode drafts",t=>{
 const {get,find,service,command}=fixture(t);
 const oldVideo=find("video"),originalConfirmed=find("assets").metadata.dramaConfirmed;
 const result=adoptDramaAssetCandidates(service,"asset-p24",command({
  "generated-hero":{action:"variant",targetId:"hero"},
  "generated-prop":{action:"new"},
 }));
 assert.equal(result.revision,2);
 const merged=readAssetDraft(find("assets").metadata.dramaDraft).assets;
 const hero=merged.find(item=>item.id==="hero");
 assert.equal(hero.variants.length,2);
 assert.equal(hero.variants[0].id,"hero-day");
 const coatId=result.mapping.variantIds["blue-coat"];
 assert.ok(hero.variants.some(item=>item.id===coatId));
 const propId=result.mapping.assetIds["generated-prop"];
 assert.equal(merged.find(item=>item.id===propId).kind,"prop");
 const shots=readStoryboardDraft(find("board").metadata.dramaDraft).shots;
 assert.equal(shots.find(item=>item.id==="old").characterVariantIds[0],"hero-day");
 assert.equal(shots.find(item=>item.id==="new").characterVariantIds[0],coatId);
 assert.deepEqual(shots.find(item=>item.id==="new").propIds,[propId]);
 assert.deepEqual(find("video"),oldVideo);
 assert.equal(find("assets").metadata.dramaConfirmed,originalConfirmed);
 assert.equal(find("assets").metadata.dramaAssetCandidate,undefined);
 assert.equal(get().document.connections.length,2);
});
test("P2.4: same-named character can explicitly remain separate; no cross-episode aliasing",t=>{
 const {find,service,command}=fixture(t);
 const result=adoptDramaAssetCandidates(service,"asset-p24",command({
  "generated-hero":{action:"new"},
  "generated-prop":{action:"new"},
 }));
 const newHero=result.mapping.assetIds["generated-hero"];
 assert.notEqual(newHero,"hero");
 const merged=readAssetDraft(find("assets").metadata.dramaDraft).assets;
 assert.equal(merged.filter(item=>item.name==="兔子").length,2);
 const shots=readStoryboardDraft(find("board").metadata.dramaDraft).shots;
 assert.equal(shots.find(item=>item.id==="old").characterVariantIds[0],"hero-day");
 assert.equal(shots.find(item=>item.id==="new").characterVariantIds[0],result.mapping.variantIds["blue-coat"]);
});
test("P2.4: skipped candidate referenced by a shot cannot enter invalid partial asset draft",t=>{
 const {get,service,command}=fixture(t);
 const before=get().document;
 assert.throws(()=>adoptDramaAssetCandidates(service,"asset-p24",command({
  "generated-hero":{action:"skip"},"generated-prop":{action:"new"},
 })),/drama_asset_candidate_invalid/);
 assert.deepEqual(get().document,before);
});
test("P2.4: candidate reuse maps a unique matching variant without creating duplicate slots",t=>{
 const reused=[makeAsset("generated-hero","character","兔子",[{id:"blue-coat",name:"日常"}]),
  makeAsset("generated-prop","prop","星星")];
 const {find,service,command}=fixture(t,reused);
 const result=adoptDramaAssetCandidates(service,"asset-p24",command({
  "generated-hero":{action:"reuse",targetId:"hero"},
  "generated-prop":{action:"new"},
 }));
 assert.equal(result.mapping.variantIds["blue-coat"],"hero-day");
 assert.equal(readAssetDraft(find("assets").metadata.dramaDraft).assets.find(a=>a.id==="hero").variants.length,1);
 assert.equal(readStoryboardDraft(find("board").metadata.dramaDraft).shots[1].characterVariantIds[0],"hero-day");
});
test("P2.4: reference slots coalesce atomically on reuse, conflicting media slots fail without mutation",t=>{
 const candidates=[makeAsset("generated-hero","character","兔子",[{id:"blue-coat",name:"日常"}]),
  makeAsset("generated-prop","prop","星星")];
 const original={assetId:"hero",variantId:"hero-day",imageStorageKeys:[],requiredForRendering:true};
 const incoming={assetId:"generated-hero",variantId:"blue-coat",imageStorageKeys:[],requiredForRendering:true};
 const ctx=fixture(t,candidates,[original,incoming]);
 const decision=ctx.command({"generated-hero":{action:"reuse",targetId:"hero"},
  "generated-prop":{action:"new"}});
 adoptDramaAssetCandidates(ctx.service,"asset-p24",decision);
 assert.deepEqual(ctx.find("assets").metadata.dramaAssetReferences,[original]);
 const other=fixture(t,candidates,[original,{...incoming,requiredForRendering:false}]);
 const before=other.get().document;
 assert.throws(()=>adoptDramaAssetCandidates(other.service,"asset-p24",decision),
  /drama_asset_candidate_reference_conflict/);
 assert.deepEqual(other.get().document,before);
});
test("P2.4: 12 reviewed assets adopt atomically when existing board shots omit optional scene fields",t=>{
 const choices=[...suggested,...Array.from({length:10},(_,index)=>makeAsset(
  "generated-extra-"+index,"prop","候选道具"+index))];
 const shots=[
  {id:"old",episodeId:"ep-one",order:1,description:"有场景但没有场景变体",sceneId:"home",
   characterVariantIds:["hero-day"],propIds:[],keyPropIds:[]},
  {id:"new",episodeId:"ep-two",order:2,description:"新候选",
   characterVariantIds:["blue-coat"],propIds:["generated-prop"],keyPropIds:[]},
 ];
 const {find,service,command,get}=fixture(t,choices,[],shots);
 const decisions=Object.fromEntries(choices.map(asset=>[asset.id,
  asset.id==="generated-hero"?{action:"variant",targetId:"hero"}:
   {action:"new"}]));
 const before=get().document;
 const result=adoptDramaAssetCandidates(service,"asset-p24",command(decisions));
 assert.equal(result.revision,2);
 assert.equal(readAssetDraft(find("assets").metadata.dramaDraft).assets.length,13);
 const updated=readStoryboardDraft(find("board").metadata.dramaDraft).shots;
 assert.equal(updated.length,2);
 assert.equal(updated[0].sceneId,"home");
 assert.equal(updated[0].sceneVariantId,undefined);
 assert.equal(updated[1].sceneId,undefined);
 assert.equal(updated[1].sceneVariantId,undefined);
 assert.equal(updated[1].characterVariantIds[0],result.mapping.variantIds["blue-coat"]);
 assert.equal(updated[1].propIds[0],result.mapping.assetIds["generated-prop"]);
 assert.equal(find("assets").metadata.dramaConfirmed,before.nodes.find(n=>n.id==="assets").metadata.dramaConfirmed);
});
test("P2.4: HTTP adoption accepts shots without scene fields and reports domain validation errors",async t=>{
 const boardShots=[
  {id:"old",episodeId:"ep-one",order:1,description:"无场景",
   characterVariantIds:["hero-day"],propIds:[],keyPropIds:[]},
  {id:"new",episodeId:"ep-two",order:2,description:"只有角色和道具",
   characterVariantIds:["blue-coat"],propIds:["generated-prop"],keyPropIds:[]},
 ];
 const {db,get,command}=fixture(t,suggested,[],boardShots);
 const app=buildApp({db,authorize:req=>req.headers["x-p24"]==="ok"});
 t.after(async()=>app.close());
 const path="/api/v1/projects/asset-p24/drama-pipeline/asset-candidates/adopt";
 const headers={"x-p24":"ok"};
 const before=get().document;
 const invalid=await app.inject({method:"POST",url:path,headers,payload:command({
  "generated-hero":{action:"reuse",targetId:"missing-asset"},
  "generated-prop":{action:"new"},
 })});
 assert.equal(invalid.statusCode,422,invalid.body);
 assert.equal(invalid.json().code,"drama_asset_candidate_target_invalid");
 assert.deepEqual(get().document,before);
 const incomplete=await app.inject({method:"POST",url:path,headers,payload:command({
  "generated-prop":{action:"new"},
 })});
 assert.equal(incomplete.statusCode,422,incomplete.body);
 assert.equal(incomplete.json().code,"drama_asset_candidate_invalid");
 assert.deepEqual(get().document,before);
 const good=await app.inject({method:"POST",url:path,headers,payload:command({
  "generated-hero":{action:"variant",targetId:"hero"},
  "generated-prop":{action:"new"},
 })});
 assert.equal(good.statusCode,200,good.body);
 assert.equal(good.json().revision,2);
 assert.equal(readStoryboardDraft(get().document.nodes.find(node=>node.id==="board").metadata.dramaDraft).shots[1].sceneId,undefined);
 const duplicate=await app.inject({method:"POST",url:path,headers,payload:command({
  "generated-hero":{action:"variant",targetId:"hero"},
  "generated-prop":{action:"new"},
 })});
 assert.equal(duplicate.statusCode,409,duplicate.body);
 assert.equal(duplicate.json().code,"drama_asset_candidate_conflict");
});
test("P2.4: first-time asset creation adopts 12 generated candidates from an empty draft",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 const proposed=Array.from({length:12},(_,index)=>makeAsset("candidate-"+index,"prop","道具 "+index));
 createProject(db,{id:"asset-first",document:{title:"First asset review",nodes:[
  {id:"story",type:"drama:source",metadata:{content:"故事"}},
  {id:"assets",type:"drama:assets",metadata:{dramaDraft:"",
   dramaAssetCandidate:{id:"new-candidate",baseline:"",assets:proposed}}},
 ],connections:[]}});
 const app=buildApp({db,authorize:req=>req.headers["x-p24"]==="ok"});
 t.after(async()=>app.close());
 const path="/api/v1/projects/asset-first/drama-pipeline/asset-candidates/adopt";
 const payload={nodeId:"assets",candidateId:"new-candidate",
  decisions:Object.fromEntries(proposed.map(asset=>[asset.id,{action:"new"}]))};
 const before=getProject(db,"asset-first");
 const adopted=await app.inject({method:"POST",url:path,headers:{"x-p24":"ok"},payload});
 assert.equal(adopted.statusCode,200,adopted.body);
 const after=getProject(db,"asset-first");
 const created=readAssetDraft(after.document.nodes.find(node=>node.id==="assets").metadata.dramaDraft).assets;
 assert.equal(created.length,12);
 assert.deepEqual(created.map(asset=>asset.name),proposed.map(asset=>asset.name));
 assert.equal(after.document.nodes.find(node=>node.id==="assets").metadata.dramaAssetCandidate,undefined);
 assert.equal(before.revision+1,after.revision);
 const stale=await app.inject({method:"POST",url:path,headers:{"x-p24":"ok"},payload});
 assert.equal(stale.statusCode,409,stale.body);
 assert.equal(stale.json().code,"drama_asset_candidate_conflict");
});

test("P2.4: adopting into a connected but completely blank storyboard preserves its empty state",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 const base=JSON.stringify({assets});
 const proposed=[...suggested,...Array.from({length:10},(_,i)=>makeAsset("extra-prop-"+i,"prop","道具 "+i))];
 const nodes=[
  {id:"assets",type:"drama:assets",metadata:{dramaDraft:base,dramaConfirmed:base,
   dramaAssetCandidate:{id:"review",baseline:base,assets:proposed}}},
  {id:"empty-board",type:"drama:storyboard",metadata:{dramaDraft:"",dramaConfirmed:""}},
 ];
 createProject(db,{id:"asset-blank-board",document:{title:"Blank board",nodes,
  connections:[{id:"asset-to-board",fromNodeId:"assets",toNodeId:"empty-board"}]}});
 const app=buildApp({db,authorize:req=>req.headers["x-p24"]==="ok"});
 t.after(async()=>app.close());
 const path="/api/v1/projects/asset-blank-board/drama-pipeline/asset-candidates/adopt";
 const before=getProject(db,"asset-blank-board"),boardBefore=before.document.nodes[1];
 const payload={nodeId:"assets",candidateId:"review",
  decisions:Object.fromEntries(proposed.map(asset=>[asset.id,{action:"new"}]))};
 const response=await app.inject({method:"POST",url:path,headers:{"x-p24":"ok"},payload});
 assert.equal(response.statusCode,200,response.body);
 const after=getProject(db,"asset-blank-board");
 assert.equal(after.revision,before.revision+1);
 assert.deepEqual(after.document.nodes.find(node=>node.id==="empty-board"),boardBefore);
 assert.equal(readAssetDraft(after.document.nodes.find(node=>node.id==="assets").metadata.dramaDraft).assets.length,14);
 assert.equal(after.document.nodes.find(node=>node.id==="assets").metadata.dramaConfirmed,base);
 const retry=await app.inject({method:"POST",url:path,headers:{"x-p24":"ok"},payload});
 assert.equal(retry.statusCode,409,retry.body);
 assert.equal(retry.json().code,"drama_asset_candidate_conflict");
});
test("P2.4: empty current storyboard draft with confirmed shots creates a mapped draft but keeps confirmation",t=>{
 const {db,get,service,command}=fixture(t);
 const before=get();
 const graph=structuredClone(before.document);
 const board=graph.nodes.find(node=>node.id==="board");
 const confirmed=board.metadata.dramaConfirmed;
 board.metadata.dramaDraft="";
 db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=?")
  .run(validateProjectDocument(graph),before.revision+1,"asset-p24");
 const result=adoptDramaAssetCandidates(service,"asset-p24",command({
  "generated-hero":{action:"variant",targetId:"hero"},
  "generated-prop":{action:"new"},
 }));
 assert.equal(result.revision,3);
 const after=get().document.nodes.find(node=>node.id==="board");
 assert.equal(after.metadata.dramaConfirmed,confirmed);
 const shots=readStoryboardDraft(after.metadata.dramaDraft).shots;
 assert.equal(shots[1].characterVariantIds[0],result.mapping.variantIds["blue-coat"]);
 assert.equal(shots[1].propIds[0],result.mapping.assetIds["generated-prop"]);
});
test("P2.4: nonempty invalid storyboard draft still rejects atomically (not silently skipped)",t=>{
 const {db,get,service,command}=fixture(t);
 const before=get();
 const graph=structuredClone(before.document);
 graph.nodes.find(node=>node.id==="board").metadata.dramaDraft="broken-storyboard";
 db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=?")
  .run(validateProjectDocument(graph),before.revision+1,"asset-p24");
 const snapshot=get();
 assert.throws(()=>adoptDramaAssetCandidates(service,"asset-p24",command({
  "generated-hero":{action:"variant",targetId:"hero"},
  "generated-prop":{action:"new"},
 })),/drama_asset_candidate_conflict/);
 assert.deepEqual(get().document,snapshot.document);
});
test("P2.4: old asset nodes with content-only drafts accept a matching candidate; changed baselines remain conflicts",t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 const base=JSON.stringify({assets});
 createProject(db,{id:"asset-content-only",document:{title:"Legacy",nodes:[{
  id:"assets",type:"drama:assets",metadata:{content:base,
   dramaAssetCandidate:{id:"review",baseline:base,assets:suggested}},
 }],connections:[]}});
 const svc={db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent};
 const command={nodeId:"assets",candidateId:"review",decisions:{
  "generated-hero":{action:"new"},"generated-prop":{action:"new"}}};
 const result=adoptDramaAssetCandidates(svc,"asset-content-only",command);
 assert.equal(result.revision,2);
 assert.equal(readAssetDraft(getProject(db,"asset-content-only").document.nodes[0].metadata.dramaDraft).assets.length,4);
 const stale=getProject(db,"asset-content-only");
 assert.throws(()=>adoptDramaAssetCandidates(svc,"asset-content-only",command),/drama_asset_candidate_conflict/);
 assert.equal(getProject(db,"asset-content-only").revision,stale.revision);
});
test("P2.4: authenticated adoption endpoint checks identity and rejects duplicate second apply",async t=>{
 const {db,get,service,command}=fixture(t);
 const app=buildApp({db,authorize:req=>req.headers["x-p24"]==="ok"});
 t.after(async()=>app.close());
 const path="/api/v1/projects/asset-p24/drama-pipeline/asset-candidates/adopt";
 const body=command({"generated-hero":{action:"variant",targetId:"hero"},
  "generated-prop":{action:"new"}});
 assert.equal((await app.inject({method:"POST",url:path,payload:body})).statusCode,401);
 const good=await app.inject({method:"POST",url:path,headers:{"x-p24":"ok"},payload:body});
 assert.equal(good.statusCode,200,good.body);
 assert.equal(good.json().revision,get().revision);
 const stale=await app.inject({method:"POST",url:path,headers:{"x-p24":"ok"},payload:body});
 assert.equal(stale.statusCode,409,stale.body);
});
