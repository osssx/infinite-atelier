import {describe,expect,it} from "vitest";
import type {CanvasNodeMetadata} from "@/types/canvas";
import {createComfyMediaOverridePatch,createComfyMediaResetPatch} from "./comfy-media-overrides";
import {getComfyInstanceScalarFields} from "./instance-parameters";
import {COMFY_MEDIA_PARAMETER_POPUP_CLASS,isComfyMediaParameterPopupTarget} from "./comfy-media-overrides";
import type {ComfyWorkflowTemplate} from "./template-schema";

const template:ComfyWorkflowTemplate={
 id:"direct-test",name:"Direct parameters",revision:"r1",apiGraph:{
  a:{class_type:"Node",inputs:{prompt:"hello",quality:"best",count:2,flag:false,empty:"",mixedA:1,mixedB:2}},
  b:{class_type:"Node",inputs:{mixed:1}},c:{class_type:"Node",inputs:{mixed:2}},
 },ports:[
  {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"a",inputName:"prompt"}]}},
  {id:"first",label:"First",direction:"target",valueKind:"INT",defaultValue:0,inputBinding:{mode:"literal",targets:[{nodeId:"a",inputName:"count"}]}},
  {id:"enum",label:"Enum",direction:"target",valueKind:"STRING",choices:[{label:"Number one",value:1},{label:"String one",value:"1"}],inputBinding:{mode:"literal",targets:[{nodeId:"a",inputName:"quality"}]}},
  {id:"bool",label:"Enabled",direction:"target",valueKind:"BOOLEAN",defaultValue:false,inputBinding:{mode:"literal",targets:[{nodeId:"a",inputName:"flag"}]}},
  {id:"text",label:"Text",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"a",inputName:"empty"}]}},
  {id:"mixed",label:"Mixed",direction:"target",valueKind:"INT",inputBinding:{mode:"literal",targets:[{nodeId:"b",inputName:"mixed"},{nodeId:"c",inputName:"mixed"}]}},
  {id:"unbound",label:"Unbound",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[]}},
  {id:"socket",label:"Socket",direction:"target",valueKind:"STRING",inputBinding:{mode:"socket",replaceInternalLink:false,targets:[{nodeId:"a",inputName:"empty"}]}},
 ],requirements:{classTypes:["Node"]},
};
const binding:NonNullable<CanvasNodeMetadata["comfyMediaPreset"]>={templateId:"t",templateRevision:"r1",overrides:{},slots:{}};
const valueOf=(field:ReturnType<typeof getComfyInstanceScalarFields>[number])=>field.localValue.source==="disconnect"?undefined:field.localValue.value;

describe("Comfy media direct parameters",()=>{
 it("reads only bound literal scalar ports in template order and resolves defaults, zero, false, and mixed targets",()=>{
  const node={id:"n",type:"comfy:workflow",metadata:{}} as never;
  const fields=getComfyInstanceScalarFields(template,node,[]);
  expect(fields.map(field=>field.port.id)).toEqual(["prompt","first","enum","bool","text","mixed"]);
  expect(valueOf(fields.find(field=>field.port.id==="first")!)).toBe(0);
  expect(valueOf(fields.find(field=>field.port.id==="bool")!)).toBe(false);
  expect(valueOf(fields.find(field=>field.port.id==="text")!)).toBe("");
  expect(fields.find(field=>field.port.id==="mixed")?.mixedTemplateValues).toBe(true);
  expect(valueOf(fields.find(field=>field.port.id==="mixed")!)).toBeUndefined();
 });
 it("writes direct values to workflow overrides without converting enum value types",()=>{
  expect(createComfyMediaOverridePatch(binding,"enum",1).comfyMediaPreset?.overrides).toEqual({enum:1});
  expect(createComfyMediaOverridePatch(binding,"enum","1").comfyMediaPreset?.overrides).toEqual({enum:"1"});
  expect(createComfyMediaOverridePatch(binding,"bool",false).comfyMediaPreset?.overrides).toEqual({bool:false});
  expect(createComfyMediaOverridePatch(binding,"text","").comfyMediaPreset?.overrides).toEqual({text:""});
 });
 it("resets one override or all overrides without changing the binding",()=>{
  const customized={...binding,overrides:{first:7,bool:true}};
  expect(createComfyMediaResetPatch(customized,"first").comfyMediaPreset).toEqual({...customized,overrides:{bool:true}});
  expect(createComfyMediaResetPatch(customized).comfyMediaPreset).toEqual({...customized,overrides:{}});
 });
 it("recognizes only the owned body popup as part of the parameter panel",()=>{
  const popup={};
  const menuTarget={closest:(selector:string)=>selector===`.${COMFY_MEDIA_PARAMETER_POPUP_CLASS}`?popup:null} as unknown as EventTarget;
  const otherTarget={closest:()=>null} as unknown as EventTarget;
  expect(isComfyMediaParameterPopupTarget(menuTarget)).toBe(true);
  expect(isComfyMediaParameterPopupTarget(otherTarget)).toBe(false);
  expect(isComfyMediaParameterPopupTarget(null)).toBe(false);
 });
});
