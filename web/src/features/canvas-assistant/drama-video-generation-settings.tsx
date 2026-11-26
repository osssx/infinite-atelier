import {useEffect,useState,type CSSProperties} from "react";
import {listComfyTemplates} from "@/features/comfy-workflow/template-registry";
import type {ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";
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
 const [templates,setTemplates]=useState<ComfyWorkflowTemplate[]>([]);
 const [loading,setLoading]=useState(true),[error,setError]=useState(""),[reload,setReload]=useState(0);
 useEffect(()=>{
  let live=true;setLoading(true);setError("");
  void Promise.resolve().then(()=>listComfyTemplates()).then(items=>{
   if(live)setTemplates(items.filter(item=>item.mediaUseCase?.channel==="video"));
  }).catch(()=>{if(live)setError("无法读取视频工作流，请重试。");}).finally(()=>{if(live)setLoading(false);});
  return ()=>{live=false;};
 },[reload]);
 const options=[{target:{kind:"inherit"} as DramaVideoTarget,label:"跟随全局默认"}];
 const online=(config.channels??[]).flatMap(channel=>channel.models.filter(model=>model.capability==="video").map(model=>({
  target:{kind:"online",modelOption:encodeChannelModel(channel.id,model.name)} as DramaVideoTarget,label:model.name+" · "+channel.name
 })));
 const comfy=templates.map((template,index)=>({
  target:{kind:"comfy",templateId:template.id,templateRevision:template.revision} as DramaVideoTarget,
  label:template.name+(template.revisionName?" · "+template.revisionName:templates.filter(t=>t.name===template.name).length>1?" · 版本 "+(index+1):"")
 }));
 const all=[...options,...online,...comfy],current=targetKey(value.target);
 const unknown=!all.some(item=>targetKey(item.target)===current);
 const style={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke} as CSSProperties;
 return <div className="grid min-w-0 gap-1.5 text-xs">
  <label className="grid gap-1.5" style={{color:theme.node.muted}}>视频渠道 / 模型 / 工作流
   <select aria-label="视频渠道" className="w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm" style={style}
    disabled={disabled} value={current} onChange={event=>{
     const selected=all.find(item=>targetKey(item.target)===event.target.value);
     if(selected)onChange({...value,target:selected.target});
    }}>
    {unknown&&<option value={current} disabled>{loading?"正在读取已选渠道…":value.target?.kind==="online"?"已选在线模型不可用":"已选工作流不可用"}</option>}
    {options.map(item=><option key={targetKey(item.target)} value={targetKey(item.target)}>{item.label}</option>)}
    {!!comfy.length&&<optgroup label="本地 ComfyUI">{comfy.map(item=><option key={targetKey(item.target)} value={targetKey(item.target)}>{item.label}</option>)}</optgroup>}
    {!!online.length&&<optgroup label="在线视频模型">{online.map(item=><option key={targetKey(item.target)} value={targetKey(item.target)}>{item.label}</option>)}</optgroup>}
   </select>
  </label>
  {loading&&<span style={{color:theme.node.muted}}>正在读取本地视频工作流…</span>}
  {error&&<div className="flex items-center gap-2" style={{color:theme.node.muted}}>{error}<button type="button" disabled={disabled} onClick={()=>setReload(n=>n+1)} className="underline">重试</button></div>}
  {!loading&&!error&&!comfy.length&&!online.length&&<span style={{color:theme.node.muted}}>暂无可选的视频模型或工作流，请先在设置中配置。</span>}
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
