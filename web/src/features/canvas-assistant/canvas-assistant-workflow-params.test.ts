// @vitest-environment happy-dom
import {describe,expect,it} from "vitest";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";
import {defaultConfig,type AiConfig} from "@/stores/use-config-store";
import type {ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";
import {assistantWorkflowBinding,assistantWorkflowTemplateContext,setAssistantWorkflowParameter,
 validAssistantWorkflowScalar} from "./canvas-assistant-workflow-params";
import {applyAssistantCanvasActions,parseAssistantCanvasActions,isDangerousAssistantAction} from "./canvas-assistant-actions";
import {setAssistantNodeParameter} from "./canvas-assistant-node-control";

const template:ComfyWorkflowTemplate={
 id:"image-preset",revision:"r2",name:"图片工作流",
 apiGraph:{"1":{class_type:"Generator",inputs:{steps:20,seed:1,aspect_ratio:"4:3",batch_size:1,negative:"",token:"should-not-leak"}}},
 requirements:{classTypes:["Generator"]},
 ports:[
  {id:"prompt",label:"正面提示词",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"positive"}]}},
  {id:"steps",label:"采样步数",direction:"target",valueKind:"INT",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"steps"}]}},
  {id:"seed",label:"随机种子",direction:"target",valueKind:"INT",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"seed"}]}},
  {id:"aspect_ratio",label:"画面比例",direction:"target",valueKind:"STRING",choices:[{label:"横向",value:"16:9"},{label:"竖向",value:"9:16"},{label:"标准",value:"4:3"}],
   inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"aspect_ratio"}]}},
  {id:"batch_size",label:"批量数量",direction:"target",valueKind:"INT",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"batch_size"}]}},
  {id:"negative",label:"负面提示词",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"negative"}]}},
  {id:"token",label:"API Token",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"token"}]}},
  {id:"reference",label:"参考图片",direction:"target",valueKind:"IMAGE",inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId:"1",inputName:"reference"}]}}
 ],
 mediaUseCase:{channel:"image",primaryOutputKind:"image",promptPortId:"prompt",
  primaryOutputPortId:"result",slots:[{id:"reference",label:"参考图",valueKind:"IMAGE"}]}
};
const config:AiConfig={...defaultConfig,comfyWorkflowDefaults:{image:{templateId:"image-preset",templateRevision:"r2"}}};
const media=(extra:CanvasNodeData["metadata"]={}):CanvasNodeData=>({
 id:"image-source",type:CanvasNodeType.Image,title:"图片生成",position:{x:100,y:50},width:480,height:300,
 metadata:{content:"/api/v1/blobs/old-asset",storageKey:"cas:old-asset",prompt:"a dragon",...extra}
});
const selected=()=>media({comfyMediaPreset:{templateId:"image-preset",templateRevision:"r2",overrides:{steps:16},slots:{}}});
const apply=(node:CanvasNodeData,actions:unknown,stage:"safe"|"dangerous",schema?:ComfyWorkflowTemplate)=>
 applyAssistantCanvasActions({nodes:[node],connections:[]},actions,stage,{x:0,y:0},new Map(),
  config,schema?new Map([[node.id,schema]]):undefined);
