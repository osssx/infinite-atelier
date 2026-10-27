import {describe,it,expect} from "vitest";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";
import {recoverLegacyGeneratedImageSize} from "./canvas-generated-image-size";
function node(patch:Partial<CanvasNodeData>={}):CanvasNodeData{
 return {id:"artifact-a",type:CanvasNodeType.Image,title:"Generated image",
  position:{x:100,y:200},width:420,height:420,
  metadata:{content:"/api/v1/blobs/"+"a".repeat(64),status:"success",
   comfyArtifact:{runId:"job",artifactId:"a",workflowNodeId:"wf",portId:"image",kind:"image",index:0}},
  ...patch} as CanvasNodeData;
}
describe("legacy generated image sizing",()=>{
 it("recovers portrait ratio without cropping; centers position and records natural dimensions",()=>{
  const resized=recoverLegacyGeneratedImageSize(node(),768,1344);
  expect(resized).toMatchObject({width:240,height:420,position:{x:190,y:200},
   metadata:{naturalWidth:768,naturalHeight:1344}});
  expect(recoverLegacyGeneratedImageSize(resized,768,1344)).toBe(resized);
 });
 it("recovers landscape ratio and model artifact as well",()=>{
  const src=node({metadata:{...node().metadata,comfyArtifact:undefined,
   modelArtifact:{jobId:"j",artifactId:"a",sourceNodeId:"model",kind:"image",model:"test"}}});
  expect(recoverLegacyGeneratedImageSize(src,1344,768)).toMatchObject({
   width:420,height:240,position:{x:100,y:290},
   metadata:{naturalWidth:1344,naturalHeight:768}
  });
 });
 it("does not override uploads, manually resized nodes, free-resize or batch images",()=>{
  const src=node();
  for(const unsafe of [
   {...src,width:480},{...src,height:340},
   {...src,metadata:{...src.metadata,freeResize:true}},
   {...src,metadata:{...src.metadata,images:[{id:"slot",content:"image"}]}},
   {...src,metadata:{...src.metadata,naturalWidth:600}},
   {...src,metadata:{...src.metadata,comfyArtifact:undefined,modelArtifact:undefined}},
   {...src,type:CanvasNodeType.Video}
  ]){
   expect(recoverLegacyGeneratedImageSize(unsafe as CanvasNodeData,768,1344)).toBe(unsafe);
  }
 });
 it("unknown or implausible dimensions never alter geometry",()=>{
  const src=node();
  for(const [w,h] of [[0,900],[NaN,900],[100000,900],[2,900000],[3,3.5]])
   expect(recoverLegacyGeneratedImageSize(src,w,h)).toBe(src);
 });
});
