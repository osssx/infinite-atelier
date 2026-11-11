// @vitest-environment happy-dom
import {describe,it,expect} from "vitest";
import {buildAssistantResourceReferences} from "./canvas-assistant-resources";
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
