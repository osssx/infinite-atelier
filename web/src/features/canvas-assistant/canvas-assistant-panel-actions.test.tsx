// @vitest-environment happy-dom
import {act,createElement,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {defaultConfig} from "@/stores/use-config-store";
import {CanvasNodeType,type CanvasAssistantSession,type CanvasNodeData} from "@/types/canvas";
import {applyAssistantCanvasActions,type AssistantCanvasStage,type AssistantCanvasGraph} from "./canvas-assistant-actions";
const mocks=vi.hoisted(()=>({
 api:vi.fn(),
 confirm:vi.fn(),
 ensure:vi.fn(async()=>{}),
}));
vi.mock("@/stores/use-theme-store",()=>({
 useThemeStore:(select:(value:{theme:"light"})=>unknown)=>select({theme:"light"})
}));
vi.mock("@/stores/use-config-store",async importOriginal=>{
 const original=await importOriginal<typeof import("@/stores/use-config-store")>();
 return {...original,
  selectableModelsByCapability:()=>["demo"],
  resolveModelChannel:()=>({id:"c1",provider:"openai_compatible",apiFormat:"openai_compatible",baseUrl:"http://localhost:8080/v1"}),
  resolveModelScript:()=>"",
  modelOptionName:()=> "demo",
  modelOptionLabel:()=> "demo"
 };
});
vi.mock("@/features/backend-sync/model-channel-autoroute",()=>({
 ensureSqliteModelChannelForExecution:mocks.ensure,
 modelChannelProvider:()=> "openai_compatible"
}));
vi.mock("@/features/backend-sync/canvas-api",async importOriginal=>{
 const original=await importOriginal<typeof import("@/features/backend-sync/canvas-api")>();
 return {...original,canvasApi:mocks.api};
});
vi.mock("antd",()=>({Modal:{confirm:mocks.confirm}}));
vi.mock("streamdown",()=>({Streamdown:({children}:{children:unknown})=>children}));
import {CanvasAssistantPanel} from "./canvas-assistant-panel";

let root:Root|null=null,container:HTMLDivElement|null=null;
const originalContent="原始正文";
function makeGraph():AssistantCanvasGraph{
 return {nodes:[{id:"text-existing",type:CanvasNodeType.Text,title:"现有文本",
  position:{x:0,y:0},width:320,height:220,metadata:{content:originalContent}} satisfies CanvasNodeData],connections:[]};
}
function setup(actions:unknown[]){
 let graph=makeGraph();
 const apply=vi.fn((items:unknown,stage:AssistantCanvasStage,refs?:ReadonlyMap<string,string>)=>{
  const result=applyAssistantCanvasActions(graph,items,stage,{x:400,y:300},refs);
  graph={nodes:result.nodes,connections:result.connections};
  return {applied:result.applied,refs:result.refs};
 });
 const result={answer:"提出操作",model:"demo",actions};
 mocks.api.mockResolvedValue(result);
 function Harness(){
  const [sessions,setSessions]=useState<CanvasAssistantSession[]>([]);
  const [active,setActive]=useState<string|null>(null);
  return createElement(CanvasAssistantPanel,{
   projectId:"p1",projectTitle:"测试画布",open:true,onClose:()=>{},
   sessions,setSessions,activeChatId:active,setActiveChatId:setActive,
   selectedNodes:[{id:"text-existing",title:"现有文本",type:CanvasNodeType.Text}],
   getContext:()=>({text:"节点：现有文本 (text, id=text-existing)",references:[],truncated:false}),
   onApplyActions:apply,config:defaultConfig
  });
 }
 container=document.createElement("div");document.body.appendChild(container);
 root=createRoot(container);
 return {Harness,apply,getGraph:()=>graph};
}
async function renderAndSend(Harness:()=>React.ReactElement){
 await act(async()=>{root!.render(createElement(Harness));});
 const suggestion=Array.from(container!.querySelectorAll("button")).find(btn=>btn.textContent?.includes("创建三个分镜文本节点"));
 expect(suggestion).toBeTruthy();
 await act(async()=>{suggestion!.click();});
 const send=container!.querySelector<HTMLButtonElement>('[aria-label="发送消息"]');
 expect(send).toBeTruthy();
 await act(async()=>{send!.click();await Promise.resolve();});
}
beforeEach(()=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 mocks.api.mockReset();mocks.confirm.mockReset();mocks.ensure.mockClear();
 mocks.confirm.mockImplementation(()=>({destroy:vi.fn()}));
});
afterEach(async()=>{
 if(root)await act(async()=>{root!.unmount()});
 root=null;container?.remove();container=null;
});
describe("P2 assistant confirmation boundary",()=>{
 const actions=[
  {type:"create_text",ref:"newA",title:"新段落",content:"新正文"},
  {type:"connect",from:"text-existing",to:"newA"},
  {type:"set_text",nodeId:"text-existing",content:"AI 覆盖正文"}
 ];
 it("auto-applies additive changes but blocks content edits until acceptance",async()=>{
  const fixture=setup(actions);
  await renderAndSend(fixture.Harness);
  expect(fixture.getGraph().nodes).toHaveLength(2);
  expect(fixture.getGraph().connections).toHaveLength(1);
  expect(fixture.getGraph().nodes[0].metadata?.content).toBe(originalContent);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  const props=mocks.confirm.mock.calls[0][0];
  expect(props.content).toContain("修改 1 个节点内容");
  expect(props.content).not.toContain("AI 覆盖正文");
  await act(async()=>{props.onOk();await Promise.resolve();});
  expect(fixture.getGraph().nodes[0].metadata?.content).toBe("AI 覆盖正文");
  expect(fixture.apply).toHaveBeenCalledTimes(2);
  expect(container!.textContent).toContain("已确认并执行");
 });
 it("cancel leaves existing content untouched while preserving safe new nodes",async()=>{
  const fixture=setup(actions);
  await renderAndSend(fixture.Harness);
  expect(fixture.getGraph().nodes).toHaveLength(2);
  const props=mocks.confirm.mock.calls[0][0];
  await act(async()=>{props.onCancel();await Promise.resolve();});
  expect(fixture.getGraph().nodes[0].metadata?.content).toBe(originalContent);
  expect(fixture.apply).toHaveBeenCalledTimes(1);
  expect(container!.textContent).toContain("你已取消");
 });
 it("stop aborts the pending confirmation without executing content edits",async()=>{
  const fixture=setup(actions);
  await renderAndSend(fixture.Harness);
  const stop=container!.querySelector<HTMLButtonElement>('[aria-label="停止生成"]');
  expect(stop).toBeTruthy();
  await act(async()=>{stop!.click();await Promise.resolve();});
  expect(fixture.getGraph().nodes[0].metadata?.content).toBe(originalContent);
  expect(fixture.apply).toHaveBeenCalledTimes(1);
  expect(container!.textContent).toContain("已停止生成");
 });
});
