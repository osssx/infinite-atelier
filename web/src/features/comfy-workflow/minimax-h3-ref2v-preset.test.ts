// @vitest-environment happy-dom
import {describe,expect,it} from "vitest";
import source from "../../../../workflows/video_minimax_h3_ref2v_turbo.json";
import {buildMiniMaxH3Ref2VPreset,isMiniMaxH3Ref2VWorkflow,minimaxH3Ref2VBundledTemplate,MINIMAX_H3_REF2V_TEMPLATE_ID} from "./minimax-h3-ref2v-preset";
import {validateComfyApiGraph,validateComfyTemplatePayload,createComfyTemplate} from "./template-schema";
import {assignComfyMediaSlots,resolveComfyMediaMode} from "./comfy-media-slot-assignment";
import {comfyModeConnectionErrors} from "./run-types";
import {ComfyGenerationModeControl} from "./comfy-generation-mode-control";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {CanvasNodeData} from "@/types/canvas";
describe("H3 Ref2V imported preset",()=>{
 it("binds all actual optional media loader files with original resource kinds and deterministic 24fps",async()=>{
  const original=structuredClone(source),preset=minimaxH3Ref2VBundledTemplate();
  expect(isMiniMaxH3Ref2VWorkflow(validateComfyApiGraph(source))).toBe(true);
  expect(source).toEqual(original);
  expect(preset.apiGraph["139"].inputs).toMatchObject({force_rate:24,frame_load_cap:360,select_every_nth:1,format:"None"});
  expect(preset.apiGraph["129"].inputs["ref_videos.ref_video_0"]).toEqual(["139",0]);
  expect(preset.apiGraph["105_11"].inputs.vae_name).toBe(source["105_11"].inputs.vae_name);
  const slots=preset.mediaUseCase!.slots;
  expect(slots.filter(s=>s.valueKind==="IMAGE")).toHaveLength(6);
  expect(slots.filter(s=>s.valueKind==="VIDEO")).toHaveLength(1);
  expect(slots.filter(s=>s.valueKind==="AUDIO")).toHaveLength(3);
  expect(preset.ports.find(p=>p.id==="reference_video_0")).toMatchObject({valueKind:"VIDEO",required:false,inputBinding:{mode:"media-file",mediaKind:"VIDEO",targets:[{nodeId:"139",inputName:"video"}]},absentPolicy:{mode:"auto-prune"}});
  expect(preset.ports.filter(p=>p.absentPolicy?.mode==="auto-prune")).toHaveLength(10);
  expect(preset.mediaUseCase!.modeBindings!.omni_reference!.rolePorts!.reference_video).toEqual(["reference_video_0"]);
  expect(validateComfyTemplatePayload(preset)).toMatchObject({name:preset.name});
  expect((await createComfyTemplate(MINIMAX_H3_REF2V_TEMPLATE_ID,preset)).revision).toHaveLength(64);
 });
 it("chooses text mode without references and omni mode with a video",async()=>{
  const t=await createComfyTemplate(MINIMAX_H3_REF2V_TEMPLATE_ID,minimaxH3Ref2VBundledTemplate());
  const nodes=[{id:"target",type:"video",title:"target",position:{x:0,y:0},width:100,height:100,metadata:{}},{id:"clip",type:"video",title:"clip",position:{x:0,y:0},width:100,height:100,metadata:{storageKey:"cas:"+"a".repeat(64)}}] as CanvasNodeData[];
  expect(resolveComfyMediaMode(t,"target",nodes,[])).toBe("text_to_video");
  expect(resolveComfyMediaMode(t,"target",nodes,[{id:"e",fromNodeId:"clip",toNodeId:"target"}])).toBe("omni_reference");
 });
 it("declares five modes with the same optional Picture ports, no prompt rewriting, and strict input counts",async()=>{
  const t=await createComfyTemplate(MINIMAX_H3_REF2V_TEMPLATE_ID,minimaxH3Ref2VBundledTemplate());
  const use=t.mediaUseCase!;
  expect(use.mediaCapabilities!.modes.map(m=>m.id)).toEqual(["text_to_video","omni_reference","first_frame","last_frame","first_last_frame"]);
  expect(use.modeBindings!.first_frame!.rolePorts).toEqual({first_frame:["reference_image_0"]});
  expect(use.modeBindings!.last_frame!.rolePorts).toEqual({last_frame:["reference_image_0"]});
  expect(use.modeBindings!.first_last_frame!.rolePorts).toEqual({first_frame:["reference_image_0"],last_frame:["reference_image_1"]});
  expect(t.ports.some(p=>p.id==="first_frame"||p.id==="last_frame")).toBe(false);
  expect(t.apiGraph["129"].inputs.prompt).toBe(source["129"].inputs.prompt);
  const nodes=["target","a","b","c"].map(id=>({id,type:id==="target"?"video":"image",title:id,position:{x:0,y:0},width:100,height:100,metadata:{content:"blob:"+id}})) as CanvasNodeData[];
  const edges=["a","b","c"].map((id,i)=>({id,fromNodeId:id,toNodeId:"target",fromPortId:"image",toPortId:"reference_image_"+i}));
  for(const mode of ["first_frame","last_frame"] as const){
   expect(assignComfyMediaSlots(t,"target",nodes,edges.slice(0,1),mode)).toEqual({slots:{reference_image_0:{nodeId:"a"}},errors:[]});
   expect(comfyModeConnectionErrors(t,"target",edges.slice(0,1),mode)).toEqual([]);
   expect(comfyModeConnectionErrors(t,"target",edges.slice(0,2),mode).join()).toContain("不接受");
  }
  expect(resolveComfyMediaMode(t,"target",nodes,edges.slice(0,2))).toBe("omni_reference");
  expect(resolveComfyMediaMode(t,"target",nodes,edges.slice(0,2),"first_last_frame")).toBe("first_last_frame");
  expect(assignComfyMediaSlots(t,"target",nodes,edges.slice(0,2),"first_last_frame")).toEqual({slots:{reference_image_0:{nodeId:"a"},reference_image_1:{nodeId:"b"}},errors:[]});
  expect(comfyModeConnectionErrors(t,"target",edges.slice(0,1),"first_last_frame").join()).toContain("缺少必填");
  expect(comfyModeConnectionErrors(t,"target",edges.slice(0,3),"first_last_frame").join()).toContain("不接受");
  const html=renderToStaticMarkup(createElement(ComfyGenerationModeControl,{template:t,value:"first_last_frame",onChange:()=>{}}));
  expect(html).toContain("首尾帧生成");expect(html).toContain("首帧：参考图片 1；尾帧：参考图片 2");expect(html).toContain("不会自动添加提示词");
 });
 it("does not advertise first/last-frame modes for absent Picture loader positions",()=>{
  const graph=validateComfyApiGraph(structuredClone(source));
  delete graph["129"].inputs["ref_images.ref_image_1"];
  expect(buildMiniMaxH3Ref2VPreset(graph).mediaUseCase!.modeBindings!.first_last_frame).toBeUndefined();
  delete graph["129"].inputs["ref_images.ref_image_0"];
  const bindings=buildMiniMaxH3Ref2VPreset(graph).mediaUseCase!.modeBindings!;
  expect(bindings.first_frame).toBeUndefined();expect(bindings.last_frame).toBeUndefined();
 });
 it("rejects unrecognized reference loader topology",()=>{
  const graph=validateComfyApiGraph(structuredClone(source));
  graph["139"].class_type="OtherLoader";
  expect(isMiniMaxH3Ref2VWorkflow(graph)).toBe(false);
  expect(()=>buildMiniMaxH3Ref2VPreset(graph)).toThrow(/not the supported/);
 });
});
