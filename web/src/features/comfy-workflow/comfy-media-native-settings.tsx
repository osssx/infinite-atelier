import {useMemo} from "react";
import {defaultConfig,type AiConfig} from "@/stores/use-config-store";
import type {CanvasNodeMetadata} from "@/types/canvas";
import {CanvasImageSettingsPopover} from "@/components/canvas/canvas-image-settings-popover";
import {CanvasVideoSettingsPopover} from "@/components/canvas/canvas-video-settings-popover";
import {CanvasAudioSettingsPopover,type CanvasAudioSettingKey} from "@/components/canvas/canvas-audio-settings-popover";
import {imageDimensionPresets} from "@/components/image-dimension-presets";
import type {ComfyTemplatePayload,ComfyTemplatePort} from "./template-schema";
import {ComfyMediaSettingsControl} from "./comfy-media-settings-control";

type Binding=NonNullable<CanvasNodeMetadata["comfyMediaPreset"]>;
const settingKey:Record<string,string>={imageQuality:"quality",imageWidth:"size",imageHeight:"size",imageCount:"count",imageBackground:"background",
 videoResolution:"vquality",videoSize:"size",videoRatio:"videoRatio",videoDuration:"videoSeconds",videoGenerateAudio:"videoGenerateAudio",videoWatermark:"videoWatermark",videoReturnLastFrame:"videoReturnLastFrame",
 audioVoice:"audioVoice",audioFormat:"audioFormat",audioSpeed:"audioSpeed",audioInstructions:"audioInstructions"};
const idList=(mapping:unknown):string[]=>typeof mapping==="string"?[mapping]:Array.isArray(mapping)?mapping:
 mapping&&typeof mapping==="object"&&"ports" in mapping&&Array.isArray(mapping.ports)?mapping.ports as string[]:[];
