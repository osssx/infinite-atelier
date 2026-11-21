import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,saveSingleUserCanvas,validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {createDramaRunService,initDramaRuns,exportDramaRuns,importDramaRuns} from "./drama-runs.mjs";
import {readStoryboardDraft} from "../canvas-text-content.mjs";

const episode=(id,sequences)=>({id,title:id,synopsis:"Plot",events:[],sourceRefs:[],ending:"End",
 sequences:sequences.map(id=>({id,title:id}))});
const shot=(id,episodeId,sequenceId,description)=>({id,episodeId,sequenceId,order:1,description,
 characterVariantIds:["hero-day"],sceneId:"home",sceneVariantId:"home-day",propIds:[],keyPropIds:[]});
const asset={assets:[
 {id:"hero",kind:"character",name:"Rabbit",description:"Shared",sourceRefs:[],
  variants:[{id:"hero-day",name:"Day",description:"Blue coat"}]},
 {id:"home",kind:"scene",name:"House",description:"Shared",sourceRefs:[],
  variants:[{id:"home-day",name:"Day",description:"Daylight"}]}
]};
function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);initDramaRuns(db);t.after(()=>db.close());
 const nodes=[
  {id:"story",type:"drama:source",metadata:{dramaConfirmed:"Rabbit visits house"}},
  {id:"assets",type:"drama:assets",metadata:{dramaConfirmed:JSON.stringify(asset)}},
  {id:"episodes",type:"drama:episodes",metadata:{dramaConfirmed:JSON.stringify({episodes:[
   episode("ep-one",["a"]),episode("ep-two",["first","second","third"])]})}},
  {id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots:[
   shot("e1","ep-one","a","First episode hand-tuned"),
   shot("s1","ep-two","first","Original 1"),
   shot("s2","ep-two","second","Original 2"),
   shot("s3","ep-two","third","Original 3")]})}},
  {id:"config-e1",type:"config",metadata:{dramaShotId:"e1",generationMode:"video",
   prompt:"Human first episode prompt",videoMode:"first_frame",seconds:"11"}},
  {id:"config-s3",type:"config",metadata:{dramaShotId:"s3",generationMode:"video",
   prompt:"Old historical third scene",seconds:"12"}},
 ];
 const edges=[["story","assets"],["story","episodes"],["assets","board"],["episodes","board"],
  ["board","config-e1"],["board","config-s3"]].map(([fromNodeId,toNodeId],i)=>({
   id:"edge-"+i,fromNodeId,toNodeId}));
 createProject(db,{id:"long",document:{title:"P2 long run",nodes,connections:edges}});
 const service=generate=>createDramaRunService({db,getProject,validateDocument:validateProjectDocument,
  emitEvent:emitProjectEvent,generate});
 const read=(id="long")=>getProject(db,id);
 const edit=(id,fn)=>{
  const current=read(id),board=current.document.nodes.find(item=>item.id==="board");
  const draft=readStoryboardDraft(board.metadata.dramaDraft);
  fn(draft.shots);
  board.metadata.dramaDraft=JSON.stringify(draft);
  saveSingleUserCanvas(db,{id,expectedRevision:current.revision,document:current.document});
 };
 return {db,service,read,edit};
}
test("P2.6: three-sequence failure survives ZIP/DB restart and resumes only remaining sequences",async t=>{
 const {db,service,read,edit}=fixture(t);
 const started=[],request={requestId:"long-run",nodeId:"board",episodeId:"ep-two",
  channelId:"fake",provider:"openai",model:"mock"};
 const generator=async(config,input)=>{
  const id=input.scope.sequenceId;
  started.push(id);
  if(id==="second"&&started.filter(value=>value==="second").length===1)
   throw Error("temporary model failure");
  const rows=id==="third"?[shot("s3-new","ep-two","third","Generated new shot")]:
   [shot(id==="first"?"s1":"s2","ep-two",id,"Generated "+id)];
  return JSON.stringify({shots:rows});
 };
 const first=service(generator);
 const failed=await first.submit("long",request);
 assert.equal(failed.status,"failed");
 assert.deepEqual(failed.candidate.completedSequenceIds,["first"]);
 assert.deepEqual(failed.candidate.shots.map(item=>item.id),["s1"]);
 assert.deepEqual(started,["first","second"]);
 const initial=read().document;
 const savedRun=exportDramaRuns(db,"long",initial);
 createProject(db,{id:"long-restored",document:initial});
 importDramaRuns(db,"long-restored",read("long-restored").document,savedRun);
 initDramaRuns(db);
 const reopened=service(generator);
 const resumed=await reopened.retry("long-restored",request.requestId);
 assert.equal(resumed.status,"ready");
 assert.deepEqual(started,["first","second","second","third"],
  "already completed first scene is never generated again");
 assert.deepEqual(resumed.candidate.completedSequenceIds,["first","second","third"]);
 const newShotId=resumed.candidate.shots.find(item=>item.sequenceId==="third").id;
 const e1Before=read("long-restored").document.nodes.find(item=>item.id==="config-e1");
 const s3Config=read("long-restored").document.nodes.find(item=>item.id==="config-s3");
 const edgesBefore=read("long-restored").document.connections;
 edit("long-restored",shots=>{
  shots.find(item=>item.id==="e1").description="First episode manual revision";
  shots.find(item=>item.id==="s2").description="Manually edited second scene";
  shots.push(shot("manual-third","ep-two","third","Human new third scene"));
 });
 const plan=reopened.preview("long-restored",request.requestId);
 assert.equal(plan.fullAdoptBlocked,true);
 assert.ok(plan.manualExtraIds.includes("manual-third"));
 assert.equal(plan.items.find(item=>item.id==="s2").conflict,true);
 assert.equal(plan.items.find(item=>item.id==="s1").conflict,false);
 assert.equal(plan.items.find(item=>item.id==="s3").kind,"deleted");
 assert.equal(plan.items.find(item=>item.id===newShotId).kind,"added");
 assert.throws(()=>reopened.adopt("long-restored",request.requestId),/drama_candidate_conflict/);
 assert.throws(()=>reopened.adopt("long-restored",request.requestId,["s2"]),/drama_candidate_conflict/);
 reopened.adopt("long-restored",request.requestId,["s1",newShotId,"s3"]);
 const current=read("long-restored"),nodes=current.document.nodes;
 const shots=readStoryboardDraft(nodes.find(item=>item.id==="board").metadata.dramaDraft).shots;
 assert.equal(shots.find(item=>item.id==="e1").description,"First episode manual revision");
 assert.equal(shots.find(item=>item.id==="s1").description,"Generated first");
 assert.equal(shots.find(item=>item.id==="s2").description,"Manually edited second scene");
 assert.equal(shots.find(item=>item.id==="manual-third").description,"Human new third scene");
 assert.equal(shots.find(item=>item.id==="s3"),undefined);
 assert.equal(shots.find(item=>item.id===newShotId).description,"Generated new shot");
 assert.deepEqual(nodes.find(item=>item.id==="config-e1"),e1Before);
 assert.deepEqual(nodes.find(item=>item.id==="config-s3"),s3Config);
 assert.deepEqual(current.document.connections,edgesBefore);
 const pending=reopened.get("long-restored",request.requestId);
 assert.deepEqual(new Set(pending.candidate.adoptedShotIds),new Set(["s1",newShotId]));
 assert.deepEqual(pending.candidate.adoptedRemovedShotIds,["s3"]);
 assert.equal(pending.status,"ready");
 // A second restart must still expose adopted markers and untouched conflict.
 const again=exportDramaRuns(db,"long-restored",current.document);
 createProject(db,{id:"long-twice",document:current.document});
 importDramaRuns(db,"long-twice",read("long-twice").document,again);
 const final=service(generator).preview("long-twice",request.requestId);
 assert.ok(final.items.find(item=>item.id==="s1").adopted);
 assert.ok(final.items.find(item=>item.id==="s3").adopted);
 assert.equal(final.items.find(item=>item.id==="s2").conflict,true);
 assert.equal(final.manualExtraIds.includes("manual-third"),true);
});
