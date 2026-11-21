import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {createDramaRunService,initDramaRuns} from "./drama-runs.mjs";
import {buildApp} from "./app.mjs";

const episode={id:"ep-two",title:"Episode two",synopsis:"Return",events:[],sourceRefs:[],ending:"End"};
const makeShot=propIds=>({id:"shot-two",episodeId:"ep-two",order:1,description:"Return home",
 characterVariantIds:[],sceneId:"home",propIds,keyPropIds:[]});
const graph=()=>({
 nodes:[
  {id:"story",type:"drama:source",metadata:{dramaConfirmed:"Story"}},
  {id:"assets",type:"drama:assets",metadata:{dramaConfirmed:JSON.stringify({assets:[
   {id:"lamp",kind:"prop",name:"Lamp",description:"Existing light",sourceRefs:[]},
   {id:"home",kind:"scene",name:"Home",description:"House",sourceRefs:[]},
  ]})}},
  {id:"episodes",type:"drama:episodes",metadata:{dramaConfirmed:JSON.stringify({episodes:[episode]})}},
  {id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots:[makeShot([])]})}},
 ],
 connections:[["story","assets"],["story","episodes"],["assets","board"],["episodes","board"]]
  .map(([fromNodeId,toNodeId],i)=>({id:"edge-"+i,fromNodeId,toNodeId})),
});
const request={requestId:"repair",nodeId:"board",episodeId:"ep-two",
 channelId:"channel",provider:"openai",model:"model"};

test("P1: invalid invented prop receives one bounded correction; persistent failure cannot publish",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);initDramaRuns(db);t.after(()=>db.close());
 createProject(db,{id:"semantic-repair",document:graph()});
 let calls=0;
 const service=createDramaRunService({db,getProject,validateDocument:validateProjectDocument,
  emitEvent:emitProjectEvent,async generate(config,input,baseline,signal,repair){
   calls++;
   if(!repair)return JSON.stringify({shots:[makeShot(["invented-prop"])]});
   assert.match(repair.reason,/shot_prop_invalid/);
   assert.match(repair.reason,/"props":\["lamp"\]/);
   assert.match(repair.reason,/禁止创造其他/);
   return JSON.stringify({shots:[makeShot(["lamp"])]});
  }});
 const ready=await service.submit("semantic-repair",request);
 assert.equal(ready.status,"ready");
 assert.equal(calls,2,"one initial model call and at most one correction");
 assert.deepEqual(ready.candidate.shots[0].propIds,["lamp"]);
 assert.deepEqual(JSON.parse(getProject(db,"semantic-repair").document.nodes[3].metadata.dramaDraft).shots[0].propIds,[]);
 const published=service.adopt("semantic-repair","repair");
 assert.deepEqual(JSON.parse(published.document.nodes[3].metadata.dramaDraft).shots[0].propIds,["lamp"]);
 let failures=0;
 const bad=createDramaRunService({db,getProject,validateDocument:validateProjectDocument,
  emitEvent:emitProjectEvent,async generate(){
   failures++;return JSON.stringify({shots:[makeShot(["invented-prop"])]});
  }});
 const failed=await bad.submit("semantic-repair",{...request,requestId:"still-bad"});
 assert.equal(failed.status,"failed");
 assert.equal(failed.error,"drama_candidate_invalid");
 assert.equal(failures,2,"no unbounded model retries");
 assert.equal(bad.get("semantic-repair","still-bad").candidate,null);
});

test("P1 HTTP: invalid prop appears as targeted repair guidance in assistant model messages",async t=>{
 let requests=0;
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner",
  assistantChat:async({messages})=>{
   requests++;
   if(requests===2){
    const correction=messages.at(-1).content;
    assert.match(correction,/shot_prop_invalid/);
    assert.match(correction,/"props":\["lamp"\]/);
    assert.match(correction,/未确认资产/);
   }
   return {answer:JSON.stringify({shots:[makeShot(requests===1?["invented-prop"]:["lamp"])]})};
  }});
 t.after(async()=>{await app.close();db.close();});
 const call=(method,url,payload)=>app.inject({method,url,headers:{"x-test-owner":"owner"},
  ...(payload===undefined?{}:{payload})});
 const project=await call("POST","/api/v1/projects",{id:"semantic-prompt",document:graph()});
 assert.equal(project.statusCode,201,project.body);
 const response=await call("POST","/api/v1/projects/semantic-prompt/drama-pipeline/runs",request);
 assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().status,"ready");
 assert.deepEqual(response.json().candidate.shots[0].propIds,["lamp"]);
 assert.equal(requests,2);
});
