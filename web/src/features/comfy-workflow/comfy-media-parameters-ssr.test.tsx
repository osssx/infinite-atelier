import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";
import {canvasThemes} from "@/lib/canvas-theme";
import type {AiConfig} from "@/stores/use-config-store";
import type {CanvasNodeMetadata} from "@/types/canvas";
import type {ComfyWorkflowTemplate} from "./template-schema";

vi.mock("@/components/canvas/canvas-image-settings-popover",()=>({CanvasImageSettingsPopover:(props:{content:unknown})=>props.content}));
vi.mock("@/components/canvas/canvas-video-settings-popover",()=>({CanvasVideoSettingsPopover:(props:{content:unknown})=>props.content}));
vi.mock("@/components/canvas/canvas-audio-settings-popover",()=>({CanvasAudioSettingsPopover:(props:{content:unknown})=>props.content}));
import {ComfyMediaParameters} from "./comfy-media-parameters";

const template:ComfyWorkflowTemplate={id:"ssr",name:"SSR",revision:"rev",apiGraph:{node:{class_type:"Generate",inputs:{prompt:"",steps:24,scale:1.2}}},
 requirements:{classTypes:["Generate"]},ports:[
  {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"node",inputName:"prompt"}]}},
  {id:"steps",label:"Steps",direction:"target",valueKind:"INT",inputBinding:{mode:"literal",targets:[{nodeId:"node",inputName:"steps"}]}},
  {id:"scale",label:"Guidance scale",direction:"target",valueKind:"FLOAT",inputBinding:{mode:"literal",targets:[{nodeId:"node",inputName:"scale"}]}},
  {id:"output",label:"Output",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:"node",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}},
 ],mediaUseCase:{channel:"image",primaryOutputKind:"image",promptPortId:"prompt",slots:[],primaryOutputPortId:"output"}};
const binding:NonNullable<CanvasNodeMetadata["comfyMediaPreset"]>={templateId:"ssr",templateRevision:"rev",overrides:{},slots:{}};

describe("Comfy media parameter popover structure",()=>{
 it("server-renders a minimal titled form with default reset and compact single-column fields",()=>{
  const html=renderToStaticMarkup(createElement(ComfyMediaParameters,{template,binding,config:{} as AiConfig,theme:canvasThemes.light,onChange:()=>{}}));
  expect(html).toContain("工作流参数");
  expect(html).not.toContain("2 项");
  expect(html).not.toContain("修改仅应用于当前节点");
  expect(html).toContain("恢复默认");
  expect(html).toContain("Steps");
  expect(html).not.toContain("已调整");
  expect(html).toContain("space-y-3");
  expect(html).not.toContain("grid-cols-2");
 });
});
