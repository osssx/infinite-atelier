import {describe,expect,it,vi} from "vitest";
import type {ReactElement} from "react";
import type {AiConfig} from "@/stores/use-config-store";
import type {CanvasNodeMetadata} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import type {ComfyWorkflowTemplate} from "./template-schema";

vi.mock("react",async importOriginal=>{
 const actual=await importOriginal<typeof import("react")>();
 return {...actual,useState:<T,>(initial:T):[T,(next:T)=>void]=>[initial,()=>{}],useEffect:()=>{}};
});
vi.mock("@/components/canvas/canvas-image-settings-popover",()=>({CanvasImageSettingsPopover:(props:{content:unknown})=>props.content}));
vi.mock("@/components/canvas/canvas-video-settings-popover",()=>({CanvasVideoSettingsPopover:(props:{content:unknown})=>props.content}));
vi.mock("@/components/canvas/canvas-audio-settings-popover",()=>({CanvasAudioSettingsPopover:(props:{content:unknown})=>props.content}));

import {withComfyMediaAspect} from "./comfy-media-aspect";
import {ComfyMediaParameters,DirectPortControl} from "./comfy-media-parameters";

const ports=[
 {id:"prompt",label:"Prompt",direction:"target" as const,valueKind:"STRING" as const,inputBinding:{mode:"literal" as const,targets:[{nodeId:"n",inputName:"prompt"}]}},
 {id:"enum",label:"Enum",direction:"target" as const,valueKind:"FLOAT" as const,choices:[{label:"One",value:1},{label:"One point five",value:1.5}],inputBinding:{mode:"literal" as const,targets:[{nodeId:"n",inputName:"enum"}]}},
 {id:"bool",label:"Boolean",direction:"target" as const,valueKind:"BOOLEAN" as const,inputBinding:{mode:"literal" as const,targets:[{nodeId:"n",inputName:"bool"}]}},
 {id:"text",label:"Text",direction:"target" as const,valueKind:"STRING" as const,inputBinding:{mode:"literal" as const,targets:[{nodeId:"n",inputName:"text"}]}},
 {id:"empty",label:"Empty targets",direction:"target" as const,valueKind:"STRING" as const,inputBinding:{mode:"literal" as const,targets:[]}},
 {id:"image-in",label:"Image socket",direction:"target" as const,valueKind:"IMAGE" as const,inputBinding:{mode:"socket" as const,replaceInternalLink:false,targets:[{nodeId:"n",inputName:"image"}]}},
 {id:"main",label:"Output",direction:"source" as const,valueKind:"IMAGE" as const,outputBinding:{nodeId:"n",outputIndex:0},capture:{kind:"image" as const,adapterId:"SaveImage"}},
];
const graph={n:{class_type:"Generate",inputs:{prompt:"p",enum:1,bool:false,text:""}}};
const template=(kind:"image"|"video"|"audio"):ComfyWorkflowTemplate=>({id:"t",name:"T",revision:"r",apiGraph:graph,
 requirements:{classTypes:["Generate"]},ports,mediaUseCase:{channel:kind,primaryOutputKind:kind,promptPortId:"prompt",slots:[],primaryOutputPortId:"main"}});
const binding:NonNullable<CanvasNodeMetadata["comfyMediaPreset"]>={templateId:"t",templateRevision:"r",overrides:{bool:true},slots:{}};
const childrenOf=(element:unknown):unknown[]=>{
 if(Array.isArray(element))return element.flatMap(childrenOf);
 if(!element||typeof element!=="object"||!("props" in element))return [];
 const props=(element as ReactElement).props as {children?:unknown};
 return [element,...childrenOf(props.children)];
};
const propElements=(element:unknown,predicate:(props:Record<string,unknown>)=>boolean)=>childrenOf(element).filter(child=>{
 const props=(child as ReactElement).props as Record<string,unknown>;return predicate(props);
});

