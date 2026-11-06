import {useEffect,useState} from "react";
import {Button,ConfigProvider,Input,InputNumber,Select,Switch} from "antd";
import {CanvasImageSettingsPopover} from "@/components/canvas/canvas-image-settings-popover";
import {CanvasVideoSettingsPopover} from "@/components/canvas/canvas-video-settings-popover";
import {CanvasAudioSettingsPopover} from "@/components/canvas/canvas-audio-settings-popover";
import type {AiConfig} from "@/stores/use-config-store";
import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import type {CanvasTheme} from "@/lib/canvas-theme";
import {getComfyInstanceScalarFields,parseComfyScalarOverride,type ComfyInstanceScalarField} from "./instance-parameters";
import {COMFY_MEDIA_PARAMETER_POPUP_CLASS,createComfyMediaOverridePatch,createComfyMediaResetPatch} from "./comfy-media-overrides";
import type {ComfyWorkflowTemplate} from "./template-schema";

type Binding=NonNullable<CanvasNodeMetadata["comfyMediaPreset"]>;
type ScalarValue=string|number|boolean;
function localValue(field:ComfyInstanceScalarField):unknown{return field.localValue.source==="disconnect"?undefined:field.localValue.value;}
export function DirectPortControl({field,value,overridden,theme,onSet,onReset}:{field:ComfyInstanceScalarField;value:unknown;overridden:boolean;theme:CanvasTheme;
 onSet:(value:ScalarValue)=>void;onReset:()=>void}){
 const kind=field.port.valueKind;
 const initial=typeof value==="string"||typeof value==="number"?String(value):"";
 const [draft,setDraft]=useState(initial);
 const [error,setError]=useState("");
 useEffect(()=>{setDraft(initial);setError("");},[initial,field.port.id]);
 const numeric=kind==="INT"||kind==="FLOAT";
 const saveNumber=()=>{
  if(!numeric||!draft.trim())return;
  const parsed=parseComfyScalarOverride(kind,draft);
  if(parsed.ok){onSet(parsed.value);setError("");}else setError(parsed.error);
 };
 const placeholder=field.mixedTemplateValues&&value===undefined?"模板目标原值不同，请设置覆盖值":value===undefined?"使用工作流默认值":undefined;
 const reset=()=>{setDraft("");setError("");onReset();};
 return <div className="space-y-1.5" data-comfy-media-port={field.port.id}>
  <div className="flex min-w-0 items-center gap-2">
   <label className="min-w-0 flex-1 truncate text-xs font-medium" title={field.port.label}>{field.port.label}</label>
   <span className="shrink-0 rounded border border-stone-300 px-1.5 py-0.5 text-[10px] opacity-60 dark:border-stone-700">{kind}</span>
   {overridden?<Button size="small" type="text" className="!h-6 shrink-0 !px-1.5 text-[11px]" onClick={reset}>恢复默认</Button>:null}
  </div>
  {field.port.choices?.length?<ConfigProvider theme={{token:{colorBgContainer:theme.toolbar.panel,colorBgElevated:theme.toolbar.panel,
   colorText:theme.node.text,colorTextSecondary:theme.node.muted,colorBorder:theme.node.stroke,colorPrimary:theme.node.activeStroke},
   components:{Select:{optionSelectedBg:theme.node.fill,optionSelectedColor:theme.node.text,optionActiveBg:theme.toolbar.itemHover}}}}>
   <Select className="w-full" size="small" allowClear getPopupContainer={()=>document.body}
   classNames={{popup:{root:COMFY_MEDIA_PARAMETER_POPUP_CLASS}}}
   styles={{popup:{root:{zIndex:1301,background:theme.toolbar.panel,color:theme.node.text,borderColor:theme.node.stroke}}}}
   value={field.port.choices.some(choice=>Object.is(choice.value,value))?
   String(field.port.choices.findIndex(choice=>Object.is(choice.value,value))):undefined}
   placeholder={placeholder??"选择参数值"} options={field.port.choices.map((choice,index)=>({value:String(index),label:choice.label}))}
   onChange={(selected:string|undefined)=>{if(selected===undefined){reset();return;}const choice=field.port.choices?.[Number(selected)];if(choice)onSet(choice.value);}}/></ConfigProvider>:
   kind==="BOOLEAN"?<div className="flex items-center gap-2"><Switch size="small" checked={value===true} onChange={onSet}/><span className="text-xs opacity-65">{field.mixedTemplateValues&&value===undefined?"模板目标值不同，请指定覆盖值":value===undefined?"未设置":value?"开启":"关闭"}</span></div>:
   numeric?<InputNumber className="w-full" size="small" stringMode value={draft||undefined} placeholder={placeholder}
    onChange={next=>{setDraft(next==null?"":String(next));setError("");}}
    onBlur={saveNumber} onPressEnter={event=>event.currentTarget.blur()}/>:
   <Input size="small" value={typeof value==="string"?value:""} placeholder={placeholder} onChange={event=>onSet(event.target.value)}/>}
  {error?<div role="alert" className="text-[11px] text-red-500">{error}</div>:null}
 </div>;
}

export function ComfyMediaParameters({template,binding,config,theme,onChange}:{template:ComfyWorkflowTemplate;binding:Binding;config:AiConfig;theme:CanvasTheme;
 onChange:(patch:Partial<CanvasNodeMetadata>)=>void}){
 const useCase=template.mediaUseCase!;
 const excluded=new Set([useCase.promptPortId,...useCase.slots.map(slot=>slot.id)]);
 const node={id:"comfy-media-settings",type:"comfy:workflow",metadata:{comfyWorkflow:{inputOverrides:binding.overrides}}} as CanvasNodeData;
 const fields=getComfyInstanceScalarFields(template,node,[],binding.overrides).filter(field=>!excluded.has(field.port.id));
 const write=(field:ComfyInstanceScalarField,value:ScalarValue)=>onChange(createComfyMediaOverridePatch(binding,field.port.id,value));
 const reset=(field:ComfyInstanceScalarField)=>onChange(createComfyMediaResetPatch(binding,field.port.id));
 const resetAll=()=>onChange(createComfyMediaResetPatch(binding));
 const controls=<div className="space-y-3" data-comfy-media-native-settings>
  {fields.length?fields.map(field=><DirectPortControl key={field.port.id} field={field} value={localValue(field)} theme={theme}
   overridden={Object.hasOwn(binding.overrides,field.port.id)} onSet={value=>write(field,value)} onReset={()=>reset(field)}/>)
   :<p className="text-xs opacity-60">没有可编辑的标量参数。</p>}
  {Object.keys(binding.overrides).length?<Button size="small" onClick={resetAll}>重置全部参数</Button>:null}
 </div>;
 const buttonLabel="工作流参数";
 const buttonClassName="!h-10 !max-w-[170px] !min-w-0 !justify-start !rounded-full !px-3";
 const noChange=()=>{};
 return useCase.primaryOutputKind==="image"?
  <CanvasImageSettingsPopover config={config} onConfigChange={noChange} placement="topLeft" buttonClassName={buttonClassName} buttonLabel={buttonLabel} content={controls}/>:
  useCase.primaryOutputKind==="video"?
   <CanvasVideoSettingsPopover config={config} onConfigChange={noChange} placement="topLeft" buttonClassName={buttonClassName} buttonLabel={buttonLabel} content={controls}/>:
   <CanvasAudioSettingsPopover config={config} onConfigChange={noChange} placement="topLeft" buttonClassName={buttonClassName} buttonLabel={buttonLabel} content={controls}/>;
}
