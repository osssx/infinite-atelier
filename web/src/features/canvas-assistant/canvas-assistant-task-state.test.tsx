// @vitest-environment happy-dom
import {act,createElement,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {CanvasAssistantSession} from "@/types/canvas";

const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:mocks.api}));
import {useCanvasAssistantTasks} from "./canvas-assistant-task-state";

let root:Root|null=null,container:HTMLDivElement|null=null;
const session:CanvasAssistantSession={id:"chat-a",title:"示例任务",
 createdAt:"2026-11-12",updatedAt:"2026-11-12",
 messages:[{id:"original-user",role:"user",text:"创建三个分镜节点"}]};
function Harness({activeChatId="chat-a",runSequence}:{activeChatId?:string;
 runSequence?:(taskId:string,view:unknown)=>Promise<void>}){
 const [draft,setDraft]=useState("");
 const state=useCanvasAssistantTasks({
  projectId:"project",activeChatId,session:activeChatId==="chat-a"?session:undefined,
  open:true,sending:false,includeContext:false,scope:"selection",
  includedIds:["private-node"],onDraft:setDraft,onRunSequenceStep:runSequence
 });
 return createElement("div",{},state.view,
  createElement("button",{type:"button",onClick:()=>void state.recordTurn(state.activeTaskId,"later-msg","继续",new AbortController().signal)},"记录下一条"),
  createElement("button",{type:"button",onClick:()=>void state.observe(state.activeTaskId,"later-msg","error","Skill 退出码 9009")},"记录失败"),
  createElement("output",{"aria-label":"续写草稿"},"草稿："+draft));
}
async function render(activeChatId?:string){
 container=document.createElement("div");document.body.appendChild(container);root=createRoot(container);
 await act(async()=>{root!.render(createElement(Harness,{activeChatId}));});
}
async function click(label:string){
 const button=Array.from(container!.querySelectorAll("button")).find(b=>b.textContent===label);
 expect(button,label).toBeTruthy();
 await act(async()=>{button!.click();await Promise.resolve();});
}
beforeEach(()=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 mocks.api.mockReset();
 let task:Record<string,unknown>|null=null;
 mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
  if(method==="GET"&&url.includes("chatSessionId="))return {tasks:task?[task]:[]};
  if(method==="GET")return {task};
  if(method==="POST"&&url.endsWith("/assistant/tasks")){
   task={id:"task-a",chatSessionId:"chat-a",rootMessageId:payload?.rootMessageId,
    originalRequest:payload?.originalRequest,status:"planning",steps:[],recoveryMode:"guidance_only"};
   return {task};
  }
  if(method==="POST"&&url.endsWith("/cancel")){task={...task,status:"cancelled"};return {task,executionStarted:false};}
  if(method==="POST"&&url.endsWith("/observations")){task={...task,lastError:payload?.kind==="error"?payload.preview:null};return {task};}
  if(method==="POST"&&url.endsWith("/resume"))return {task,executionStarted:false};
  if(method==="POST"&&url.endsWith("/turns"))return {task};
  throw Error("unexpected task request: "+method+" "+url);
 });
});
afterEach(async()=>{if(root)await act(async()=>{root!.unmount();});root=null;container?.remove();container=null;});
describe("P3b persisted multi-run UI resume",()=>{
 it("loads the next frozen target after refresh and never invents a second Job",async()=>{
  const task={id:"task-seq",chatSessionId:"chat-a",rootMessageId:"original-user",
   originalRequest:"生成两段",status:"ready",recoveryMode:"job_observation",steps:[]};
  const actions=[{type:"run_node" as const,nodeId:"first",mode:"text" as const},
   {type:"run_node" as const,nodeId:"second",mode:"text" as const}];
  let submitted=false;
  const view={sequence:{id:"seq-1",taskId:task.id,sourceMessageId:"original-user",
   planVersion:1,actions,status:"active"},state:"ready",
   next:{index:1,action:actions[1],dependsOn:["trusted-material"],last:true}};
  const runner=vi.fn(async(_taskId:string,_view:unknown)=>{
   submitted=true;
  });
  mocks.api.mockImplementation(async(url:string,method:string)=>{
   if(method!=="GET")throw Error("resume view must not POST on its own");
   if(url.includes("chatSessionId="))return {tasks:[task]};
   if(url.endsWith("/model-calls"))return {calls:[]};
   if(url.endsWith("/run-sequences"))return submitted?{...view,state:"waiting_approval",next:null}:view;
   return {task};
  });
  container=document.createElement("div");document.body.appendChild(container);
  root=createRoot(container);
  await act(async()=>root!.render(createElement(Harness,{runSequence:runner})));
  expect(container!.textContent).toContain("顺序生成计划：2 项");
  await click("继续第 2/2 项生成（需审批）");
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner.mock.calls[0][0]).toBe("task-seq");
  expect(runner.mock.calls[0][1]).toMatchObject({sequence:{id:"seq-1"},next:{index:1}});
  expect(container!.textContent).not.toContain("继续第 2/2 项生成（需审批）");
  expect(mocks.api.mock.calls.every(call=>call[1]==="GET")).toBe(true);
 });
});
describe("P3 task progress and read-only event pagination",()=>{
 it("shows trusted materialization and paginates 10+ turn evidence without executing steps",async()=>{
  const steps=[
   {id:"canvas",kind:"canvas_mutation",planVersion:1,ordinal:0,
    status:"succeeded",receiptTrust:"server_committed",actionDigest:"a".repeat(64)},
   {id:"job",kind:"model_job",planVersion:1,ordinal:1,
    status:"succeeded",receiptTrust:"server_committed",actionDigest:"b".repeat(64),
    result:{jobId:"existing-job-1"}},
   {id:"materialize",kind:"materialize",planVersion:1,ordinal:2,
    status:"succeeded",receiptTrust:"server_committed",actionDigest:"c".repeat(64)}
  ];
  const task={id:"task-p3-events",chatSessionId:"chat-a",rootMessageId:"original-user",
   originalRequest:"生成图片并落图",status:"ready",recoveryMode:"job_observation",steps};
  const seen:number[]=[];
  mocks.api.mockImplementation(async(url:string,method:string)=>{
   if(method!=="GET")throw Error("event view must be read only");
   if(url.includes("chatSessionId="))return {tasks:[task]};
   if(url.endsWith("/model-calls"))return {calls:[]};
   if(url.includes("/events?")){
    const cursor=Number(new URL("http://localhost"+url).searchParams.get("afterSeq")??0);
    seen.push(cursor);
    return cursor===0?{events:Array.from({length:30},(_,i)=>({seq:i+1,
     stepId:null,kind:"user_turn",createdAt:i+1})),nextSeq:30,hasMore:true}:
     {events:[{seq:31,stepId:"materialize",kind:"materialize_verified",createdAt:31}],
      nextSeq:31,hasMore:false};
   }
   return {task};
  });
  await render();
  expect(container!.textContent).toContain("可信完成：3/3");
  expect(container!.textContent).toContain("已核对生成产物和落图");
  expect(container!.textContent).toContain("继续");
  await click("查看任务事件（只读）");
  expect(container!.textContent).toContain("1 · user_turn");
  await click("加载更多事件");
  expect(container!.textContent).toContain("31 · materialize_verified");
  expect(seen).toEqual([0,30]);
  expect(mocks.api.mock.calls.every(call=>call[1]==="GET")).toBe(true);
  await click("收起任务事件");
  expect(container!.textContent).not.toContain("31 · materialize_verified");
 });
});
describe("P2a Task external Job UI",()=>{
 it("requires explicit approval, enqueues with frozen Step identity and only observes on refresh",async()=>{
  const step={id:"external-step-1",kind:"model_job",planVersion:1,
   status:"waiting_approval",actionDigest:"a".repeat(64),receiptTrust:"none",
   action:{job:{targetNodeId:"source",executionMode:"poll",snapshot:{adapterKind:"model"}}},
   result:{}};
  let task={id:"task-ext",chatSessionId:"chat-a",rootMessageId:"original-user",
   originalRequest:"生成图片",status:"waiting_approval",recoveryMode:"job_observation",steps:[step]};
  mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
   if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
   if(method==="GET")return {task};
   if(method==="POST"&&url.endsWith("/approval")){
    expect(payload?.actionDigest).toBe(step.actionDigest);
    expect(payload?.decision).toBe("approve");
    step.status="ready";return {status:"ready"};
   }
   if(method==="POST"&&url.endsWith("/enqueue")){
    expect(payload).toEqual({requestId:"external-step-1-external-enqueue",
     expectedPlanVersion:1,actionDigest:step.actionDigest});
    step.status="waiting_external";step.result={jobId:"existing-job-1"};
    task={...task,status:"waiting_external"};
    return {jobId:"existing-job-1",status:"waiting_external"};
   }
   if(method==="POST"&&url.endsWith("/reconcile"))return {advanced:0};
   throw Error("unexpected request "+method+" "+url);
  });
  await render();
  expect(container!.textContent).toContain("生成与落图分阶段对账");
  expect(container!.textContent).toContain("批准并入队（可能计费）");
  expect(mocks.api.mock.calls.some(call=>String(call[0]).endsWith("/enqueue"))).toBe(false);
  await click("批准并入队（可能计费）");
  expect(container!.textContent).toContain("Job ID：existing-job-1");
  expect(mocks.api.mock.calls.filter(call=>String(call[0]).endsWith("/enqueue"))).toHaveLength(1);
  await click("检查生成与落图状态（不重新提交）");
  expect(mocks.api.mock.calls.filter(call=>String(call[0]).endsWith("/enqueue"))).toHaveLength(1);
  expect(mocks.api.mock.calls.filter(call=>String(call[0]).endsWith("/reconcile"))).toHaveLength(2);
 });
});


