import {beforeEach,describe,expect,it,vi} from "vitest";
import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import type {ComfyWorkflowTemplate} from "./template-schema";

vi.mock("./template-schema",async importOriginal=>({
 ...await importOriginal<typeof import("./template-schema")>(),
 createComfyTemplate:vi.fn(async(id:string,payload:any)=>({id,revision:"a".repeat(64),...payload})),
}));
vi.mock("./preset-registry",()=>({listComfyPresets:vi.fn(async()=>[]),saveComfyPresetBinding:vi.fn(async()=>{})}));

import {createComfyTemplate} from "./template-schema";
import {listComfyPresets,saveComfyPresetBinding} from "./preset-registry";
import {snapshotComfyInstanceAsPreset,saveComfyInstanceAsNewPreset} from "./save-instance-as-preset";

const template:ComfyWorkflowTemplate={
 id:"original",revision:"b".repeat(64),name:"Sample workflow",
 apiGraph:{
  "1":{class_type:"Model",inputs:{prompt:"base",steps:8,scale:0.5,enabled:true,choice:"fast"}},
  "2":{class_type:"SaveImage",inputs:{image:["1",0]}},
  "3":{class_type:"ModelPreviewOverrideKJ",inputs:{model:["1",0],max_resolution:512,jpeg_quality:80,suppress_default_preview:true,preview_frames:1,preview_fps:8}}
 },
 ports:[
  {id:"prompt",label:"提示词",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"prompt"}]}},
  {id:"steps",label:"步数",direction:"target",valueKind:"INT",defaultValue:8,
   inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"steps"}]}},
  {id:"scale",label:"比例",direction:"target",valueKind:"FLOAT",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"scale"}]}},
  {id:"enabled",label:"启用",direction:"target",valueKind:"BOOLEAN",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"enabled"}]}},
  {id:"choice",label:"模式",direction:"target",valueKind:"STRING",choices:[{label:"快速",value:"fast"},{label:"质量",value:"quality"}],
   inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"choice"}]}},
  {id:"output",label:"图片",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:"1",outputIndex:0},
   capture:{kind:"image",adapterId:"SaveImage"}}
 ],
 requirements:{classTypes:["Model","ModelPreviewOverrideKJ","SaveImage"]},
 previewBinding:{protocol:"kj-preview",nodeId:"3"}
};
const node:CanvasNodeData={
 id:"wf",title:"Workflow",type:"comfy:workflow",width:420,height:300,position:{x:0,y:0},
 metadata:{comfyWorkflow:{
  templateId:template.id,templateRevision:template.revision,bindingState:"bound",
  inputOverrides:{prompt:"changed",steps:0,scale:1.25,enabled:false,choice:"quality"}
 }}
};
const edge:CanvasConnection={id:"edge-1",fromNodeId:"text",fromPortId:"text",toNodeId:"wf",toPortId:"prompt"};

describe("save current workflow as independent preset",()=>{
 beforeEach(()=>vi.clearAllMocks());
 it("snapshots 0/false and select values as defaults without rewriting the source template",()=>{
  const payload=snapshotComfyInstanceAsPreset(template,node,[edge],"  新预设  ");
  expect(payload.name).toBe("新预设");
  expect(payload.apiGraph["1"].inputs).toEqual({
   prompt:"base",steps:8,scale:0.5,enabled:true,choice:"fast"
  });
  expect(payload.ports.find(p=>p.id==="steps")?.defaultValue).toBe(0);
  expect(payload.ports.find(p=>p.id==="enabled")?.defaultValue).toBe(false);
  expect(payload.ports.find(p=>p.id==="choice")?.defaultValue).toBe("quality");
  expect(payload.apiGraph["2"].inputs.image).toEqual(["1",0]);
  expect(payload.previewBinding).toEqual(template.previewBinding);
  expect(template.apiGraph["1"].inputs.steps).toBe(8);
  expect(template.ports.find(p=>p.id==="steps")?.defaultValue).toBe(8);
  expect(node.metadata?.comfyWorkflow?.inputOverrides.steps).toBe(0);
 });
 it("creates a new template id and alias instead of altering the bound one",async()=>{
  const saved=await saveComfyInstanceAsNewPreset(template,node,[edge],"用户预设");
  expect(saved.id).toMatch(/^comfy-custom-[0-9a-f-]{36}$/);
  expect(saved.templateId).toBe(saved.id);
  expect(saved.name).toBe("用户预设");
  expect(vi.mocked(createComfyTemplate)).toHaveBeenCalledOnce();
  expect(vi.mocked(createComfyTemplate).mock.calls[0][0]).toBe(saved.id);
  expect(vi.mocked(saveComfyPresetBinding)).toHaveBeenCalledWith(saved,expect.objectContaining({id:saved.id}));
  expect(node.metadata?.comfyWorkflow?.templateId).toBe("original");
 });
 it("rejects empty names and stale workflow bindings without writing",async()=>{
  expect(()=>snapshotComfyInstanceAsPreset(template,node,[],"   ")).toThrow(/名称/);
  const stale={...node,metadata:{...node.metadata,comfyWorkflow:{
   ...node.metadata!.comfyWorkflow!,templateRevision:"stale"
  }}};
  await expect(saveComfyInstanceAsNewPreset(template,stale,[],"new")).rejects.toThrow(/有效的工作流/);
  expect(createComfyTemplate).not.toHaveBeenCalled();
 });
 it("shares the stable workflow identity and creates a variant for a known source preset",async()=>{
  vi.mocked(listComfyPresets).mockResolvedValueOnce([{id:"source-preset",name:"Source",workflowId:"logical",templateId:template.id,revision:template.revision,kind:"base",source:"user"}]);
  const saved=await saveComfyInstanceAsNewPreset(template,node,[],"variant");
  expect(saved).toMatchObject({workflowId:"logical",kind:"variant",parentId:"source-preset"});
  expect(saveComfyPresetBinding).toHaveBeenCalledOnce();
 });
});
