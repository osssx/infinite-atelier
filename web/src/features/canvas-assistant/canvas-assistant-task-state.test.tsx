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
function Harness({activeChatId="chat-a",runSequence,generate}:{activeChatId?:string;
 runSequence?:(taskId:string,view:unknown)=>Promise<void>;
 generate?:(taskId:string,turnId:string,signal:AbortSignal)=>Promise<void>}){ const [draft,setDraft]=useState("");
 const state=useCanvasAssistantTasks({
  projectId:"project",activeChatId,session:activeChatId==="chat-a"?session:undefined,
  open:true,sending:false,includeContext:false,scope:"selection",
   includedIds:["private-node"],onDraft:setDraft,onRunSequenceStep:runSequence,
   onGenerateSemanticProposals:generate });
 return createElement("div",{},state.view,
  createElement("button",{type:"button",onClick:()=>void state.recordTurn(state.activeTaskId,"later-msg","继续",new AbortController().signal)},"记录下一条"),
  createElement("button",{type:"button",onClick:()=>void state.observe(state.activeTaskId,"later-msg","error","Skill 退出码 9009")},"记录失败"),
  createElement("output",{"aria-label":"续写草稿"},"草稿："+draft));
}
async function render(activeChatId?:string,
 generate?:(taskId:string,turnId:string,signal:AbortSignal)=>Promise<void>){
 container=document.createElement("div");document.body.appendChild(container);root=createRoot(container);
 await act(async()=>{root!.render(createElement(Harness,{activeChatId,generate}));});
}async function click(label:string){
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
it.each(["agent","structured"])("allows explicit revocation of an approved unexecuted %s Step",async kind=>{
 let task={id:"agent-task",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
  rootMessageId:"original-user",originalRequest:"检查并创建节点",status:"ready",activePlanVersion:1,
  recoveryMode:"canvas_transaction",steps:[{id:"agent-step",kind:"canvas_mutation",planVersion:1,
   status:"ready",actionDigest:"a".repeat(64),canRevokeApproval:kind==="structured",
   action:{actions:[],...(kind==="agent"?{agentRunId:"ar_test"}:{deliverableSpecDigest:"b".repeat(64)})}}]};
 mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
  if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
  if(method==="POST"&&url.endsWith("/approval")){
   expect(payload?.decision).toBe("reject");
   task={...task,status:"blocked",steps:task.steps.map(step=>({...step,status:"blocked"}))};
   return {status:"blocked"};
  }
  if(url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
  if(url.endsWith("/model-calls"))return {calls:[]};
  return {task};
 });
 await render();
 await click("撤销此步骤并允许重新规划");
 expect(task.status).toBe("blocked");
 expect(mocks.api.mock.calls.some(([url])=>url.endsWith("/execute"))).toBe(false);
});
it("offers standalone verification of a committed deliverable after refresh",async()=>{
 let task={id:"text-task",chatSessionId:"chat-a",chatSessionIds:["chat-a"],rootMessageId:"original-user",
  originalRequest:"创建故事大纲文本节点",status:"ready",activePlanVersion:1,recoveryMode:"canvas_atomic",
  steps:[{id:"text-step",kind:"canvas_mutation",planVersion:1,status:"succeeded",receiptTrust:"server_committed",
   actionDigest:"a".repeat(64),action:{deliverableSpecDigest:"b".repeat(64)}}]};
 mocks.api.mockImplementation(async(url:string,method:string)=>{
  if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
  if(url.endsWith("/deliverables/text/verify")){task={...task,status:"completed"};return {verified:true};}
  if(url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
  if(url.endsWith("/model-calls"))return {calls:[]};
  return {task};
 });
 await render();
 await click("验证已提交交付物（不重放画布）");
 expect(task.status).toBe("completed");
 expect(mocks.api.mock.calls.some(([url])=>url.endsWith("/execute")||url.endsWith("/canvas-steps"))).toBe(false);
});
it("discards a delayed safe-continuation response after switching chats",async()=>{
 let resolveAdvance!:(value:unknown)=>void;
 const deferred=new Promise(resolve=>{resolveAdvance=resolve;});
 const makeTask=(suffix:string)=>({id:"task-"+suffix,chatSessionId:"chat-"+suffix,
  chatSessionIds:["chat-"+suffix],rootMessageId:"original-user",originalRequest:"任务"+suffix,
  status:"ready",activePlanVersion:1,recoveryMode:"job_observation",
  steps:[{id:"job-"+suffix,kind:"model_job",planVersion:1,status:"succeeded",actionDigest:"a".repeat(64),receiptTrust:"server_committed"}]});
 const a=makeTask("a"),b=makeTask("b");
 mocks.api.mockImplementation(async(url:string,method:string)=>{
  if(method==="POST"&&url.endsWith("/continue-safe"))return deferred;
  if(url.includes("chatSessionId="))return {tasks:[url.includes("chat-b")?b:a]};
  if(url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
  if(url.endsWith("/model-calls"))return {calls:[]};
  return {task:url.includes("task-b")?b:a};
 });
 await render();
 await click("安全续行（不提交新生成或 Skill）");
 await act(async()=>{root!.render(createElement(Harness,{activeChatId:"chat-b"}));});
 const prior=mocks.api.mock.calls.length;
 await act(async()=>{resolveAdvance({taskId:a.id,taskStatus:"ready",sequenceState:"ready",
  checkpoints:[{kind:"skip",index:1}],reconciledJobs:1,requiresApproval:true,
  requiresManualReview:false,reason:null,executionStarted:false,next:null});await deferred;});
 expect(container!.textContent).not.toContain("已安全写入 跳过分支");
 expect(mocks.api.mock.calls.slice(prior).some(([url])=>url.includes("task-a"))).toBe(false);
});
it("keeps a normal planning Task compact and restores every control on demand",async()=>{
 const task={id:"compact-task",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
  rootMessageId:"original-user",originalRequest:"三镜头分镜文字规划",status:"planning",
  activePlanVersion:1,recoveryMode:"guidance_only",steps:[]};
 mocks.api.mockImplementation(async(url:string,method:string)=>{
  if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
  if(method==="GET"&&url.endsWith("/compact-task"))return {task};
  if(method==="GET"&&url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
  if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
  return {task};
 });
 await render("chat-a");
 const detail=container!.querySelector<HTMLDivElement>("#canvas-assistant-task-content");
 const toggle=Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent==="任务详情");
 expect(detail?.hidden).toBe(true);
 expect(toggle?.getAttribute("aria-expanded")).toBe("false");
 expect(container!.querySelector(".canvas-assistant-task-status")?.textContent?.trim()).toBe("待规划");
 expect(container!.querySelector(".canvas-assistant-task-steps")?.textContent).toContain("步骤 0");
 expect(Array.from(container!.querySelectorAll("button")).some(b=>b.textContent==="继续")).toBe(true);
 await click("任务详情");
 expect(detail?.hidden).toBe(false);
 expect(container!.textContent).toContain("长期目标与决策");
 await click("收起详情");
 expect(detail?.hidden).toBe(true);
 expect(mocks.api.mock.calls.some(([,method])=>method==="POST")).toBe(false);
});

it.each(["waiting_approval","needs_reconcile","blocked","failed"] as const)(
 "opens recovery controls by default when the server Task is %s",async status=>{
 const task={id:"attention-task",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
  rootMessageId:"original-user",originalRequest:"儿童动画任务",status,
  activePlanVersion:1,recoveryMode:"job_observation",steps:[]};
 mocks.api.mockImplementation(async(url:string,method:string)=>{
  if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
  if(method==="GET"&&url.endsWith("/attention-task"))return {task};
  if(method==="GET"&&url.endsWith("/run-sequences"))return {sequence:null,state:"none"};
  if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
  if(method==="GET"&&url.endsWith("/recovery"))return {canReplan:false,reason:"needs_receipts"};
  if(method==="GET"&&url.endsWith("/run-sequences/failure-recovery"))
   return {canRecover:false,reason:"needs_receipts"};
  return {task};
 });
 await render("chat-a");
 const detail=container!.querySelector<HTMLDivElement>("#canvas-assistant-task-content");
 expect(detail?.hidden).toBe(false);
 expect(Array.from(container!.querySelectorAll("button")).some(b=>b.textContent==="收起详情")).toBe(true);
 expect(mocks.api.mock.calls.some(([,method])=>method==="POST")).toBe(false);
});

it("P3 imported read-only Task disables resume and cancellation controls",async()=>{
 const task={id:"imported-task",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
  rootMessageId:"original-user",originalRequest:"历史运行",status:"running",readOnly:true,
  activePlanVersion:1,recoveryMode:"job_observation",steps:[]};
 mocks.api.mockImplementation(async(url:string,method:string)=>{
  if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
  if(method==="GET"&&url.endsWith("/imported-task"))return {task};
  if(method==="GET"&&url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
  if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
  return {task};
 });
 await render("chat-a");
 expect(container!.textContent).toContain("只读归档（禁止恢复执行）");
 expect(Array.from(container!.querySelectorAll("button")).some(b=>b.textContent==="继续")).toBe(false);
 expect(Array.from(container!.querySelectorAll("button")).some(b=>b.textContent==="结束记录")).toBe(false);
 expect(mocks.api.mock.calls.some(([,method])=>method==="POST")).toBe(false);
});

it("P3 Task panel displays server-derived turns and current-plan trusted progress",async()=>{
 const task={id:"summary-task",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
  rootMessageId:"original-user",originalRequest:"长期分镜",status:"ready",activePlanVersion:3,
  recoveryMode:"canvas_atomic",steps:[],summary:{version:1,source:"server_derived",
   userTurns:{total:28},execution:{currentPlan:{stepCount:7,trustedSteps:4,unverifiedSuccess:1,
    stages:{needs_reconcile:2}}}}};
 mocks.api.mockImplementation(async(url:string,method:string)=>{
  if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
  if(method==="GET"&&url.endsWith("/summary-task"))return {task};
  if(method==="GET"&&url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
  if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
  return {task};
 });
 await render("chat-a");
 expect(container!.textContent).toContain("已记录续写 28 轮");
 expect(container!.textContent).toContain("当前计划可信步骤 4/7");
 expect(container!.textContent).toContain("待对账 2");
 expect(mocks.api.mock.calls.some(([,method])=>method==="POST")).toBe(false);
});

it("P3 semantic panel requires explicit confirmation and never invokes a Job",async()=>{
 let task={id:"semantic-task",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
  rootMessageId:"original-user",originalRequest:"制作分镜",status:"planning",
  activePlanVersion:1,recoveryMode:"guidance_only",steps:[],
  semantic:{revision:0,goal:null,notes:[] as {id:string;kind:string;text:string}[]}};
 mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
  if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
  if(method==="GET"&&url.endsWith("/semantic-task"))return {task};
  if(method==="GET"&&url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
  if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
  if(method==="POST"&&url.endsWith("/semantic")){
   expect(payload?.confirmed).toBe(true);
   expect(payload?.expectedRevision).toBe(task.semantic.revision);
   expect(payload?.contextPolicy).toMatchObject({includeContext:false,scope:"selection"});
   if(payload?.operation==="add_constraint")
    task={...task,semantic:{revision:1,goal:null,notes:[{id:"note-1",kind:"constraint",text:String(payload?.text)}]}};
   else if(payload?.operation==="remove_note")
    task={...task,semantic:{revision:2,goal:null,notes:[]}};
   else throw Error("unexpected semantic operation");
   return {task,executionStarted:false};
  }
  return {task};
 });
 await render("chat-a");
 await click("长期目标与决策");
 expect(container!.textContent).toContain("尚未确认长期约束或决策");
 const field=container!.querySelector('textarea[aria-label="长期事项内容"]') as HTMLTextAreaElement;
 expect(field).toBeTruthy();
 await act(async()=>{
  const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;
  setter.call(field,"始终使用水彩画风");
  field.dispatchEvent(new Event("input",{bubbles:true}));
  await Promise.resolve();
 });
 expect((container!.querySelector('textarea[aria-label="长期事项内容"]') as HTMLTextAreaElement).value)
  .toBe("始终使用水彩画风");
 await click("确认保存长期事项");
 expect(container!.textContent).toContain("约束：始终使用水彩画风");
 await click("移除");
 expect(container!.textContent).toContain("尚未确认长期约束或决策");
 expect(mocks.api.mock.calls.filter(([url,method])=>method==="POST"&&url.endsWith("/semantic")).length).toBe(2);
 expect(mocks.api.mock.calls.some(([url])=>url.includes("/enqueue")||url.includes("/jobs")||url.includes("/run-skill"))).toBe(false);
});

it("P3 read-only archive can view long-term notes but cannot change them",async()=>{
 const task={id:"semantic-archive",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
  rootMessageId:"original-user",originalRequest:"长期任务",status:"running",readOnly:true,
  activePlanVersion:1,recoveryMode:"guidance_only",steps:[],
  semantic:{revision:5,goal:{text:"历史目标",provenance:"user_confirmed"},
   notes:[{id:"n",kind:"decision",text:"历史关键决策",provenance:"user_confirmed"}]}};
 mocks.api.mockImplementation(async(url:string,method:string)=>{
  if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
  if(method==="GET"&&url.endsWith("/semantic-archive"))return {task};
  if(method==="GET"&&url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
  if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
  return {task};
 });
 await render("chat-a");
 await click("长期目标与决策");
 expect(container!.textContent).toContain("历史目标");
 expect(container!.textContent).toContain("历史关键决策");
 expect(container!.textContent).toContain("任务不可编辑");
 expect(container!.querySelector('textarea[aria-label="长期事项内容"]')).toBe(null);
 expect(mocks.api.mock.calls.some(([,method])=>method==="POST")).toBe(false);
});

it("P3 AI proposals remain unconfirmed until each explicit accept/reject, and survive reopening",async()=>{
 let task={id:"candidate-task",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
  rootMessageId:"original-user",originalRequest:"长视频分镜",status:"ready",readOnly:false,
  recoveryMode:"guidance_only",steps:[],semantic:{revision:0,goal:null,
   notes:[] as {id:string;kind:string;text:string}[]}};
 const scope={includeContext:false,scope:"selection",includedIds:[]};
 const initial=[
  {id:"suggest-a",kind:"constraint",text:"所有镜头保持水彩画风",status:"pending",source:"model_suggested",contextPolicy:scope},
  {id:"suggest-b",kind:"decision",text:"片尾使用开放式结局",status:"pending",source:"model_suggested",contextPolicy:scope}
 ];
 let proposals=initial.map(item=>({...item}));
 const generation=vi.fn(async(_taskId:string,_turnId:string,_signal:AbortSignal)=>{
  expect(_taskId).toBe("candidate-task");
 });
 let created=false;
 mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
  if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
  if(method==="GET"&&url.endsWith("/candidate-task"))return {task};
  if(method==="GET"&&url.endsWith("/semantic-proposals"))return {proposals:created?proposals:[]};
  if(method==="GET"&&url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
  if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
  if(method==="POST"&&url.endsWith("/turns")){
   expect(payload?.contextPolicy).toMatchObject({includeContext:false,scope:"selection"});
   created=true;return {task};
  }
  if(method==="POST"&&url.endsWith("/semantic-proposals/decision")){
   const id=String(payload?.proposalId),decision=String(payload?.decision);
   expect(payload?.confirmed).toBe(true);
   expect(payload?.expectedRevision).toBe(task.semantic.revision);
   proposals=proposals.map(item=>item.id===id?{...item,status:decision==="accept"?"accepted":"rejected"}:item);
   if(decision==="accept")task={...task,semantic:{revision:1,goal:null,notes:[
    {id:"saved-note",kind:"constraint",text:"所有镜头保持水彩画风"}]}};
   return {proposalId:id,decision,semanticRevision:task.semantic.revision,executionStarted:false};
  }
  return {task};
 });
 await render("chat-a",generation);
 await click("长期目标与决策");
 expect(container!.textContent).toContain("暂无 AI 记忆候选");
 await click("提取 AI 记忆候选");
 expect(generation).toHaveBeenCalledTimes(1);
 expect(container!.textContent).toContain("约束建议：所有镜头保持水彩画风");
 expect(container!.textContent).toContain("决策建议：片尾使用开放式结局");
 expect(container!.textContent).toContain("待人工确认");
 expect(task.semantic.notes.length).toBe(0);
 expect(mocks.api.mock.calls.filter(([url,method])=>method==="POST"&&url.endsWith("/semantic")).length).toBe(0);
 await click("确认候选");
 expect(task.semantic.notes[0].text).toBe("所有镜头保持水彩画风");
 expect(container!.textContent).toContain("已确认");
 await click("拒绝候选");
 expect(container!.textContent).toContain("已拒绝");
 await act(async()=>{root!.unmount();});root=null;container?.remove();container=null;
 await render("chat-a",generation);
 await click("长期目标与决策");
 expect(container!.textContent).toContain("已确认");
 expect(container!.textContent).toContain("已拒绝");
 expect(generation).toHaveBeenCalledTimes(1);
 expect(mocks.api.mock.calls.some(([url])=>url.includes("/enqueue")||url.includes("/run-skill")||url.includes("/jobs"))).toBe(false);
});

it("P3 archived candidate list is read-only, even if old items are still pending",async()=>{
 const task={id:"archived-candidate-task",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
  rootMessageId:"original-user",originalRequest:"历史任务",status:"running",readOnly:true,
  recoveryMode:"guidance_only",steps:[],semantic:{revision:0,goal:null,notes:[]}};
 const proposals=[{id:"archived-candidate",kind:"goal",text:"历史建议",status:"pending",source:"model_suggested",
  contextPolicy:{includeContext:false,scope:"selection",includedIds:[]}}];
 mocks.api.mockImplementation(async(url:string,method:string)=>{
  if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
  if(method==="GET"&&url.endsWith("/archived-candidate-task"))return {task};
  if(method==="GET"&&url.endsWith("/semantic-proposals"))return {proposals};
  if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
  if(method==="GET"&&url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
  return {task};
 });
 await render("chat-a",vi.fn());
 await click("长期目标与决策");
 expect(container!.textContent).toContain("历史建议");
 expect(container!.textContent).toContain("待人工确认");
 expect(container!.textContent).not.toContain("提取 AI 记忆候选");
 expect(Array.from(container!.querySelectorAll("button")).some(b=>b.textContent==="确认候选")).toBe(false);
 expect(Array.from(container!.querySelectorAll("button")).some(b=>b.textContent==="拒绝候选")).toBe(false);
 expect(mocks.api.mock.calls.some(([,method])=>method==="POST")).toBe(false);
});

describe("P3c cross-chat resume and safe replan UI",()=>{
 it("links an existing Task from another chat without executing any Job",async()=>{
  const previous={id:"task-old",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
   rootMessageId:"old-user",originalRequest:"Moss 两张图片",status:"ready",
   recoveryMode:"job_observation",activePlanVersion:1,steps:[]};
  mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
   if(method==="GET"&&url.includes("includeOther=true"))return {tasks:[previous]};
   if(method==="GET"&&url.includes("chatSessionId=chat-b"))return {tasks:[]};
   if(method==="POST"&&url.endsWith("/link-chat")){
    expect(payload).toMatchObject({chatSessionId:"chat-b"});
    return {task:{...previous,chatSessionIds:["chat-a","chat-b"]},executionStarted:false};
   }
   if(method==="GET"&&url.endsWith("/task-old"))return {task:{...previous,chatSessionIds:["chat-a","chat-b"]}};
   if(method==="GET"&&url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
   if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
   return {task:previous};
  });
  await render("chat-b");
  await click("从其他会话关联任务");
  expect(container!.textContent).toContain("Moss 两张图片");
  await click("关联并继续");
  expect(container!.textContent).toContain("Moss 两张图片");
  expect(mocks.api.mock.calls.filter(([url,method])=>method==="POST"&&url.endsWith("/link-chat")).length).toBe(1);
  expect(mocks.api.mock.calls.some(([url])=>url.endsWith("/enqueue")||url.includes("/jobs"))).toBe(false);
 });
 it("safe replan only after server recovery verdict, and never POSTs a Job",async()=>{
  let task={id:"task-broken",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
   rootMessageId:"original-user",originalRequest:"Moss 工作流",status:"blocked",
   recoveryMode:"job_observation",activePlanVersion:1,steps:[]};
  mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
   if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
   if(method==="GET"&&url.endsWith("/task-broken"))return {task};
   if(method==="GET"&&url.endsWith("/recovery"))return {canReplan:true,reason:"verified_safe_to_replan",
    planVersion:1,projectRevision:42};
   if(method==="POST"&&url.endsWith("/replan")){
    expect(payload).toMatchObject({expectedPlanVersion:1,expectedProjectRevision:42});
    task={...task,status:"planning",activePlanVersion:2};
    return {activePlanVersion:2,executionStarted:false};
   }
   if(method==="GET"&&url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
   if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
   return {task};
  });
  await render("chat-a");
  expect(container!.textContent).toContain("安全重新规划（不会自动生成）");
  await click("安全重新规划（不会自动生成）");
  expect(container!.textContent).toContain("草稿：请依据服务端可信回执重新规划剩余步骤");
  expect(mocks.api.mock.calls.filter(([url,method])=>method==="POST"&&url.endsWith("/replan")).length).toBe(1);
  expect(mocks.api.mock.calls.some(([url])=>url.endsWith("/enqueue")||url.includes("/jobs"))).toBe(false);
 });
});
describe("P3c3d explicit confirmed failure fallback UI",()=>{
 it("only freezes a new plan from trusted failure and leaves all paid Jobs untouched",async()=>{
  let task={id:"task-definitive-failure",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
   rootMessageId:"original-user",originalRequest:"生成失败后运行备用节点",
   status:"failed",activePlanVersion:1,recoveryMode:"job_observation",steps:[]};
  let confirmed=false;
  const source={type:"run_node",nodeId:"first",mode:"text"};
  const fallback={type:"run_node",nodeId:"alternative",mode:"text"};
  const requests:{method:string;url:string;payload?:Record<string,unknown>}[]=[];
  mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
   requests.push({url,method,payload});
   if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
   if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
   if(method==="GET"&&url.endsWith("/recovery"))return {
    canReplan:true,reason:"verified_safe_to_replan",planVersion:1,projectRevision:3};
   if(method==="GET"&&url.endsWith("/run-sequences/failure-recovery"))return {
    canRecover:!confirmed,reason:confirmed?"task_not_definitively_failed":"definitive_failure_fallback_ready",
    planVersion:1,projectRevision:3,failureReason:"provider_confirmed_not_accepted",
    sourceJobId:"original-job-1",fallbackAction:fallback,evidenceDigest:"a".repeat(64)};
   if(method==="GET"&&url.endsWith("/run-sequences"))return confirmed?{
    sequence:{id:"failover-sequence",taskId:task.id,sourceMessageId:"failover-old",planVersion:2,
     actions:[fallback],status:"active"},state:"ready",next:{index:0,action:fallback,dependsOn:[],last:true},
    joins:[],branchSkips:[],outputs:[]}:{
    sequence:{id:"original-sequence",taskId:task.id,sourceMessageId:"user",
     planVersion:1,actions:[source,fallback],status:"active"},state:"blocked",next:null,outputs:[]};
   if(method==="GET"&&url.endsWith("/task-definitive-failure"))return {task};
   if(method==="POST"&&url.endsWith("/run-sequences/failure-recovery")){
    expect(payload).toMatchObject({expectedPlanVersion:1,expectedProjectRevision:3,
     evidenceDigest:"a".repeat(64)});
    confirmed=true;task={...task,status:"planning",activePlanVersion:2};
    return {sequenceId:"failover-sequence",executionStarted:false,planVersion:2};
   }
   throw Error("unexpected Task external side effect "+method+" "+url);
  });
  await render();
  expect(container!.textContent).toContain("确认启用备用计划（不生成）");
  expect(container!.textContent).toContain("alternative");
  await click("确认启用备用计划（不生成）");
  expect(confirmed).toBe(true);
  expect(container!.textContent).toContain("顺序生成计划：1 项");
  expect(requests.filter(item=>item.method==="POST")).toHaveLength(1);
  expect(requests.some(item=>item.method==="POST"&&/\/enqueue$|\/external-jobs$|\/canvas-steps$/.test(item.url))).toBe(false);
 });
 it("does not offer failure fallback for an unverified or unknown upstream Job",async()=>{
  const task={id:"task-unknown",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
   rootMessageId:"original-user",originalRequest:"图像生成提交结果未知",
   status:"failed",activePlanVersion:1,recoveryMode:"job_observation",steps:[]};
  mocks.api.mockImplementation(async(url:string,method:string)=>{
   if(method!=="GET")throw Error("unverified failure cannot POST");
   if(url.includes("chatSessionId="))return {tasks:[task]};
   if(url.endsWith("/model-calls"))return {calls:[]};
   if(url.endsWith("/run-sequences/failure-recovery"))return {
    canRecover:false,reason:"job_failure_evidence_unverified",planVersion:1,projectRevision:1};
   if(url.endsWith("/recovery"))return {
    canReplan:false,reason:"job_outcome_unknown",planVersion:1,projectRevision:1};
   if(url.endsWith("/run-sequences"))return {sequence:null,state:"none",next:null};
   return {task};
  });
  await render();
  expect(container!.textContent).toContain("job_failure_evidence_unverified");
  expect(container!.textContent).not.toContain("确认启用备用计划（不生成）");
  expect(mocks.api.mock.calls.every(item=>item[1]==="GET")).toBe(true);
 });
});
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
describe("P3c3c multi-predecessor Join checkpoint UI",()=>{
 it("commits trusted Join only once without executing the final paid generation",async()=>{
  const task={id:"task-join",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
   rootMessageId:"original-user",originalRequest:"先素材再分支最后汇合",
   status:"ready",activePlanVersion:1,recoveryMode:"job_observation",steps:[]};
  const cond={sourceIndex:0,kind:"image",op:"gte",count:2};
  const inverse={sourceIndex:0,kind:"image",op:"lt",count:2};
  const actions=[
   {type:"run_node",nodeId:"src",mode:"image"},
   {type:"run_node",nodeId:"a",mode:"image",when:cond},
   {type:"run_node",nodeId:"b",mode:"image",when:inverse},
   {type:"run_node",nodeId:"final",mode:"image",join:{indices:[0,1,2]}}
  ];
  const digest="e".repeat(64),deps=["material-source","material-branch"];
  let joined=false;
  const requests:{method:string;url:string;payload?:Record<string,unknown>}[]=[];
  mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
   requests.push({url,method,payload});
   if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
   if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
   if(method==="GET"&&url.endsWith("/run-sequences"))return {
    sequence:{id:"sequence-join",taskId:task.id,sourceMessageId:"original-user",
     planVersion:1,actions,status:"active"},
    state:joined?"ready":"join_ready",index:3,
    join:joined?null:{index:3,planVersion:1,taskId:task.id,projectId:"project",
     sourceStepId:"job-source",sourceMaterialStepId:"material-source",
     executedIndex:1,executedStepId:"job-branch",executedMaterialStepId:"material-branch",
     skippedIndex:2,skipEvidenceDigest:"a".repeat(64),evidenceDigest:digest,
     dependsOn:deps},
    joins:joined?[{index:3,receipt:{decision:"join",receiptTrust:"server_committed",
     evidenceDigest:digest,dependsOn:deps},joinedAt:1}]:[],
    next:joined?{index:3,action:actions[3],dependsOn:deps,last:true,joinEvidenceDigest:digest}:null,
    branchSkips:[],outputs:[]
   };
   if(method==="GET"&&url==="/api/v1/projects/project")return {revision:5};
   if(method==="GET")return {task};
   if(method==="POST"&&url.endsWith("/run-sequences/join")){
    expect(payload).toMatchObject({runSequenceId:"sequence-join",runIndex:3,
     expectedPlanVersion:1,expectedProjectRevision:5,evidenceDigest:digest});
    joined=true;return {joined:true,executionStarted:false};
   }
   throw Error("unexpected side effect: "+method+" "+url);
  });
  await render();
  expect(container!.textContent).toContain("汇合待确认");
  await click("确认可信汇合（只写回执）");
  expect(joined).toBe(true);
  expect(container!.textContent).toContain("已提交可信汇合检查点");
  expect(requests.filter(r=>r.method==="POST")).toHaveLength(1);
  expect(requests.some(r=>r.method==="POST"&&/\/enqueue$|\/external-jobs$|\/canvas-steps$/.test(r.url))).toBe(false);
 });
});
describe("P3c3b trusted branch skip UI",()=>{
 it("requires deliberate skip confirmation and posts only the receipt command",async()=>{
  const task={id:"task-branch",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
   rootMessageId:"original-user",originalRequest:"先出图再按类型走分支",
   status:"ready",activePlanVersion:1,recoveryMode:"job_observation",steps:[]};
  const cond={sourceIndex:0,kind:"image",op:"gte",count:2};
  const inverse={sourceIndex:0,kind:"image",op:"lt",count:2};
  const actions=[{type:"run_node",nodeId:"source",mode:"image"},
   {type:"run_node",nodeId:"two-image-target",mode:"image",when:cond},
   {type:"run_node",nodeId:"small-batch-target",mode:"image",when:inverse}];
  const digest="e".repeat(64);
  let skipped=false;
  const calls:{method:string;url:string;payload?:Record<string,unknown>}[]=[];
  mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
   calls.push({method,url,payload});
   if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
   if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
   if(method==="GET"&&url.endsWith("/run-sequences"))return {
    sequence:{id:"branch-1",taskId:task.id,sourceMessageId:"original-user",
     planVersion:1,actions,status:"active"},
    state:skipped?"ready":"skip_ready",index:skipped?2:1,
    skip:skipped?null:{index:1,action:actions[1],sourceStepId:"job0",
     materialStepId:"mat0",count:1,verifiedCount:1,evidenceDigest:digest},
    branchSkips:skipped?[{index:1,receipt:{decision:"skip",receiptTrust:"server_committed",
     condition:cond,evaluatedCount:1,evidenceDigest:digest},skippedAt:1}]:[],
    next:skipped?{index:2,action:actions[2],dependsOn:["mat0"],last:true}:null,
    outputs:[]
   };
   if(method==="GET"&&url==="/api/v1/projects/project")return {revision:3};
   if(method==="GET")return {task};
   if(method==="POST"&&url.endsWith("/run-sequences/skip")){
    expect(payload).toMatchObject({runSequenceId:"branch-1",runIndex:1,
     expectedPlanVersion:1,expectedProjectRevision:3,evidenceDigest:digest});
    skipped=true;return {skipped:true,executionStarted:false};
   }
   throw Error("unexpected external call: "+method+" "+url);
  });
  await render();
  expect(container!.textContent).toContain("未满足第 2 项");
  await click("确认跳过第 2 项（仅写回执，不生成）");
  expect(skipped).toBe(true);
  expect(container!.textContent).toContain("已持久记录跳过：2/3");
  expect(calls.filter(c=>c.method==="POST")).toHaveLength(1);
  expect(calls.some(c=>c.method==="POST"&&
   /\/external-jobs$|\/enqueue$|\/canvas-steps$/.test(c.url))).toBe(false);
 });
});
describe("P3c3a explicit multi-artifact selection UI",()=>{
 it("shows two verified outputs and persists one selection without creating any Job",async()=>{
  const task={id:"task-multi",chatSessionId:"chat-a",chatSessionIds:["chat-a"],
   rootMessageId:"original-user",originalRequest:"生成两张图后选一张转视频",
   status:"ready",activePlanVersion:1,recoveryMode:"job_observation",steps:[]};
  const actions=[{type:"run_node",nodeId:"source",mode:"image"},
   {type:"run_workflow",nodeId:"wf",inputFromPrevious:{sourceKind:"image",toPortId:"first_frame"}}];
  const candidates=[
   {artifactId:"art-image-a",nodeId:"rendered-a",kind:"image",portId:"image",itemKey:"0",sha256:"a".repeat(64),addressable:true},
   {artifactId:"art-image-b",nodeId:"rendered-b",kind:"image",portId:"image",itemKey:"1",sha256:"b".repeat(64),addressable:true}
  ];
  let committed=false;
  const apiCalls:{url:string;method:string;payload?:Record<string,unknown>}[]=[];
  mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
   apiCalls.push({url,method,payload});
   if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
   if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
   if(method==="GET"&&url.endsWith("/run-sequences"))return {
    sequence:{id:"sequence-1",taskId:task.id,sourceMessageId:"original-user",
     planVersion:1,actions,status:"active"},
    state:committed?"ready":"selection_required",index:committed?undefined:1,
    selectionCandidates:committed?undefined:candidates,
    next:committed?{index:1,action:actions[1],dependsOn:["material-step"],last:true,
     needsBinding:true,inputBinding:{sourceArtifactId:"art-image-b",sourceSha256:"b".repeat(64),
      sourceMaterialStepId:"material-step",sourceNodeId:"rendered-b",sourcePortId:"image",
      toNodeId:"wf",toPortId:"first_frame",sourceKind:"image",valueKind:"IMAGE"}}:null,
    outputs:[]
   };
   if(method==="GET"&&url==="/api/v1/projects/project")return {revision:2};
   if(method==="GET")return {task};
   if(method==="POST"&&url.endsWith("/run-sequences/select")){
    expect(payload).toMatchObject({runSequenceId:"sequence-1",runIndex:1,
     expectedPlanVersion:1,expectedProjectRevision:2,artifactId:"art-image-b"});
    committed=true;return {selected:true,artifactId:"art-image-b"};
   }
   throw Error("unexpected mutation: "+method+" "+url);
  });
  container=document.createElement("div");document.body.appendChild(container);root=createRoot(container);
  await act(async()=>root!.render(createElement(Harness,{runSequence:vi.fn()})));
  expect(container!.textContent).toContain("上一项生成了多个可信产物");
  expect(container!.textContent).toContain("rendered-a");
  expect(container!.textContent).toContain("rendered-b");
  const buttons=Array.from(container!.querySelectorAll("button")).filter(b=>b.textContent==="使用此产物");
  expect(buttons).toHaveLength(2);
  await act(async()=>{buttons[1]!.click();await Promise.resolve();});
  expect(committed).toBe(true);
  expect(container!.textContent).toContain("先连接可信产物，再生成第 2/2 项");
  expect(container!.textContent).not.toContain("上一项生成了多个可信产物");
  expect(apiCalls.filter(c=>c.method==="POST"&&c.url.endsWith("/run-sequences/select"))).toHaveLength(1);
  expect(apiCalls.some(c=>c.method==="POST"&&/\/enqueue$|\/external-jobs$|\/canvas-steps$/.test(c.url))).toBe(false);
 });
});
describe("P3c2 typed media binding resume UI",()=>{
 it("P3c2 after refresh labels the pending verified media binding separately from the paid Job",async()=>{
  const task={id:"task-image-seq",chatSessionId:"chat-a",rootMessageId:"original-user",
   originalRequest:"先出图再转视频",status:"ready",recoveryMode:"job_observation",steps:[]};
  const actions=[{type:"run_node",nodeId:"image-source",mode:"image"},
   {type:"run_workflow",nodeId:"video-workflow",inputFromPrevious:{sourceKind:"image",toPortId:"first_frame"}}];
  const view={sequence:{id:"seq-i2v",taskId:task.id,sourceMessageId:"original-user",
   planVersion:1,actions,status:"active"},state:"ready",
   next:{index:1,action:actions[1],dependsOn:["trusted-material"],last:true,needsBinding:true,
    inputBinding:{sourceNodeId:"rendered-image",sourcePortId:"image",toNodeId:"video-workflow",
     toPortId:"first_frame",sourceArtifactId:"art-image",sourceSha256:"a".repeat(64),
     sourceMaterialStepId:"trusted-material",sourceKind:"image",valueKind:"IMAGE"}},
   outputs:[{artifactId:"art-image",nodeId:"rendered-image",kind:"image"}]};
  const runner=vi.fn(async()=>{});
  mocks.api.mockImplementation(async(url:string,method:string)=>{
   if(method!=="GET")throw Error("state view is read-only");
   if(url.includes("chatSessionId="))return {tasks:[task]};
   if(url.endsWith("/model-calls"))return {calls:[]};
   if(url.endsWith("/run-sequences"))return view;
   return {task};
  });
  container=document.createElement("div");document.body.appendChild(container);root=createRoot(container);
  await act(async()=>root!.render(createElement(Harness,{runSequence:runner})));
  expect(container!.textContent).toContain("先连接可信产物，再生成第 2/2 项（需审批）");
  expect(container!.textContent).toContain("rendered-image → video-workflow.first_frame");
  expect(container!.textContent).toContain("经服务端验证的落图引用");
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


it("P4.4a user-triggered safe continuation never POSTs a paid Job or Skill",async()=>{
 const task={id:"task-safe",chatSessionId:"chat-a",rootMessageId:"original-user",
  originalRequest:"已批准但不可重复计费的顺序生成",status:"ready",activePlanVersion:1,
  recoveryMode:"job_observation",readOnly:false,steps:[]};
 const actions=[{type:"run_node",nodeId:"source",mode:"text"},
  {type:"run_node",nodeId:"branch-false",mode:"text"},
  {type:"run_node",nodeId:"branch-true",mode:"text"}];
 let advanced=false;
 const calls:{method:string;url:string;payload?:Record<string,unknown>}[]=[];
 mocks.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
  calls.push({url,method,payload});
  if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[task]};
  if(method==="GET"&&url.endsWith("/model-calls"))return {calls:[]};
  if(method==="GET"&&url.endsWith("/run-sequences"))return {
   sequence:{id:"seq-safe",taskId:task.id,sourceMessageId:"original-user",
    planVersion:1,actions,status:"active"},
   state:advanced?"ready":"skip_ready",
   index:advanced?2:1,
   skip:advanced?null:{index:1,action:actions[1],sourceStepId:"step-source",
    materialStepId:"material-source",count:0,verifiedCount:0,evidenceDigest:"a".repeat(64)},
   next:advanced?{index:2,action:actions[2],dependsOn:["material-source"],last:true}:null,
   branchSkips:advanced?[{index:1,receipt:{receiptTrust:"server_committed"},skippedAt:1}]:[]
  };
  if(method==="POST"&&url.endsWith("/continue-safe")){
   expect(payload?.expectedPlanVersion).toBe(1);
   expect(typeof payload?.requestId).toBe("string");
   advanced=true;
   return {taskId:task.id,taskStatus:"ready",sequenceState:"ready",
    checkpoints:[{kind:"skip",index:1}],reconciledJobs:1,requiresApproval:true,
    requiresManualReview:false,reason:"paid_step_requires_approval",executionStarted:false,
    next:{index:2,type:"run_node",nodeId:"branch-true"}};
  }
  if(method==="GET")return {task};
  throw Error("unexpected side effect: "+method+" "+url);
 });
 await render();
 await click("安全续行（不提交新生成或 Skill）");
 expect(advanced).toBe(true);
 expect(container!.textContent).toContain("已安全写入 跳过分支 #2");
 expect(container!.textContent).toContain("第 3 项仍需单独审批生成");
 expect(calls.filter(c=>c.method==="POST").map(c=>c.url)).toEqual([
  "/api/v1/projects/project/assistant/tasks/task-safe/continue-safe"]);
 expect(calls.some(c=>/\/enqueue$|\/external-jobs$|\/run-skill$|\/jobs$/.test(c.url))).toBe(false);
});