describe("P2b Task Skill recovery UI",()=>{
 it("shows original Run ID and cannot resubmit unknown Skill from a refresh",async()=>{
  const step={id:"skill-step",kind:"skill_script",planVersion:1,
   status:"waiting_approval",actionDigest:"e".repeat(64),receiptTrust:"none",
   action:{skill_id:"fixture-skill",version:"abcdef123456",script_path:"scripts/render.js"},
   result:{}};
  let task={id:"task-skill",chatSessionId:"chat-a",rootMessageId:"original-user",
   originalRequest:"执行 Skill",status:"waiting_approval",recoveryMode:"skill_audit",steps:[step]};
  mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
   if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
   if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
   if(method==="GET")return {task};
   if(method==="POST"&&url.endsWith("/approval")){
    expect(payload?.actionDigest).toBe(step.actionDigest);
    expect(payload?.decision).toBe("approve");
    step.status="ready";return {status:"ready"};
   }
   if(method==="POST"&&url.endsWith("/run-skill")){
    expect(payload).toEqual({requestId:"skill-step-skill-execute",
     expectedPlanVersion:1,actionDigest:step.actionDigest});
    step.status="needs_reconcile";step.result={runId:"original-run-1",status:"needs_reconcile"};
    task={...task,status:"needs_reconcile"};return {runId:"original-run-1",
     status:"needs_reconcile",shouldLaunch:false};
   }
   throw Error("unexpected "+method+" "+url);
  });
  await render();
  expect(container!.textContent).toContain("批准并运行 Skill");
  expect(mocks.api.mock.calls.some(c=>String(c[0]).endsWith("/run-skill"))).toBe(false);
  await click("批准并运行 Skill");
  expect(container!.textContent).toContain("Run ID：original-run-1");
  expect(container!.textContent).toContain("上次执行结果不明");
  expect(container!.textContent).not.toContain("运行已批准的 Skill");
  expect(mocks.api.mock.calls.filter(c=>String(c[0]).endsWith("/run-skill"))).toHaveLength(1);
 });
});
describe("P0a guidance-only task strip",()=>{
 it("creates from an existing user message, retains privacy scope, and does not execute tasks automatically",async()=>{
  await render();
  expect(container!.textContent).toContain("未关联任务");
  await click("记录为任务");
  const created=mocks.api.mock.calls.find(call=>call[1]==="POST"&&String(call[0]).endsWith("/assistant/tasks"));
  expect(created?.[2].rootMessageId).toBe("original-user");
  expect(created?.[2].contextPolicy).toEqual({includeContext:false,scope:"selection",includedIds:[]});
  expect(container!.textContent).toContain("仅指导恢复");
  await click("记录下一条");
  const turn=mocks.api.mock.calls.find(call=>String(call[0]).endsWith("/turns"));
  expect(turn?.[2].requestId).toBe("later-msg");
  await click("记录失败");
  expect(container!.textContent).toContain("上次错误：Skill 退出码 9009");
  await click("继续");
  expect(container!.textContent).toContain("草稿：继续");
  expect(mocks.api.mock.calls.filter(call=>String(call[0]).endsWith("/resume"))).toHaveLength(1);
  expect(mocks.api.mock.calls.some(call=>String(call[0]).includes("/assistant/chat"))).toBe(false);
  await click("结束记录");
  expect(container!.textContent).toContain("已结束记录");
 });
 it("shows an uncertain provider call without offering an automatic rerun",async()=>{
  const original=mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async(...args:unknown[])=>String(args[0]).endsWith("/model-calls")?{
   calls:[{id:"recorded-model-call",kind:"initial",status:"needs_reconcile"}]
  }:original(...args));
  await render();
  await click("记录为任务");
  expect(container!.textContent).toContain("存在结果不明的模型请求，不会自动重发");
  await click("模型调用记录 (1)");
  expect(container!.textContent).toContain("initial · needs_reconcile");
 });
 it("only loads tasks for its active session",async()=>{
  await render("chat-b");
  expect(mocks.api.mock.calls[0][0]).toContain("chatSessionId=chat-b");
  expect(container!.textContent).toContain("未关联任务");
  expect(container!.textContent).not.toContain("记录为任务");
 });
});
