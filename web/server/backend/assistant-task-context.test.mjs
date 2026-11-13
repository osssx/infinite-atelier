import test from "node:test";
import assert from "node:assert/strict";
import {buildAssistantTaskProviderContext} from "./assistant-task-context.mjs";
const step=(i,kind,status="succeeded",receiptTrust="server_committed",result={})=>({
 id:"step-"+i,kind,status,receiptTrust,result
});
test("P3 factual Task context uses only trusted Step counts, preserves privacy after 20+ turns",()=>{
 const task={originalRequest:"创建分镜",status:"ready",activePlanVersion:1,
  contextPolicy:{includeContext:false,scope:"selection",includedIds:["secret-node"]},
  steps:Array.from({length:19},(_,i)=>step(i,"canvas_mutation","succeeded",
   "server_committed",{applied:1})).concat([
   step(19,"model_job","succeeded","server_committed",{jobId:"private-job",artifactIds:["a","b"]}),
   step(20,"materialize","succeeded","server_committed",{bindings:[{nodeId:"private-node"}]}),
   step(21,"canvas_mutation","running","none",{applied:1000}),
  ])};
 const doc={nodes:[{id:"secret-node",type:"text",title:"私人剧本文字",
  metadata:{content:"绝密拍摄内容"}}],connections:[]};
 const value=buildAssistantTaskProviderContext({task,document:doc});
 assert.match(value,/原始任务要求：创建分镜/);
 assert.match(value,/总步骤数：22/);
 assert.match(value,/已确认产物=2/);
 assert.match(value,/已核对落图=1/);
 assert.match(value,/可信回执=none/);
 assert.doesNotMatch(value,/已提交画布操作=1000/);
 for(const v of ["绝密拍摄内容","私人剧本文字","private-job","private-node"])
  assert.equal(value.includes(v),false,"leaked "+v);
 assert.ok(value.length<=12000);
});
test("P3 untrusted client-reported results cannot become server-backed facts",()=>{
 const value=buildAssistantTaskProviderContext({task:{
  originalRequest:"生成图像",status:"running",activePlanVersion:2,
  contextPolicy:{includeContext:false,scope:"selection",includedIds:[]},
  steps:[step(1,"model_job","succeeded","client_reported",{artifactIds:["fake"]})]
 },document:{nodes:[],connections:[]}});
 assert.doesNotMatch(value,/已确认产物=1/);
 assert.match(value,/client_reported/);
});
