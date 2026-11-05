import type {ComfyMediaUseCase,ComfyTemplatePayload,ComfyTemplatePort} from "./template-schema";
import {Button,Checkbox,Input,Select} from "antd";

/** Recover editable drafts without weakening revision validation. */
export function normalizeComfyMediaUseCaseOutputSelection(useCase:ComfyMediaUseCase|undefined):ComfyMediaUseCase|undefined{
 if(!useCase||!useCase.additionalOutputPortIds)return useCase;
 return {...useCase,additionalOutputPortIds:[...new Set(useCase.additionalOutputPortIds)].filter(id=>id!==useCase.primaryOutputPortId)};
}
export function normalizeComfyTemplateMediaDraft<T extends ComfyTemplatePayload>(draft:T):T{
 const mediaUseCase=normalizeComfyMediaUseCaseOutputSelection(draft.mediaUseCase);
 return mediaUseCase===draft.mediaUseCase?draft:{...draft,mediaUseCase};
}

const fields:Record<string,string[]>={
 image:["imageQuality","imageWidth","imageHeight","imageCount","imageBackground"],
 video:["videoResolution","videoSize","videoRatio","videoDuration","videoGenerateAudio","videoWatermark","videoReturnLastFrame"],
 audio:["audioVoice","audioFormat","audioSpeed","audioInstructions"],
};
const titles:Record<string,string>={imageQuality:"图片质量",imageWidth:"宽度",imageHeight:"高度",imageCount:"数量",imageBackground:"背景",
 videoResolution:"分辨率",videoSize:"宽高 / 尺寸",videoRatio:"画面比例",videoDuration:"时长",videoGenerateAudio:"生成音频",videoWatermark:"水印",videoReturnLastFrame:"尾帧",
 audioVoice:"音色",audioFormat:"格式",audioSpeed:"语速",audioInstructions:"生成指令"};
const scalar=(port:ComfyTemplatePort)=>port.direction==="target"&&port.inputBinding?.mode==="literal"&&port.inputBinding.targets.length>0&&["STRING","INT","FLOAT","BOOLEAN"].includes(port.valueKind);
function mappingTargetDescription(port:ComfyTemplatePort){
 const targets=port.inputBinding?.targets.map(target=>target.nodeId+"."+target.inputName).join(", ");
 return port.label+(targets?" · "+targets:"")+" · "+port.valueKind;
}
const controlClass="mt-1 w-full min-w-0";
const controlPopupStyles={popup:{root:{backgroundColor:"var(--comfy-panel)",color:"var(--comfy-text)",borderColor:"var(--comfy-border)"}}};
const selectProps={className:controlClass,size:"small" as const,getPopupContainer:(trigger:HTMLElement)=>trigger.parentElement??document.body,
 classNames:{root:"comfy-media-use-case-select",popup:{root:"comfy-media-use-case-popup"}},styles:controlPopupStyles};
