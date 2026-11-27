// @vitest-environment happy-dom
import {describe,expect,it} from "vitest";
import source from "../../../../workflows/video_minimax_h3_ref2v_turbo.json";
import {buildMiniMaxH3Ref2VPreset,isMiniMaxH3Ref2VWorkflow,minimaxH3Ref2VBundledTemplate,MINIMAX_H3_REF2V_TEMPLATE_ID} from "./minimax-h3-ref2v-preset";
import {validateComfyApiGraph,validateComfyTemplatePayload,createComfyTemplate} from "./template-schema";
import {assignComfyMediaSlots,resolveComfyMediaMode} from "./comfy-media-slot-assignment";
import type {MediaModeId} from "@/services/media-capabilities";
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
 it("exposes five modes, reuses existing image ports and preserves automatic omni behavior",async()=>{
  const preset=minimaxH3Ref2VBundledTemplate(),t=await createComfyTemplate(MINIMAX_H3_REF2V_TEMPLATE_ID,preset);
  const use=t.mediaUseCase!;
  expect(use.mediaCapabilities!.modes.map(m=>m.id).sort()).toEqual(["first_frame","first_last_frame","last_frame","omni_reference","text_to_video"]);
  expect(use.modeBindings!.first_frame).toMatchObject({rolePorts:{first_frame:["reference_image_0"]}});
  expect(use.modeBindings!.last_frame).toMatchObject({rolePorts:{last_frame:["reference_image_0"]}});
  expect(use.modeBindings!.first_last_frame).toMatchObject({rolePorts:{first_frame:["reference_image_0"],last_frame:["reference_image_1"]}});
  for(const binding of Object.values(use.modeBindings!))expect(binding?.promptTransform).toBeUndefined();
  expect(t.apiGraph["129"].class_type).toBe("MiniMaxH3ReferenceToVideo");
  expect(Object.keys(t.apiGraph).sort()).toEqual(Object.keys(source).sort());
  const make=(id:string,type="image")=>({id,type,title:id,position:{x:0,y:0},width:32,height:32,metadata:{storageKey:"cas:"+"a".repeat(64)}} as CanvasNodeData);
  const nodes=[make("target","video"),make("start"),make("end"),make("clip","video")];
  const edges=[{id:"a",fromNodeId:"start",toNodeId:"target"},{id:"b",fromNodeId:"end",toNodeId:"target"}];
  expect(resolveComfyMediaMode(t,"target",nodes,edges.slice(0,1))).toBe("omni_reference");
  expect(resolveComfyMediaMode(t,"target",nodes,edges)).toBe("omni_reference");
  for(const mode of ["first_frame","last_frame"] as MediaModeId[]){
   expect(resolveComfyMediaMode(t,"target",nodes,edges.slice(0,1),mode)).toBe(mode);
   expect(assignComfyMediaSlots(t,"target",nodes,edges.slice(0,1),mode)).toEqual({slots:{reference_image_0:{nodeId:"start"}},errors:[]});
   expect(assignComfyMediaSlots(t,"target",nodes,[],mode).errors.length).toBeGreaterThan(0);
   expect(assignComfyMediaSlots(t,"target",nodes,edges,mode).errors.length).toBeGreaterThan(0);
  }
  expect(assignComfyMediaSlots(t,"target",nodes,edges,"first_last_frame")).toEqual({slots:{reference_image_0:{nodeId:"start"},reference_image_1:{nodeId:"end"}},errors:[]});
  expect(assignComfyMediaSlots(t,"target",nodes,edges.slice(0,1),"first_last_frame").errors.length).toBeGreaterThan(0);
  expect(assignComfyMediaSlots(t,"target",nodes,[...edges,{id:"c",fromNodeId:"clip",toNodeId:"target"}],"first_last_frame").errors.length).toBeGreaterThan(0);
 });
 it("only exposes endpoint modes when enough ordinary image sockets exist",()=>{
  const graph=validateComfyApiGraph(structuredClone(source));
  for(const key of Object.keys(graph["129"].inputs))if(/^ref_images\./.test(key)&&key!=="ref_images.ref_image_3")delete graph["129"].inputs[key];
  const preset=buildMiniMaxH3Ref2VPreset(graph);
  expect(preset.mediaUseCase!.modeBindings!.first_frame!.rolePorts!.first_frame).toEqual(["reference_image_3"]);
  expect(preset.mediaUseCase!.modeBindings!.first_last_frame).toBeUndefined();
 });
 it("rejects unrecognized reference loader topology",()=>{
  const graph=validateComfyApiGraph(structuredClone(source));
  graph["139"].class_type="OtherLoader";
  expect(isMiniMaxH3Ref2VWorkflow(graph)).toBe(false);
  expect(()=>buildMiniMaxH3Ref2VPreset(graph)).toThrow(/not the supported/);
 });
});