const asTyped=(port:ComfyTemplatePort,value:unknown):string|number|boolean=>{
 if(port.valueKind==="BOOLEAN")return value===true||value==="true";
 if(port.valueKind==="INT"){const n=Number(value);if(!Number.isSafeInteger(n))throw Error("invalid_integer");return n;}
 if(port.valueKind==="FLOAT"){const n=Number(value);if(!Number.isFinite(n))throw Error("invalid_float");return n;}
 return String(value??"");
};
type NativeEntry={key:string;field:string;ids:string[]};
function nativeEntries(template:ComfyTemplatePayload):NativeEntry[]{
 const useCase=template.mediaUseCase!;const ports=new Map(template.ports.map(port=>[port.id,port]));
 const entries=Object.entries(useCase.settings??{}).map(([key,mapping])=>({key,field:settingKey[key],ids:idList(mapping)})).filter(x=>!!x.field&&x.ids.some(id=>ports.has(id)));
 const width=entries.find(x=>x.key==="imageWidth"),height=entries.find(x=>x.key==="imageHeight");
 if(width&&height){width.ids=[...width.ids,...height.ids];return entries.filter(x=>x!==height);}
 return entries;
}
export function comfyMediaNativeMappedOptions(template:ComfyTemplatePayload):Record<string,Array<{label:string;value:string}>>{
 const useCase=template.mediaUseCase!;const ports=new Map(template.ports.map(port=>[port.id,port]));
 return Object.fromEntries(nativeEntries(template).flatMap(entry=>{
  const mapping=(useCase.settings as Record<string,unknown>)[entry.key] as any;
  const values=mapping&&typeof mapping==="object"&&!Array.isArray(mapping)?mapping.values as Array<{label:string;value:string|number|boolean}>|undefined:undefined;
  let choices=values?.map(item=>({label:item.label,value:String(item.value) }))??(entry.ids.length===1?ports.get(entry.ids[0])?.choices?.map(item=>({label:item.label,value:String(item.value)})):undefined);
  if(!choices?.length&&entry.key==="imageWidth"&&entry.ids.length===2&&entry.ids.every(id=>ports.get(id)?.valueKind==="INT"))
   choices=imageDimensionPresets.map(item=>({label:item.label,value:item.value}));
  const panelKey:Record<string,string>={vquality:"resolution",videoSeconds:"duration"};
  return choices?.length?[[panelKey[entry.field]??entry.field,choices]]:[];
 }));
}
export function resolveComfyMediaNativeConfig(template:ComfyTemplatePayload,binding:Binding):Record<string,unknown>{
 const config:Record<string,unknown>={...defaultConfig};const ports=new Map(template.ports.map(port=>[port.id,port]));
 const portValue=(id:string)=>{if(Object.hasOwn(binding.overrides,id))return binding.overrides[id];const port=ports.get(id);
  if(port&&Object.hasOwn(port,"defaultValue"))return port.defaultValue;const target=port?.inputBinding?.targets[0];return target?template.apiGraph[target.nodeId]?.inputs[target.inputName]:undefined;};
 for(const entry of nativeEntries(template)){const values=entry.ids.map(portValue);const mapping=(template.mediaUseCase!.settings as Record<string,unknown>)[entry.key] as any;
  const choices=mapping&&typeof mapping==="object"&&!Array.isArray(mapping)?mapping.values as Array<{value:string|number|boolean;portValues?:Record<string,string|number|boolean>}>|undefined:undefined;
  const match=choices?.find(item=>entry.ids.every((id,index)=>Object.is(values[index],item.portValues?.[id]??(entry.ids.length===1?item.value:undefined))));
  const value=match?.value??(values.length===2&&values.every(v=>v!==undefined)?`${values[0]}x${values[1]}`:values[0]);
  if(value!==undefined)config[entry.field]=String(value);
 }
 return config;
}
export function mapComfyMediaNativeSetting(template:ComfyTemplatePayload,binding:Binding,field:string,value:string):Partial<CanvasNodeMetadata>{
 const entry=nativeEntries(template).find(x=>x.field===field);if(!entry)return {};
 const mapping=(template.mediaUseCase!.settings as Record<string,unknown>)[entry.key] as any;
 const explicit=mapping&&typeof mapping==="object"&&!Array.isArray(mapping)?mapping.values as Array<{value:string|number|boolean;portValues?:Record<string,string|number|boolean>}>|undefined:undefined;
 const selected=explicit?.find(item=>String(item.value)===String(value));const ports=new Map(template.ports.map(port=>[port.id,port]));
 const updates:Record<string,string|number|boolean>={};
 if(selected?.portValues){for(const [id,v] of Object.entries(selected.portValues))if(entry.ids.includes(id))updates[id]=v;}
 else if(entry.ids.length===2){if(value==="auto"){
   const overrides={...binding.overrides};for(const id of entry.ids)delete overrides[id];
   return {comfyMediaPreset:{...binding,overrides}};
  }
  const match=value.match(/^(\d+)\s*[x×]\s*(\d+)$/i);if(!match)return {};
  updates[entry.ids[0]]=asTyped(ports.get(entry.ids[0])!,match[1]);updates[entry.ids[1]]=asTyped(ports.get(entry.ids[1])!,match[2]);
 }else if(entry.ids.length===1){updates[entry.ids[0]]=asTyped(ports.get(entry.ids[0])!,selected?.value??value);}else return {};
 return {comfyMediaPreset:{...binding,overrides:{...binding.overrides,...updates}}};
}
export function ComfyMediaNativeSettings({template,binding,onChange}:{template:ComfyTemplatePayload;binding:Binding;onChange:(patch:Partial<CanvasNodeMetadata>)=>void}){
 const useCase=template.mediaUseCase!;
 const ports=new Map(template.ports.map(port=>[port.id,port]));
 const visible=useMemo(()=>nativeEntries(template),[template]);
 const config=resolveComfyMediaNativeConfig(template,binding);
 const write=(field:string,value:string)=>{
  onChange(mapComfyMediaNativeSetting(template,binding,field,value));
 };
 const available=(field:string)=>visible.some(x=>x.field===field);
 const imageKeys=(['quality','size','count','background'] as const).filter(available);
 const videoKeys=(['resolution','size','duration','ratio','generateAudio','watermark','lastFrame'] as const).filter(key=>{
  const field:Record<string,string>={resolution:'vquality',size:'size',duration:'videoSeconds',ratio:'videoRatio',generateAudio:'videoGenerateAudio',watermark:'videoWatermark',lastFrame:'videoReturnLastFrame'};return available(field[key]);
 });
 const audioKeys=(['audioVoice','audioFormat','audioSpeed','audioInstructions'] as const).filter(available) as CanvasAudioSettingKey[];
 const mappedOptions=comfyMediaNativeMappedOptions(template);
 const onImage=(key:string,value:string)=>write(key,value);
 const onVideo=(key:string,value:string)=>write(key,value);
 const onAudio=(key:CanvasAudioSettingKey,value:string)=>write(key,value);
 const clearSettings=()=>{onChange({comfyMediaPreset:{...binding,overrides:{}}});};
 const advanced=<div className="mt-2 space-y-2"><button type="button" className="rounded border border-stone-300 px-2 py-1 text-xs dark:border-stone-700" onClick={clearSettings}>恢复预设默认参数</button>
  <ComfyMediaSettingsControl template={template} binding={binding} onChange={onChange} showCommon={false}/></div>;
 const buttonClassName="!h-10 !max-w-[170px] !min-w-0 !justify-start !rounded-full !px-3";
 const buttonLabel=visible.length?visible.map(entry=>{
  const value=String(config[entry.field]??"");const mapping=(useCase.settings as Record<string,unknown>)[entry.key] as any;
  const choices=mapping&&typeof mapping==="object"&&!Array.isArray(mapping)?mapping.values as Array<{label:string;value:string|number|boolean}>|undefined:undefined;
  return choices?.find(option=>String(option.value)===value)?.label??value;
 }).filter(Boolean).join(" · "):"工作流参数";
 return <div className="flex min-w-0 items-center gap-1" data-comfy-media-native-settings>
  {useCase.primaryOutputKind==="image"?<CanvasImageSettingsPopover config={config as AiConfig} visibleKeys={imageKeys} mappedOptions={mappedOptions as import("@/components/image-settings-panel").ImageSettingsPanelMappedOptions} extraContent={advanced} buttonLabel={buttonLabel} buttonClassName={buttonClassName} onConfigChange={onImage}/>:null}
  {useCase.primaryOutputKind==="video"?<CanvasVideoSettingsPopover config={config as AiConfig} visibleKeys={videoKeys} mappedOptions={mappedOptions as import("@/components/video-settings-panel").VideoSettingsPanelMappedOptions} extraContent={advanced} buttonLabel={buttonLabel} buttonClassName={buttonClassName} onConfigChange={onVideo}/>:null}
  {useCase.primaryOutputKind==="audio"?<CanvasAudioSettingsPopover config={config as AiConfig} visibleKeys={audioKeys} mappedOptions={mappedOptions as import("@/components/audio-settings-panel").AudioSettingsMappedOptions} extraContent={advanced} buttonLabel={buttonLabel} buttonClassName={buttonClassName} onConfigChange={onAudio}/>:null}
 </div>;
}
