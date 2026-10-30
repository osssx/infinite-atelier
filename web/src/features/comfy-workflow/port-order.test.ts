import {beforeAll,describe,expect,it,vi} from "vitest";
import {registerBuiltinNodes} from "@/components/canvas/nodes/builtin-nodes";
import {canToggleComfyInputPortVisibility,getCanvasPortAnchor,getCanvasPortOffset,getCanvasVisiblePorts,pickCanvasDropHandle} from "@/lib/canvas/canvas-ports";
import {connectionControlPoints} from "@/lib/canvas/canvas-connection-culling";
import type {CanvasNodeData,CanvasConnection} from "@/types/canvas";
import {canonicalComfyJson,type ComfyTemplatePort} from "./template-schema";
import {moveComfyCanvasPort,reorderComfyCanvasPorts} from "./port-order";

vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
beforeAll(()=>registerBuiltinNodes());

const ports:ComfyTemplatePort[]=[
 {id:"prompt",label:"提示词",direction:"target",valueKind:"STRING",defaultValue:"hello",
  inputBinding:{mode:"literal",targets:[{nodeId:"12",inputName:"text"}]}},
 {id:"image",label:"图片",direction:"source",valueKind:"IMAGE",
  outputBinding:{nodeId:"34",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}},
 {id:"ratio",label:"画面比例",direction:"target",valueKind:"STRING",
  choices:[{label:"方形",value:"1:1"},{label:"横版",value:"16:9"}],
  inputBinding:{mode:"literal",targets:[{nodeId:"19",inputName:"aspect_ratio"}]}},
 {id:"video",label:"视频",direction:"source",valueKind:"VIDEO",
  outputBinding:{nodeId:"40",outputIndex:0},capture:{kind:"video",adapterId:"SaveVideo"}},
 {id:"negative",label:"负面提示词",direction:"target",valueKind:"STRING",
  inputBinding:{mode:"literal",targets:[{nodeId:"13",inputName:"text"}]}},
];
const ids=(list:readonly ComfyTemplatePort[])=>list.map(p=>p.id);
const makeNode=(arr:readonly ComfyTemplatePort[]):CanvasNodeData=>({
 id:"wf",title:"工作流",type:"comfy:workflow",width:400,height:320,
 position:{x:500,y:100},metadata:{
  comfyWorkflow:{templateId:"test",templateRevision:"a".repeat(64),bindingState:"bound",inputOverrides:{}},
  comfyPorts:arr.map(({id,label,direction,valueKind,required,canvasVisible})=>({id,label,direction,valueKind,required,canvasVisible})),
 }
});
describe("Comfy workflow canvas port order",()=>{
 it("hides optional input sockets only; required sockets and outputs stay visible",()=>{
  const configurable=[
   {id:"required",label:"Required",direction:"target" as const,valueKind:"STRING" as const,required:true,canvasVisible:false},
   {id:"optional",label:"Optional",direction:"target" as const,valueKind:"IMAGE" as const,canvasVisible:false},
   {id:"plain",label:"Default",direction:"target" as const,valueKind:"STRING" as const},
   {id:"float",label:"Numeric",direction:"target" as const,valueKind:"FLOAT" as const},
   {id:"out",label:"Output",direction:"source" as const,valueKind:"IMAGE" as const},
  ];
  const node=makeNode(configurable.map(p=>({...p,inputBinding:p.direction==="target"?{mode:"literal" as const,targets:[]}:undefined})));
  expect(canToggleComfyInputPortVisibility(configurable[1])).toBe(true);
  expect(canToggleComfyInputPortVisibility(configurable[3])).toBe(false);
  expect(canToggleComfyInputPortVisibility(configurable[4])).toBe(false);
  expect(getCanvasVisiblePorts(node).map(p=>p.id)).toEqual(["required","plain","out"]);
  expect(pickCanvasDropHandle(node,{nodeId:"source",handleType:"source"},node.position.y+node.height/2)?.portId).not.toBe("optional");
  expect(getCanvasVisiblePorts(makeNode(ports)).filter(p=>p.direction==="target").map(p=>p.id)).toEqual(["prompt","ratio","negative"]);
 });
 it("drags inputs before/after siblings while preserving outputs and metadata",()=>{
  const reordered=reorderComfyCanvasPorts(ports,"negative","prompt","before");
  expect(ids(reordered)).toEqual(["negative","image","prompt","video","ratio"]);
  expect(ids(ports)).toEqual(["prompt","image","ratio","video","negative"]);
  expect(reordered[0]).toBe(ports[4]);
  expect(reordered[2]).toBe(ports[0]);
  expect(reordered[1]).toBe(ports[1]);
  expect(reordered[3]).toBe(ports[3]);
  expect(reordered[4].choices).toEqual(ports[2].choices);
  expect(reordered[4].inputBinding).toBe(ports[2].inputBinding);
  expect(canonicalComfyJson(reordered)).not.toEqual(canonicalComfyJson(ports));
 });
 it("reorders output ports independently without altering input relative order",()=>{
  const updated=reorderComfyCanvasPorts(ports,"video","image","before");
  expect(ids(updated)).toEqual(["prompt","video","ratio","image","negative"]);
  expect(updated[1].outputBinding).toBe(ports[3].outputBinding);
  expect(updated.filter(p=>p.direction==="target").map(p=>p.id))
   .toEqual(["prompt","ratio","negative"]);
 });
 it("rejects cross-side, missing, self and no-op drag without reallocating",()=>{
  expect(reorderComfyCanvasPorts(ports,"prompt","image")).toBe(ports);
  expect(reorderComfyCanvasPorts(ports,"ghost","prompt")).toBe(ports);
  expect(reorderComfyCanvasPorts(ports,"ratio","ghost")).toBe(ports);
  expect(reorderComfyCanvasPorts(ports,"prompt","prompt")).toBe(ports);
  expect(reorderComfyCanvasPorts(ports,"prompt","ratio","before")).toBe(ports);
  expect(reorderComfyCanvasPorts(ports,"ratio","prompt","after")).toBe(ports);
 });
 it("supports one-step up/down controls with disabled edge cases",()=>{
  expect(ids(moveComfyCanvasPort(ports,"negative",-1))).toEqual(["prompt","image","negative","video","ratio"]);
  expect(ids(moveComfyCanvasPort(ports,"prompt",1))).toEqual(["ratio","image","prompt","video","negative"]);
  expect(ids(moveComfyCanvasPort(ports,"image",1))).toEqual(["prompt","video","ratio","image","negative"]);
  expect(moveComfyCanvasPort(ports,"prompt",-1)).toBe(ports);
  expect(moveComfyCanvasPort(ports,"negative",1)).toBe(ports);
  expect(moveComfyCanvasPort(ports,"not-found",1)).toBe(ports);
 });
 it("uses new visible order in both canvas connectors and connection geometry, with port IDs intact",()=>{
  const reordered=reorderComfyCanvasPorts(ports,"negative","prompt","before");
  const oldNode=makeNode(ports);
  const newNode=makeNode(reordered);
  expect(getCanvasVisiblePorts(newNode).filter(p=>p.direction==="target").map(p=>p.id))
   .toEqual(["negative","prompt","ratio"]);
  expect(getCanvasPortOffset(newNode,"target","negative")).toBe(newNode.height/2-30);
  expect(getCanvasPortOffset(newNode,"target","prompt")).toBe(newNode.height/2);
  expect(getCanvasPortOffset(newNode,"target","ratio")).toBe(newNode.height/2+30);
  expect(getCanvasPortAnchor(newNode,"target","negative").y)
   .not.toBe(getCanvasPortAnchor(oldNode,"target","negative").y);
  expect(getCanvasPortAnchor(newNode,"source","image").y)
   .toBe(getCanvasPortAnchor(oldNode,"source","image").y);
  const text:CanvasNodeData={id:"text",title:"文本",type:"text",position:{x:0,y:100},width:300,height:200,metadata:{}};
  const existing:CanvasConnection={id:"link",fromNodeId:"text",fromPortId:"text",toNodeId:"wf",toPortId:"negative"};
  expect(connectionControlPoints(text,newNode,existing).endY)
   .toBe(getCanvasPortAnchor(newNode,"target","negative").y);
  expect(existing.toPortId).toBe("negative");
 });
});
