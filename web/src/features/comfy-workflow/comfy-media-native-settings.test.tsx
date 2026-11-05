import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";
vi.hoisted(()=>{Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}});});
import type {CanvasNodeMetadata} from "@/types/canvas";
import type {ComfyTemplatePayload} from "./template-schema";
import {ComfyMediaNativeSettings,comfyMediaNativeMappedOptions,mapComfyMediaNativeSetting,resolveComfyMediaNativeConfig} from "./comfy-media-native-settings";
import {imageDimensionPresets} from "@/components/image-dimension-presets";

const binding:NonNullable<CanvasNodeMetadata["comfyMediaPreset"]>={templateId:"image",templateRevision:"r1",overrides:{steps:0,enabled:false},slots:{}};
const template:ComfyTemplatePayload={name:"Image",apiGraph:{"1":{class_type:"Generate",inputs:{width:1024,height:768,quality:"ultra"}},"2":{class_type:"SaveImage",inputs:{}}},
 requirements:{classTypes:["Generate","SaveImage"]},ports:[
  {id:"width",label:"Width",direction:"target",valueKind:"INT",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"width"}]}},
  {id:"height",label:"Height",direction:"target",valueKind:"INT",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"height"}]}},
  {id:"quality",label:"Quality",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"quality"}]}},
  {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"prompt"}]}},
  {id:"image",label:"Image",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:"2",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}],
 mediaUseCase:{channel:"image",primaryOutputKind:"image",promptPortId:"prompt",slots:[],primaryOutputPortId:"image",settings:{imageWidth:"width",imageHeight:"height",
  imageQuality:{ports:["quality"],values:[{label:"Best",value:"best",portValues:{quality:"ultra"}},{label:"Fast",value:"fast",portValues:{quality:"draft"}}]}}}};
const mediaTemplate=(kind:"video"|"audio"):ComfyTemplatePayload=>({name:kind,apiGraph:{"1":{class_type:"Generate",inputs:{resolution:"1080p",duration:8,voice:"narrator",format:"wav",speed:1.25}}},
 requirements:{classTypes:["Generate"]},ports:[
  {id:"resolution",label:"Resolution",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"resolution"}]}},
  {id:"duration",label:"Duration",direction:"target",valueKind:"INT",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"duration"}]}},
  {id:"voice",label:"Voice",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"voice"}]}},
  {id:"format",label:"Format",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"format"}]}},
  {id:"speed",label:"Speed",direction:"target",valueKind:"FLOAT",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"speed"}]}},
  {id:kind,label:"Output",direction:"source",valueKind:kind.toUpperCase() as "VIDEO"|"AUDIO",outputBinding:{nodeId:"1",outputIndex:0},capture:{kind,adapterId:"Save"}}],
 mediaUseCase:{channel:kind,primaryOutputKind:kind,promptPortId:"prompt",slots:[],primaryOutputPortId:kind,
  settings:kind==="video"?{videoResolution:"resolution",videoDuration:"duration"}:{audioVoice:"voice",audioFormat:"format",audioSpeed:"speed"}}});
describe("Comfy media native settings adapter",()=>{
 it("reads scalar defaults and reverses explicit enum mappings into native panel values",()=>{
  const config=resolveComfyMediaNativeConfig(template,binding);
  expect(config.size).toBe("1024x768");expect(config.quality).toBe("best");
  expect(config.channels).toBeDefined();
 });
 it("writes paired dimensions atomically and preserves false/zero on unrelated overrides",()=>{
  const patch=mapComfyMediaNativeSetting(template,binding,"size","1536x1024");
  expect(patch.comfyMediaPreset?.overrides).toEqual({steps:0,enabled:false,width:1536,height:1024});
  expect(mapComfyMediaNativeSetting(template,binding,"size","2:3")).toEqual({});
 });
 it("maps the native 2:3 image preset to real pixel dimensions for integer width/height ports",()=>{
  const option=comfyMediaNativeMappedOptions(template).size.find(choice=>choice.label==="2:3");
  expect(option?.value).toBe("1024x1536");
  expect(imageDimensionPresets.find(choice=>choice.ratio==="2:3")?.value).toBe("1024x1536");
  expect(mapComfyMediaNativeSetting(template,binding,"size",option!.value).comfyMediaPreset?.overrides)
   .toMatchObject({width:1024,height:1536});
 });
 it("rejects ratio strings for video width/height ports but accepts explicit WxH dimensions",()=>{
  const video=mediaTemplate("video");video.ports.push(
   {id:"width",label:"Width",direction:"target",valueKind:"INT",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"width"}]}},
   {id:"height",label:"Height",direction:"target",valueKind:"INT",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"height"}]}});
  video.mediaUseCase!.settings={videoSize:{ports:["width","height"]}};
  expect(mapComfyMediaNativeSetting(video,{...binding,templateId:"video"},"size","2:3")).toEqual({});
  expect(mapComfyMediaNativeSetting(video,{...binding,templateId:"video"},"size","720x1280").comfyMediaPreset?.overrides)
   .toMatchObject({width:720,height:1280});
 });
 it("renders the shared native image settings control with a safe complete AiConfig",()=>{
  const html=renderToStaticMarkup(createElement(ComfyMediaNativeSettings,{template,binding,onChange:()=>{}}));
  expect(html).toContain("data-comfy-media-native-settings");expect(html).toContain("1024x768");
  expect(html).toContain("Best");
 });
 it.each(["video","audio"] as const)("renders a safe native %s settings trigger from template defaults",kind=>{
  const media=mediaTemplate(kind);const mediaBinding={...binding,templateId:kind};
  const html=renderToStaticMarkup(createElement(ComfyMediaNativeSettings,{template:media,binding:mediaBinding,onChange:()=>{}}));
  expect(html).toContain("data-comfy-media-native-settings");expect(html).toContain(kind==="video"?"1080p":"narrator");
 });
});
