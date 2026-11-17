import {Button,Checkbox,Input,InputNumber,Select} from "antd";
import type {ComfyMediaUseCase,ComfyTemplatePayload,ComfyTemplatePort} from "./template-schema";
import {MEDIA_MODES,type MediaCapabilities,type MediaInputRule,type MediaKind,type MediaModeId,type MediaParameterSpec,type MediaRole} from "@/services/media-capabilities";

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
const labels:Record<MediaModeId,string>={text_to_image:"文生图",reference_edit:"参考编辑",inpaint:"局部重绘",text_to_video:"文生视频",first_frame:"首帧生成",last_frame:"尾帧生成",first_last_frame:"首尾帧生成",omni_reference:"全能参考",text_to_speech:"语音合成",voice_clone:"参考音色合成",text_to_music:"音乐生成",text_to_sound:"音效生成"};
function defaultInputs(id:MediaModeId):MediaInputRule[]{
 const rule=(role:MediaRole,kind:MediaInputRule["kind"],minItems:number,maxItems:number):MediaInputRule=>({role,kind,minItems,maxItems});
 return id==="reference_edit"?[rule("reference_image","image",1,4)]:id==="inpaint"?[rule("source_image","image",1,1),rule("mask","mask",1,1)]:
  id==="first_frame"?[rule("first_frame","image",1,1)]:id==="last_frame"?[rule("last_frame","image",1,1)]:
  id==="first_last_frame"?[rule("first_frame","image",1,1),rule("last_frame","image",1,1)]:
  id==="voice_clone"?[rule("voice_reference","audio",1,1)]:id==="omni_reference"?[rule("reference_image","image",0,9),rule("reference_video","video",0,3),rule("reference_audio","audio",0,3)]:[];
}
export function comfyAdditionalOutputOptions(template:ComfyTemplatePayload,useCase:ComfyMediaUseCase|undefined){
 return template.ports.filter(port=>port.direction==="source"&&port.capture&&port.capture.kind!=="none"&&port.capture.adapterId&&port.id!==useCase?.primaryOutputPortId);
}
export function ComfyMediaUseCaseEditor({template,onChange}:{template:ComfyTemplatePayload;onChange:(value:ComfyMediaUseCase|undefined)=>void}){
 const current=template.mediaUseCase;
 const promptPorts=template.ports.filter(port=>scalar(port)&&port.valueKind==="STRING");
 const mediaTargets=template.ports.filter(port=>port.direction==="target"&&["IMAGE","MASK","VIDEO","AUDIO"].includes(port.valueKind)&&
  ["media-file","socket"].includes(port.inputBinding?.mode??""));
 const ratioPorts=template.ports.filter(port=>scalar(port)&&port.valueKind==="STRING");
 const dimensionPorts=template.ports.filter(port=>scalar(port)&&["INT","FLOAT"].includes(port.valueKind));
 const sync=current?.aspectSync;
 const portOptions=(ports:ComfyTemplatePort[])=>ports.map(port=>({value:port.id,label:port.label+" · "+port.id}));
 const kind=current?.primaryOutputKind??"image";
 const outputs=template.ports.filter(port=>port.direction==="source"&&port.capture&&port.capture.kind===kind&&port.capture.adapterId);
 const ensure=():ComfyMediaUseCase=>current??{channel:"image",primaryOutputKind:"image",promptPortId:"",slots:[],primaryOutputPortId:"",additionalOutputPortIds:[]};
 const patch=(value:Partial<ComfyMediaUseCase>)=>onChange(normalizeComfyMediaUseCaseOutputSelection({...ensure(),...value})!);
 const targetDescription=(port:ComfyTemplatePort)=>port.inputBinding?.targets.map(target=>target.nodeId+"."+target.inputName).join(", ");
 const capability=current?.mediaCapabilities;
 const ensureCapabilities=():MediaCapabilities=>capability??{schemaVersion:1,kind:current?.channel??"image",modes:MEDIA_MODES[current?.channel??"image"].map(id=>({id,enabled:false,inputs:defaultInputs(id),parameters:[]}))};
 const enabledModes=capability?.modes.filter(item=>item.enabled)??[];
 const setModeEnabled=(id:MediaModeId,enabled:boolean)=>{const base=ensureCapabilities(),modes=base.modes.map(mode=>mode.id===id?{...mode,enabled}:mode);
  const nextDefault=base.defaultMode&&modes.some(mode=>mode.id===base.defaultMode&&mode.enabled)?base.defaultMode:enabled?id:modes.find(mode=>mode.enabled)?.id;
  const bindings={...(current?.modeBindings??{})};
  if(enabled)bindings[id]=bindings[id]??{promptPortId:current?.promptPortId??"",parameterPorts:{},rolePorts:{}};else delete bindings[id];
  patch({mediaCapabilities:{schemaVersion:1,kind:base.kind,modes,...(nextDefault?{defaultMode:nextDefault}:{})},modeBindings:bindings});};
 const mapRole=(id:MediaModeId,role:MediaRole,ports:string[])=>{
  const base=ensureCapabilities(),modes=base.modes.map(mode=>mode.id===id?{...mode,inputs:mode.inputs.map(rule=>rule.role===role?{...rule,maxItems:ports.length}:rule)}:mode);
  patch({mediaCapabilities:{...base,modes},modeBindings:{...(current?.modeBindings??{}),[id]:{...(current?.modeBindings?.[id]??{promptPortId:current?.promptPortId??"",parameterPorts:{}}),rolePorts:{...(current?.modeBindings?.[id]?.rolePorts??{}),[role]:ports}}}});
 };
 const updateMode=(id:MediaModeId,update:(mode:MediaCapabilities["modes"][number])=>MediaCapabilities["modes"][number])=>{const base=ensureCapabilities();patch({mediaCapabilities:{...base,modes:base.modes.map(mode=>mode.id===id?update(mode):mode)}})};
 const parameterIds:Record<MediaKind,string[]>={image:["width","height","seed","count","negative_prompt","transparent_background","output_format"],video:["duration_seconds","aspect_ratio","resolution","seed","generate_audio","return_last_frame","watermark"],audio:["voice","speed","language","instructions","duration_seconds","sample_rate","channels","output_format"]};
 const addParameter=(modeId:MediaModeId,id:string)=>{const type:MediaParameterSpec["type"]=["generate_audio","return_last_frame","watermark","transparent_background"].includes(id)?"boolean":["aspect_ratio","resolution","voice","language","sample_rate","channels","output_format"].includes(id)?"enum":["negative_prompt","instructions"].includes(id)?"string":"number";
  const values:MediaParameterSpec["values"]=type==="enum"?(id==="resolution"?["480p","720p","1080p"]:id==="aspect_ratio"?["16:9","9:16","1:1","4:3","3:4"]:id==="voice"?["alloy","echo","fable","onyx","nova","shimmer"]:id==="language"?["en","zh"]:id==="sample_rate"?[24000,44100,48000]:id==="channels"?[1,2]:["mp3","wav","flac"]):undefined;
  const def=type==="number"?(id==="duration_seconds"?6:id==="speed"?1:id==="count"?1:id==="width"||id==="height"?1024:0):type==="boolean"?false:values?.[0]??"";
  updateMode(modeId,mode=>({...mode,parameters:[...mode.parameters.filter(item=>item.id!==id),{id,mode:"adjustable",type,defaultValue:def,...(values?{values}:{})}]}));};
 return <details className="rounded-lg border border-[var(--comfy-border)] p-3 [&_label]:text-[11px] [&_label]:font-medium [&_label]:text-[var(--comfy-muted)]" data-comfy-media-use-case-editor>
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
  {kind!=="audio"?<div className="mt-3 space-y-2" data-comfy-aspect-sync-editor>
   <label className="block text-xs">节点比例同步<Select {...selectProps} value={sync?.mode??"auto"}
    options={[{value:"auto",label:"自动识别"},{value:"ratio",label:"指定比例端口"},{value:"dimensions",label:"指定宽高端口"},{value:"off",label:"关闭"}]}
    onChange={(mode:"auto"|"ratio"|"dimensions"|"off")=>patch({aspectSync:mode==="ratio"?{mode,portId:""}:mode==="dimensions"?{mode,widthPortId:"",heightPortId:""}:{mode}})}/></label>
   {sync?.mode==="ratio"?<label className="block text-xs">比例端口<Select {...selectProps} value={sync.portId||undefined} placeholder="选择比例 STRING 端口"
    options={portOptions(ratioPorts)} onChange={(portId:string)=>patch({aspectSync:{mode:"ratio",portId}})}/></label>:null}
   {sync?.mode==="dimensions"?<div className="grid gap-2 sm:grid-cols-2">
    <label className="text-xs">宽度端口<Select {...selectProps} value={sync.widthPortId||undefined} placeholder="选择宽度端口"
     options={portOptions(dimensionPorts.filter(port=>port.id!==sync.heightPortId))} onChange={(widthPortId:string)=>patch({aspectSync:{...sync,widthPortId}})}/></label>
    <label className="text-xs">高度端口<Select {...selectProps} value={sync.heightPortId||undefined} placeholder="选择高度端口"
     options={portOptions(dimensionPorts.filter(port=>port.id!==sync.widthPortId))} onChange={(heightPortId:string)=>patch({aspectSync:{...sync,heightPortId}})}/></label>
   </div>:null}
   <p className="text-[11px] text-[var(--comfy-muted)]">仅预览空图片和视频节点的比例，生成结果以实际尺寸为准。</p>
  </div>:null}
  <div className="mt-3"><span className="text-xs font-medium">有序媒体槽位</span><div className="mt-1 grid gap-1 sm:grid-cols-2">
   {mediaTargets.map(port=>{const existing=current?.slots.find(slot=>slot.id===port.id);return <label key={port.id} className="flex min-w-0 items-center gap-2 text-xs">
    <Checkbox checked={!!existing} onChange={event=>{const slots=(current?.slots??[]).filter(slot=>slot.id!==port.id);
     if(event.target.checked)slots.push({id:port.id,label:port.label,valueKind:port.valueKind as "IMAGE"|"MASK"|"VIDEO"|"AUDIO",required:!!port.required});
     patch({slots});}}/><span className="min-w-0 truncate" title={port.label+" · "+port.valueKind}>
     {port.label} · {port.valueKind}{port.required?"（必填）":"（可选）"}</span></label>;})}
   {!mediaTargets.length?<span className="text-xs text-[var(--comfy-muted)]">当前模板没有已绑定的媒体输入。</span>:null}
  </div></div>
  {current?<Button size="small" className="mt-3" onClick={()=>onChange(undefined)}>清除媒体用途配置</Button>:null}
  {current?<div className="mt-4 rounded-md border border-[var(--comfy-border)] p-3" data-media-capabilities-editor>
   <div className="text-xs font-semibold">版本化生成模式</div>
   {!capability?<Button size="small" className="mt-2" onClick={()=>patch({mediaCapabilities:ensureCapabilities()})}>配置显式能力</Button>:null}
   {capability?<>
    <label className="mt-2 block text-xs">默认模式<Select {...selectProps} value={capability.defaultMode} placeholder="选择默认模式" options={enabledModes.map(mode=>({value:mode.id,label:labels[mode.id]}))}
     onChange={(value:MediaModeId)=>patch({mediaCapabilities:{...capability,defaultMode:value}})}/></label>
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">{MEDIA_MODES[capability.kind].map(id=><Checkbox key={id} checked={!!capability.modes.find(mode=>mode.id===id)?.enabled} onChange={e=>setModeEnabled(id,e.target.checked)}>{labels[id]}</Checkbox>)}</div>
    {enabledModes.map(mode=>{const binding=current.modeBindings?.[mode.id];return <div key={mode.id} className="mt-3 rounded border border-[var(--comfy-border)] p-2">
     <div className="text-xs font-medium">{labels[mode.id]} · 角色端口映射</div>
     {mode.inputs.map(rule=><label key={rule.role} className="mt-2 block text-xs">{rule.role} · {rule.minItems}–{rule.maxItems} 项
      <Select {...selectProps} mode="multiple" value={binding?.rolePorts?.[rule.role]??[]} placeholder="确认角色对应的端口"
       options={mediaTargets.filter(port=>current.slots.some(slot=>slot.id===port.id)&&port.valueKind===(rule.kind==="image"?"IMAGE":rule.kind==="mask"?"MASK":rule.kind==="video"?"VIDEO":"AUDIO")).map(port=>({value:port.id,label:port.label+" · "+port.id}))}
       onChange={(values:string[])=>mapRole(mode.id,rule.role,values)}/></label>)}
     <div className="mt-3 border-t border-[var(--comfy-border)] pt-2"><div className="text-xs font-medium">参数约束与端口</div>
      <Select {...selectProps} className="mt-1 w-full" placeholder="添加可配置参数" value={undefined}
       options={parameterIds[capability.kind].filter(id=>!mode.parameters.some(parameter=>parameter.id===id)).map(id=>({value:id,label:id}))}
       onChange={(id:string)=>addParameter(mode.id,id)}/>
      {mode.parameters.map(spec=>{const type=spec.type==="number"?["INT","FLOAT"]:spec.type==="boolean"?["BOOLEAN"]:spec.type==="string"?["STRING"]:["STRING","INT","FLOAT","BOOLEAN"];
       return <div key={spec.id} className="mt-2 rounded bg-black/5 p-2 dark:bg-white/5"><div className="flex flex-wrap items-center gap-2">
        <span className="w-28 text-[11px]">{spec.id}（{spec.type}）</span><Select size="small" className="w-32" placeholder="映射到参数端口" value={binding?.parameterPorts?.[spec.id]}
         options={template.ports.filter(port=>scalar(port)&&type.includes(port.valueKind)).map(port=>({value:port.id,label:port.label+" · "+port.id}))}
         onChange={(portId:string)=>patch({modeBindings:{...(current.modeBindings??{}),[mode.id]:{...(binding??{promptPortId:current.promptPortId,rolePorts:{},parameterPorts:{}}),parameterPorts:{...(binding?.parameterPorts??{}),[spec.id]:portId}}}})}/>
        <Select size="small" className="w-24" value={spec.mode} options={[{value:"adjustable",label:"可调"},{value:"fixed",label:"固定"}]}
         onChange={(value:"adjustable"|"fixed")=>updateMode(mode.id,currentMode=>({...currentMode,parameters:currentMode.parameters.map(parameter=>{if(parameter.id!==spec.id)return parameter;const {fixedValue,...rest}=parameter;return value==="fixed"?{...rest,mode:value,fixedValue:parameter.defaultValue}:rest.mode==="fixed"?{...rest,mode:value}:{...rest,mode:value};})}))}/>
        <Button size="small" type="link" danger onClick={()=>{updateMode(mode.id,currentMode=>({...currentMode,parameters:currentMode.parameters.filter(parameter=>parameter.id!==spec.id)}));const next={...(current.modeBindings??{}),[mode.id]:{...(binding??{promptPortId:current.promptPortId,rolePorts:{},parameterPorts:{}}),parameterPorts:{...(binding?.parameterPorts??{})}}};delete next[mode.id]!.parameterPorts?.[spec.id];patch({modeBindings:next});}}>移除</Button>
       </div><div className="mt-2 flex flex-wrap items-center gap-2">{spec.type==="number"?<><InputNumber size="small" placeholder="默认" value={typeof spec.defaultValue==="number"?spec.defaultValue:undefined} onChange={value=>updateMode(mode.id,currentMode=>({...currentMode,parameters:currentMode.parameters.map(parameter=>parameter.id===spec.id?{...parameter,defaultValue:value??undefined,...(parameter.mode==="fixed"?{fixedValue:value??undefined}:{})}:parameter)}))}/><InputNumber size="small" placeholder="最小" value={spec.min} onChange={value=>updateMode(mode.id,currentMode=>({...currentMode,parameters:currentMode.parameters.map(parameter=>parameter.id===spec.id?{...parameter,min:value??undefined}:parameter)}))}/><InputNumber size="small" placeholder="最大" value={spec.max} onChange={value=>updateMode(mode.id,currentMode=>({...currentMode,parameters:currentMode.parameters.map(parameter=>parameter.id===spec.id?{...parameter,max:value??undefined}:parameter)}))}/></>:spec.type==="enum"?<Input size="small" className="w-60" value={(spec.values??[]).join(",")} placeholder="逗号分隔的允许值" onChange={event=>updateMode(mode.id,currentMode=>({...currentMode,parameters:currentMode.parameters.map(parameter=>{if(parameter.id!==spec.id)return parameter;const values=event.target.value.split(",").map(value=>value.trim()).filter(Boolean),def=values.includes(String(parameter.defaultValue))?parameter.defaultValue:values[0];return {...parameter,values,defaultValue:def,...(parameter.mode==="fixed"?{fixedValue:def}:{})};})}))}/>:spec.type==="string"?<Input size="small" className="w-48" value={typeof spec.defaultValue==="string"?spec.defaultValue:""} placeholder="默认值" onChange={event=>updateMode(mode.id,currentMode=>({...currentMode,parameters:currentMode.parameters.map(parameter=>parameter.id===spec.id?{...parameter,defaultValue:event.target.value,...(parameter.mode==="fixed"?{fixedValue:event.target.value}:{})}:parameter)}))}/>:<Checkbox checked={Boolean(spec.defaultValue)} onChange={event=>updateMode(mode.id,currentMode=>({...currentMode,parameters:currentMode.parameters.map(parameter=>parameter.id===spec.id?{...parameter,defaultValue:event.target.checked,...(parameter.mode==="fixed"?{fixedValue:event.target.checked}:{})}:parameter)}))}>默认 false / true</Checkbox>}</div></div>})}
     </div>
     <div className="mt-3 border-t border-[var(--comfy-border)] pt-2">
      <Checkbox checked={!!mode.layout} onChange={event=>{const modes=ensureCapabilities().modes.map(item=>item.id===mode.id?{...item,layout:event.target.checked?{format:"atelier_bbox_json_v1" as const,delivery:"prompt_json" as const}:undefined}:item);patch({mediaCapabilities:{...ensureCapabilities(),modes}})}}>接受画布结构化布局</Checkbox>
      {mode.layout?<div className="mt-2 grid gap-2 sm:grid-cols-2">
       <label className="text-xs">布局传递方式<Select {...selectProps} value={mode.layout.delivery} options={[{value:"prompt_json",label:"作为完整结构化提示词"},{value:"dedicated_input",label:"发送到专用端口"}]}
        onChange={(delivery:"prompt_json"|"dedicated_input")=>{const modes=ensureCapabilities().modes.map(item=>item.id===mode.id?{...item,layout:{...mode.layout!,delivery}}:item);patch({mediaCapabilities:{...ensureCapabilities(),modes}})}}/></label>
       {mode.layout.delivery==="dedicated_input"?<label className="text-xs">布局端口<Select {...selectProps} value={binding?.layoutPortId} placeholder="选择 STRING literal 端口"
        options={promptPorts.map(port=>({value:port.id,label:port.label+" · "+port.id}))}
        onChange={(portId:string|undefined)=>patch({modeBindings:{...(current.modeBindings??{}),[mode.id]:{...(binding??{promptPortId:current.promptPortId,parameterPorts:{},rolePorts:{}}),layoutPortId:portId}}})}/></label>:null}
      </div>:null}
     </div>
     {!mode.inputs.length?<p className="mt-1 text-[11px] text-[var(--comfy-muted)]">此模式不需要媒体输入。</p>:null}
    </div>})}
   </>:null}
  </div>:null}
 </details>;
}
