import {describe,expect,it,vi} from "vitest";
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
import {defaultConfig,type AiConfig} from "@/stores/use-config-store";
import {resolveComfyWorkflowSelection} from "./comfy-workflow-selection";
import {normalizeComfyWorkflowDefaults} from "@/stores/use-config-store";

const image={templateId:"image-flow",templateRevision:"a".repeat(64),overrides:{steps:5},slots:{}};
const video={templateId:"video-flow",templateRevision:"b".repeat(64),overrides:{},slots:{}};
const node=(metadata:Record<string,unknown>)=>({id:"n",type:"config",metadata} as any);
describe("Comfy workflow defaults and mode bindings",()=>{
 it("normalizes persisted defaults by capability and excludes text or malformed refs",()=>{
  expect(normalizeComfyWorkflowDefaults({image:{templateId:"image-flow",templateRevision:"a".repeat(64)},
   video:{templateId:"bad id",templateRevision:"b".repeat(64)},text:{templateId:"text",templateRevision:"c".repeat(64)}}))
   .toEqual({image:{templateId:"image-flow",templateRevision:"a".repeat(64)}});
 });
 it("inherits only the selected mode, honors explicit config-node bindings and channel overrides",()=>{
  const config={...defaultConfig,comfyWorkflowDefaults:{image:{templateId:image.templateId,templateRevision:image.templateRevision},
   video:{templateId:video.templateId,templateRevision:video.templateRevision}}} as AiConfig;
  expect(resolveComfyWorkflowSelection(config,node({}),"image")?.templateId).toBe(image.templateId);
  expect(resolveComfyWorkflowSelection(config,node({}),"video")?.templateId).toBe(video.templateId);
  expect(resolveComfyWorkflowSelection(config,node({}),"text")).toBeUndefined();
  expect(resolveComfyWorkflowSelection(config,node({comfyWorkflowSelections:{image:video}}),"image")).toEqual(video);
  expect(resolveComfyWorkflowSelection(config,node({model:config.imageModel}),"image")).toBeUndefined();
  expect(resolveComfyWorkflowSelection(config,node({comfyMediaPreset:video}),"image")).toEqual(video);
 });
});
