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
function fixture(t,choices=suggested,references=[]){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 const base=JSON.stringify({assets});
 const board=JSON.stringify({shots:[shot("old","ep-one","hero-day"),
  shot("new","ep-two","blue-coat",["generated-prop"])]});
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
