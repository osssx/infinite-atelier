// @vitest-environment happy-dom
import {describe,expect,it} from "vitest";
import source from "../../../../workflows/video_minimax_h3_ref2v_turbo.json";
import {buildMiniMaxH3Ref2VPreset,isMiniMaxH3Ref2VWorkflow,minimaxH3Ref2VBundledTemplate,MINIMAX_H3_REF2V_TEMPLATE_ID} from "./minimax-h3-ref2v-preset";
import {validateComfyApiGraph,validateComfyTemplatePayload,createComfyTemplate} from "./template-schema";
import {resolveComfyMediaMode} from "./comfy-media-slot-assignment";
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
 it("rejects unrecognized reference loader topology",()=>{
  const graph=validateComfyApiGraph(structuredClone(source));
  graph["139"].class_type="OtherLoader";
  expect(isMiniMaxH3Ref2VWorkflow(graph)).toBe(false);
  expect(()=>buildMiniMaxH3Ref2VPreset(graph)).toThrow(/not the supported/);
 });
});
