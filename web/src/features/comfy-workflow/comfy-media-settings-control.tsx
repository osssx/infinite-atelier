import {useEffect,useRef,useState} from "react";
import {Select} from "antd";
import {parseComfyScalarOverride} from "./instance-parameters";
import type {CanvasNodeMetadata} from "@/types/canvas";
import type {ComfyMediaUseCase,ComfyTemplatePayload,ComfyTemplatePort} from "./template-schema";

type Binding=NonNullable<CanvasNodeMetadata["comfyMediaPreset"]>;
type MappedChoice={label:string;value:string|number|boolean;portValues?:Record<string,string|number|boolean>};
const labels:Record<string,string>={imageQuality:"质量",imageWidth:"宽度 / 尺寸",imageHeight:"高度",imageCount:"数量",imageBackground:"背景",
 videoResolution:"分辨率 / 尺寸",videoRatio:"画面比例",videoDuration:"时长",videoGenerateAudio:"生成音频",videoWatermark:"水印",videoReturnLastFrame:"返回尾帧",
 audioVoice:"音色",audioFormat:"格式",audioSpeed:"语速",audioInstructions:"生成指令"};
const defaults:Record<string,Array<{label:string;value:string|number|boolean}>>={
 imageQuality:["auto","low","medium","high"].map(value=>({label:value,value})),
 imageCount:Array.from({length:10},(_,i)=>({label:String(i+1),value:i+1})),
 imageBackground:["auto","opaque","transparent"].map(value=>({label:value,value})),
 videoResolution:["480p","720p","1080p"].map(value=>({label:value,value})),
 videoRatio:["adaptive","16:9","9:16","1:1","4:3","3:4","21:9"].map(value=>({label:value,value})),
 videoDuration:Array.from({length:17},(_,i)=>({label:String(i+4)+" 秒",value:i+4})),
 videoGenerateAudio:[{label:"开启",value:true},{label:"关闭",value:false}],
 videoWatermark:[{label:"开启",value:true},{label:"关闭",value:false}],
 videoReturnLastFrame:[{label:"开启",value:true},{label:"关闭",value:false}],
 audioFormat:["mp3","wav","flac"].map(value=>({label:value.toUpperCase(),value})),
 audioSpeed:[0.5,0.75,1,1.25,1.5,2].map(value=>({label:String(value),value})),
};
function targets(mapping:unknown):string[]{return typeof mapping==="string"?[mapping]:Array.isArray(mapping)?mapping:
 mapping&&typeof mapping==="object"&&"ports" in mapping&&Array.isArray(mapping.ports)?mapping.ports as string[]:[];}
