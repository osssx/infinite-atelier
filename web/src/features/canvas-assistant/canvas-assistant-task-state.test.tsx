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
function Harness({activeChatId="chat-a"}:{activeChatId?:string}){
 const [draft,setDraft]=useState("");
 const state=useCanvasAssistantTasks({
  projectId:"project",activeChatId,session:activeChatId==="chat-a"?session:undefined,
  open:true,sending:false,includeContext:false,scope:"selection",
  includedIds:["private-node"],onDraft:setDraft
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
 it("only loads tasks for its active session",async()=>{
  await render("chat-b");
  expect(mocks.api.mock.calls[0][0]).toContain("chatSessionId=chat-b");
  expect(container!.textContent).toContain("未关联任务");
  expect(container!.textContent).not.toContain("记录为任务");
 });
});
