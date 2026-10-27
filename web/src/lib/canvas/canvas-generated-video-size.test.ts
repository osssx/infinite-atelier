import {describe,expect,it} from "vitest";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";
import {recoverLegacyGeneratedVideoSize} from "./canvas-generated-video-size";

function node(patch:Partial<CanvasNodeData>={}):CanvasNodeData{
 return {id:"generated-video",type:CanvasNodeType.Video,title:"Generated video",
  position:{x:100,y:200},width:420,height:236,
  metadata:{content:"/api/v1/blobs/"+"a".repeat(64),status:"success",
   comfyArtifact:{runId:"job",artifactId:"a",workflowNodeId:"wf",portId:"video",kind:"video",index:0}},
  ...patch} as CanvasNodeData;
}

describe("recovery of fixed-size generated video nodes",()=>{
 it("uses portrait poster aspect immediately without opening a video decoder",()=>{
  const restored=recoverLegacyGeneratedVideoSize(node(),144,256,"poster");
  expect(restored).toMatchObject({width:236,height:420,position:{x:192,y:108},
   metadata:{legacyVideoAspectRecovered:true}});
  expect(restored.metadata?.naturalWidth).toBeUndefined();
  expect(restored.metadata?.naturalHeight).toBeUndefined();
  expect(recoverLegacyGeneratedVideoSize(restored,144,256,"poster")).toBe(restored);
 });
 it("uses actual native video size when known and retains geometry after a poster recovery",()=>{
  const original=node();
  const native=recoverLegacyGeneratedVideoSize(original,1344,768,"video");
  expect(native).toMatchObject({width:420,height:240,position:{x:100,y:198},
   metadata:{naturalWidth:1344,naturalHeight:768}});
  const poster=recoverLegacyGeneratedVideoSize(original,144,256,"poster");
  const afterNative=recoverLegacyGeneratedVideoSize(poster,768,1344,"video");
  expect(afterNative.width).toBe(poster.width);
  expect(afterNative.height).toBe(poster.height);
  expect(afterNative.metadata).toMatchObject({naturalWidth:768,naturalHeight:1344});
  expect(recoverLegacyGeneratedVideoSize(afterNative,768,1344,"video")).toBe(afterNative);
 });
 it("handles square and model-created video nodes",()=>{
  const original=node({metadata:{...node().metadata,comfyArtifact:undefined,
   modelArtifact:{jobId:"job",artifactId:"a",sourceNodeId:"config",kind:"video",model:"ark"}}});
  expect(recoverLegacyGeneratedVideoSize(original,800,800,"video")).toMatchObject({width:420,height:420,
   position:{x:100,y:108},metadata:{naturalWidth:800,naturalHeight:800}});
 });
 it("never resizes uploads, already sized new nodes, manually adjusted video or invalid metadata",()=>{
  const base=node();
  for(const item of [
   {...base,width:410},{...base,height:420},
   {...base,metadata:{...base.metadata,comfyArtifact:undefined,modelArtifact:undefined}},
   {...base,metadata:{...base.metadata,freeResize:true}},
   {...base,metadata:{...base.metadata,naturalWidth:1344,naturalHeight:768}},
   {...base,metadata:{...base.metadata,legacyVideoAspectRecovered:true}},
   {...base,type:CanvasNodeType.Image}
  ]){
   expect(recoverLegacyGeneratedVideoSize(item as CanvasNodeData,768,1344,"poster")).toBe(item);
  }
  for(const [w,h] of [[0,800],[Infinity,720],[1280,0],[1,999999],[2,4.5]]){
   expect(recoverLegacyGeneratedVideoSize(base,w,h,"video")).toBe(base);
  }
 });
});
