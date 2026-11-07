import {describe,it,expect,vi} from "vitest";
import {parseComfyAspect,resolveComfyMediaAspect,withComfyMediaAspect} from "./comfy-media-aspect";
import {createComfyMediaOverridePatch,createComfyMediaResetPatch} from "./comfy-media-overrides";
import {applyNodeConfigPatch} from "@/lib/canvas/canvas-node-factory";
import {nodeSizeFromRatio} from "@/lib/canvas/canvas-node-size";
import {NODE_DEFAULT_SIZE} from "@/constant/canvas";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";
import {validateComfyTemplatePayload,type ComfyWorkflowTemplate,type ComfyTemplatePort} from "./template-schema";

vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));

const port=(id:string,inputName:string,kind:"STRING"|"INT"="STRING",nodeId="n"):ComfyTemplatePort=>({id,label:id,direction:"target",valueKind:kind,inputBinding:{mode:"literal",targets:[{nodeId,inputName}]}});
function template():ComfyWorkflowTemplate{return {id:"t",revision:"r",name:"T",
 apiGraph:{n:{class_type:"Resolution",inputs:{aspect_ratio:"1:1 (Square)",width:1024,height:768,prompt:"p"}}},
 requirements:{classTypes:["Resolution"]},ports:[port("prompt","prompt"),port("aspect","aspect_ratio"),port("w","width","INT"),port("h","height","INT"),
 {id:"out",label:"Out",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:"n",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}],
 mediaUseCase:{channel:"image",primaryOutputKind:"image",promptPortId:"prompt",primaryOutputPortId:"out",slots:[]}};}