const outputOption=(port:ComfyTemplatePort)=>({value:port.id,label:<span className="block truncate" title={port.label+" · "+port.id+" · "+port.capture?.kind}>{port.label} · {port.id} · {port.capture?.kind}</span>});
function mappingTargetOptions(template:ComfyTemplatePayload,targetPorts:ComfyTemplatePort[],mappedIds:string[]){
 const eligible=new Set(targetPorts.map(port=>port.id));
 const candidates=targetPorts.map(port=>{const description=mappingTargetDescription(port);return {value:port.id,label:<span className="block truncate" title={description}>{description}{port.choices?.length?"（枚举）":""}</span>};});
 const retained=mappedIds.filter(id=>!eligible.has(id)).map(id=>{
  const port=template.ports.find(candidate=>candidate.id===id);
  const description=port?mappingTargetDescription(port)+"（当前不可映射）":"端口已删除 · "+id;
  return {value:id,disabled:true,label:<span className="block truncate text-[var(--comfy-muted)]" title={description}>{description}</span>};
 });
 return [...candidates,...retained];
}
export function comfyAdditionalOutputOptions(template:ComfyTemplatePayload,useCase:ComfyMediaUseCase|undefined){
 return template.ports.filter(port=>port.direction==="source"&&port.capture&&port.capture.kind!=="none"&&port.capture.adapterId&&port.id!==useCase?.primaryOutputPortId);
}
export function ComfyMediaUseCaseEditor({template,onChange}:{template:ComfyTemplatePayload;onChange:(value:ComfyMediaUseCase|undefined)=>void}){
 const current=template.mediaUseCase;
 const promptPorts=template.ports.filter(port=>scalar(port)&&port.valueKind==="STRING");
 const targetPorts=template.ports.filter(scalar);
 const mediaTargets=template.ports.filter(port=>port.direction==="target"&&["IMAGE","VIDEO","AUDIO"].includes(port.valueKind)&&["media-file","socket"].includes(port.inputBinding?.mode??""));
 const kind=current?.primaryOutputKind??"image";
 const outputs=template.ports.filter(port=>port.direction==="source"&&port.capture&&port.capture.kind===kind&&port.capture.adapterId);
 const ensure=():ComfyMediaUseCase=>current??{channel:"image",primaryOutputKind:"image",promptPortId:"",slots:[],primaryOutputPortId:"",additionalOutputPortIds:[],settings:{}};
 const patch=(value:Partial<ComfyMediaUseCase>)=>onChange(normalizeComfyMediaUseCaseOutputSelection({...ensure(),...value})!);
 const mappingPorts=(value:unknown):string[]=>typeof value==="string"?[value]:Array.isArray(value)?value:
  value&&typeof value==="object"&&"ports" in value&&Array.isArray(value.ports)?value.ports as string[]:[];
 return <details className="rounded-lg border border-[var(--comfy-border)] p-3" data-comfy-media-use-case-editor>
  <summary className="cursor-pointer text-[11px] font-medium text-[var(--comfy-muted)]">媒体预设用途 · 通用设置映射</summary>
  <p className="mt-2 text-[11px] text-[var(--comfy-muted)]">启用后，图片/视频/音频节点可直接选择此模板。映射只呈现已绑定的通用控件；其余标量仍显示为高级参数。</p>
  <div className="mt-3 grid gap-2 sm:grid-cols-2">
   <label className="min-w-0 text-xs">主输出类型<Select {...selectProps} value={kind} options={(["image","video","audio"] as const).map(x=>({value:x,label:x==="image"?"图片":x==="video"?"视频":"音频"}))}
    onChange={(value:ComfyMediaUseCase["primaryOutputKind"])=>patch({channel:value,primaryOutputKind:value,primaryOutputPortId:"",additionalOutputPortIds:[]})}/></label>
   <label className="min-w-0 text-xs">固定提示词端口<Select {...selectProps} value={current?.promptPortId||undefined} placeholder="选择 STRING literal 端口" allowClear
    options={promptPorts.map(p=>({value:p.id,label:<span className="block truncate" title={p.label+" · "+p.id}>{p.label} · {p.id}</span>}))}
    onChange={(value:string|undefined)=>patch({promptPortId:value??""})}/></label>
   <label className="min-w-0 text-xs">主输出<Select {...selectProps} value={current?.primaryOutputPortId||undefined} placeholder="选择可采集输出" allowClear
    options={outputs.map(outputOption)} onChange={(value:string|undefined)=>patch({primaryOutputPortId:value??""})}/></label>
   <label className="min-w-0 text-xs">附加输出（可选）<Select {...selectProps} mode="multiple" allowClear maxCount={Math.max(1,comfyAdditionalOutputOptions(template,current).length)}
    maxTagCount="responsive" maxTagTextLength={18} placeholder="选择附加输出" value={normalizeComfyMediaUseCaseOutputSelection(current)?.additionalOutputPortIds??[]}
    options={comfyAdditionalOutputOptions(template,current).map(outputOption)}
    onChange={(values:string[])=>patch({additionalOutputPortIds:[...new Set(values)].filter(id=>id!==current?.primaryOutputPortId)})}/></label>
  </div>
  <div className="mt-3"><span className="text-xs font-medium">有序媒体槽位</span><div className="mt-1 grid gap-1 sm:grid-cols-2">
   {mediaTargets.map(port=>{const existing=current?.slots.find(slot=>slot.id===port.id);return <label key={port.id} className="flex min-w-0 items-center gap-2 text-xs">
    <Checkbox checked={!!existing} onChange={e=>{const slots=(current?.slots??[]).filter(slot=>slot.id!==port.id);if(e.target.checked)slots.push({id:port.id,label:port.label,valueKind:port.valueKind as "IMAGE"|"VIDEO"|"AUDIO",required:!!port.required});patch({slots});}}/>
    <span className="min-w-0 truncate" title={port.label+" · "+port.valueKind}>{port.label} · {port.valueKind}{port.required?"（必填）":"（可选）"}</span></label>;})}
   {!mediaTargets.length?<span className="text-xs text-[var(--comfy-muted)]">当前模板没有已绑定的媒体输入。</span>:null}
  </div></div>
  <div className="mt-3"><span className="text-xs font-medium">通用设置映射</span><div className="mt-1 grid gap-2 sm:grid-cols-2">
   {(fields[kind]??[]).map(key=>{const mapped=mappingPorts(current?.settings?.[key]);return <label key={key} className="text-xs">{titles[key]}
   <Select {...selectProps} data-comfy-mapping-key={key} mode={key==="imageWidth"||key==="videoResolution"||key==="videoSize"?"multiple":undefined}
    maxCount={2} maxTagCount="responsive" maxTagTextLength={18} value={(key==="imageWidth"||key==="videoResolution"||key==="videoSize")?mapped:(mapped[0]||undefined)}
    placeholder="不映射" allowClear options={mappingTargetOptions(template,targetPorts,mapped)}
    onChange={(selected:string|string[]|undefined)=>{
     const settings={...(current?.settings??{})};const selectedIds:string[]=(key==="imageWidth"||key==="videoResolution"||key==="videoSize")?
      (Array.isArray(selected)?selected.slice(0,2):typeof selected==="string"?[selected]:[]):typeof selected==="string"?[selected]:[];
     if(!selectedIds.length)delete settings[key];else settings[key]={ports:selectedIds};patch({settings});}}/>
    {mapped.length===1&&targetPorts.find(port=>port.id===mapped[0])?.choices?.length?
      <Input.TextArea aria-label={titles[key]+" 通用值映射"} className="mt-1 w-full font-mono text-[10px]"
       title="可编辑 JSON: [{label, value, portValues}]" rows={2} value={JSON.stringify((typeof current?.settings?.[key]==="object"&&!Array.isArray(current.settings[key])&&current.settings[key].values)||targetPorts.find(port=>port.id===mapped[0])?.choices||[])}
       onChange={event=>{try{const values=JSON.parse(event.target.value);if(Array.isArray(values)){const settings={...(current?.settings??{}),[key]:{ports:mapped,values}};patch({settings});}}catch{/* retain current valid mapping until JSON is complete */}}}/>:null}</label>;})}
  </div></div>
  {current?<Button size="small" className="mt-3" onClick={()=>onChange(undefined)}>清除媒体用途配置</Button>:null}
 </details>;
}
