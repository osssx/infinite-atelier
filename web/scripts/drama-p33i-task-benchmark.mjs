/** P3.3i: reproducible local Task path benchmark, no GPU/model/HTTP calls.
 * node --expose-gc scripts/drama-p33i-task-benchmark.mjs [trials=12]
 * Measures planning, approval, claim, commit, and SQLite reopen/recovery.
 * Samples RSS/heap AFTER stages (not synchronous peak memory).
 */
import assert from "node:assert/strict";
import {performance} from "node:perf_hooks";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {initializeSchema} from "../server/backend/schema.mjs";
import {createProject,getProject} from "../server/backend/projects.mjs";
import {createAssistantTask} from "../server/backend/assistant-tasks.mjs";
import {planAssistantCanvasStep,commitAssistantCanvasAttempt,recoverAssistantCanvasTasksAtStartup}
 from "../server/backend/assistant-task-canvas-executor.mjs";
import {decideAssistantTaskStep,claimAssistantTaskStep} from "../server/backend/assistant-task-step-gate.mjs";

const count=Math.min(40,Math.max(1,Number.parseInt(process.argv[2]??"12",10)||12));
const assets=Array.from({length:50},(_,i)=>({id:i?"prop-"+i:"hero",kind:i?"prop":"character",
 name:"Asset "+i,description:"Description "+i,sourceRefs:[]}));
const episodes=Array.from({length:4},(_,i)=>({id:"ep-"+i,title:"Episode "+i,
 synopsis:"Scene "+i,ending:"End "+i,events:[],eventItems:[],sourceRefs:[]}));
const shots=Array.from({length:100},(_,i)=>({id:"shot-"+i,episodeId:"ep-"+Math.floor(i/25),
 order:i%25,description:"Shot "+i,characterVariantIds:[],propIds:[],keyPropIds:[]}));
const graph=()=>({title:"Task benchmark 200 nodes, 100 shots",nodes:[
 {id:"assets",type:"drama:assets",metadata:{dramaDraft:JSON.stringify({assets}),dramaConfirmed:JSON.stringify({assets})}},
 {id:"episodes",type:"drama:episodes",metadata:{dramaDraft:JSON.stringify({episodes}),dramaConfirmed:JSON.stringify({episodes})}},
 {id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots}),dramaConfirmed:JSON.stringify({shots})}},
 ...Array.from({length:197},(_,i)=>({id:"text-"+i,type:"text",metadata:{content:"safe "+i}}))
 ],connections:[{id:"assets-board",fromNodeId:"assets",toNodeId:"board"},
 {id:"episodes-board",fromNodeId:"episodes",toNodeId:"board"}]});
const actions=[
 {type:"patch_drama_asset",nodeId:"assets",assetId:"hero",changes:{description:"Modified"}},
 {type:"patch_drama_episode",nodeId:"episodes",episodeId:"ep-3",changes:{synopsis:"Modified"}},
 {type:"patch_storyboard_shot",nodeId:"board",shotId:"shot-75",changes:{description:"Modified"}}
];
const times={},mem={},notes=[];
function record(label,time){
 (times[label]??=[]).push(performance.now()-time);
 const rss=process.memoryUsage();
 (mem[label]??=[]).push({rssMiB:+(rss.rss/1048576).toFixed(2),
  heapMiB:+(rss.heapUsed/1048576).toFixed(2)});
}
const summary=arr=>{
 const sorted=[...arr].sort((a,b)=>a-b);
 return {medianMs:+sorted[Math.floor((sorted.length-1)/2)].toFixed(3),
  p95Ms:+sorted[Math.ceil(sorted.length*.95)-1].toFixed(3),
  minMs:+sorted[0].toFixed(3),maxMs:+sorted.at(-1).toFixed(3)};
};
const fileRoot=mkdtempSync(join(tmpdir(),"atelier-p33i-benchmark-"));
try{
 for(let i=0;i<count;i++){
  if(global.gc)global.gc();
  const file=join(fileRoot,"trial-"+i+".sqlite");
  let db=new DatabaseSync(file);
  try{
   let tick=performance.now();
   initializeSchema(db);
   const project=createProject(db,{id:"p",document:graph()});
   const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",
    rootMessageId:"root",originalRequest:"bench",requestId:"create"}).task;
   record("fixture",tick);
   tick=performance.now();
   const plan=planAssistantCanvasStep(db,{projectId:"p",taskId:task.id,requestId:"plan",
    expectedPlanVersion:1,expectedProjectRevision:project.revision,
    actions,center:{x:0,y:0},dependsOn:[],finalizeTask:false});
   assert.equal(db.prepare("SELECT json_extract(preconditions_json,'$.scopedPatches.schemaVersion') AS version FROM assistant_task_steps").get().version,1);
   record("plan",tick);
   tick=performance.now();
   decideAssistantTaskStep(db,{projectId:"p",taskId:task.id,stepId:plan.stepId,
    requestId:"approval",expectedPlanVersion:1,actionDigest:plan.actionDigest,decision:"approve"});
   record("approval",tick);
   tick=performance.now();
   const claim=claimAssistantTaskStep(db,{projectId:"p",taskId:task.id,stepId:plan.stepId,expectedPlanVersion:1});
   record("claim",tick);
   tick=performance.now();
   const completed=commitAssistantCanvasAttempt(db,{projectId:"p",taskId:task.id,stepId:plan.stepId,
    attemptId:claim.attemptId,leaseOwner:claim.leaseOwner,planVersion:1,actionDigest:plan.actionDigest});
   assert.equal(completed.receipt.executionPath,"scoped_cas");
   assert.equal(getProject(db,"p",{compact:true}).revision,2);
   record("commit",tick);
   db.close();
   tick=performance.now();
   db=new DatabaseSync(file);initializeSchema(db);
   const recovery=recoverAssistantCanvasTasksAtStartup(db);
   assert.equal(recovery.unknown,0);
   assert.equal(db.prepare("SELECT status FROM assistant_task_steps").get().status,"succeeded");
   record("restart",tick);
  }finally{db.close()}
 }
 const stage=Object.fromEntries(Object.entries(times).map(([k,v])=>[k,summary(v)]));
 const memory=Object.fromEntries(Object.entries(mem).map(([k,v])=>[k,{
  maxSampledRssMiB:Math.max(...v.map(s=>s.rssMiB)),
  maxSampledHeapMiB:Math.max(...v.map(s=>s.heapMiB))}]));
 console.log("P33I_TASK_BENCHMARK "+JSON.stringify({samples:count,nodeCount:200,
  assetCount:50,episodeCount:4,shotCount:100,stage,memory,notes:[
   "Windows desktop local SQLite, real worktree, isolated temporary databases",
   "Memory snapshots are observed after synchronous stages, not exact peak",
   "Duration is environment-dependent; not a 60 fps rendering benchmark",
   "No Comfy UI, GPU or provider call in this benchmark"]}));
}finally{rmSync(fileRoot,{recursive:true,force:true,maxRetries:6,retryDelay:80})}
