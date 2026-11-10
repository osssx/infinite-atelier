// @vitest-environment happy-dom
import {describe,it,expect} from "vitest";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";
import {defaultConfig,type AiConfig} from "@/stores/use-config-store";
import {COMFY_WORKFLOW_MOCK_TYPE} from "@/lib/canvas/canvas-ports";
import {assistantValueHasSupportedShape,assistantNodeMode,setAssistantNodeParameter,
 setAssistantNodePrompt,planAssistantNodeRuns} from "./canvas-assistant-node-control";
import {applyAssistantCanvasActions,parseAssistantCanvasActions,isDangerousAssistantAction,
 dangerousAssistantActionSummary} from "./canvas-assistant-actions";

const make=(type:string,id="node-1",extra:CanvasNodeData["metadata"]={}):CanvasNodeData=>({
 id,type,title:"Node",position:{x:0,y:0},width:320,height:210,
 metadata:{status:"idle",...extra}
});
const config:AiConfig={...defaultConfig,channels:[{
 id:"ch-1",name:"Configured",baseUrl:"http://127.0.0.1:8383/v1",apiFormat:"openai",apiKey:"",
 models:[{name:"my-text",capability:"text"},{name:"my-image",capability:"image"},
  {name:"my-video",capability:"video"},{name:"my-audio",capability:"audio"}]
}]};
const apply=(nodes:CanvasNodeData[],actions:unknown,stage:"safe"|"dangerous",refs=new Map<string,string>())=>
 applyAssistantCanvasActions({nodes,connections:[]},actions,stage,{x:100,y:100},refs,config);

