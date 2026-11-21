import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,saveSingleUserCanvas,validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {initDramaRuns,createDramaRunService,exportDramaRuns,importDramaRuns} from "./drama-runs.mjs";
import {planDramaShotDiff,mergeDramaSelectedShots} from "./drama-run-diff.mjs";
import {buildApp} from "./app.mjs";

const episode=id=>({id,title:id,synopsis:"Story",events:[],sourceRefs:[],ending:"End"});
const shot=(id,episodeId,order,description,sequenceId)=>({id,episodeId,order,description,
 characterVariantIds:[],propIds:[],keyPropIds:[],...(sequenceId?{sequenceId}:{})});
function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);initDramaRuns(db);
 t.after(()=>db.close());
 const original=[shot("first","one",1,"First"),shot("a","two",1,"Before A"),
  shot("b","two",2,"Before B")];
 const document={title:"P2.2 fixture",
 nodes:[
  {id:"story",type:"drama:source",metadata:{dramaConfirmed:"Two episodes"}},
  {id:"assets",type:"drama:assets",metadata:{dramaConfirmed:'{"assets":[]}'}},
  {id:"episodes",type:"drama:episodes",metadata:{dramaConfirmed:JSON.stringify({episodes:[episode("one"),episode("two")]})}},
  {id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots:original})}},
 ],
 connections:[["story","assets"],["story","episodes"],["assets","board"],["episodes","board"]]
  .map(([fromNodeId,toNodeId],i)=>({id:"edge-"+i,fromNodeId,toNodeId}))};
 createProject(db,{id:"p22",document});
 const service=createDramaRunService({db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent,
  async generate(){
   return JSON.stringify({shots:[shot("a","two",3,"Updated A"),
    shot("new","two",2,"New shot")]});
  }});
 const update=fn=>{
  const current=getProject(db,"p22"),board=current.document.nodes[3];
  const parsed=JSON.parse(board.metadata.dramaDraft);
  fn(parsed.shots);
  board.metadata.dramaDraft=JSON.stringify(parsed);
  saveSingleUserCanvas(db,{id:"p22",expectedRevision:current.revision,document:current.document});
 };
 const read=()=>JSON.parse(getProject(db,"p22").document.nodes[3].metadata.dramaDraft).shots;
 const request={requestId:"generate-two",nodeId:"board",episodeId:"two",channelId:"channel",
  provider:"openai",model:"fake"};
 return {db,service,request,update,read};
}
test("P2.2 diff reports added/replaced/deleted/reordered without classifying manual extras as candidate",()=>{
 const initial=[shot("a","two",1,"A"),shot("b","two",2,"B")];
 const proposed=[shot("a","two",3,"A"),shot("c","two",2,"C")];
 const plan=planDramaShotDiff({baseline:initial,current:initial,candidate:proposed});
 assert.deepEqual(plan.items.map(item=>[item.id,item.kind]),[
  ["a","reordered"],["c","added"],["b","deleted"]]);
 assert.deepEqual(plan.summary,{added:1,replaced:0,deleted:1,reordered:1,unchanged:0,conflicts:0});
 assert.equal(plan.fullAdoptBlocked,false);
 assert.deepEqual(plan.manualExtraIds,[]);
 const merged=mergeDramaSelectedShots([...initial],new Set(["a","b","c"]),proposed);
 assert.deepEqual(merged.map(item=>item.id),["c","a"]);
 assert.equal(merged[1].order,3);
});
test("P2.2 partial adoption keeps manual edits and detects deletion conflicts independently",async t=>{
 const {db,service,request,read,update}=fixture(t);
 const ready=await service.submit("p22",request);
 assert.equal(ready.status,"ready");
 const added=ready.candidate.shots.find(item=>item.id!=="a");
 assert.ok(added);
 const before=service.preview("p22",request.requestId);
 assert.deepEqual(before.items.map(item=>[item.id,item.kind]),[
  ["a","replaced"],[added.id,"added"],["b","deleted"]]);
 assert.equal(before.items.find(item=>item.id==="a").reordered,true);
 update(shots=>{
  shots.find(item=>item.id==="first").description="Manual first";
  shots.find(item=>item.id==="b").description="Manual B";
  shots.push(shot("manual-extra","two",4,"Human addition"));
 });
 const pending=service.preview("p22",request.requestId);
 assert.deepEqual(pending.manualExtraIds,["manual-extra"]);
 assert.equal(pending.fullAdoptBlocked,true);
 assert.equal(pending.items.find(item=>item.id==="b").conflict,true);
 assert.equal(pending.items.find(item=>item.id==="a").conflict,false);
 assert.equal(pending.items.find(item=>item.id===added.id).conflict,false);
 assert.throws(()=>service.adopt("p22",request.requestId),/drama_candidate_conflict/);
 assert.throws(()=>service.adopt("p22",request.requestId,["b"]),/drama_candidate_conflict/);
 const partial=service.adopt("p22",request.requestId,["a",added.id]);
 assert.equal(partial.revision,getProject(db,"p22").revision);
 assert.equal(read().find(item=>item.id==="b").description,"Manual B");
 assert.equal(read().find(item=>item.id==="first").description,"Manual first");
 assert.equal(read().find(item=>item.id==="manual-extra").description,"Human addition");
 assert.equal(read().find(item=>item.id==="a").description,"Updated A");
 assert.equal(read().find(item=>item.id===added.id).description,"New shot");
 const repeated=service.adopt("p22",request.requestId,["a",added.id]);
 assert.equal(repeated.revision,partial.revision,"idempotent partial reapply");
 const saved=service.get("p22",request.requestId);
 assert.deepEqual(new Set(saved.candidate.adoptedShotIds),new Set(["a",added.id]));
 assert.deepEqual(service.preview("p22",request.requestId).items.filter(item=>item.adopted).map(item=>item.id),
  ["a",added.id]);
 update(shots=>{
  shots.splice(shots.findIndex(item=>item.id==="manual-extra"),1);
  shots.find(item=>item.id==="b").description="Before B";
 });
 const finalPreview=service.preview("p22",request.requestId);
 assert.equal(finalPreview.fullAdoptBlocked,false);
 const applied=service.adopt("p22",request.requestId);
 assert.equal(applied.revision,getProject(db,"p22").revision);
 assert.equal(service.get("p22",request.requestId).status,"adopted");
 assert.equal(read().some(item=>item.id==="b"),false);
 assert.equal(read().find(item=>item.id==="first").description,"Manual first");
 const exported=exportDramaRuns(db,"p22",getProject(db,"p22").document);
 createProject(db,{id:"p22-import",document:getProject(db,"p22").document});
 importDramaRuns(db,"p22-import",getProject(db,"p22-import").document,exported);
 assert.equal(service.get("p22-import",request.requestId).status,"adopted");
 assert.deepEqual(service.get("p22-import",request.requestId).candidate.adoptedRemovedShotIds,["b"]);
});
test("P2.2 selecting only deleted shot retains its historical video Config and graph link",async t=>{
 const {service,request,read,db}=fixture(t);
 const project=getProject(db,"p22");
 const oldConfig={id:"legacy-video",type:"config",metadata:{dramaShotId:"b",generationMode:"video",
  prompt:"Human video prompt",seconds:"9"}};
 const oldLink={id:"legacy-video-edge",fromNodeId:"board",toNodeId:"legacy-video"};
 project.document.nodes.push(oldConfig);
 project.document.connections.push(oldLink);
 saveSingleUserCanvas(db,{id:"p22",expectedRevision:project.revision,document:project.document});
 const ready=await service.submit("p22",request);
 const candidateAdded=ready.candidate.shots.find(item=>item.id!=="a").id;
 const partial=service.adopt("p22",request.requestId,["b"]);
 assert.equal(read().some(item=>item.id==="b"),false);
 assert.equal(read().find(item=>item.id==="a").description,"Before A");
 assert.equal(read().some(item=>item.id===candidateAdded),false);
 const graph=getProject(db,"p22").document;
 assert.deepEqual(graph.nodes.find(item=>item.id==="legacy-video"),oldConfig);
 assert.deepEqual(graph.connections.find(edge=>edge.id==="legacy-video-edge"),oldLink);
 assert.equal(service.adopt("p22",request.requestId,["b"]).revision,partial.revision);
 const remaining=service.preview("p22",request.requestId);
 assert.equal(remaining.items.find(item=>item.id==="b").adopted,true);
 assert.equal(remaining.items.find(item=>item.id==="b").conflict,false);
 assert.equal(remaining.items.find(item=>item.id==="a").adopted,false);
});test("P2.2 full completion after all selective accepts changes only the run state",async t=>{
 const {service,request,db}=fixture(t);
 await service.submit("p22",request);
 const diff=service.preview("p22",request.requestId);
 const all=diff.items.filter(item=>item.changed).map(item=>item.id);
 const partial=service.adopt("p22",request.requestId,all);
 assert.equal(service.get("p22",request.requestId).status,"ready");
 const complete=service.adopt("p22",request.requestId);
 assert.equal(complete.revision,partial.revision,"no duplicate project revision");
 assert.equal(service.get("p22",request.requestId).status,"adopted");
 assert.equal(getProject(db,"p22").revision,partial.revision);
});
test("P2.2 authenticated read-only preview and selected deletion API preserve authorization",async t=>{
 const {db,service,request,read}=fixture(t);
 await service.submit("p22",request);
 const app=buildApp({db,authorize:req=>req.headers["x-p22-owner"]==="yes"});
 t.after(async()=>app.close());
 const base="/api/v1/projects/p22/drama-pipeline/runs/"+request.requestId;
 assert.equal((await app.inject({method:"GET",url:base+"/preview"})).statusCode,401);
 const view=await app.inject({method:"GET",url:base+"/preview",headers:{"x-p22-owner":"yes"}});
 assert.equal(view.statusCode,200,view.body);
 assert.equal(view.json().summary.deleted,1);
 assert.equal(view.json().items.find(item=>item.id==="b").kind,"deleted");
 const response=await app.inject({method:"POST",url:base+"/adopt",
  headers:{"x-p22-owner":"yes"},payload:{shotIds:["b"]}});
 assert.equal(response.statusCode,200,response.body);
 assert.equal(read().some(item=>item.id==="b"),false);
});
