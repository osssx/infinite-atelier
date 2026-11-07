import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolveComfyMediaDimensions} from "./comfy-media-dimensions";
import type {ComfyApiGraph,ComfyWorkflowTemplate,ComfyTemplatePort} from "./template-schema";
const binding={templateId:"t",templateRevision:"r",overrides:{},slots:{}};
const port=(id:string,nodeId:string,inputName:string,kind:"INT"|"FLOAT"|"STRING"):ComfyTemplatePort=>({id,label:id,direction:"target",valueKind:kind,inputBinding:{mode:"literal",targets:[{nodeId,inputName}]}});
function template(graph:ComfyApiGraph,root:string,ports:ComfyTemplatePort[]=[]):ComfyWorkflowTemplate{return {id:"t",revision:"r",name:"T",apiGraph:graph,
 requirements:{classTypes:[]},ports:[...ports,{id:"out",label:"Out",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:root,outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}],
 mediaUseCase:{channel:"image",primaryOutputKind:"image",promptPortId:"prompt",primaryOutputPortId:"out",slots:[]}};}
describe("workflow pixel dimensions",()=>{
 it("resolves literal width and height, defaults and overrides",()=>{
  const t=template({n:{class_type:"Generate",inputs:{width:1024,height:768}}},"n",[port("w","n","width","INT"),port("h","n","height","INT")]);
  expect(resolveComfyMediaDimensions(t,binding)).toEqual({width:1024,height:768});
  t.ports[0].defaultValue=1536;
  expect(resolveComfyMediaDimensions(t,binding)).toEqual({width:1536,height:768});
  expect(resolveComfyMediaDimensions(t,{...binding,overrides:{w:864,h:1536}})).toEqual({width:864,height:1536});
  for(const w of [0,-1,NaN,Infinity,3.5,100000])expect(resolveComfyMediaDimensions(t,{...binding,overrides:{w}})).toBeUndefined();
 });
 it("matches the real Moss workflow selector and applies exposed MP and ratio overrides",()=>{
  const graph=JSON.parse(readFileSync(new URL("../../../../workflows/image_moss_image_t2i.json",import.meta.url),"utf8"));
  const t=template(graph,"9",[port("ratio","19","aspect_ratio","STRING"),port("mp","19","megapixels","FLOAT")]);
  expect(resolveComfyMediaDimensions(t,binding)).toEqual({width:1248,height:1248});
  expect(resolveComfyMediaDimensions(t,{...binding,overrides:{ratio:"16:9 (Widescreen)",mp:1}})).toEqual({width:1360,height:768});
  expect(resolveComfyMediaDimensions(t,{...binding,overrides:{ratio:"auto"}})).toBeUndefined();
 });
 it("ignores disconnected Krea ResolutionSelector nodes",()=>{
  const graph=JSON.parse(readFileSync(new URL("../../../../workflows/image_krea2_turbo_t2i_int8.json",import.meta.url),"utf8"));
  const save=Object.entries(graph).find(([,node])=>(node as {class_type:string}).class_type==="SaveImage")![0];
  const t=template(graph,save,[port("w","30:5","width","INT"),port("h","30:5","height","INT")]);
  expect(resolveComfyMediaDimensions(t,{...binding,overrides:{w:1152,h:1536}})).toEqual({width:1152,height:1536});
 });
 it("preserves actual multiple-of-eight dimensions without substituting a BBox preset",()=>{
  const t=template({s:{class_type:"ResolutionSelector",inputs:{aspect_ratio:"16:9",megapixels:1,multiple:8}},
   n:{class_type:"Generate",inputs:{width:["s",0],height:["s",1]}}},"n");
  expect(resolveComfyMediaDimensions(t,binding)).toEqual({width:1368,height:768});
 });
 it("does not guess unknown transforms, conflicting branches, cycles or dynamic reference sizes",()=>{
  expect(resolveComfyMediaDimensions(template({n:{class_type:"ImageScaleBy",inputs:{image:["latent",0],scale_by:2}},latent:{class_type:"Latent",inputs:{width:1024,height:1024}}},"n"),binding)).toBeUndefined();
  expect(resolveComfyMediaDimensions(template({n:{class_type:"Generate",inputs:{width:["ref",0],height:["ref",1]}},ref:{class_type:"ImageSize",inputs:{}}},"n"),binding)).toBeUndefined();
  expect(resolveComfyMediaDimensions(template({n:{class_type:"Pass",inputs:{image:["n",0]}}},"n"),binding)).toBeUndefined();
  const t=template({n:{class_type:"Combine",inputs:{a:["a",0],b:["b",0]}},a:{class_type:"Generate",inputs:{width:1024,height:1024}},b:{class_type:"Generate",inputs:{width:768,height:1344}}},"n");
  expect(resolveComfyMediaDimensions(t,binding)).toBeUndefined();
 });
});