const binding={templateId:"t",templateRevision:"r",overrides:{},slots:{}};
function node(type=CanvasNodeType.Image):CanvasNodeData{return {id:"node",type,title:"Node",width:400,height:300,position:{x:100,y:200},metadata:{}};}
const numericRatio=(ratio:string|undefined)=>{const [w,h]=(ratio??"0:1").split(":").map(Number);return w/h;};
describe("workflow aspect preview",()=>{
 it.each(["16:9","16:9 (Widescreen)","1024x576","16 × 9"])("parses %s",value=>expect(numericRatio(parseComfyAspect(value))).toBeCloseTo(16/9,5));
 it.each(["auto","0:1","-1:2","1:0","1:9","NaN:1","16:9 junk",null,Infinity])("ignores invalid or unsupported %s",value=>expect(parseComfyAspect(value)).toBeUndefined());
 it("uses override, default, graph precedence and restores defaults",()=>{
  const t=template();t.ports[1].defaultValue="4:3";
  expect(numericRatio(resolveComfyMediaAspect(t,binding).ratio)).toBeCloseTo(4/3,5);
  const patch=createComfyMediaOverridePatch(binding,"aspect","9:16");
  expect(numericRatio(resolveComfyMediaAspect(t,patch.comfyMediaPreset!).ratio)).toBeCloseTo(9/16,5);
  for(const id of ["aspect",undefined])expect(numericRatio(resolveComfyMediaAspect(t,createComfyMediaResetPatch(patch.comfyMediaPreset!,id).comfyMediaPreset!).ratio)).toBeCloseTo(4/3,5);
  delete t.ports[1].defaultValue;expect(numericRatio(resolveComfyMediaAspect(t,binding).ratio)).toBe(1);
 });
 it("prefers internal aspect mappings, supports explicit dimensions and off",()=>{
  const t=template();t.ports.push({...port("ratio","prompt"),defaultValue:"16:9"});
  expect(numericRatio(resolveComfyMediaAspect(t,binding).ratio)).toBe(1);
  t.mediaUseCase!.aspectSync={mode:"dimensions",widthPortId:"w",heightPortId:"h"};
  expect(numericRatio(resolveComfyMediaAspect(t,binding).ratio)).toBeCloseTo(4/3,5);
  t.mediaUseCase!.aspectSync={mode:"ratio",portId:"ratio"};expect(numericRatio(resolveComfyMediaAspect(t,binding).ratio)).toBeCloseTo(16/9,5);
  t.mediaUseCase!.aspectSync={mode:"off"};expect(resolveComfyMediaAspect(t,binding)).toEqual({});
 });
 it("detects paired internal dimensions, rejects ambiguity and missing/invalid dimensions",()=>{
  const t=template();t.ports=t.ports.filter(p=>p.id!=="aspect");
  expect(numericRatio(resolveComfyMediaAspect(t,binding).ratio)).toBeCloseTo(4/3,5);
  expect(resolveComfyMediaAspect(t,{...binding,overrides:{h:0}}).ratio).toBeUndefined();
  t.ports.push(port("other-width","width","INT"));expect(resolveComfyMediaAspect(t,binding).warning).toBeTruthy();
  t.ports=t.ports.filter(p=>!["h","other-width"].includes(p.id));expect(resolveComfyMediaAspect(t,binding).ratio).toBeUndefined();
 });
 it("supports Chinese names, and requires manual selection for ambiguous ratios",()=>{
  const t=template();t.ports[1]={...port("custom","prompt"),label:"画面比例",defaultValue:"9:16"};
  expect(numericRatio(resolveComfyMediaAspect(t,binding).ratio)).toBeCloseTo(9/16,5);
  t.ports.push({...port("ratio","prompt"),defaultValue:"1:1"});expect(resolveComfyMediaAspect(t,binding).warning).toBeTruthy();
 });
 it.each([CanvasNodeType.Image,CanvasNodeType.Video])("updates empty %s geometry and keeps its center and channel size",type=>{
  const src=node(type);src.metadata={size:"2:3"};
  const patch=withComfyMediaAspect(template(),createComfyMediaOverridePatch(binding,"aspect","9:16"));
  const next=applyNodeConfigPatch(src,patch);
  expect(next.width/next.height).toBeCloseTo(9/16,5);
  expect(next.position.x+next.width/2).toBe(src.position.x+src.width/2);
  expect(next.position.y+next.height/2).toBe(src.position.y+src.height/2);
  expect(next.metadata.size).toBe("2:3");
  const spec=NODE_DEFAULT_SIZE[type];expect({width:next.width,height:next.height}).toEqual(nodeSizeFromRatio(patch.comfyMediaPreviewRatio!,spec.width,spec.height));
 });
 it("preserves existing media, free resize, audio and unresolved aspect geometry",()=>{
  const patch=withComfyMediaAspect(template(),{comfyMediaPreset:binding});
  for(const metadata of [{content:"image"},{storageKey:"cas:blob"},{images:[{id:"one"}]},{freeResize:true}]){
   const src={...node(),metadata} as CanvasNodeData;
   expect(applyNodeConfigPatch(src,patch)).toMatchObject({width:400,height:300,position:src.position});
  }
  expect(applyNodeConfigPatch(node(CanvasNodeType.Audio),patch).width).toBe(400);
  expect(applyNodeConfigPatch(node(),{comfyMediaPreset:binding}).width).toBe(400);
 });
 it("keeps channel model sizing unchanged and recalculates a selected revision's defaults",()=>{
  const src=node();expect(applyNodeConfigPatch(src,{size:"16:9"}).width/applyNodeConfigPatch(src,{size:"16:9"}).height).toBeCloseTo(16/9);
  const t=template();t.revision="next";t.apiGraph.n.inputs.aspect_ratio="9:16";
  const patch=withComfyMediaAspect(t,{comfyMediaPreset:{...binding,templateRevision:"next"}});
  expect(applyNodeConfigPatch(src,patch).width/applyNodeConfigPatch(src,patch).height).toBeCloseTo(9/16);
  t.mediaUseCase!.primaryOutputKind="audio";expect(resolveComfyMediaAspect(t,binding)).toEqual({});
 });
 it("validates explicit bindings and preserves legacy media configuration",()=>{
  const t=template();expect(validateComfyTemplatePayload(t).mediaUseCase?.aspectSync).toBeUndefined();
  for(const aspectSync of [{mode:"ratio",portId:"aspect"},{mode:"dimensions",widthPortId:"w",heightPortId:"h"},{mode:"auto"},{mode:"off"}])
   expect(()=>validateComfyTemplatePayload({...t,mediaUseCase:{...t.mediaUseCase,aspectSync}})).not.toThrow();
  for(const aspectSync of [{mode:"ratio",portId:"w"},{mode:"dimensions",widthPortId:"w",heightPortId:"w"},{mode:"invalid"}])
   expect(()=>validateComfyTemplatePayload({...t,mediaUseCase:{...t.mediaUseCase,aspectSync}})).toThrow(/aspect/);
 });
});
