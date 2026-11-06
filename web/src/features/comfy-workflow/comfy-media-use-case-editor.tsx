import {Button,Checkbox,Select} from "antd";
import type {ComfyMediaUseCase,ComfyTemplatePayload,ComfyTemplatePort} from "./template-schema";

/** Recover drafts without weakening immutable revision validation. */
export function normalizeComfyMediaUseCaseOutputSelection(useCase:ComfyMediaUseCase|undefined):ComfyMediaUseCase|undefined{
 if(!useCase||!useCase.additionalOutputPortIds)return useCase;
 return {...useCase,additionalOutputPortIds:[...new Set(useCase.additionalOutputPortIds)].filter(id=>id!==useCase.primaryOutputPortId)};
}
export function normalizeComfyTemplateMediaDraft<T extends ComfyTemplatePayload>(draft:T):T{
 const mediaUseCase=normalizeComfyMediaUseCaseOutputSelection(draft.mediaUseCase);
 return mediaUseCase===draft.mediaUseCase?draft:{...draft,mediaUseCase};
}

const scalar=(port:ComfyTemplatePort)=>port.direction==="target"&&port.inputBinding?.mode==="literal"&&
 port.inputBinding.targets.length>0&&["STRING","INT","FLOAT","BOOLEAN"].includes(port.valueKind);
const selectProps={className:"mt-1 w-full min-w-0",size:"small" as const,
 getPopupContainer:(trigger:HTMLElement)=>trigger.parentElement??document.body,
 classNames:{root:"comfy-media-use-case-select",popup:{root:"comfy-media-use-case-popup"}},
 styles:{popup:{root:{backgroundColor:"var(--comfy-panel)",color:"var(--comfy-text)",borderColor:"var(--comfy-border)"}}}};
const outputOption=(port:ComfyTemplatePort)=>({value:port.id,label:<span className="block truncate" title={port.label+" · "+port.id+" · "+port.capture?.kind}>{port.label} · {port.id} · {port.capture?.kind}</span>});
export function comfyAdditionalOutputOptions(template:ComfyTemplatePayload,useCase:ComfyMediaUseCase|undefined){
 return template.ports.filter(port=>port.direction==="source"&&port.capture&&port.capture.kind!=="none"&&port.capture.adapterId&&port.id!==useCase?.primaryOutputPortId);
}
export function ComfyMediaUseCaseEditor({template,onChange}:{template:ComfyTemplatePayload;onChange:(value:ComfyMediaUseCase|undefined)=>void}){
 const current=template.mediaUseCase;
 const promptPorts=template.ports.filter(port=>scalar(port)&&port.valueKind==="STRING");
 const mediaTargets=template.ports.filter(port=>port.direction==="target"&&["IMAGE","VIDEO","AUDIO"].includes(port.valueKind)&&
  ["media-file","socket"].includes(port.inputBinding?.mode??""));
 const kind=current?.primaryOutputKind??"image";
 const outputs=template.ports.filter(port=>port.direction==="source"&&port.capture&&port.capture.kind===kind&&port.capture.adapterId);
 const ensure=():ComfyMediaUseCase=>current??{channel:"image",primaryOutputKind:"image",promptPortId:"",slots:[],primaryOutputPortId:"",additionalOutputPortIds:[]};
 const patch=(value:Partial<ComfyMediaUseCase>)=>onChange(normalizeComfyMediaUseCaseOutputSelection({...ensure(),...value})!);
 const targetDescription=(port:ComfyTemplatePort)=>port.inputBinding?.targets.map(target=>target.nodeId+"."+target.inputName).join(", ");
 return <details className="rounded-lg border border-[var(--comfy-border)] p-3" data-comfy-media-use-case-editor>
  <summary className="cursor-pointer text-[11px] font-medium text-[var(--comfy-muted)]">媒体预设用途</summary>
  <p className="mt-2 text-[11px] text-[var(--comfy-muted)]">启用后，图片/视频/音频节点可直接选择此模板。</p>
  <div className="mt-3 grid gap-2 sm:grid-cols-2">
   <label className="min-w-0 text-xs">主输出类型<Select {...selectProps} value={kind}
    options={(["image","video","audio"] as const).map(value=>({value,label:value==="image"?"图片":value==="video"?"视频":"音频"}))}
    onChange={(value:ComfyMediaUseCase["primaryOutputKind"])=>patch({channel:value,primaryOutputKind:value,primaryOutputPortId:"",additionalOutputPortIds:[]})}/></label>
   <label className="min-w-0 text-xs">固定提示词端口<Select {...selectProps} value={current?.promptPortId||undefined} placeholder="选择 STRING literal 端口" allowClear
    options={promptPorts.map(port=>{const target=targetDescription(port);const label=port.label+(target?" · "+target:"");return {value:port.id,label:<span className="block truncate" title={label}>{label}</span>};})}
    onChange={(value:string|undefined)=>patch({promptPortId:value??""})}/></label>
   <label className="min-w-0 text-xs">主输出<Select {...selectProps} value={current?.primaryOutputPortId||undefined} placeholder="选择可采集输出" allowClear
    options={outputs.map(outputOption)} onChange={(value:string|undefined)=>patch({primaryOutputPortId:value??""})}/></label>
   <label className="min-w-0 text-xs">附加输出（可选）<Select {...selectProps} mode="multiple" allowClear
    maxCount={Math.max(1,comfyAdditionalOutputOptions(template,current).length)} maxTagCount="responsive" maxTagTextLength={18}
    placeholder="选择附加输出" value={normalizeComfyMediaUseCaseOutputSelection(current)?.additionalOutputPortIds??[]}
    options={comfyAdditionalOutputOptions(template,current).map(outputOption)}
    onChange={(values:string[])=>patch({additionalOutputPortIds:[...new Set(values)].filter(id=>id!==current?.primaryOutputPortId)})}/></label>
  </div>
  <div className="mt-3"><span className="text-xs font-medium">有序媒体槽位</span><div className="mt-1 grid gap-1 sm:grid-cols-2">
   {mediaTargets.map(port=>{const existing=current?.slots.find(slot=>slot.id===port.id);return <label key={port.id} className="flex min-w-0 items-center gap-2 text-xs">
    <Checkbox checked={!!existing} onChange={event=>{const slots=(current?.slots??[]).filter(slot=>slot.id!==port.id);
     if(event.target.checked)slots.push({id:port.id,label:port.label,valueKind:port.valueKind as "IMAGE"|"VIDEO"|"AUDIO",required:!!port.required});
     patch({slots});}}/><span className="min-w-0 truncate" title={port.label+" · "+port.valueKind}>
     {port.label} · {port.valueKind}{port.required?"（必填）":"（可选）"}</span></label>;})}
   {!mediaTargets.length?<span className="text-xs text-[var(--comfy-muted)]">当前模板没有已绑定的媒体输入。</span>:null}
  </div></div>
  {current?<Button size="small" className="mt-3" onClick={()=>onChange(undefined)}>清除媒体用途配置</Button>:null}
 </details>;
}
