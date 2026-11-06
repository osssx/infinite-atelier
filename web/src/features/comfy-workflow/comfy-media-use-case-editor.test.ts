import {describe,expect,it} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {comfyAdditionalOutputOptions,ComfyMediaUseCaseEditor,normalizeComfyMediaUseCaseOutputSelection,normalizeComfyTemplateMediaDraft} from "./comfy-media-use-case-editor";
import type {ComfyMediaUseCase,ComfyTemplatePayload} from "./template-schema";

describe("Comfy media output editor draft recovery",()=>{
 it("deduplicates additional outputs and removes the selected primary output",()=>{
  const useCase:ComfyMediaUseCase={channel:"image",primaryOutputKind:"image",promptPortId:"prompt",slots:[],
   primaryOutputPortId:"main",additionalOutputPortIds:["preview","main","preview"]};
  expect(normalizeComfyMediaUseCaseOutputSelection(useCase)?.additionalOutputPortIds).toEqual(["preview"]);
 });
 it("normalizes duplicated legacy draft selections before restore or save",()=>{
  const draft={name:"Draft",apiGraph:{},ports:[],requirements:{classTypes:[]},mediaUseCase:{channel:"video",primaryOutputKind:"video",
   promptPortId:"prompt",slots:[],primaryOutputPortId:"video",additionalOutputPortIds:["video","audio","audio"]}} as ComfyTemplatePayload;
  const recovered=normalizeComfyTemplateMediaDraft(draft);
  expect(recovered.mediaUseCase?.additionalOutputPortIds).toEqual(["audio"]);
  expect(draft.mediaUseCase?.additionalOutputPortIds).toHaveLength(3);
 });
 it("uses styled controls, concise clearable multiselects, and excludes the selected primary output",()=>{
  const template={name:"Media",apiGraph:{n:{class_type:"Generate",inputs:{}}},requirements:{classTypes:["Generate"]},ports:[
   {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"n",inputName:"prompt"}]}},
   {id:"quality",label:"Quality",direction:"target",valueKind:"STRING",choices:[{label:"Best",value:"best"}],inputBinding:{mode:"literal",targets:[{nodeId:"n",inputName:"quality"}]}},
   {id:"image-in",label:"Reference image",direction:"target",valueKind:"IMAGE",inputBinding:{mode:"socket",replaceInternalLink:false,targets:[{nodeId:"n",inputName:"image"}]}},
   {id:"main",label:"Main output",direction:"source",valueKind:"IMAGE",capture:{kind:"image",adapterId:"SaveImage"}},
   {id:"preview",label:"Preview output",direction:"source",valueKind:"IMAGE",capture:{kind:"image",adapterId:"SaveImage"}},
  ],mediaUseCase:{channel:"image",primaryOutputKind:"image",promptPortId:"prompt",slots:[{id:"image-in",label:"Reference image",valueKind:"IMAGE"}],
   primaryOutputPortId:"main",additionalOutputPortIds:["preview"]}} as ComfyTemplatePayload;
  const html=renderToStaticMarkup(createElement(ComfyMediaUseCaseEditor,{template,onChange:()=>{}}));
  expect(html).toContain("ant-select");expect(html).toContain("ant-checkbox");expect(html).toContain("ant-btn");
  expect(html).not.toContain("<select");expect(html).not.toContain("multiple=");
  expect(comfyAdditionalOutputOptions(template,template.mediaUseCase).map(port=>port.id)).toEqual(["preview"]);
 });
});