describe("ComfyMediaParameters component events",()=>{
 it("emits the effective preview ratio with parameter changes and reset in one patch",()=>{
  const t=template("image");t.mediaUseCase!.aspectSync={mode:"ratio",portId:"text"};
  t.apiGraph.n.inputs.text="1:1";
  const emitted=vi.fn();
  const root=ComfyMediaParameters({template:t,binding,config:{} as AiConfig,theme:canvasThemes.light,
   onChange:patch=>emitted(withComfyMediaAspect(t,patch))}) as ReactElement;
  const content=(root.type as (props:unknown)=>unknown)(root.props);
  const field=childrenOf(content).find(child=>(child as ReactElement).type===DirectPortControl&&
   ((child as ReactElement).props as {field:{port:{id:string}}}).field.port.id==="text") as ReactElement;
  const props=field.props as {onSet:(value:string)=>void;onReset:()=>void};
  props.onSet("9:16");expect(emitted).toHaveBeenLastCalledWith({comfyMediaPreset:{...binding,overrides:{bool:true,text:"9:16"}},comfyMediaPreviewRatio:"562500:1000000"});
  props.onReset();expect(emitted).toHaveBeenLastCalledWith({comfyMediaPreset:binding,comfyMediaPreviewRatio:"1000000:1000000"});
 });

 it("routes all media types to the same direct, ordered controls and excludes prompt/unbound/socket ports",()=>{
 for(const kind of ["image","video","audio"] as const){
  const emitted=vi.fn();const root=ComfyMediaParameters({template:template(kind),binding,config:{} as AiConfig,theme:canvasThemes.light,onChange:emitted}) as ReactElement;
  expect((root.props as Record<string,unknown>).panelWidth).toBe(300);
  const content=(root.type as (props:unknown)=>unknown)(root.props);
  const controls=childrenOf(content).filter(child=>(child as ReactElement).type===DirectPortControl);
  expect(controls.map(child=>((child as ReactElement).props as {field:{port:{id:string}}}).field.port.id)).toEqual(["enum","bool","text"]);
 }
 });
 it("renders a compact titled header with count and a disabled full reset when untouched",()=>{
  const untouched={...binding,overrides:{}};
  const root=ComfyMediaParameters({template:template("image"),binding:untouched,config:{} as AiConfig,theme:canvasThemes.light,onChange:vi.fn()}) as ReactElement;
  const content=(root.type as (props:unknown)=>unknown)(root.props);
  const wrapper=childrenOf(content).find(element=>((element as ReactElement).props as Record<string,unknown>)["data-comfy-media-native-settings"]!==undefined) as ReactElement;
  const reset=propElements(wrapper,props=>props.children==="恢复默认"&&props.disabled===true)[0] as ReactElement;
  expect((reset.props as Record<string,unknown>).disabled).toBe(true);
  const firstControl=childrenOf(wrapper).find(element=>(element as ReactElement).type===DirectPortControl) as ReactElement;
  const card=(firstControl.type as (props:unknown)=>unknown)(firstControl.props);
  expect((card as ReactElement).props).toMatchObject({className:"min-w-0 space-y-1.5","data-comfy-media-port":"enum"});
 });
 it("calls the real control callbacks for enum, boolean, text, and reset actions",()=>{
 const emitted=vi.fn();const root=ComfyMediaParameters({template:template("image"),binding,config:{} as AiConfig,theme:canvasThemes.light,onChange:emitted}) as ReactElement;
 const content=(root.type as (props:unknown)=>unknown)(root.props);
 const controls=childrenOf(content).filter(child=>(child as ReactElement).type===DirectPortControl) as ReactElement[];
 const invoke=(element:ReactElement)=> (element.type as (props:unknown)=>unknown)(element.props);
 const enumElement=controls[0],enumControl=invoke(enumElement);
 const select=propElements(enumControl,props=>Array.isArray(props.options))[0] as ReactElement;
 expect((select.props as Record<string,unknown>).getPopupContainer).toBeTypeOf("function");
 expect((select.props as Record<string,unknown>).classNames).toEqual({popup:{root:"comfy-media-parameter-select-popup"}});
 expect((select.props as Record<string,unknown>).styles).toMatchObject({popup:{root:{zIndex:1301,background:canvasThemes.light.toolbar.panel}}});
 ((select.props as Record<string,unknown>).onChange as (value:string)=>void)("1");
 expect(emitted).toHaveBeenLastCalledWith({comfyMediaPreset:{...binding,overrides:{bool:true,enum:1.5}}});
 const boolElement=controls[1],boolControl=invoke(boolElement);
 const switchElement=propElements(boolControl,props=>typeof props.checked==="boolean"&&typeof props.onChange==="function")[0] as ReactElement;
 ((switchElement.props as Record<string,unknown>).onChange as (value:boolean)=>void)(false);
 expect(emitted).toHaveBeenLastCalledWith({comfyMediaPreset:{...binding,overrides:{bool:false}}});
 const textElement=controls[2],textControl=invoke(textElement);
 const input=propElements(textControl,props=>typeof props.value==="string"&&typeof props.onChange==="function")[0] as ReactElement;
 ((input.props as Record<string,unknown>).onChange as (event:{target:{value:string}})=>void)({target:{value:""}});
 expect(emitted).toHaveBeenLastCalledWith({comfyMediaPreset:{...binding,overrides:{bool:true,text:""}}});
 const reset=propElements(boolControl,props=>typeof props.onClick==="function"&&props.title==="恢复默认")[0] as ReactElement;
 ((reset.props as Record<string,unknown>).onClick as ()=>void)();
 expect(emitted).toHaveBeenLastCalledWith({comfyMediaPreset:{...binding,overrides:{}}});
 });
});
