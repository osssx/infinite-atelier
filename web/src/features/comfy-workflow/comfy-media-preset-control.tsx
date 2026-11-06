import {useCallback,useEffect,useMemo,useState,type ReactNode} from "react";
import {Select} from "antd";
import type {CanvasConnection,CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {listComfyPresetCatalog,loadComfyPresetCatalogTemplates,type ComfyCatalogLoadFailure,type ComfyCatalogPreset} from "./preset-catalog";
import {getComfyTemplate} from "./template-registry";
import type {ComfyMediaUseCase,ComfyWorkflowTemplate} from "./template-schema";
import {ComfyMediaParameters} from "./comfy-media-parameters";
import type {AiConfig} from "@/stores/use-config-store";
import type {CanvasTheme} from "@/lib/canvas-theme";

type Props={node:CanvasNodeData;nodes:readonly CanvasNodeData[];connections:readonly CanvasConnection[];config:AiConfig;theme:CanvasTheme;
 onChange:(patch:Partial<CanvasNodeMetadata>)=>void;
 onPickerOptionsChange?:(options:{value:string;label:string}[],select:(value:string)=>void,activeValue?:string)=>void};
const family=(kind:string)=>kind==="image"?"image":kind==="video"?"video":"audio";
function hasMedia(node:CanvasNodeData,kind:string){
 const m=node.metadata;
 if(kind==="image")return node.type==="image"&&Boolean(m?.storageKey||m?.content||m?.images?.length);
 if(kind==="video")return node.type==="video"&&Boolean(m?.storageKey||m?.content);
 return node.type==="audio"&&Boolean(m?.storageKey||m?.content);
}
export function useComfyMediaPresetControl({node,nodes,connections,config,theme,onChange,onPickerOptionsChange}:Props):{settings:ReactNode;slots:ReactNode;error?:string}{
 const [catalog,setCatalog]=useState<ComfyCatalogPreset[]>([]);
 const [templates,setTemplates]=useState<Record<string,ComfyWorkflowTemplate>>({});
 const [catalogFailures,setCatalogFailures]=useState<ComfyCatalogLoadFailure[]>([]);
 const [catalogError,setCatalogError]=useState<string>();
 const [boundPresetError,setBoundPresetError]=useState<string>();
 useEffect(()=>{let current=true;void listComfyPresetCatalog().then(async items=>{
  const loaded=await loadComfyPresetCatalogTemplates(items,item=>getComfyTemplate(item.templateId,item.revision));
  if(!current)return;
  setCatalog(items);setTemplates(Object.fromEntries(Object.entries(loaded.templates).filter(([,template])=>template.mediaUseCase)));
  setCatalogFailures(loaded.failures);setCatalogError(undefined);
 }).catch(error=>{if(current){setCatalog([]);setTemplates({});setCatalogError(error instanceof Error?error.message:String(error));}});return()=>{current=false};},[]);
 const preset=node.metadata?.comfyMediaPreset;
 useEffect(()=>{if(!preset)return;const key=preset.templateId+"@"+preset.templateRevision;if(templates[key])return;
  let active=true;void getComfyTemplate(preset.templateId,preset.templateRevision).then(template=>{
  if(active&&template?.mediaUseCase)setTemplates(current=>({...current,[key]:template}));
  if(active)setBoundPresetError(undefined);
 }).catch(error=>{if(active)setBoundPresetError(error instanceof Error?error.message:String(error));});return()=>{active=false};},[preset?.templateId,preset?.templateRevision,templates]);
 const template=preset?templates[preset.templateId+"@"+preset.templateRevision]:undefined;
 const useCase=template?.mediaUseCase;
 const options=useMemo(()=>catalog.map(item=>{
  const t=templates[item.templateId+"@"+item.revision];
  return t?.mediaUseCase?{label:item.name,value:item.templateId+"@"+item.revision,group:family(t.mediaUseCase.primaryOutputKind)}:null;
 }).filter((x):x is {label:string;value:string;group:string}=>!!x&&x.group===family(node.type)),[catalog,templates,node.type]);
 const selectPreset=useCallback(async(value:string)=>{
  if(!value){onChange({comfyMediaPreset:undefined});return;}
  const [templateId,revision]=value.split("@");
  const row=catalog.find(item=>item.templateId===templateId&&item.revision===revision);
  const found=templates[value]??(row?await getComfyTemplate(templateId,revision):null);
  if(!found?.mediaUseCase)return;
  const prior=node.metadata?.comfyMediaPreset;
  const cache={...(node.metadata?.comfyMediaPresetCache??{})};
  if(prior)cache[prior.templateId+"@"+prior.templateRevision]=prior;
  const restored=cache[value];
  onChange({comfyMediaPresetCache:cache,comfyMediaPreset:restored??{templateId,templateRevision:revision,
   instanceId:prior?.instanceId,overrides:{},slots:{}}});
 },[catalog,node.metadata?.comfyMediaPreset,node.metadata?.comfyMediaPresetCache,onChange,templates]);
 const pickerOptions=useMemo(()=>[
  ...options.map(({label,value})=>({label,value})),
  ...(preset&&template&&!options.some(option=>option.value===preset.templateId+"@"+preset.templateRevision)?
   [{label:template.name,value:preset.templateId+"@"+preset.templateRevision}]:[])
 ],[options,preset,template]);
 useEffect(()=>{onPickerOptionsChange?.(pickerOptions,selectPreset,preset?preset.templateId+"@"+preset.templateRevision:undefined);},
  [onPickerOptionsChange,pickerOptions,selectPreset,preset?.templateId,preset?.templateRevision]);
 const incoming=new Set(connections.filter(edge=>edge.toNodeId===node.id).map(edge=>edge.fromNodeId));
 const candidates=(slot:ComfyMediaUseCase["slots"][number])=>nodes.filter(source=>
  hasMedia(source,slot.valueKind.toLowerCase())).sort((a,b)=>Number(incoming.has(b.id))-Number(incoming.has(a.id))||a.title.localeCompare(b.title));
 const assign=(slotId:string,ref:NonNullable<CanvasNodeMetadata["comfyMediaPreset"]>["slots"][string]|undefined)=>{
  if(!preset)return;const slots={...preset.slots};if(ref)slots[slotId]=ref;else delete slots[slotId];onChange({comfyMediaPreset:{...preset,slots}});
 };
 const grouped=(kind:string)=>options.filter(option=>option.group===kind).map(({label,value})=>({label,value}));
 const slots=useCase?.slots.length?<div className="mt-2 min-w-0 max-w-[300px] space-y-1">{useCase.slots.map(slot=>{
   const assets=candidates(slot);const value=preset?.slots[slot.id];
   const selected=value?value.nodeId+"#"+(value.imageId??""):undefined;
   const choices=assets.flatMap(source=>{
    const images=source.type==="image"&&source.metadata?.images?.length?source.metadata.images:null;
    if(images?.length)return images.map(image=>({label:`${incoming.has(source.id)?"↑ ":""}${source.title} · 单张 ${image.id.slice(0,8)}`,value:source.id+"#"+image.id}));
    return [{label:`${incoming.has(source.id)?"↑ ":""}${source.title} · 单张`,value:source.id+"#"}];
   });
   return <label key={slot.id} className="block"><Select className="w-full" allowClear placeholder={slot.label+(slot.required?"（必填）":"（可选）")}
    value={selected} options={choices} onChange={(v:string|undefined)=>{if(!v){assign(slot.id,undefined);return;}const [nodeId,imageId]=v.split("#");assign(slot.id,{nodeId,...(imageId?{imageId}:{})});}}/></label>;
  })}</div>:null;
 const settings=template?.mediaUseCase&&preset?<ComfyMediaParameters template={template} binding={preset} config={config} theme={theme} onChange={onChange}/>:null;
 const error=catalogError?`工作流预设目录加载失败：${catalogError}`:
  catalogFailures.length?`以下预设版本无法加载，请在工作流设置中重新导入：${catalogFailures.map(failure=>`${failure.name} (${failure.presetId}): ${failure.message}`).join("；")}`:
  boundPresetError?`当前绑定的工作流版本无法加载，请重新导入该版本：${boundPresetError}`:undefined;
 return {settings,slots,error};
}