describe("AI workflow preset scalar overrides",()=>{
 it("uses real literal input ports for generation, preserving source media and existing overrides",()=>{
  const source=selected(),before=JSON.stringify(source);
  const updated=setAssistantWorkflowParameter(source,"steps",36,config,template);
  expect(updated.metadata?.comfyMediaPreset?.overrides).toEqual({steps:36});
  expect(updated.metadata?.content).toBe(source.metadata?.content);
  expect(updated.metadata?.storageKey).toBe(source.metadata?.storageKey);
  expect(JSON.stringify(source)).toBe(before);
  const another=setAssistantWorkflowParameter(updated,"aspect_ratio","9:16",config,template);
  expect(another.metadata?.comfyMediaPreset?.overrides).toEqual({steps:36,aspect_ratio:"9:16"});
  expect(another.width).toBe(source.width); // Existing image is never resized by an AI parameter change.
  expect(another.metadata?.comfyMediaPreviewRatio).toBe("562500:1000000"); });
 it("pins the global default as a node-specific binding rather than mutating global settings",()=>{
  const source=media();
  expect(assistantWorkflowBinding(source,config)?.binding.templateId).toBe(template.id);
  const changed=setAssistantWorkflowParameter(source,"seed",123456,config,template);
  expect(changed.metadata?.comfyMediaPreset?.overrides).toEqual({seed:123456});
  expect(source.metadata?.comfyMediaPreset).toBeUndefined();
  expect(config.comfyWorkflowDefaults?.image?.templateId).toBe(template.id);
 });
 it("rejects ordinary channel settings on a preset without promising false success",()=>{
  for(const [key,value] of [["count",2],["size","1024x1024"],["quality","high"]] as const)
   expect(()=>setAssistantNodeParameter(selected(),key,value,config)).toThrow(/set_workflow_param/);  expect(()=>setAssistantNodeParameter(media(),"count",2,config)).toThrow(/set_workflow_param/);
 });
 it("verifies pinned revision, scalar types, choices and excludes prompt/media ports",()=>{
  const source=selected();
  expect(()=>setAssistantWorkflowParameter(source,"missing",4,config,template)).toThrow(/不存在/);
  expect(()=>setAssistantWorkflowParameter(source,"steps",1.2,config,template)).toThrow(/类型/);
  expect(()=>setAssistantWorkflowParameter(source,"steps","35",config,template)).toThrow(/类型/);
  expect(()=>setAssistantWorkflowParameter(source,"aspect_ratio","5:4",config,template)).toThrow(/候选/);
  expect(()=>setAssistantWorkflowParameter(source,"prompt","override prompt",config,template)).toThrow(/专门操作/);
  expect(()=>setAssistantWorkflowParameter(source,"reference","file",config,template)).toThrow(/专门操作/);
  expect(()=>setAssistantWorkflowParameter(source,"steps",36,config,{...template,revision:"wrong"})).toThrow(/版本/);
  expect(()=>setAssistantWorkflowParameter(source,"steps",36,config,{...template,mediaUseCase:{...template.mediaUseCase!,channel:"video"}})).toThrow(/版本/);
  expect(validAssistantWorkflowScalar("__proto__",1)).toBe(true); // syntactically valid, but not a template port.
  expect(()=>setAssistantWorkflowParameter(source,"__proto__",1,config,template)).toThrow(/不存在/);
 });
 it("routes AI edit to the workflow binding only after explicit confirmation and validates whole batch atomically",()=>{
  const source=selected(),actions=parseAssistantCanvasActions([
   {type:"set_workflow_param",nodeId:source.id,portId:"steps",value:38},
   {type:"set_workflow_param",nodeId:source.id,portId:"batch_size",value:2}
  ]);
  expect(actions.every(isDangerousAssistantAction)).toBe(true);
  const safe=apply(source,actions,"safe",template);
  expect(safe.applied).toBe(0);
  expect(safe.nodes[0].metadata?.comfyMediaPreset?.overrides).toEqual({steps:16});
  const approved=apply(source,actions,"dangerous",template);
  expect(approved.applied).toBe(2);
  expect(approved.nodes[0].metadata?.comfyMediaPreset?.overrides).toEqual({steps:38,batch_size:2});
  expect(()=>apply(source,[
   {type:"set_workflow_param",nodeId:source.id,portId:"steps",value:50},
   {type:"set_workflow_param",nodeId:source.id,portId:"not-a-port",value:1}
  ],"dangerous",template)).toThrow(/不存在/);
  expect(source.metadata?.comfyMediaPreset?.overrides).toEqual({steps:16});
  expect(()=>apply(source,actions,"dangerous")).toThrow(/未加载/);
 });
 it("provides the exact editable port identifiers while hiding secrets and media content",()=>{
  const context=assistantWorkflowTemplateContext(selected(),config,template);
  expect(context).toContain("set_workflow_param");
  expect(context).toContain("steps");
  expect(context).toContain("aspect_ratio");
  expect(context).toContain("候选值=");
  expect(context).not.toContain("/api/v1/blobs/old-asset");
  expect(context).not.toContain("API Token");
  expect(context).not.toContain("should-not-leak");
 });
});
