import {useEffect,useRef,useState,type CSSProperties} from "react";
import {getComfyTemplate} from "@/features/comfy-workflow/template-registry";
import {listComfyPresets} from "@/features/comfy-workflow/preset-registry";
import {resolveMediaCapabilities} from "@/services/media-capabilities";
import {encodeChannelModel,type AiConfig} from "@/stores/use-config-store";
import type {CanvasTheme} from "@/lib/canvas-theme";
import type {DramaShotProduction,DramaVideoTarget} from "./drama-pipeline-media";
import type {DramaProductionCapabilities} from "./drama-production-audit";
import type {MediaParameterSpec} from "@/services/media-capabilities";

const targetKey=(target?:DramaVideoTarget)=>JSON.stringify(target??{kind:"inherit"});
const labels:Record<string,string>={adaptive:"自适应",auto:"自动"};
const display=(value:string|number)=>labels[String(value)]??String(value);
export function DramaVideoTargetPicker({config,value,onChange,theme,disabled}:{config:AiConfig;value:DramaShotProduction;
 onChange:(value:DramaShotProduction)=>void;theme:CanvasTheme;disabled:boolean}){
 const [workflows,setWorkflows]=useState<{target:DramaVideoTarget;label:string;disabled?:boolean}[]>([]);
 const [loading,setLoading]=useState(true),[error,setError]=useState(""),[reload,setReload]=useState(0),[failures,setFailures]=useState(0);
 // Keep the originally bound version visible even if its preset has since moved.
 const originalTarget=useRef(value.target);
 const defaultId=config.comfyWorkflowDefaults?.video?.templateId,defaultRevision=config.comfyWorkflowDefaults?.video?.templateRevision;
 useEffect(()=>{
  let live=true;setLoading(true);setError("");setFailures(0);
  void (async()=>{
   let presets:Awaited<ReturnType<typeof listComfyPresets>>=[];
   let catalogFailed=false;
   try{presets=await listComfyPresets();}catch{catalogFailed=true;}
   const entries=new Map<string,{templateId:string;revision:string;name?:string}>();
   for(const preset of presets){
    const key=preset.templateId+"@"+preset.revision;
    if(!entries.has(key))entries.set(key,preset);
   }
   const original=originalTarget.current;
   const pinned=[...(defaultId&&defaultRevision?[{templateId:defaultId,revision:defaultRevision}]:[]),
    ...(original?.kind==="comfy"?[{templateId:original.templateId,revision:original.templateRevision}]:[])];
   for(const item of pinned){const key=item.templateId+"@"+item.revision;if(!entries.has(key))entries.set(key,item);}
   const results=await Promise.all([...entries.values()].map(async item=>{
    try{
     const template=await getComfyTemplate(item.templateId,item.revision);
     if(!template)return {failed:true};
     if(template.mediaUseCase?.channel!=="video")return {};
     const resolved=resolveMediaCapabilities({mediaCapabilities:template.mediaUseCase.mediaCapabilities},{kind:"video"});
     const available=resolved.explicit&&!resolved.unavailable.length&&resolved.modes.some(mode=>
      ["text_to_video","first_frame","first_last_frame","omni_reference"].includes(mode.id)&&!!template.mediaUseCase?.modeBindings?.[mode.id as keyof typeof template.mediaUseCase.modeBindings]);
     return {option:{target:{kind:"comfy",templateId:template.id,templateRevision:template.revision} as DramaVideoTarget,
      label:(item.name??template.name)+(available?"":"（未声明可用视频模式）"),disabled:!available}};
    }catch{return {failed:true};}
   }));
   if(!live)return;
   setWorkflows(results.flatMap(result=>result.option?[result.option]:[]));
   setFailures(results.filter(result=>result.failed).length);
   if(catalogFailed)setError("无法读取工作流预设目录，请重试。");
  })().finally(()=>{if(live)setLoading(false);});
  return ()=>{live=false;};
 },[reload,defaultId,defaultRevision]);
 const options=[{target:{kind:"inherit"} as DramaVideoTarget,label:"跟随全局默认"}];
 const online=(config.channels??[]).flatMap(channel=>channel.models.filter(model=>model.capability==="video").map(model=>({
  target:{kind:"online",modelOption:encodeChannelModel(channel.id,model.name)} as DramaVideoTarget,label:model.name+" · "+channel.name
 })));
 const comfy=workflows;
 const all=[...options,...online,...comfy],current=targetKey(value.target);
 const unknown=!all.some(item=>targetKey(item.target)===current);
 const style={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke} as CSSProperties;
 return <div className="grid min-w-0 gap-1.5 text-xs">
  <label className="grid gap-1.5" style={{color:theme.node.muted}}>视频渠道 / 模型 / 工作流
   <select aria-label="视频渠道" className="w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm" style={style}
    disabled={disabled} value={current} onChange={event=>{
     const selected=all.find(item=>targetKey(item.target)===event.target.value);
     if(selected&&!("disabled" in selected&&selected.disabled))onChange({...value,target:selected.target});
    }}>
    {unknown&&<option value={current} disabled>{loading?"正在读取已选渠道…":value.target?.kind==="online"?"已选在线模型不可用":"已选工作流不可用"}</option>}
    {options.map(item=><option key={targetKey(item.target)} value={targetKey(item.target)}>{item.label}</option>)}
    {!!comfy.length&&<optgroup label="本地 ComfyUI">{comfy.map(item=><option key={targetKey(item.target)} value={targetKey(item.target)} disabled={item.disabled}>{item.label}</option>)}</optgroup>}
    {!!online.length&&<optgroup label="在线视频模型">{online.map(item=><option key={targetKey(item.target)} value={targetKey(item.target)}>{item.label}</option>)}</optgroup>}
   </select>
  </label>
  {loading&&<span style={{color:theme.node.muted}}>正在读取本地视频工作流…</span>}
  {(error||failures>0)&&<div className="flex flex-wrap items-center gap-2" style={{color:theme.node.muted}}>{error||"部分工作流版本无法读取或校验，其他可用工作流仍可选择。"}<button type="button" disabled={disabled||loading} onClick={()=>setReload(n=>n+1)} className="underline">重试</button></div>}
  {!loading&&!error&&!comfy.some(item=>!item.disabled)&&!online.length&&<span style={{color:theme.node.muted}}>暂无可选的视频模型或工作流，请先在设置中配置。</span>}
 </div>;
}
export function DramaVideoParameterFields({config,value,capabilities,shotDuration,theme,disabled,editing,onChange}:{config:AiConfig;
 value:DramaShotProduction;capabilities:DramaProductionCapabilities|null;shotDuration?:number;theme:CanvasTheme;
 disabled:boolean;editing:boolean;onChange?:(value:DramaShotProduction)=>void}){
 const specs=capabilities?.modes.find(item=>item.mode===(value.gridInput?"grid":value.mode))?.parameters??[];
 const style={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 const field="w-full min-w-0 rounded-lg border px-3 py-2 text-sm";
 const duration=value.durationSec??shotDuration??(Number(config.videoSeconds)||6);
 const ratio=value.aspectRatio??config.videoRatio;
 const inheritedRatio=config.videoRatio;
 const params=[{id:"duration_seconds",key:"durationSec" as const,label:"时长（秒）",current:duration},
  {id:"aspect_ratio",key:"aspectRatio" as const,label:"画幅",current:ratio}];
 const write=(key:"durationSec"|"aspectRatio",raw:string)=>{
  if(!onChange)return;
  const next={...value};if(!raw)delete next[key];
  else if(key==="durationSec")next.durationSec=Number(raw);
  else next.aspectRatio=raw;
  onChange(next);
 };
 return <div className="grid min-w-0 gap-2 sm:grid-cols-2">
  {params.map(({id,key,label,current})=>{
   const spec:MediaParameterSpec|undefined=specs.find(item=>item.id===id);
   const adjustable=spec?.mode==="adjustable"&&(key==="durationSec"&&spec.type==="number"||key==="aspectRatio"&&spec.type==="enum");
   const selected=value[key];
   const shown=current;
   const fixedMismatch=spec?.mode==="fixed"&&spec.fixedValue!==undefined&&spec.fixedValue!==current;
   return <div key={id} className="grid min-w-0 content-start gap-1 text-xs">
    <label style={{color:theme.node.muted}}>{label}</label>
    {editing&&adjustable?key==="durationSec"?<input aria-label="视频时长" type="number" min={spec?.min??0.1} max={spec?.max} step={spec?.step??"any"}
     placeholder={String(shotDuration??(Number(config.videoSeconds)||6))} value={selected??""} disabled={disabled} className={field} style={style} onChange={event=>write(key,event.target.value)}/>:
     <select aria-label="视频画幅" value={selected??""} disabled={disabled} className={field} style={style} onChange={event=>write(key,event.target.value)}>
      <option value="">继承默认（{display(inheritedRatio)}）</option>
      {selected!==undefined&&!spec?.values?.includes(selected)&&<option value={selected} disabled>{display(selected)}（不支持）</option>}
      {spec?.values?.map(option=><option key={option} value={option}>{display(option)}</option>)}
     </select>:<div className="rounded-md px-3 py-2 text-sm" style={{background:theme.toolbar.activeBg}}>{display(String(shown))}</div>}
    {editing&&<div className="flex flex-wrap gap-2" style={{color:theme.node.muted}}>
     <span>{spec?.mode==="fixed"?"由模型固定":adjustable?"留空继承原设置":"未声明可编辑参数"}</span>
     {fixedMismatch&&<button type="button" disabled={disabled} onClick={()=>write(key,String(spec.fixedValue))} className="underline">采用固定值 {display(String(spec.fixedValue))}</button>}
     {selected!==undefined&&!adjustable&&<button type="button" disabled={disabled} onClick={()=>write(key,"")} className="underline">清除覆盖</button>}
    </div>}
   </div>;
  })}
 </div>;
}
export function dramaVideoTargetLabel(config:AiConfig,value:DramaShotProduction,capabilities:DramaProductionCapabilities|null){
 const inherited=!value.target||value.target.kind==="inherit";
 return (inherited?"跟随全局默认 · ":"")+(capabilities?[capabilities.channel,capabilities.model].filter(Boolean).join(" · "):
  "正在检查渠道");
}
