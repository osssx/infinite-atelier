// @vitest-environment happy-dom
import {act,createElement,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {defaultConfig} from "@/stores/use-config-store";
import {CanvasNodeType,type CanvasAssistantSession,type CanvasNodeData} from "@/types/canvas";
import {applyAssistantCanvasActions,type AssistantCanvasStage,type AssistantCanvasGraph} from "./canvas-assistant-actions";
import {CanvasApiError} from "@/features/backend-sync/canvas-api";
const mocks=vi.hoisted(()=>({
 api:vi.fn(),
 confirm:vi.fn(),
 ensure:vi.fn(async()=>{}),
 run:vi.fn(async(_actions:unknown,_refs:ReadonlyMap<string,string>,_signal:AbortSignal)=>({submitted:1,jobIds:["job-demo"]})), }));
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
   onApplyActions:apply,onRunActions:mocks.run,config:defaultConfig  });
 }
 container=document.createElement("div");document.body.appendChild(container);
 root=createRoot(container);
 return {Harness,apply,getGraph:()=>graph};
}
async function renderAndSend(Harness:()=>React.ReactElement){
 await act(async()=>{root!.render(createElement(Harness));});
 const suggestion=Array.from(container!.querySelectorAll("button")).find(btn=>btn.textContent?.includes("创建三个分镜文本节点"));
 if(suggestion){
  await act(async()=>{suggestion.click();});
 }else{
  const input=container!.querySelector<HTMLTextAreaElement>('[aria-label="向 AI 助手发送消息"]')!;
  const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;
  await act(async()=>{
   setter.call(input,"创建三个分镜文本节点并依次连线");
   input.dispatchEvent(new Event("input",{bubbles:true}));
  });
 }
 const send=container!.querySelector<HTMLButtonElement>('[aria-label="发送消息"]');
 expect(send).toBeTruthy();
 expect(send!.disabled).toBe(false);
 await act(async()=>{send!.click();await Promise.resolve();});
}beforeEach(()=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 mocks.api.mockReset();mocks.confirm.mockReset();mocks.ensure.mockClear();mocks.run.mockClear();
 mocks.run.mockResolvedValue({submitted:1,jobIds:["job-demo"]});
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
  expect(props.className).toBe("canvas-assistant-confirm");
  expect(props.style["--assistant-confirm-surface"]).toBe("#fbfaf7");
  expect(props.rootClassName).toBe("canvas-assistant-confirm-root");
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
 it("P2.2 automatically creates mixed nodes, layouts and groups without confirmation",async()=>{
  const actions=[
   {type:"create_node",ref:"picture",nodeType:"image",title:"封面图",prompt:"人物海报"},
   {type:"create_node",ref:"scene",nodeType:"text",title:"场景文本",content:"雨夜"},
   {type:"layout_nodes",nodeIds:["text-existing","scene","picture"],direction:"horizontal",gap:32},
   {type:"create_group",ref:"act",title:"第一幕",members:["text-existing","scene","picture"]}
  ];
  const fixture=setup(actions);
  await renderAndSend(fixture.Harness);
  expect(fixture.apply).toHaveBeenCalledTimes(1);
  expect(mocks.confirm).not.toHaveBeenCalled();
  const graph=fixture.getGraph();
  expect(graph.nodes).toHaveLength(4);
  const group=graph.nodes.find(n=>n.type===CanvasNodeType.Group)!;
  expect(graph.nodes.filter(n=>n.metadata?.groupId===group.id)).toHaveLength(3);
  expect(graph.nodes.find(n=>n.type===CanvasNodeType.Image)?.metadata?.prompt).toBe("人物海报");
  expect(graph.nodes.find(n=>n.id==="text-existing")?.metadata?.content).toBe(originalContent);
  expect(container!.textContent).toContain("已自动执行 4 项画布操作");
 });
 it("P2.3 requires confirmation for dissolving a group, preserving its child nodes when cancelled",async()=>{
  const actions=[
   {type:"create_node",ref:"scene",nodeType:"text",title:"场景",content:"雨夜"},
   {type:"create_group",ref:"new-group",title:"第一幕",members:["text-existing","scene"]},
   {type:"ungroup",groupId:"new-group"}
  ];
  const fixture=setup(actions);
  await renderAndSend(fixture.Harness);
  expect(fixture.apply).toHaveBeenCalledTimes(1);
  expect(fixture.getGraph().nodes.filter(n=>n.type===CanvasNodeType.Group)).toHaveLength(1);
  expect(fixture.getGraph().nodes).toHaveLength(3);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  const props=mocks.confirm.mock.calls[0][0];
  expect(props.content).toContain("解散 1 个分组");
  expect(props.content).toContain("保留");
  await act(async()=>{props.onCancel();await Promise.resolve();});
  expect(fixture.apply).toHaveBeenCalledTimes(1);
  expect(fixture.getGraph().nodes.filter(n=>n.type===CanvasNodeType.Group)).toHaveLength(1);
  expect(fixture.getGraph().nodes.find(n=>n.id==="text-existing")?.metadata?.content).toBe(originalContent);
 });
 it("P2.3 ungroup after acceptance removes only the shell, not its members or connections",async()=>{
  const actions=[
   {type:"create_node",ref:"scene",nodeType:"text",title:"场景",content:"雨夜"},
   {type:"create_group",ref:"new-group",title:"第一幕",members:["text-existing","scene"]},
   {type:"ungroup",groupId:"new-group"}
  ];
  const fixture=setup(actions);
  await renderAndSend(fixture.Harness);
  const props=mocks.confirm.mock.calls[0][0];
  await act(async()=>{props.onOk();await Promise.resolve();});
  expect(fixture.apply).toHaveBeenCalledTimes(2);
  expect(fixture.getGraph().nodes).toHaveLength(2);
  expect(fixture.getGraph().nodes.some(n=>n.type===CanvasNodeType.Group)).toBe(false);
  expect(fixture.getGraph().nodes.every(n=>!n.metadata?.groupId)).toBe(true);
  expect(fixture.getGraph().nodes.find(n=>n.id==="text-existing")?.metadata?.content).toBe(originalContent);
  expect(container!.textContent).toContain("已确认并执行 1 项");
 });

 it("plain promises without an action payload are visibly marked as no-op",async()=>{
  const fixture=setup([]);
  mocks.api.mockResolvedValue({
   answer:"将对整个画布进行从左到右的拓扑布局，预计执行 1 项布局操作。",
   actions:[],model:"demo"
  });
  await renderAndSend(fixture.Harness);
  expect(fixture.apply).not.toHaveBeenCalled();
  expect(container!.textContent).toContain("本轮没有执行任何画布操作");
  expect(container!.textContent).toContain("画布保持不变");
  expect(mocks.confirm).not.toHaveBeenCalled();
 });
  it("repeated failures in one session do not pollute later successful canvas operations",async()=>{
   const fixture=setup([{type:"create_text",ref:"new1",title:"新的分镜",content:"剧情"}]);
   mocks.api.mockRejectedValueOnce(new CanvasApiError("assistant_actions_missing",502));
   mocks.api.mockRejectedValueOnce(new CanvasApiError("assistant_actions_missing",502));
   mocks.api.mockRejectedValueOnce(new CanvasApiError("assistant_actions_missing",502));
   for(let i=0;i<4;i++)await renderAndSend(fixture.Harness);
   expect(mocks.api).toHaveBeenCalledTimes(4);
   for(const call of mocks.api.mock.calls){
    const messages=call[2].messages as Array<{role:string;content:string}>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("创建三个分镜文本节点");
   }
   expect(fixture.apply).toHaveBeenCalledTimes(1);
   expect(fixture.getGraph().nodes).toHaveLength(2);
   expect(container!.textContent).toContain("已自动执行 1 项画布操作");
   expect(container!.textContent).toContain("模型未返回可执行的画布指令");
  });
 it("P2.5 requires approval before prompt and parameter edits can trigger generation",async()=>{
  const fixture=setup([
   {type:"set_prompt",nodeId:"text-existing",prompt:"新生成提示词"},
   {type:"set_node_param",nodeId:"text-existing",key:"reasoningEffort",value:"high"},
   {type:"run_node",nodeId:"text-existing",mode:"text"}
  ]);
  await renderAndSend(fixture.Harness);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(fixture.getGraph().nodes[0].metadata?.prompt).toBeUndefined();
  expect(mocks.confirm.mock.calls[0][0].content).toContain("修改 1 个生成提示词");
  await act(async()=>{mocks.confirm.mock.calls[0][0].onOk();await Promise.resolve();});
  expect(fixture.getGraph().nodes[0].metadata?.composerContent).toBe("新生成提示词");
  expect(fixture.getGraph().nodes[0].metadata?.reasoningEffort).toBe("high");
  expect(fixture.getGraph().nodes[0].metadata?.content).toBe(originalContent);
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(mocks.run.mock.calls[0][0]).toEqual([{type:"run_node",nodeId:"text-existing",mode:"text"}]);
  expect(container!.textContent).toContain("job-demo");
 });
 it("P2.5 rejecting a parameter change also skips its generation",async()=>{
  const fixture=setup([
   {type:"set_prompt",nodeId:"text-existing",prompt:"新提示词"},
   {type:"run_node",nodeId:"text-existing"}
  ]);
  await renderAndSend(fixture.Harness);
  await act(async()=>{mocks.confirm.mock.calls[0][0].onCancel();await Promise.resolve();});
  expect(fixture.getGraph().nodes[0].metadata?.composerContent).toBeUndefined();
  expect(mocks.run).not.toHaveBeenCalled();
  expect(container!.textContent).toContain("已跳过全部 1 项生成执行");
 });
 it("P2.5 runs an already configured node automatically and reports real submission IDs",async()=>{
  const fixture=setup([{type:"run_node",nodeId:"text-existing",mode:"text"}]);
  await renderAndSend(fixture.Harness);
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(container!.textContent).toContain("已通过原有节点执行链路提交 1 项生成任务");
  expect(container!.textContent).toContain("job-demo");
 });
 it("P2.5 reports execution failure without falsely claiming successful submission",async()=>{
  const fixture=setup([{type:"run_node",nodeId:"text-existing"}]);
  mocks.run.mockRejectedValueOnce(Error("任务未成功提交"));
  await renderAndSend(fixture.Harness);
  expect(container!.textContent).toContain("画布操作未完成：任务未成功提交");
  expect(container!.textContent).not.toContain("已通过原有节点执行链路提交");
 });
 it("P2.5 passes an abortable signal and stops waiting on a pending submission",async()=>{
  const fixture=setup([{type:"run_node",nodeId:"text-existing"}]);
  let finish!:(result:{submitted:number;jobIds:string[]})=>void;
  mocks.run.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await renderAndSend(fixture.Harness);
  const signal=mocks.run.mock.calls[0][2] as AbortSignal;
  expect(signal.aborted).toBe(false);
  const stop=container!.querySelector<HTMLButtonElement>('[aria-label="停止生成"]');
  expect(stop).toBeTruthy();
  await act(async()=>{stop!.click();finish({submitted:1,jobIds:["job-x"]});await Promise.resolve();});
  expect(signal.aborted).toBe(true);
  expect(container!.textContent).toContain("已停止生成");
 });
   it("P2.4 auto-executes dependency layout after creating and connecting nodes, without confirmation",async()=>{  const actions=[   {type:"create_node",ref:"step1",nodeType:"text",title:"起点",content:"场景一"},   {type:"create_node",ref:"step2",nodeType:"text",title:"终点",content:"场景二"},
   {type:"connect",from:"text-existing",to:"step1"},
   {type:"connect",from:"step1",to:"step2"},
   {type:"layout_graph",nodeIds:[],direction:"horizontal",gap:48,layerGap:140}
  ];
  const fixture=setup(actions);
  await renderAndSend(fixture.Harness);
  expect(fixture.apply).toHaveBeenCalledTimes(1);
  expect(mocks.confirm).not.toHaveBeenCalled();
  const graph=fixture.getGraph();
  const start=graph.nodes.find(n=>n.id==="text-existing")!;
  const step1=graph.nodes.find(n=>n.title==="起点")!;
  const step2=graph.nodes.find(n=>n.title==="终点")!;
  expect(start.position.x).toBeLessThan(step1.position.x);
  expect(step1.position.x).toBeLessThan(step2.position.x);
  expect(graph.connections).toHaveLength(2);
  expect(start.metadata?.content).toBe(originalContent);
  expect(step1.metadata?.content).toBe("场景一");
  expect(container!.textContent).toContain("已自动执行 5 项画布操作");
 });
});