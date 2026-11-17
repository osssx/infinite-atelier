// @vitest-environment happy-dom
import {describe,it,expect} from "vitest";
import {assignComfyMediaSlots,resolveComfyMediaMode} from "./comfy-media-slot-assignment";
import type {ComfyWorkflowTemplate} from "./template-schema";
import type {CanvasNodeData,CanvasConnection} from "@/types/canvas";
const node=(id:string,type="image"):CanvasNodeData=>({id,type,title:id,position:{x:0,y:0},width:100,height:100,metadata:{content:"blob:"+id}});
const template={mediaUseCase:{slots:[{id:"first",label:"First",valueKind:"IMAGE",required:true},{id:"last",label:"Last",valueKind:"IMAGE",required:true}]}} as ComfyWorkflowTemplate;
const edge=(from:string,to="target",port?:string):CanvasConnection=>({id:from+to,fromNodeId:from,toNodeId:to,...(port?{toPortId:port,fromPortId:"image"}:{})});
const run=(nodes:CanvasNodeData[],edges:CanvasConnection[],t=template)=>assignComfyMediaSlots(t,"target",nodes,edges);
describe("automatic Comfy media slots",()=>{
 it("freezes the current image as a reference and chooses editing without a canvas self-edge",()=>{
  const t={...template,mediaUseCase:{...template.mediaUseCase!,channel:"image",mediaCapabilities:{schemaVersion:1,kind:"image",defaultMode:"text_to_image",modes:[
   {id:"text_to_image",enabled:true,inputs:[],parameters:[]},
   {id:"reference_edit",enabled:true,inputs:[{role:"reference_image",kind:"image",minItems:1,maxItems:1}],parameters:[]}
  ]},modeBindings:{text_to_image:{rolePorts:{}},reference_edit:{rolePorts:{reference_image:["first"]}}}}} as ComfyWorkflowTemplate;
  const nodes=[node("target")],edges:CanvasConnection[]=[];
  const mode=resolveComfyMediaMode(t,"target",nodes,edges);
  expect(mode).toBe("reference_edit");
  expect(assignComfyMediaSlots(t,"target",nodes,edges,mode)).toEqual({slots:{first:{nodeId:"target"}},errors:[]});
  expect(edges).toEqual([]);
  expect(nodes[0].metadata?.content).toBe("blob:target");
  expect(resolveComfyMediaMode(t,"target",[{...nodes[0],metadata:{}}],edges)).toBe("text_to_image");
 });
 it("switches a default text-to-video preset to first-frame when an image is connected",()=>{
  const t={...template,mediaUseCase:{...template.mediaUseCase!,mediaCapabilities:{schemaVersion:1,kind:"video",defaultMode:"text_to_video",modes:[
   {id:"text_to_video",enabled:true,inputs:[],parameters:[]},
   {id:"first_frame",enabled:true,inputs:[{role:"first_frame",kind:"image",minItems:1,maxItems:1}],parameters:[]}
  ]},modeBindings:{text_to_video:{rolePorts:{}},first_frame:{rolePorts:{first_frame:["first"]}}}}} as ComfyWorkflowTemplate;
  const nodes=[node("target"),node("a")];
  const mode=resolveComfyMediaMode(t,"target",nodes,[edge("a")]);
  expect(mode).toBe("first_frame");
  expect(assignComfyMediaSlots(t,"target",nodes,[edge("a")],mode)).toEqual({slots:{first:{nodeId:"a"}},errors:[]});
  expect(resolveComfyMediaMode(t,"target",nodes,[])).toBe("text_to_video");
  expect(resolveComfyMediaMode(t,"target",nodes,[edge("a")],"text_to_video")).toBe("text_to_video");
  expect(assignComfyMediaSlots(t,"target",nodes,[edge("a")],"text_to_video").errors).toHaveLength(1);
 });
 it("uses reference order, ignores text, and excludes self fallback",()=>{
  const nodes=[node("target"),node("b"),node("a"),node("text","text")];
  expect(run(nodes,[edge("a"),edge("text"),edge("b")])).toEqual({slots:{first:{nodeId:"a"},last:{nodeId:"b"}},errors:[]});
  expect(run(nodes,[]).slots).toEqual({});
 });
 it("reserves explicit ports before assigning remaining references",()=>{
  expect(run([node("target"),node("a"),node("b")],[edge("a","target","last"),edge("b")]).slots).toEqual({last:{nodeId:"a"},first:{nodeId:"b"}});
 });
 it("uses config node references",()=>{
  expect(run([node("target"),node("a"),node("b"),node("config","config")],[edge("target","config"),edge("b","config"),edge("a","config")]).slots).toEqual({first:{nodeId:"b"},last:{nodeId:"a"}});
 });
 it("reports missing, excess, and unavailable media",()=>{
  expect(run([node("target")],[]).errors).toHaveLength(2);
  expect(run([node("target"),node("a"),node("b"),node("c")],[edge("a"),edge("b"),edge("c")]).errors).toHaveLength(1);
  expect(run([node("target"),{...node("a"),metadata:{}}],[edge("a")]).errors).toHaveLength(3);
 });
 it("recomputes removed references and preserves the primary image id",()=>{
  const a:CanvasNodeData={...node("a"),metadata:{primaryImageId:"one",images:[{id:"one",content:"blob:one",status:"success",storageKey:"one",naturalWidth:1,naturalHeight:1,bytes:1,mimeType:"image/png"}]}};
  expect(run([node("target"),a,node("b")],[edge("a"),edge("b")]).slots.first).toEqual({nodeId:"a",imageId:"one"});
  expect(run([node("target"),a,node("b")],[edge("b")]).slots).toEqual({first:{nodeId:"b"}});
 });
 it("only fills active mode slots and reports disabled modes",()=>{
  const t={...template,mediaUseCase:{...template.mediaUseCase!,mediaCapabilities:{schemaVersion:1,kind:"video",defaultMode:"first_frame",modes:[{id:"first_frame",enabled:true,inputs:[{role:"first_frame",kind:"image",minItems:1,maxItems:1}],parameters:[]}]},modeBindings:{first_frame:{promptPortId:"prompt",rolePorts:{first_frame:["first"]},parameterPorts:{}}}}} as ComfyWorkflowTemplate;
  expect(run([node("target"),node("a")],[edge("a")],t)).toEqual({slots:{first:{nodeId:"a"}},errors:[]});
  expect(assignComfyMediaSlots(t,"target",[node("target")],[],"text_to_video").errors).toHaveLength(1);
 });
 it("matches mixed media by type and shares an image with its valid mask",()=>{
  const t={mediaUseCase:{slots:[{id:"picture",valueKind:"IMAGE"},{id:"video",valueKind:"VIDEO"},{id:"audio",valueKind:"AUDIO"},{id:"mask",valueKind:"MASK",required:true}]}} as ComfyWorkflowTemplate;
  const image={...node("a"),metadata:{storageKey:"image",naturalWidth:1,naturalHeight:1,mask:{storageKey:"mask",sourceStorageKey:"image",width:1,height:1}}} as CanvasNodeData;
  const nodes=[node("target"),image,node("v","video"),node("s","audio")];
  const edges=[edge("s"),edge("a"),edge("v")];
  expect(run(nodes,edges,t)).toEqual({slots:{picture:{nodeId:"a"},video:{nodeId:"v"},audio:{nodeId:"s"},mask:{nodeId:"a"}},errors:[]});
  expect(run(nodes.map(n=>n.id==="a"?{...n,metadata:{...n.metadata,mask:undefined}}:n),edges,t).errors).toHaveLength(1);
 });
});
