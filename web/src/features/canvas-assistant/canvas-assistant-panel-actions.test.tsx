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
const skillMocks=vi.hoisted(()=>({
 snapshot:vi.fn(async():Promise<{revision:number;skills:unknown[]}>=>({revision:4,skills:[]}))
}));
vi.mock("@/features/skills/skill-registry",()=>({
 getSkillRegistrySnapshot:skillMocks.snapshot,SKILL_REGISTRY_CHANNEL:"test:assistant-skills"
}));
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
   getWorkflowTemplates:async()=>({context:"",templates:new Map()}),   onApplyActions:apply,onRunActions:mocks.run,config:defaultConfig  });
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
 mocks.run.mockResolvedValue({submitted:1,jobIds:["job-demo"]});
 mocks.confirm.mockImplementation(()=>({destroy:vi.fn()}));
 skillMocks.snapshot.mockResolvedValue({revision:4,skills:[]});
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