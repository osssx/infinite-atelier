// @vitest-environment happy-dom
import {act,createElement,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {defaultConfig} from "@/stores/use-config-store";
import {CanvasNodeType,type CanvasAssistantSession,type CanvasNodeData} from "@/types/canvas";
import {applyAssistantCanvasActions,type AssistantCanvasStage,type AssistantCanvasGraph} from "./canvas-assistant-actions";
import {CanvasApiError} from "@/features/backend-sync/canvas-api";
import type {ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";
import {registerCanvasPortResolver} from "@/lib/canvas/canvas-ports";
import {canvasResourceReferenceToken,type CanvasResourceReference} from "@/lib/canvas/canvas-resource-references";
const skillMocks=vi.hoisted(()=>({
 snapshot:vi.fn(async():Promise<{revision:number;skills:unknown[]}>=>({revision:4,skills:[]}))
}));
vi.mock("@/features/skills/skill-registry",()=>({
 getSkillRegistrySnapshot:skillMocks.snapshot,SKILL_REGISTRY_CHANNEL:"test:assistant-skills"
}));
const mocks=vi.hoisted(()=>({
 api:vi.fn(),
 taskApi:vi.fn(),
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
 // Task-state requests should not consume legacy model request mock expectations.
 return {...original,canvasApi:(url:string,...args:unknown[])=>String(url).includes("/assistant/tasks")?
  mocks.taskApi(url,...args):mocks.api(url,...args)};
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
function setup(actions:unknown[],resources:CanvasResourceReference[]=[],history:CanvasAssistantSession[]=[]){
 let graph=makeGraph();
 const getContext=vi.fn((ids:string[])=>({text:"节点：现有文本 (text, id=text-existing)\n明确引用："+ids.join(","),references:[],truncated:false}));
 const apply=vi.fn((items:unknown,stage:AssistantCanvasStage,refs?:ReadonlyMap<string,string>)=>{
  const result=applyAssistantCanvasActions(graph,items,stage,{x:400,y:300},refs);
  graph={nodes:result.nodes,connections:result.connections};
  return {applied:result.applied,refs:result.refs};
 });
 const result={answer:"提出操作",model:"demo",actions};
 mocks.api.mockResolvedValue(result);
 function Harness(){
  const [sessions,setSessions]=useState<CanvasAssistantSession[]>(history);
  const [active,setActive]=useState<string|null>(history[0]?.id??null);
  return createElement(CanvasAssistantPanel,{
   projectId:"p1",projectTitle:"测试画布",open:true,onClose:()=>{},
   sessions,setSessions,activeChatId:active,setActiveChatId:setActive,
   selectedNodes:resources.length?resources.map(item=>({id:item.nodeId,title:item.title,type:CanvasNodeType.Image})):
    [{id:"text-existing",title:"现有文本",type:CanvasNodeType.Text}],
   getContext,
   getResourceReferences:()=>resources,
   getWorkflowTemplates:async()=>({context:"",templates:new Map()}),   onApplyActions:apply,onRunActions:mocks.run,config:defaultConfig  });
 }
 container=document.createElement("div");document.body.appendChild(container);
 root=createRoot(container);
 return {Harness,apply,getContext,getGraph:()=>graph};
}
async function renderAndSend(Harness:()=>React.ReactElement){
 await act(async()=>{root!.render(createElement(Harness));});
 const suggestion=Array.from(container!.querySelectorAll("button")).find(btn=>btn.textContent?.includes("创建三个分镜文本节点"));
 if(suggestion){
  await act(async()=>{suggestion.click();});
 }else{
  const input=container!.querySelector<HTMLElement>('[aria-label="向 AI 助手发送消息"]')!;
  await act(async()=>{
   input.textContent="创建三个分镜文本节点并依次连线";
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
 mocks.taskApi.mockReset();mocks.taskApi.mockResolvedValue({tasks:[]});
 mocks.run.mockResolvedValue({submitted:1,jobIds:["job-demo"]});
 mocks.confirm.mockImplementation(()=>({destroy:vi.fn()}));
 skillMocks.snapshot.mockResolvedValue({revision:4,skills:[]});
});
afterEach(async()=>{
 if(root)await act(async()=>{root!.unmount()});
 root=null;container?.remove();container=null;
});
describe("P0a task linkage in the existing assistant send flow",()=>{
 it("records later user instructions and client observations without marking a task complete",async()=>{
  const history:CanvasAssistantSession[]=[{id:"chat-existing",title:"画布任务",createdAt:"2026-11-12",
   updatedAt:"2026-11-12",messages:[{id:"user-old",role:"user",text:"请搭建工作流"}]}];
  const fixture=setup([],[],history);
  const task={id:"task-linked",chatSessionId:"chat-existing",rootMessageId:"user-old",
   originalRequest:"请搭建工作流",status:"planning",steps:[],recoveryMode:"guidance_only"};
  mocks.taskApi.mockImplementation(async(url:string,method:string)=>{
   if(method==="GET"&&url.includes("chatSessionId="))return {tasks:[]};
   if(method==="GET")return {task};
   if(method==="POST")return {task};
   return {tasks:[]};
  });
  await act(async()=>{root!.render(createElement(fixture.Harness));});
  const remember=Array.from(container!.querySelectorAll("button")).find(btn=>btn.textContent==="记录为任务");
  expect(remember).toBeTruthy();
  await act(async()=>{remember!.click();await Promise.resolve();});
  expect(container!.textContent).toContain("仅指导恢复");
  await renderAndSend(fixture.Harness);
  const turn=mocks.taskApi.mock.calls.find(call=>String(call[0]).endsWith("/turns"));
  expect(turn).toBeTruthy();
  expect(turn?.[2].text).toContain("创建三个分镜文本节点");
  const report=mocks.taskApi.mock.calls.find(call=>String(call[0]).endsWith("/observations"));
  expect(report?.[2].kind).toBe("reply");
  expect(container!.textContent).toContain("待规划");
  expect(mocks.api.mock.calls.filter(call=>String(call[0]).includes("/assistant/chat"))).toHaveLength(1);
 });
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
    for(const [index,call] of mocks.api.mock.calls.entries()){
     const messages=call[2].messages as Array<{role:string;content:string}>;
     expect(messages).toHaveLength(1+index*2);
     expect(messages.at(-1)?.role).toBe("user");
     expect(messages.at(-1)?.content).toContain("创建三个分镜文本节点");
     if(index)expect(messages.some(item=>item.content.includes("模型未返回可执行的画布指令"))).toBe(true);
    }   expect(fixture.apply).toHaveBeenCalledTimes(1);
   expect(fixture.getGraph().nodes).toHaveLength(2);
   expect(container!.textContent).toContain("已自动执行 1 项画布操作");
   expect(container!.textContent).toContain("模型未返回可执行的画布指令");
  });
 it("AI receives exact media preset port definitions, confirms override, then runs node with updated binding",async()=>{
  const template:ComfyWorkflowTemplate={id:"img-flow",revision:"r1",name:"图片生成流程",
   apiGraph:{"1":{class_type:"Sampler",inputs:{steps:20,prompt:""}},"2":{class_type:"SaveImage",inputs:{}}},
   requirements:{classTypes:["Sampler","SaveImage"]},
   ports:[
    {id:"steps",label:"采样步数",direction:"target",valueKind:"INT",
     inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"steps"}]}},
    {id:"prompt",label:"提示词",direction:"target",valueKind:"STRING",
     inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"prompt"}]}},
    {id:"image",label:"Image",direction:"source",valueKind:"IMAGE",capture:{kind:"image",adapterId:"SaveImage"},outputBinding:{nodeId:"2",outputIndex:0}}
   ],
   mediaUseCase:{channel:"image",primaryOutputKind:"image",promptPortId:"prompt",slots:[],primaryOutputPortId:"image"}};
  const source:CanvasNodeData={id:"img-source",type:CanvasNodeType.Image,title:"生成图片",
   position:{x:0,y:0},width:400,height:320,
   metadata:{content:"/api/v1/blobs/original",prompt:"city",
    comfyMediaPreset:{templateId:"img-flow",templateRevision:"r1",overrides:{steps:16},slots:{}}}};
  let graph:AssistantCanvasGraph={nodes:[source],connections:[]};
  const apply=vi.fn((items:unknown,stage:AssistantCanvasStage,refs?:ReadonlyMap<string,string>,
   templates?:ReadonlyMap<string,ComfyWorkflowTemplate>)=>{
   const result=applyAssistantCanvasActions(graph,items,stage,{x:0,y:0},refs,defaultConfig,templates);
   graph={nodes:result.nodes,connections:result.connections};
   return {applied:result.applied,refs:result.refs};
  });
  const getWorkflowTemplates=vi.fn(async()=>({context:"工作流预设 img-flow；端口 id=steps，名称=采样步数，类型=INT，当前值=16",
   templates:new Map([["img-source",template]])}));
  mocks.api.mockResolvedValue({answer:"设置步数后生成",model:"demo",actions:[
   {type:"set_workflow_param",nodeId:"img-source",portId:"steps",value:42},
   {type:"run_node",nodeId:"img-source",mode:"image"}
  ]});
  function Harness(){
   const [sessions,setSessions]=useState<CanvasAssistantSession[]>([]);
   const [active,setActive]=useState<string|null>(null);
   return createElement(CanvasAssistantPanel,{
    projectId:"p1",projectTitle:"图像画布",open:true,onClose:()=>{},
    sessions,setSessions,activeChatId:active,setActiveChatId:setActive,
    selectedNodes:[{id:"img-source",title:"生成图片",type:CanvasNodeType.Image}],
    getContext:()=>({text:"图像节点 id=img-source",references:[],truncated:false}),
    getWorkflowTemplates,onApplyActions:apply,onRunActions:mocks.run,config:defaultConfig
   });
  }
  container=document.createElement("div");document.body.appendChild(container);
  root=createRoot(container);
  await renderAndSend(Harness);
  expect(getWorkflowTemplates).toHaveBeenCalled();  expect((mocks.api.mock.calls[0][2].messages as {role:string;content:string}[]).at(-1)?.content).toContain("端口 id=steps");
  expect(graph.nodes[0].metadata?.comfyMediaPreset?.overrides).toEqual({steps:16});
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
   expect(mocks.confirm.mock.calls[0][0].content).toContain("工作流输入参数");
   expect(mocks.run).not.toHaveBeenCalled();  await act(async()=>{mocks.confirm.mock.calls[0][0].onOk();await Promise.resolve();});
  expect(graph.nodes[0].metadata?.comfyMediaPreset?.overrides).toEqual({steps:42});
  expect(graph.nodes[0].metadata?.content).toBe(source.metadata?.content);
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(container!.textContent).toContain("已确认并执行 1 项内容或参数修改"); });
 it("P2.6 confirms replacement of a connected Comfy workflow input before running",async()=>{
  registerCanvasPortResolver("comfy:workflow",node=>node.metadata?.comfyPorts??[]);
  const template:ComfyWorkflowTemplate={id:"wf-tpl",revision:"rev1",name:"Workflow",
   apiGraph:{"1":{class_type:"TextProcessor",inputs:{text:""}},"2":{class_type:"Output",inputs:{}}},
   requirements:{classTypes:["TextProcessor","Output"]},
   ports:[
    {id:"text_in",label:"文本输入",direction:"target",valueKind:"STRING",required:true,
     inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"text"}]}},
    {id:"result",label:"图片输出",direction:"source",valueKind:"IMAGE",
     outputBinding:{nodeId:"2",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}
   ]};
  const work:CanvasNodeData={id:"wf-node",type:"comfy:workflow",title:"工作流",
   position:{x:300,y:0},width:360,height:260,metadata:{
    comfyWorkflow:{templateId:"wf-tpl",templateRevision:"rev1",bindingState:"needs-instance-binding",inputOverrides:{}},
    comfyPorts:template.ports.map(({id,label,direction,valueKind})=>({id,label,direction,valueKind}))
   }};
  const textNode=(id:string):CanvasNodeData=>({id,type:CanvasNodeType.Text,title:id,
   position:{x:0,y:0},width:280,height:180,metadata:{content:id+" content"}});
  const oldEdge={id:"old-edge",fromNodeId:"source-a",fromPortId:"text",toNodeId:"wf-node",toPortId:"text_in"};
  let graph:AssistantCanvasGraph={nodes:[textNode("source-a"),textNode("source-b"),work],
   connections:[oldEdge]};
  const apply=vi.fn((actions:unknown,stage:AssistantCanvasStage,refs?:ReadonlyMap<string,string>,
   templates?:ReadonlyMap<string,ComfyWorkflowTemplate>)=>{
   const result=applyAssistantCanvasActions(graph,actions,stage,{x:50,y:50},refs,defaultConfig,templates);
   graph={nodes:result.nodes,connections:result.connections};
   return {applied:result.applied,refs:result.refs};
  });
  const load=vi.fn(async()=>({context:"输入 portId=text_in，类型=STRING，已连接=source-a.text；sourceNodeId=source-b，sourcePortId=text",
   templates:new Map([["wf-node",template]])}));
  mocks.api.mockResolvedValue({answer:"更换上游文本并执行",model:"demo",actions:[
   {type:"replace_workflow_port",fromNodeId:"source-b",fromPortId:"text",toNodeId:"wf-node",toPortId:"text_in"},
   {type:"run_workflow",nodeId:"wf-node"}
  ]});
  function Harness(){
   const [sessions,setSessions]=useState<CanvasAssistantSession[]>([]);
   const [active,setActive]=useState<string|null>(null);
   return createElement(CanvasAssistantPanel,{
    projectId:"p1",projectTitle:"测试工作流",open:true,onClose:()=>{},
    sessions,setSessions,activeChatId:active,setActiveChatId:setActive,
    selectedNodes:[{id:"wf-node",title:"工作流",type:"comfy:workflow"}],
    getContext:()=>({text:"节点工作流 wf-node",references:[],truncated:false}),
    getWorkflowTemplates:load,onApplyActions:apply,onRunActions:mocks.run,config:defaultConfig
   });
  }
  try{
   container=document.createElement("div");document.body.appendChild(container);
   root=createRoot(container);
   await renderAndSend(Harness);
   expect(load).toHaveBeenCalled();
   expect((mocks.api.mock.calls[0][2].messages as {role:string;content:string}[]).at(-1)?.content).toContain("portId=text_in");
   expect(mocks.confirm).toHaveBeenCalledOnce();
   expect(mocks.confirm.mock.calls[0][0].content).toContain("替换 1 条工作流输入连线");
   expect(graph.connections).toEqual([oldEdge]);
   expect(mocks.run).not.toHaveBeenCalled();
   await act(async()=>{mocks.confirm.mock.calls[0][0].onOk();await Promise.resolve();});
   expect(graph.connections).toMatchObject([{fromNodeId:"source-b",fromPortId:"text",toNodeId:"wf-node",toPortId:"text_in"}]);
   expect(graph.connections[0].id).not.toBe(oldEdge.id);
   expect(mocks.run).toHaveBeenCalledOnce();
   expect(container!.textContent).toContain("已通过原有节点执行链路提交 1 项生成任务");
  }finally{registerCanvasPortResolver("comfy:workflow");}
 });
   it("P2.5 requires approval before prompt and parameter edits can trigger generation",async()=>{   const fixture=setup([   {type:"set_prompt",nodeId:"text-existing",prompt:"新生成提示词"},
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
 it("typing slash opens the same Skill menu and selecting a suggestion inserts a scoped Skill chip",async()=>{
  skillMocks.snapshot.mockResolvedValue({revision:6,skills:[
   {id:"story",name:"分镜编剧",description:"剧本分镜工作流",enabled:true,scope:{type:"global"},
    activeVersion:"abcdef123456",versions:["abcdef123456"],updatedAt:"today"},
   {id:"hidden",name:"隐藏技能",description:"不可使用",enabled:false,scope:{type:"global"},
    activeVersion:"bbbbbbbbbbbb",versions:["bbbbbbbbbbbb"],updatedAt:"today"}
  ]});
  const fixture=setup([]);
  await act(async()=>{root!.render(createElement(fixture.Harness));await Promise.resolve();});
  const editor=container!.querySelector<HTMLElement>('[aria-label="向 AI 助手发送消息"]')!;
  await act(async()=>{
   editor.focus();
   editor.textContent="请规划镜头 /";
   const range=document.createRange();
   const textNode=editor.firstChild!;
   range.setStart(textNode,(textNode.textContent||"").length);
   range.collapse(true);
   window.getSelection()?.removeAllRanges();
   window.getSelection()?.addRange(range);
   editor.dispatchEvent(new Event("input",{bubbles:true}));
   await Promise.resolve();
  });
  const menu=document.body.querySelector<HTMLElement>('[data-skill-slash-menu="true"]');
  expect(menu).toBeTruthy();
  expect(menu!.textContent).toContain("分镜编剧");
  expect(menu!.textContent).not.toContain("隐藏技能");
  await act(async()=>{menu!.querySelector<HTMLButtonElement>("button")!.click();});
  expect(editor.querySelector<HTMLElement>('[data-skill-id="story"]')).toBeTruthy();
  const send=container!.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!;
  await act(async()=>{send.click();await Promise.resolve();});
  const sent=mocks.api.mock.calls.find(call=>String(call[0]).includes("/assistant/chat"));
  expect(sent?.[2].skills).toEqual({mode:"manual",projectId:"p1",expectedRevision:6,
   skillIds:["story"],versionPins:{story:"abcdef123456"}});
  expect(sent?.[2].messages.at(-1).content).not.toContain("/[skill:");
 });
 it("positions Skill suggestions immediately above the caret in the bottom chat composer",async()=>{
  skillMocks.snapshot.mockResolvedValue({revision:6,skills:[
   {id:"story",name:"分镜编剧",description:"镜头指导",enabled:true,scope:{type:"global"},
    activeVersion:"abcdef123456",versions:["abcdef123456"],updatedAt:"today"}
  ]});
  const rangeRect=vi.spyOn(Range.prototype,"getBoundingClientRect").mockReturnValue(new DOMRect(0,0,0,0));
  const glyphRect=new DOMRect(460,window.innerHeight-60,8,18);
  const glyphRects=vi.spyOn(Range.prototype,"getClientRects").mockReturnValue([glyphRect] as unknown as DOMRectList);
  try{
   const fixture=setup([]);
   await act(async()=>{root!.render(createElement(fixture.Harness));await Promise.resolve();});
   const editor=container!.querySelector<HTMLElement>('[aria-label="向 AI 助手发送消息"]')!;
   await act(async()=>{
    editor.focus();
    editor.textContent="写分镜 /";
    const range=document.createRange();
    range.setStart(editor.firstChild!,editor.firstChild!.textContent!.length);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    editor.dispatchEvent(new Event("input",{bubbles:true}));
   });
   const menu=document.body.querySelector<HTMLElement>('[data-skill-slash-menu="true"]')!;
   expect(menu).toBeTruthy();
   expect(menu.style.left).toBe("468px");
   expect(menu.style.bottom).toBe("66px");
   expect(menu.style.top).toBe("");
   expect(Number.parseInt(menu.style.maxHeight,10)).toBeGreaterThanOrEqual(58);
  }finally{rangeRect.mockRestore();glyphRects.mockRestore();}
 });
 it("positions a single @ image candidate immediately above the bottom composer caret without a scrollbar",async()=>{
  const references:CanvasResourceReference[]=[{
   id:"img-01",nodeId:"img-01",kind:"image",label:"参考图1",
   title:"人物立绘",previewUrl:"/api/v1/blobs/image",active:true
  }];
  const rangeRect=vi.spyOn(Range.prototype,"getBoundingClientRect").mockReturnValue(new DOMRect(0,0,0,0));
  const glyphRect=new DOMRect(460,window.innerHeight-60,8,18);
  const glyphRects=vi.spyOn(Range.prototype,"getClientRects").mockReturnValue([glyphRect] as unknown as DOMRectList);
  try{
   const fixture=setup([],references);
   await act(async()=>{root!.render(createElement(fixture.Harness));await Promise.resolve();});
   const editor=container!.querySelector<HTMLElement>('[aria-label="向 AI 助手发送消息"]')!;
   await act(async()=>{
    editor.focus();
    editor.textContent="反推图片 @";
    const range=document.createRange();
    range.setStart(editor.firstChild!,editor.firstChild!.textContent!.length);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    editor.dispatchEvent(new Event("input",{bubbles:true}));
   });
   const menu=document.body.querySelector<HTMLElement>('[data-canvas-resource-mention-menu="true"]');
   expect(menu).toBeTruthy();
   expect(menu!.querySelectorAll("button")).toHaveLength(1);
   expect(menu!.style.left).toBe("468px");
   expect(menu!.style.bottom).toBe("66px");
   expect(menu!.style.top).toBe("");
   expect(Number.parseInt(menu!.style.maxHeight,10)).toBeGreaterThanOrEqual(58);
   await act(async()=>{menu!.querySelector<HTMLButtonElement>("button")!.click();});
   expect(editor.querySelector('[data-ref-label^="@[node:img-01"]')).toBeTruthy();
  }finally{rangeRect.mockRestore();glyphRects.mockRestore();}
 });
 it("assistant sends only selected authorized Skill IDs and version pins",async()=>{
  skillMocks.snapshot.mockResolvedValue({revision:4,skills:[
   {id:"story",name:"分镜编剧",description:"分镜指导",enabled:true,scope:{type:"global"},
    activeVersion:"abcdef123456",versions:["abcdef123456"],updatedAt:"today"},
   {id:"hidden",name:"不可用",description:"不应该展示",enabled:false,scope:{type:"global"},
    activeVersion:"aaaaaaaaaaaa",versions:["aaaaaaaaaaaa"],updatedAt:"today"}
  ]});
  const fixture=setup([]);
  await act(async()=>{root!.render(createElement(fixture.Harness));});
  expect(container!.querySelector('[aria-label="Skill 模式"]')).toBeNull();
  const input=container!.querySelector<HTMLElement>('[aria-label="向 AI 助手发送消息"]')!;
  expect(container!.textContent).toContain("输入 /");
  await act(async()=>{
   input.textContent="创建三个分镜文本节点并依次连线 /[skill:story]";
   input.dispatchEvent(new Event("input",{bubbles:true}));
  });
  expect(container!.textContent).not.toContain("不可用");
  const send=container!.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!;
  await act(async()=>{send.click();await Promise.resolve();});
  const sent=mocks.api.mock.calls.find(call=>String(call[0]).includes("/assistant/chat"));
  expect(sent).toBeTruthy();
  expect(sent![2].skills).toEqual({
   mode:"manual",projectId:"p1",expectedRevision:4,
   skillIds:["story"],versionPins:{story:"abcdef123456"}
  });
  expect(sent![2].messages.at(-1).content).not.toContain("/[skill:story]");
  expect(sent![2].messages.at(-1).content).not.toContain("分镜指导");
  expect(fixture.apply).not.toHaveBeenCalled();
 });
 it("explicit slash Skill takes priority over default automatic matching",async()=>{
  skillMocks.snapshot.mockResolvedValue({revision:8,skills:[
   {id:"story",name:"分镜编剧",description:"剧本",enabled:true,
    activeVersion:"abcdef123456",versions:["abcdef123456"],updatedAt:"today"},
   {id:"sound",name:"配乐",description:"音乐",enabled:true,
    activeVersion:"bbbbbbbbbbbb",versions:["bbbbbbbbbbbb"],updatedAt:"today"}
  ]});
  const fixture=setup([]);
  await act(async()=>{root!.render(createElement(fixture.Harness));});
  expect(container!.querySelector('[aria-label="Skill 模式"]')).toBeNull();
  const editor=container!.querySelector<HTMLElement>('[aria-label="向 AI 助手发送消息"]')!;
  await act(async()=>{
   editor.textContent="整理故事 /[skill:story]";
   editor.dispatchEvent(new Event("input",{bubbles:true}));
  });
  await act(async()=>{container!.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click();});
  const sent=mocks.api.mock.calls.find(call=>String(call[0]).includes("/assistant/chat"));
  expect(sent?.[2].skills.mode).toBe("manual");
  expect(sent?.[2].skills.skillIds).toEqual(["story"]);
 });
 it("automatically sends all enabled project Skills for server-side relevance matching by default",async()=>{
  skillMocks.snapshot.mockResolvedValue({revision:11,skills:[
   {id:"story",name:"编剧",description:"分镜剧本",enabled:true,scope:{type:"global"},
    activeVersion:"abcdef123456",versions:["abcdef123456"],updatedAt:"today"},
   {id:"sound",name:"配乐",description:"音乐",enabled:true,scope:{type:"project",projectId:"p1"},
    activeVersion:"bbbbbbbbbbbb",versions:["bbbbbbbbbbbb"],updatedAt:"today"},
   {id:"hidden",name:"不可用",description:"禁用",enabled:false,scope:{type:"global"},
    activeVersion:"cccccccccccc",versions:["cccccccccccc"],updatedAt:"today"},
   {id:"foreign",name:"其他项目",description:"不可使用",enabled:true,scope:{type:"project",projectId:"p2"},
    activeVersion:"dddddddddddd",versions:["dddddddddddd"],updatedAt:"today"}
  ]});
  const fixture=setup([]);
  await renderAndSend(fixture.Harness);
  expect(container!.querySelector('[aria-label="Skill 模式"]')).toBeNull();
  const sent=mocks.api.mock.calls.find(call=>String(call[0]).includes("/assistant/chat"));
  expect(sent?.[2].skills).toEqual({mode:"auto",projectId:"p1",expectedRevision:11,
   skillIds:["story","sound"],versionPins:{story:"abcdef123456",sound:"bbbbbbbbbbbb"}});
 });

 it("without enabled Skills ordinary chat and canvas actions continue without selection",async()=>{
  const fixture=setup([{type:"create_node",ref:"new",nodeType:"text",title:"新节点",content:"剧情"}]);
  await renderAndSend(fixture.Harness);
  const sent=mocks.api.mock.calls.find(call=>String(call[0]).includes("/assistant/chat"));
  expect(sent).toBeTruthy();
  expect(sent?.[2].skills).toBeUndefined();
  expect(fixture.apply).toHaveBeenCalledTimes(1);
  expect(container!.textContent).not.toContain("未匹配");
 });

 it("automatic Skill catalog fetch failure degrades to ordinary chat, not a request failure",async()=>{
  skillMocks.snapshot.mockRejectedValue(Error("registry offline"));
  const fixture=setup([]);
  await renderAndSend(fixture.Harness);
  const sent=mocks.api.mock.calls.find(call=>String(call[0]).includes("/assistant/chat"));
  expect(sent).toBeTruthy();
  expect(sent?.[2].skills).toBeUndefined();
  expect(container!.textContent).toContain("Skill 列表暂不可用");
 });

 it("explicitly selected Skill fails closed when registry cannot be validated",async()=>{
  skillMocks.snapshot.mockRejectedValue(Error("registry offline"));
  const fixture=setup([]);
  await act(async()=>{root!.render(createElement(fixture.Harness));});
  const input=container!.querySelector<HTMLElement>('[aria-label="向 AI 助手发送消息"]')!;
  await act(async()=>{
   input.textContent="按剧本生成 /[skill:story]";
   input.dispatchEvent(new Event("input",{bubbles:true}));
  });
  await act(async()=>{container!.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click();await Promise.resolve();});
  expect(mocks.api.mock.calls.filter(call=>String(call[0]).includes("/assistant/chat"))).toHaveLength(0);
  expect(container!.textContent).toContain("无法验证指定的 Skill");
 });

 it("auto Skill authorization changes retry without Skill while preserving canvas execution",async()=>{
  skillMocks.snapshot.mockResolvedValue({revision:10,skills:[
   {id:"story",name:"分镜",description:"剧情",enabled:true,scope:{type:"global"},
    activeVersion:"abcdef123456",versions:["abcdef123456"],updatedAt:"today"}
  ]});
  const fixture=setup([{type:"create_node",ref:"new",nodeType:"text",title:"自动重试",content:"剧情"}]);
  mocks.api.mockRejectedValueOnce(new CanvasApiError("assistant_skill_catalog_changed",409));
  await renderAndSend(fixture.Harness);
  const sent=mocks.api.mock.calls.filter(call=>String(call[0]).includes("/assistant/chat"));
  expect(sent).toHaveLength(2);
  expect(sent[0][2].skills.mode).toBe("auto");
  expect(sent[1][2].skills).toBeUndefined();
  expect(sent[1][2].messages).toEqual(sent[0][2].messages);
  expect(fixture.apply).toHaveBeenCalledTimes(1);
  expect(container!.textContent).toContain("Skill 自动匹配未成功");
 });

 it("explicit Skill authorization error does not silently fall back to unskilled chat",async()=>{
  skillMocks.snapshot.mockResolvedValue({revision:10,skills:[
   {id:"story",name:"分镜",description:"剧情",enabled:true,scope:{type:"global"},
    activeVersion:"abcdef123456",versions:["abcdef123456"],updatedAt:"today"}
  ]});
  const fixture=setup([]);
  mocks.api.mockRejectedValueOnce(new CanvasApiError("assistant_skill_catalog_changed",409));
  await act(async()=>{root!.render(createElement(fixture.Harness));});
  const input=container!.querySelector<HTMLElement>('[aria-label="向 AI 助手发送消息"]')!;
  await act(async()=>{input.textContent="生成分镜 /[skill:story]";input.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>{container!.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click();await Promise.resolve();});
  const sent=mocks.api.mock.calls.filter(call=>String(call[0]).includes("/assistant/chat"));
  expect(sent).toHaveLength(1);
  expect(sent[0][2].skills.mode).toBe("manual");
  expect(container!.textContent).toContain("Skill 列表或版本已发生变化");
 });

 it("restores a historical completed run's real text output from the audit API without rerunning the script",async()=>{
  const runId="01182680-43a8-428a-b373-189668e7bf4a";
  const prompt='{"caption":"夜市肖像","visible_text":"你好"}';
  const history:CanvasAssistantSession[]=[{
   id:"chat-old",title:"历史 Skill 执行",createdAt:"2026-11-12",updatedAt:"2026-11-12",
   messages:[{id:"run-message",role:"assistant",meta:"Skill 脚本运行记录",
    text:"Skill 脚本已执行完成（运行 ID："+runId+"；状态：completed）。已保存产物：outputs/prompt.txt。"}]
  }];
  const fixture=setup([],[],history);
  mocks.api.mockImplementation(async(url:string,method:string)=>{
   if(url==="/api/v1/skills/runs/"+runId&&method==="GET")return {
    id:runId,project_id:"p1",status:"completed",result:{
     status:"completed",exit_code:0,artifacts:[{
      path:"outputs/prompt.txt",mime:"text/plain",content:prompt,
      byte_length:new TextEncoder().encode(prompt).length,blob_id:"a".repeat(64)
     }]
    }
   };
   throw Error("Unexpected endpoint: "+url);
  });
  await act(async()=>{root!.render(createElement(fixture.Harness));});
  const restore=container!.querySelector<HTMLButtonElement>('[aria-label="恢复 Skill 脚本产物"]');
  expect(restore).toBeTruthy();
  await act(async()=>{restore!.click();await Promise.resolve();});
  expect(fixture.getGraph().nodes.find(node=>node.title.includes("prompt.txt"))?.metadata?.content).toBe(prompt);
  expect(container!.textContent).toContain("无需重新执行 Skill 脚本");
  expect(mocks.api.mock.calls.every(call=>call[0]!=="/api/v1/skills/execute")).toBe(true);
 });

 it("rejects restoring historical Skill output from another project",async()=>{
  const runId="01182680-43a8-428a-b373-189668e7bf4a";
  const history:CanvasAssistantSession[]=[{
   id:"chat-old",title:"历史 Skill 执行",createdAt:"2026-11-12",updatedAt:"2026-11-12",
   messages:[{id:"run-message",role:"assistant",meta:"Skill 脚本运行记录",
    text:"Skill 脚本已执行完成（运行 ID："+runId+"；状态：completed）。"}]
  }];
  const fixture=setup([],[],history);
  mocks.api.mockResolvedValue({id:runId,project_id:"other",status:"completed",result:{
   status:"completed",exit_code:0,artifacts:[{path:"final.txt",mime:"text/plain",content:"private"}]
  }});
  await act(async()=>{root!.render(createElement(fixture.Harness));});
  await act(async()=>{container!.querySelector<HTMLButtonElement>('[aria-label="恢复 Skill 脚本产物"]')!.click();await Promise.resolve();});
  expect(fixture.getGraph().nodes).toHaveLength(1);
  expect(container!.textContent).toContain("不属于当前项目");
 });
 it("recovers real text artifacts into canvas when post-script model reports an incomplete Skill flow",async()=>{
  const fixture=setup([]);
  const prompt='{"summary":{"caption":"夜市红灯笼"},"items":[{"label":"object","text":"你好"}]}';
  const proposal={skill_id:"generic-kit",version:"abcdef123456",
   script_path:"scripts/build.py",args:["draft.json","--output","outputs/prompt.txt"],
   input_files:{"draft.json":"{}"},output_files:["outputs/prompt.txt"]};
  let chats=0;
  mocks.api.mockImplementation(async(url:string)=>{
   if(String(url).includes("/assistant/chat")){
    if(++chats===1)return {answer:"等待用户确认",model:"demo",actions:[],
      skillScriptProposal:proposal,appliedSkillIds:["generic-kit"]};
    throw new CanvasApiError("assistant_skill_execution_incomplete",502);
   }
   if(url==="/api/v1/skills/execute")return {run_id:"01182680-recovered",
    status:"completed",exit_code:0,
    artifacts:[{path:"outputs/prompt.txt",mime:"text/plain",
     content:prompt,byte_length:new TextEncoder().encode(prompt).length,
     blob_id:"a".repeat(64)}]};
   throw Error("Unexpected request: "+url);
  });
  await renderAndSend(fixture.Harness);
  expect(fixture.getGraph().nodes).toHaveLength(1);
  await act(async()=>{mocks.confirm.mock.calls[0][0].onOk();await Promise.resolve();});
  expect(chats).toBe(2);
  const created=fixture.getGraph().nodes.find(node=>node.title.includes("prompt.txt"));
  expect(created?.metadata?.content).toBe(prompt);
  expect(container!.textContent).toContain("01182680-recovered");
  expect(container!.textContent).toContain("真实文本产物写入画布");
 });

 it("completed Skill text output is materialized if model returns no canvas actions",async()=>{
  const fixture=setup([]);
  const proposal={skill_id:"toolkit",version:"abcdef123456",script_path:"scripts/format.js",
   args:[],input_files:{},output_files:["outputs/final.txt"]};
  let chats=0;
  mocks.api.mockImplementation(async(url:string)=>{
   if(String(url).includes("/assistant/chat")){
    if(++chats===1)return {answer:"等待确认",model:"demo",actions:[],skillScriptProposal:proposal};
    return {answer:"脚本已经完成，结果可使用",model:"demo",actions:[]};
   }
   if(url==="/api/v1/skills/execute")return {run_id:"success-output",status:"completed",
    exit_code:0,artifacts:[{path:"outputs/final.txt",mime:"text/plain",
     content:"the actual output",byte_length:17}]};
   throw Error("Unexpected request");
  });
  await renderAndSend(fixture.Harness);
  await act(async()=>{mocks.confirm.mock.calls[0][0].onOk();await Promise.resolve();});
  expect(chats).toBe(2);
  expect(fixture.getGraph().nodes.some(node=>node.metadata?.content==="the actual output")).toBe(true);
 });

 it("generic Skill uses actual compiled artifact text to create a canvas node",async()=>{
  const fixture=setup([]);
  const proposal={skill_id:"toolkit",version:"abcdef123456",script_path:"scripts/process.py",
   args:["source.json","--output","result.txt"],input_files:{"source.json":'{"title":"测试"}'},output_files:["result.txt"]};
  const compiled='{"payload":"已经生成的实际输出","script":"toolkit"}';
  let turns=0;
  mocks.api.mockImplementation(async(url:string,_method:string,body:Record<string,unknown>)=>{
   if(String(url).includes("/assistant/chat")){
    turns++;
    if(turns===1)return {answer:"准备执行技能",model:"demo",actions:[],skillScriptProposal:proposal,
     appliedSkillIds:["toolkit"]};
    expect(JSON.stringify(body.messages)).toContain("已经生成的实际输出");
    return {answer:"已根据输出创建文本节点",model:"demo",actions:[
     {type:"create_node",ref:"complete",nodeType:"text",title:"最终结果",content:compiled}]};
   }
   if(url==="/api/v1/skills/execute")return {run_id:"run-toolkit",status:"completed",exit_code:0,
    artifacts:[{path:"result.txt",content:compiled,mime:"text/plain",blob_id:"a".repeat(64)}]};
   throw Error("unexpected");
  });
  await renderAndSend(fixture.Harness);
  expect(fixture.getGraph().nodes).toHaveLength(1);
  await act(async()=>{mocks.confirm.mock.calls[0][0].onOk();await Promise.resolve();});
  expect(fixture.getGraph().nodes.find(node=>node.title==="最终结果")?.metadata?.content).toBe(compiled);
  expect(turns).toBe(2);
  expect(container!.textContent).toContain("run-toolkit");
 });

 it("a generic Skill can recover a failed script using a second explicitly approved proposal",async()=>{
  const fixture=setup([]);
  const first={skill_id:"toolkit",version:"abcdef123456",script_path:"scripts/compile.py",
   args:["source.json"],input_files:{"source.json":'{"type":"wrong"}'},output_files:["result.txt"]};
  const corrected={...first,input_files:{"source.json":'{"type":"correct"}'}};
  let chats=0,runs=0;
  mocks.api.mockImplementation(async(url:string,_method:string,body:Record<string,unknown>)=>{
   if(String(url).includes("/assistant/chat")){
    chats++;
    if(chats===1)return {answer:"请求执行",model:"demo",actions:[],skillScriptProposal:first,
     appliedSkillIds:["toolkit"]};
    if(chats===2){
     expect(JSON.stringify(body.messages)).toContain("type must be correct");
     return {answer:"依据脚本错误修正输入，等待再次批准",model:"demo",actions:[],
      skillScriptProposal:corrected,appliedSkillIds:["toolkit"]};
    }
    expect(JSON.stringify(body.messages)).toContain("已生成真实产物");
    return {answer:"脚本成功",model:"demo",actions:[
     {type:"create_node",ref:"created",nodeType:"text",title:"真实结果",content:"已生成真实产物"}]};
   }
   if(url==="/api/v1/skills/execute"){
    runs++;
    return runs===1?{run_id:"fail-run",status:"failed",exit_code:2,stderr:"type must be correct",
     artifacts:[]}:{run_id:"pass-run",status:"completed",exit_code:0,
      artifacts:[{path:"result.txt",content:"已生成真实产物",mime:"text/plain",blob_id:"b".repeat(64)}]};
   }
   throw Error("unexpected");
  });
  await renderAndSend(fixture.Harness);
  await act(async()=>{mocks.confirm.mock.calls[0][0].onOk();await Promise.resolve();});
  expect(runs).toBe(1);
  expect(fixture.getGraph().nodes).toHaveLength(1);
  expect(container!.textContent).toContain("type must be correct");
  expect(mocks.confirm).toHaveBeenCalledTimes(2);
  await act(async()=>{mocks.confirm.mock.calls[1][0].onOk();await Promise.resolve();});
  expect(runs).toBe(2);
  expect(fixture.getGraph().nodes.find(node=>node.title==="真实结果")?.metadata?.content).toBe("已生成真实产物");
  expect(container!.textContent).toContain("pass-run");
 });

 it("failed Skill execution never applies model-proposed draft-only actions",async()=>{
  const fixture=setup([]);
  let chats=0;
  mocks.api.mockImplementation(async(url:string)=>{
   if(String(url).includes("/assistant/chat")){
    chats++;
    return chats===1?{answer:"等待执行",model:"demo",actions:[],
      skillScriptProposal:{skill_id:"toolkit",version:"abcdef123456",
       script_path:"scripts/compile.py",args:[],input_files:{},output_files:[]}}:
      {answer:"脚本没有成功",model:"demo",actions:[
       {type:"create_node",ref:"draft",nodeType:"text",title:"错误的草稿",content:"草稿"}]};
   }
   if(url==="/api/v1/skills/execute")return {
    run_id:"failed-123",status:"failed",exit_code:2,stderr:"label must be an allowed value"
   };
   throw Error("unexpected");
  });
  await renderAndSend(fixture.Harness);
  await act(async()=>{mocks.confirm.mock.calls[0][0].onOk();await Promise.resolve();});
  expect(fixture.getGraph().nodes).toHaveLength(1);
  expect(container!.textContent).toContain("label must be an allowed value");
  expect(container!.textContent).toContain("failed-123");
 });
 it("assistant requires explicit confirmation before executing a model-proposed Skill script",async()=>{
  const fixture=setup([]);
  const proposal={skill_id:"story",version:"aaaaaaaaaaaa",script_path:"scripts/compile.js",
   args:["input.txt"],input_files:{"input.txt":"用户数据"},output_files:["result.txt"]};
  let assistantCalls=0;
  mocks.api.mockImplementation(async (url:string,_method:string,body:Record<string,unknown>)=>{
   if(url.includes("/assistant/chat")){
    assistantCalls++;
    return assistantCalls===1?
     {answer:"等待确认",model:"demo",actions:[],skillScriptProposal:proposal}:
     {answer:"已根据脚本结果创建文本",model:"demo",
      actions:[{type:"create_node",ref:"created",nodeType:"text",title:"生成结果",content:"脚本返回内容"}]};
   }
   if(url==="/api/v1/skills/execute")
    return {run_id:"run-audit-123",status:"completed",stdout:"生成成功",exit_code:0,
     artifacts:[{path:"result.txt",mime:"text/plain",blob_id:"b".repeat(64)}]};
   throw Error("Unexpected request: "+url);
  });
  await renderAndSend(fixture.Harness);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  const confirmation=mocks.confirm.mock.calls[0][0];
  expect(confirmation.title).toBe("确认运行本地 Skill 脚本");
  expect(confirmation.okText).toBe("确认运行脚本");
  expect(mocks.api.mock.calls.filter(call=>call[0]==="/api/v1/skills/execute")).toHaveLength(0);
  expect(fixture.apply).not.toHaveBeenCalled();
  await act(async()=>{confirmation.onOk();await Promise.resolve();await Promise.resolve();});
  const scriptRequests=mocks.api.mock.calls.filter(call=>call[0]==="/api/v1/skills/execute");
  expect(scriptRequests).toHaveLength(1);
  expect(scriptRequests[0][2]).toEqual({project_id:"p1",...proposal});
  const chatRequests=mocks.api.mock.calls.filter(call=>String(call[0]).includes("/assistant/chat"));
  expect(chatRequests).toHaveLength(2);
  expect(chatRequests[1][2].skillScriptProposalEnabled).toBe(true);
  expect(chatRequests[1][2].messages[0].content).toContain("run-audit-123");
  expect(chatRequests[1][2].messages[0].content).toContain("生成成功");
  expect(fixture.getGraph().nodes).toHaveLength(2);
  expect(container!.textContent).toContain("运行 ID：run-audit-123");
 });

 it("persists the Skill run ID in chat even if final model inference fails",async()=>{
  const fixture=setup([]);
  const proposal={skill_id:"story",version:"aaaaaaaaaaaa",script_path:"scripts/compile.js",
   args:[],input_files:{},output_files:[]};
  let count=0;
  mocks.api.mockImplementation(async (url:string)=>{
   if(String(url).includes("/assistant/chat")){
    count++;
    if(count===1)return {answer:"等待确认",model:"demo",actions:[],skillScriptProposal:proposal};
    throw new CanvasApiError("assistant_upstream_error",502);
   }
   if(url==="/api/v1/skills/execute")return {run_id:"audit-survived",status:"completed",stdout:"运行完毕"};
   throw Error("unexpected");
  });
  await renderAndSend(fixture.Harness);
  await act(async()=>{mocks.confirm.mock.calls[0][0].onOk();await Promise.resolve();await Promise.resolve();});
  expect(mocks.api.mock.calls.filter(call=>call[0]==="/api/v1/skills/execute")).toHaveLength(1);
  expect(container!.textContent).toContain("运行 ID：audit-survived");
  expect(container!.textContent).toContain("模型渠道返回错误");
  expect(fixture.apply).not.toHaveBeenCalled();
 });
 it("assistant cancellation never executes a proposed Skill script or modifies canvas",async()=>{
  const fixture=setup([]);
  mocks.api.mockResolvedValue({answer:"等待确认",model:"demo",actions:[],
   skillScriptProposal:{skill_id:"story",version:"aaaaaaaaaaaa",script_path:"scripts/compile.js",
    args:[],input_files:{},output_files:[]}});
  await renderAndSend(fixture.Harness);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  await act(async()=>{mocks.confirm.mock.calls[0][0].onCancel();await Promise.resolve();});
  expect(mocks.api.mock.calls.filter(call=>call[0]==="/api/v1/skills/execute")).toHaveLength(0);
  expect(mocks.api.mock.calls.filter(call=>String(call[0]).includes("/assistant/chat"))).toHaveLength(1);
  expect(fixture.apply).not.toHaveBeenCalled();
  expect(container!.textContent).toContain("已取消待执行的 Skill 脚本");
 });
 it("stopping while confirmation is open aborts without executing the script",async()=>{
  const fixture=setup([]);
  mocks.api.mockResolvedValue({answer:"等待确认",model:"demo",actions:[],
   skillScriptProposal:{skill_id:"story",version:"aaaaaaaaaaaa",script_path:"scripts/compile.js",
    args:[],input_files:{},output_files:[]}});
  await renderAndSend(fixture.Harness);
  await act(async()=>{container!.querySelector<HTMLButtonElement>('[aria-label="停止生成"]')!.click();await Promise.resolve();});
  expect(mocks.api.mock.calls.filter(call=>call[0]==="/api/v1/skills/execute")).toHaveLength(0);
  expect(fixture.apply).not.toHaveBeenCalled();
  expect(container!.textContent).toContain("已停止生成");
 });
 it("reuses selected canvas image @ suggestions, prepopulates reverse prompt, and sends only image IDs",async()=>{
  const refs:CanvasResourceReference[]=[{id:"img-01",nodeId:"img-01",kind:"image",label:"参考图1",
   title:"人物立绘",previewUrl:"/api/v1/blobs/123",active:true}];
  const fixture=setup([],refs);
  await act(async()=>{root!.render(createElement(fixture.Harness));});
  const shortcut=Array.from(container!.querySelectorAll("button")).find(button=>
   button.textContent?.includes("反推画布图片的生成提示词"));
  expect(shortcut).toBeTruthy();
  await act(async()=>{shortcut!.click();});
  const editor=container!.querySelector<HTMLElement>('[aria-label="向 AI 助手发送消息"]')!;
  expect(editor.querySelector('[data-ref-label^="@[node:img-01"]')).toBeTruthy();
  await act(async()=>{container!.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click();await Promise.resolve();});
  const sent=mocks.api.mock.calls.find(call=>String(call[0]).includes("/assistant/chat"));
  expect(sent?.[2].visualContext).toEqual({detail:"high",images:[{nodeId:"img-01"}]});
  expect(sent?.[2].messages.at(-1).content).toContain("【参考图片：人物立绘】");
  expect(JSON.stringify(sent?.[2])).not.toContain("data:image");
  expect(container!.textContent).toContain("视觉图片 1 张");
 });

 it("@ references unselected text, video and workflow nodes without media bytes",async()=>{
  const refs:CanvasResourceReference[]=[
   {id:"text-1",nodeId:"text-1",kind:"text",label:"资料1",title:"分镜脚本",text:"完整脚本",active:true},
   {id:"video-1",nodeId:"video-1",kind:"video",label:"视频1",title:"镜头预览",active:true},
   {id:"workflow-1",nodeId:"workflow-1",kind:"node",label:"节点1",title:"Comfy 工作流",active:true}
  ];
  const fixture=setup([],refs);
  await act(async()=>{root!.render(createElement(fixture.Harness));});
  const overview=Array.from(container!.querySelectorAll("button")).find(button=>button.textContent==="画布概览")!;
  await act(async()=>{overview.click();});
  const editor=container!.querySelector<HTMLElement>('[aria-label="向 AI 助手发送消息"]')!;
  await act(async()=>{
   editor.textContent="比较 "+refs.map(canvasResourceReferenceToken).join(" ");
   editor.dispatchEvent(new Event("input",{bubbles:true}));
  });
  await act(async()=>{container!.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click();await Promise.resolve();});
  const sent=mocks.api.mock.calls.find(call=>String(call[0]).includes("/assistant/chat"));
  expect(sent).toBeTruthy();
  expect(sent?.[2].visualContext).toBeUndefined();
  expect(sent?.[2].messages.at(-1).content).toContain("【引用节点：分镜脚本（text，id=text-1）】");
  expect(sent?.[2].messages.at(-1).content).toContain("明确引用：text-1,video-1,workflow-1");
  expect(fixture.getContext).toHaveBeenCalledWith(["text-1","video-1","workflow-1"],"selection");
 });
  it("plain chat never sends canvas pictures implicitly even with image references selected",async()=>{
  const refs:CanvasResourceReference[]=[{id:"img-01",nodeId:"img-01",kind:"image",label:"参考图1",
   title:"人物立绘",active:true}];
  const fixture=setup([],refs);
  await act(async()=>{root!.render(createElement(fixture.Harness));});
  const editor=container!.querySelector<HTMLElement>('[aria-label="向 AI 助手发送消息"]')!;
  await act(async()=>{editor.textContent="帮我写一段独白";editor.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>{container!.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click();await Promise.resolve();});
  const sent=mocks.api.mock.calls.find(call=>String(call[0]).includes("/assistant/chat"));
  expect(sent).toBeTruthy();expect(sent?.[2].visualContext).toBeUndefined();
 });
 it("Ctrl or Cmd Enter submits assistant messages, while plain Enter preserves composer newlines",async()=>{
  const fixture=setup([]);
  await act(async()=>{root!.render(createElement(fixture.Harness));});
  const editor=container!.querySelector<HTMLElement>('[aria-label="向 AI 助手发送消息"]')!;
  await act(async()=>{editor.textContent="梳理角色关系";editor.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>{editor.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));});
  expect(mocks.api.mock.calls.filter(call=>String(call[0]).includes("/assistant/chat"))).toHaveLength(0);
  await act(async()=>{editor.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true}));await Promise.resolve();});
  expect(mocks.api.mock.calls.filter(call=>String(call[0]).includes("/assistant/chat"))).toHaveLength(1);
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