describe("P2.5 node parameters and execution plan",()=>{
 it("accepts strict bounded parameter types but no arbitrary metadata, URLs or scripts",()=>{
  for(const action of [
   {type:"set_prompt",nodeId:"n",prompt:"cinematic lighting"},
   {type:"set_node_param",nodeId:"n",key:"model",value:"ch-1::my-image"},
   {type:"set_node_param",nodeId:"n",key:"count",value:2},
   {type:"set_node_param",nodeId:"n",key:"generateAudio",value:true},
   {type:"run_node",nodeId:"n",mode:"image"},
   {type:"run_workflow",nodeId:"workflow-1"}
  ])expect(parseAssistantCanvasActions([action])).toEqual([action]);
  for(const action of [
   {type:"set_prompt",nodeId:"n",prompt:"x".repeat(12001)},
   {type:"set_prompt",nodeId:"n",prompt:"a",url:"https://example.com"},
   {type:"set_node_param",nodeId:"n",key:"storageKey",value:"C:/files/private"},
   {type:"set_node_param",nodeId:"n",key:"model",value:""},
   {type:"set_node_param",nodeId:"n",key:"count",value:11},
   {type:"set_node_param",nodeId:"n",key:"count",value:1.5},
   {type:"set_node_param",nodeId:"n",key:"audioSpeed",value:"1.5"},
   {type:"set_node_param",nodeId:"n",key:"seconds",value:NaN},
   {type:"set_node_param",nodeId:"n",key:"videoRatio",value:"3:2"},
   {type:"run_node",nodeId:"n",mode:"workflow"},
   {type:"run_workflow",nodeId:"n",script:"unsafe"}
  ])expect(()=>parseAssistantCanvasActions([action])).toThrow();
  expect(()=>parseAssistantCanvasActions(Array.from({length:4},(_,i)=>({
   type:"run_node",nodeId:"n"+i
  })))).toThrow(/最多触发 3/);
  expect(assistantValueHasSupportedShape("model","ch-1::my-image")).toBe(true);
 });
 it("stages prompt and model edits until confirmation, preserving media content",()=>{
  const media=make(CanvasNodeType.Image,"img",{content:"existing-image-url",prompt:"old"});
  const actions=[{type:"set_prompt",nodeId:"img",prompt:"new idea"},
   {type:"set_node_param",nodeId:"img",key:"model",value:"ch-1::my-image"},
   {type:"set_node_param",nodeId:"img",key:"count",value:2},
   {type:"run_node",nodeId:"img",mode:"image"}];
  expect(isDangerousAssistantAction(parseAssistantCanvasActions(actions)[0])).toBe(true);
  expect(dangerousAssistantActionSummary(parseAssistantCanvasActions(actions))).toContain("生成参数");
  const safe=apply([media],actions,"safe");
  expect(safe.applied).toBe(0);
  expect(safe.nodes[0].metadata?.prompt).toBe("old");
  const changed=apply(safe.nodes,actions,"dangerous");
  expect(changed.applied).toBe(3);
  expect(changed.nodes[0].metadata?.prompt).toBe("new idea");
  expect(changed.nodes[0].metadata?.model).toBe("ch-1::my-image");
  expect(changed.nodes[0].metadata?.count).toBe(2);
  expect(changed.nodes[0].metadata?.content).toBe("existing-image-url");
  expect(()=>planAssistantNodeRuns(changed.nodes,[{type:"run_node",nodeId:"img"}])).toThrow(/已有媒体产物/);
 });
 it("validates channel model capability and blocks automatic Comfy preset unbinding",()=>{
  const node=make(CanvasNodeType.Image);
  expect(setAssistantNodeParameter(node,"model","ch-1::my-image",config).metadata?.model).toBe("ch-1::my-image");
  expect(()=>setAssistantNodeParameter(node,"model","ch-1::my-text",config)).toThrow(/不支持/);
  expect(()=>setAssistantNodeParameter(node,"model","invented",config)).toThrow();
  expect(()=>setAssistantNodeParameter(node,"model","ch-1::my-image")).toThrow(/模型配置/);
  const preset={templateId:"tpl",templateRevision:"r1",overrides:{},slots:{}};
  expect(()=>setAssistantNodeParameter(make(CanvasNodeType.Image,"p",{comfyMediaPreset:preset}),
   "model","ch-1::my-image",config)).toThrow(/解除绑定/);
 });
 it("maps settings to the exact generation metadata fields and enforces node-mode checks",()=>{
  const video=make(CanvasNodeType.Video,"video",{prompt:"Scene"});
  const s=setAssistantNodeParameter(video,"seconds",8,config);
  expect(s.metadata?.seconds).toBe("8");
  expect(setAssistantNodeParameter(s,"generateAudio",false,config).metadata?.generateAudio).toBe("false");
  expect(setAssistantNodeParameter(s,"videoRatio","9:16",config).metadata?.videoRatio).toBe("9:16");
  expect(()=>setAssistantNodeParameter(video,"count",2,config)).toThrow(/不适用/);
  const audio=make(CanvasNodeType.Audio,"audio");
  expect(setAssistantNodeParameter(audio,"audioSpeed",1.25,config).metadata?.audioSpeed).toBe("1.25");
  expect(setAssistantNodeParameter(audio,"audioFormat","wav",config).metadata?.audioFormat).toBe("wav");
  expect(()=>setAssistantNodeParameter(audio,"quality","high",config)).toThrow(/不适用/);
  const text=make(CanvasNodeType.Text,"txt",{content:"existing"});
  expect(setAssistantNodeParameter(text,"reasoningEffort","high",config).metadata?.reasoningEffort).toBe("high");
  expect(setAssistantNodePrompt(text,"new prompt").metadata?.composerContent).toBe("new prompt");
  const composer=make(CanvasNodeType.Config,"cfg",{generationMode:"video",composerContent:"old"});
  expect(assistantNodeMode(composer)).toBe("video");
  expect(setAssistantNodeParameter(composer,"generationMode","audio",config).metadata?.generationMode).toBe("audio");
  expect(()=>setAssistantNodeParameter(text,"generationMode","audio",config)).toThrow(/配置节点/);
  expect(()=>setAssistantNodePrompt(make(CanvasNodeType.Group),"unsafe")).toThrow(/不允许/);
 });
 it("resolves temporary refs, limits task count, and refuses invalid targets before submitting",()=>{
  const actions=[
   {type:"create_node",ref:"a",nodeType:"image",title:"Frame",prompt:"sunrise"},
   {type:"create_node",ref:"b",nodeType:"text",title:"Script"},
   {type:"set_prompt",nodeId:"b",prompt:"explain sunrise"}
  ];
  const created=apply([],actions,"safe");
  const changed=apply(created.nodes,actions,"dangerous",created.refs);
  const runs=planAssistantNodeRuns(changed.nodes,[
   {type:"run_node",nodeId:"a",mode:"image"},
   {type:"run_node",nodeId:"b",mode:"text"}
  ],created.refs);
  expect(runs).toHaveLength(2);
  expect(runs[0].prompt).toBe("sunrise");
  expect(runs[1].prompt).toBe("explain sunrise");
  expect(()=>planAssistantNodeRuns(changed.nodes,[
   {type:"run_node",nodeId:"a"},{type:"run_node",nodeId:"a"}
  ],created.refs)).toThrow(/重复执行/);
  expect(()=>planAssistantNodeRuns(changed.nodes,[{type:"run_node",nodeId:"b",mode:"image"}],created.refs)).toThrow(/模式/);
  expect(()=>planAssistantNodeRuns(changed.nodes,[{type:"run_node",nodeId:"missing"}],created.refs)).toThrow(/不存在/);
  expect(()=>planAssistantNodeRuns([make(CanvasNodeType.Image,"empty")],[{type:"run_node",nodeId:"empty"}])).toThrow(/提示词为空/);
 });
 it("requires bound workflow and uses a distinct workflow execution action",()=>{
  const workflow=make(COMFY_WORKFLOW_MOCK_TYPE,"wf",{
   comfyWorkflow:{templateId:"t",templateRevision:"r",bindingState:"bound",inputOverrides:{}}
  });
  expect(planAssistantNodeRuns([workflow],[{type:"run_workflow",nodeId:"wf"}])).toEqual([{kind:"workflow",nodeId:"wf"}]);
  expect(()=>planAssistantNodeRuns([workflow],[{type:"run_node",nodeId:"wf"}])).toThrow(/run_workflow/);
  expect(()=>planAssistantNodeRuns([make(COMFY_WORKFLOW_MOCK_TYPE,"wf")],[{type:"run_workflow",nodeId:"wf"}])).toThrow(/尚未绑定/);
  expect(()=>planAssistantNodeRuns([make(CanvasNodeType.Text,"txt",{prompt:"hi"})],[{type:"run_workflow",nodeId:"txt"}])).toThrow(/不是 ComfyUI/);
 });
});
