// @vitest-environment happy-dom
import {describe,it,expect} from "vitest";
import {buildAssistantResourceReferences,prioritizeAssistantResourceReferences} from "./canvas-assistant-resources";
import {collectAssistantImageMentions} from "./canvas-assistant-visual-mentions";
import {canvasResourceReferenceToken} from "@/lib/canvas/canvas-resource-references";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";

const makeImage=(id:string,key:string)=>({
 id,status:"success" as const,content:"/api/v1/blobs/"+key.slice(4),
 storageKey:key,naturalWidth:1024,naturalHeight:768,bytes:123,mimeType:"image/png"
});
describe("assistant @ multi-output canvas images",()=>{
 const node:CanvasNodeData={id:"img-batch",type:CanvasNodeType.Image,title:"人物三视图",
  position:{x:0,y:0},width:200,height:100,metadata:{
   content:"/api/v1/blobs/"+"b".repeat(64),storageKey:"cas:"+"b".repeat(64),
   primaryImageId:"back",
   images:[makeImage("front","cas:"+"a".repeat(64)),makeImage("back","cas:"+"b".repeat(64))]
  }};
 it("exposes each actual image as a distinct candidate, putting the primary first",()=>{
  const candidates=buildAssistantResourceReferences([node]);
  expect(candidates).toHaveLength(2);
  expect(candidates[0].imageId).toBe("back");
  expect(candidates[1].imageId).toBe("front");
  expect(candidates[0].label).not.toBe(candidates[1].label);
  const mention=collectAssistantImageMentions(
   "对比 "+canvasResourceReferenceToken(candidates[0])+" 与 "+canvasResourceReferenceToken(candidates[1]),candidates);
  expect(mention.images).toEqual([
   {nodeId:"img-batch",imageId:"back"},
   {nodeId:"img-batch",imageId:"front"}
  ]);
 });
 it("does not guess the first batch output when no primary image exists",()=>{
  const withoutPrimary={...node,metadata:{...node.metadata,primaryImageId:undefined}};
  const candidates=buildAssistantResourceReferences([withoutPrimary]);
  expect(candidates).toHaveLength(2);
  expect(candidates.every(item=>Boolean(item.imageId))).toBe(true);
 });
});

describe("assistant @ reference candidates",()=>{
 it("shows selected nodes first, retaining selected order and multi-output image order",()=>{
  const refs=[
   {id:"other",nodeId:"other",kind:"text" as const,label:"资料1",title:"其他",active:true},
   {id:"image:front",nodeId:"image",imageId:"front",kind:"image" as const,label:"参考图1",title:"正面",active:true},
   {id:"image:back",nodeId:"image",imageId:"back",kind:"image" as const,label:"参考图2",title:"背面",active:true},
   {id:"text",nodeId:"text",kind:"text" as const,label:"资料2",title:"选中文本",active:true},
   {id:"later",nodeId:"later",kind:"node" as const,label:"节点1",title:"其他节点",active:true}
  ];
  const prioritized=prioritizeAssistantResourceReferences(refs,["text","image"]);
  expect(prioritized.map(ref=>ref.id)).toEqual(["text","image:front","image:back","other","later"]);
  expect(prioritized[1]).toBe(refs[1]);
  expect(prioritized[1].label).toBe("参考图1");
  expect(prioritizeAssistantResourceReferences(refs,[])).toEqual(refs);
  expect(refs[0].id).toBe("other"); // does not mutate baseline candidates
 });
 it("includes text and non-resource group nodes without pretending media exists",()=>{
  const text:CanvasNodeData={id:"text-1",type:CanvasNodeType.Text,title:"脚本文案",
   position:{x:0,y:0},width:200,height:100,metadata:{content:"完整文本"}};
  const group:CanvasNodeData={id:"group-1",type:CanvasNodeType.Group,title:"第一幕",
   position:{x:0,y:0},width:200,height:100,metadata:{}};
  const refs=buildAssistantResourceReferences([text,group]);
  expect(refs.map(ref=>ref.kind)).toEqual(["text","node"]);
  expect(refs[0].text).toBe("完整文本");
  expect(refs[1]).toMatchObject({nodeId:"group-1",title:"第一幕",kind:"node",active:true});
 });
});
