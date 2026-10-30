import {describe,expect,it} from "vitest";
import {parseComfyLiveUpdate} from "./comfy-live-events";

describe("Comfy native live-event validation",()=>{
 it("accepts bounded progress, previews and node errors",()=>{
  expect(parseComfyLiveUpdate({kind:"progress",currentNode:"w_wf__12",step:3,steps:20,value:.15}))
   .toEqual({kind:"progress",currentNode:"w_wf__12",step:3,steps:20,value:.15});
  expect(parseComfyLiveUpdate({kind:"preview",mime:"image/png",data:"iVBORw0KGgo="})?.kind).toBe("preview");
  expect(parseComfyLiveUpdate({kind:"error",error:{nodeId:"w_wf__12",classType:"Sampler",type:"runtime_error",message:"runtime_error"}})?.kind).toBe("error");
 });
 it("accepts bounded node names and drops oversized names without dropping progress",()=>{
  const base={kind:"progress",currentNode:"w_wf__105_14",step:2,steps:6,value:2/6};
  expect(parseComfyLiveUpdate({...base,nodeName:"自定义采样器（高级）"})).toEqual({...base,nodeName:"自定义采样器（高级）"});
  expect(parseComfyLiveUpdate({...base,nodeName:"X".repeat(150)})).toEqual(base);
 });
 it("rejects unknown formats, over-limit base64, hostile nodes and invalid percentages",()=>{
  expect(parseComfyLiveUpdate({kind:"preview",mime:"image/svg+xml",data:"AAAA"})).toBeNull();
  expect(parseComfyLiveUpdate({kind:"preview",mime:"image/png",data:"A".repeat(360000)})).toBeNull();
  expect(parseComfyLiveUpdate({kind:"progress",currentNode:"<svg>",step:3,steps:20,value:0.15})).toBeNull();
  expect(parseComfyLiveUpdate({kind:"progress",currentNode:null,step:3,steps:20,value:2})).toBeNull();
  expect(parseComfyLiveUpdate({kind:"error",error:{nodeId:"x",classType:"a",type:"b",message:"z".repeat(1000)}})).toBeNull();
 });
});