function templateValue(template:ComfyTemplatePayload,port:ComfyTemplatePort){
 if(Object.hasOwn(port,"defaultValue"))return port.defaultValue;
 const first=port.inputBinding?.targets[0];return first?template.apiGraph[first.nodeId]?.inputs[first.inputName]:undefined;
}
function cast(port:ComfyTemplatePort,value:string):string|number|boolean{
 if(port.valueKind==="BOOLEAN")return value==="true";
 if(port.valueKind==="INT"){const parsed=Number(value);if(!Number.isSafeInteger(parsed))throw Error("invalid_integer");return parsed;}
 if(port.valueKind==="FLOAT"){const parsed=Number(value);if(!Number.isFinite(parsed))throw Error("invalid_float");return parsed;}
 return value;
}
export function patchComfyMediaOverrides(overrides:Record<string,unknown>,updates:Record<string,unknown>,clear:readonly string[]=[]){
 const next={...overrides};for(const id of clear)delete next[id];return Object.assign(next,updates);
}
export function ComfyMediaNumericInput({kind,value,onChange}:{kind:"INT"|"FLOAT";value:unknown;onChange:(value:string|number|boolean)=>void}){
 const text=value===undefined?"":String(value);
 const [draft,setDraft]=useState(text);
 const [error,setError]=useState("");
 const editing=useRef(false);
 useEffect(()=>{if(!editing.current)setDraft(text);},[text]);
 return <div><input type="text" inputMode={kind==="INT"?"numeric":"decimal"}
  className="w-full rounded border border-stone-300 bg-transparent px-2 py-1 text-xs dark:border-stone-700"
  value={draft} aria-invalid={!!error} onFocus={()=>{editing.current=true;}}
  onChange={e=>{
   const next=e.target.value;setDraft(next);setError("");
   const parsed=parseComfyScalarOverride(kind,next);
   if(parsed.ok)onChange(parsed.value);
  }}
  onBlur={()=>{
   editing.current=false;
   const parsed=parseComfyScalarOverride(kind,draft);
   if(parsed.ok){setDraft(String(parsed.value));setError("");}
   else {setDraft(text);setError(parsed.error);}
  }}
  onKeyDown={e=>{e.stopPropagation();if(e.key==="Enter")e.currentTarget.blur();}}/>
  {error?<p role="alert" className="mt-1 text-xs text-red-500">{error}</p>:null}
 </div>;
}
function GenericInput({port,value,onChange,options}:{port:ComfyTemplatePort;value:unknown;onChange:(v:string|number|boolean)=>void;options?:Array<{label:string;value:string|number|boolean}>}){
 const choices=options??port.choices;
 if(choices?.length)return <Select getPopupContainer={trigger=>trigger.parentElement!} className="w-full" value={value===undefined?undefined:String(value)} placeholder="使用工作流默认值" allowClear
  options={choices.map(option=>({label:option.label,value:String(option.value)}))} onChange={selected=>{if(selected===undefined)return;const option=choices.find(item=>String(item.value)===selected);if(option)onChange(option.value);}}/>;
 if(port.valueKind==="BOOLEAN")return <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={value===true} onChange={e=>onChange(e.target.checked)}/>{value===true?"开启":"关闭"}</label>;
 if(port.valueKind==="STRING")return /prompt|instruction|指令|提示/i.test(port.id+" "+port.label)?
  <textarea className="w-full rounded border border-stone-300 bg-transparent px-2 py-1 text-xs dark:border-stone-700" rows={2} value={String(value??"")} onChange={e=>onChange(e.target.value)}/>
  :<input className="w-full rounded border border-stone-300 bg-transparent px-2 py-1 text-xs dark:border-stone-700" value={String(value??"")} onChange={e=>onChange(e.target.value)}/>;
 return <ComfyMediaNumericInput kind={port.valueKind==="INT"?"INT":"FLOAT"} value={value} onChange={onChange}/>;
}
export function ComfyMediaSettingsControl({template,binding,onChange,showCommon=true}:{template:ComfyTemplatePayload;binding:Binding;onChange:(patch:Partial<CanvasNodeMetadata>)=>void;showCommon?:boolean}){
 const useCase=template.mediaUseCase!;
 const mapped=new Set(Object.values(useCase.settings??{}).flatMap(targets));
 const scalarPorts=template.ports.filter(port=>port.direction==="target"&&port.inputBinding?.mode==="literal"&&["STRING","INT","FLOAT","BOOLEAN"].includes(port.valueKind));
 const writeMany=(updates:Record<string,string|number|boolean>,clear:readonly string[]=[])=>onChange({comfyMediaPreset:{...binding,
  overrides:patchComfyMediaOverrides(binding.overrides,updates,clear)}});
 const write=(portId:string,value:string|number|boolean)=>writeMany({[portId]:value});
 const clear=(ids:readonly string[])=>writeMany({},ids);
 const value=(port:ComfyTemplatePort)=>Object.hasOwn(binding.overrides,port.id)?binding.overrides[port.id]:templateValue(template,port);
 const common=Object.entries(useCase.settings??{}).map(([key,mapping])=>{
  const ids=targets(mapping),ports=ids.map(id=>scalarPorts.find(port=>port.id===id)).filter((port):port is ComfyTemplatePort=>!!port);
  if(!ports.length)return null;
  const explicit=!Array.isArray(mapping)&&typeof mapping==="object"?mapping.values as MappedChoice[]|undefined:undefined;
  const commonValues:MappedChoice[]|undefined=explicit?.length?explicit:(ports.length===1?ports[0].choices?.map(choice=>({label:choice.label,value:choice.value})):undefined);
  const selected=commonValues?.find(option=>ports.every(port=>Object.is(value(port),option.portValues?.[port.id]??option.value)));
  if(commonValues?.length)return <label key={key} className="block text-xs">{labels[key]??key}
   <Select getPopupContainer={trigger=>trigger.parentElement!} className="mt-1 w-full" value={selected?String(selected.value):undefined} placeholder="使用工作流默认值" allowClear
    options={commonValues.map(option=>({label:option.label,value:String(option.value)}))} onChange={selectedValue=>{
     if(selectedValue===undefined){clear(ids);return;}
     const option=commonValues.find(item=>String(item.value)===selectedValue);if(!option)return;
     if(ports.length===1)writeMany({[ports[0].id]:option.portValues?.[ports[0].id]??option.value});
     else {const dims=String(option.value).match(/^(\d+)\s*[x×:]\s*(\d+)$/i);if(dims){writeMany({[ports[0].id]:cast(ports[0],dims[1]),[ports[1].id]:cast(ports[1],dims[2])});}
      else {const updates:Record<string,string|number|boolean>={};ports.forEach(port=>{const mappedValue=option.portValues?.[port.id];if(mappedValue!==undefined)updates[port.id]=mappedValue;});writeMany(updates);}}
    }}/></label>;
  if(ports.length===2){const w=value(ports[0]),h=value(ports[1]);return <label key={key} className="block text-xs">{labels[key]??key}
   <input className="mt-1 w-full rounded border border-stone-300 bg-transparent px-2 py-1 text-xs dark:border-stone-700" placeholder="宽 × 高" value={w!==undefined&&h!==undefined?`${w}x${h}`:""}
     onChange={e=>{const match=e.target.value.match(/^(\d+)\s*[x×:]\s*(\d+)$/i);if(match){try{writeMany({[ports[0].id]:cast(ports[0],match[1]),[ports[1].id]:cast(ports[1],match[2])});}catch{/* invalid dimensions are not saved */}}else if(e.target.value==="")clear(ids);}}/></label>;}
  const port=ports[0],generic=defaults[key];return <label key={key} className="block text-xs">{labels[key]??key}
   <div className="mt-1"><GenericInput port={port} value={value(port)} options={generic?.length?generic:undefined} onChange={next=>write(port.id,next)}/></div></label>;
 });
 const advanced=scalarPorts.filter(port=>!mapped.has(port.id)&&port.id!==useCase.promptPortId);
 return <div className="mt-1 w-full max-w-[270px] space-y-2" data-comfy-media-settings>
  {showCommon?common:null}
  {advanced.length?<details className="text-xs"><summary className="cursor-pointer opacity-60">其他工作流参数</summary><div className="mt-2 space-y-2">{advanced.map(port=><label key={port.id} className="block">{port.label}<div className="mt-1"><GenericInput port={port} value={value(port)} onChange={next=>write(port.id,next)}/></div></label>)}</div></details>:null}
 </div>;
}
