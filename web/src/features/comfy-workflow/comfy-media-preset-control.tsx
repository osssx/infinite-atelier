import {lazy,Suspense,useCallback,useEffect,useMemo,useState,type ReactNode} from "react";
import {Modal} from "antd";
import type {CanvasConnection,CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {listComfyPresetCatalog,loadComfyPresetCatalogTemplates,type ComfyCatalogLoadFailure,type ComfyCatalogPreset} from "./preset-catalog";
import {getComfyTemplate} from "./template-registry";
import type {ComfyWorkflowTemplate} from "./template-schema";
import {withComfyMediaAspect} from "./comfy-media-aspect";
import {ComfyMediaParameters} from "./comfy-media-parameters";
import type {AiConfig,ModelCapability} from "@/stores/use-config-store";
import type {CanvasTheme} from "@/lib/canvas-theme";
import {assignComfyMediaSlots,resolveComfyMediaMode} from "./comfy-media-slot-assignment";
import type {MediaModeId} from "@/services/media-capabilities";
import {comfyModeLabels as modeLabels} from "./comfy-media-mode-config";

const ComfyWorkflowPanel=lazy(()=>import("./comfy-workflow-panel").then(module=>({default:module.ComfyWorkflowPanel})));

type MediaBinding=NonNullable<CanvasNodeMetadata["comfyMediaPreset"]>;
type Props={node:CanvasNodeData;nodes:readonly CanvasNodeData[];connections:readonly CanvasConnection[];config:AiConfig;theme:CanvasTheme;
 capability?:ModelCapability;defaultPreset?:Pick<MediaBinding,"templateId"|"templateRevision">;
 settingsButtonClassName?:string;settingsPlacement?:"topLeft"|"topRight";
 onChange:(patch:Partial<CanvasNodeMetadata>)=>void;
 onPickerOptionsChange?:(options:{value:string;label:string;disabled?:boolean}[],select:(value:string)=>void,activeValue?:string)=>void};
const family=(kind:string)=>kind==="image"?"image":kind==="video"?"video":kind==="mask"?"mask":"audio";
function workflowCapabilityTags(template:ComfyWorkflowTemplate|undefined):string[]{
 const useCase=template?.mediaUseCase;
 if(!useCase)return [];
 if(!useCase.mediaCapabilities)return [];
 const modes=useCase.mediaCapabilities.modes.filter(mode=>mode.enabled&&useCase.modeBindings?.[mode.id]);
 return modes.length?[...modes.map(mode=>modeLabels[mode.id]),...(modes.some(mode=>mode.layout)?["Layout"]:[])]:["暂无可用能力"];
}
export function useComfyMediaPresetControl({node,nodes,connections,config,theme,capability,onChange,onPickerOptionsChange,defaultPreset,settingsButtonClassName,settingsPlacement,mediaMode}:Props&{mediaMode?:MediaModeId}):{settings:ReactNode;slots:ReactNode;error?:string;supportsLayout:boolean}{
 const [editor,setEditor]=useState<CanvasNodeData|null>(null);
 const [catalogRevision,setCatalogRevision]=useState(0);
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
 }).catch(error=>{if(current){setCatalog([]);setTemplates({});setCatalogError(error instanceof Error?error.message:String(error));}});return()=>{current=false};},[catalogRevision]);
 const preset=node.metadata?.comfyMediaPreset;
 const activePreset=useMemo(()=>preset??(defaultPreset?{...defaultPreset,overrides:{},slots:{}}:undefined),[
  preset,defaultPreset?.templateId,defaultPreset?.templateRevision,
 ]);
 useEffect(()=>{if(!activePreset)return;const key=activePreset.templateId+"@"+activePreset.templateRevision;if(templates[key])return;
  let active=true;void getComfyTemplate(activePreset.templateId,activePreset.templateRevision).then(template=>{
  if(active&&template?.mediaUseCase)setTemplates(current=>({...current,[key]:template}));
  if(active)setBoundPresetError(undefined);
 }).catch(error=>{if(active)setBoundPresetError(error instanceof Error?error.message:String(error));});return()=>{active=false};},[activePreset?.templateId,activePreset?.templateRevision,templates]);
 const template=activePreset?templates[activePreset.templateId+"@"+activePreset.templateRevision]:undefined;
 const useCase=template?.mediaUseCase;
 const activeMode=template?resolveComfyMediaMode(template,node.id,nodes,connections,activePreset?.mediaMode,mediaMode):undefined;
 const options=useMemo(()=>catalog.map(item=>{
  const t=templates[item.templateId+"@"+item.revision];
  if(!t?.mediaUseCase)return null;
  const unavailable=Boolean(mediaMode&&t.mediaUseCase.mediaCapabilities&&!t.mediaUseCase.mediaCapabilities.modes.some(mode=>mode.id===mediaMode&&mode.enabled));
  return {label:item.name+(unavailable?" · 当前模式不可用":""),value:item.templateId+"@"+item.revision,group:family(t.mediaUseCase.primaryOutputKind),disabled:unavailable};
 }).filter((x):x is {label:string;value:string;group:string;disabled:boolean}=>!!x&&capability!=="text"&&x.group===(capability??family(node.type))),[catalog,templates,node.type,capability,mediaMode]);
 const selectPreset=useCallback(async(value:string)=>{
  if(!value){onChange({comfyMediaPreset:undefined});return;}
  const [templateId,revision]=value.split("@");
  const row=catalog.find(item=>item.templateId===templateId&&item.revision===revision);
  const found=templates[value]??(row?await getComfyTemplate(templateId,revision):null);
  if(!found?.mediaUseCase)return;
  const prior=activePreset;
  const cache={...(node.metadata?.comfyMediaPresetCache??{})};
  if(prior)cache[prior.templateId+"@"+prior.templateRevision]=prior;
  const restored=cache[value];
  onChange(withComfyMediaAspect(found,{comfyMediaPresetCache:cache,comfyMediaPreset:restored??{templateId,templateRevision:revision,
   instanceId:prior?.instanceId,overrides:{},slots:{}}}));
 },[activePreset,catalog,node.metadata?.comfyMediaPresetCache,onChange,templates]);
 const pickerOptions=useMemo(()=>[
  ...options.map(({label,value,disabled})=>({label,value,disabled,tags:workflowCapabilityTags(templates[value])})),
  ...(activePreset&&!options.some(option=>option.value===activePreset.templateId+"@"+activePreset.templateRevision)?
   [{label:template?.name??catalog.find(item=>item.templateId===activePreset.templateId&&item.revision===activePreset.templateRevision)?.name??"工作流版本不可用",
     value:activePreset.templateId+"@"+activePreset.templateRevision,tags:workflowCapabilityTags(template),disabled:!template||Boolean(capability&&template.mediaUseCase?.channel!==capability)}]:[])
 ],[options,activePreset,template,catalog,capability,templates]);
 useEffect(()=>{onPickerOptionsChange?.(pickerOptions,selectPreset,activePreset?activePreset.templateId+"@"+activePreset.templateRevision:undefined);},
  [onPickerOptionsChange,pickerOptions,selectPreset,activePreset?.templateId,activePreset?.templateRevision]);
 const assignment=template?assignComfyMediaSlots(template,node.id,nodes,connections,activeMode):undefined;
 const slots=null;
 const openPresetEditor=()=>{
  if(!template||!activePreset)return;
  const entry=catalog.find(item=>item.templateId===activePreset.templateId&&item.revision===activePreset.templateRevision)
   ??catalog.find(item=>item.templateId===activePreset.templateId);
  setEditor({id:entry?.id??template.id,type:"comfy:workflow",title:template.name,position:{x:0,y:0},width:400,height:300,
   metadata:{comfyWorkflow:{templateId:template.id,templateRevision:template.revision,bindingState:"bound",inputOverrides:{}}}});
 };
 const applyPresetEdit=(patch:Partial<CanvasNodeMetadata>)=>{
  const binding=patch.comfyWorkflow;
  if(!binding||!activePreset)return false;
  setEditor(current=>current?{...current,metadata:{...current.metadata,...patch}}:current);
  const mediaPatch={comfyMediaPreset:{...activePreset,templateId:binding.templateId,templateRevision:binding.templateRevision}};
  // The editor has persisted the immutable version before calling this callback.
  void getComfyTemplate(binding.templateId,binding.templateRevision).then(saved=>{
   if(saved){
    setTemplates(current=>({...current,[saved.id+"@"+saved.revision]:saved}));
    onChange(withComfyMediaAspect(saved,mediaPatch));
   }else onChange(mediaPatch);
  }).catch(()=>onChange(mediaPatch));
  setCatalogRevision(current=>current+1);
  return true;
 };
 const settings=<>
  {!editor&&template?.mediaUseCase&&activePreset?<ComfyMediaParameters template={template} binding={activePreset} config={config} theme={theme} onChange={patch=>onChange(withComfyMediaAspect(template,patch))} onEditPreset={openPresetEditor}
   buttonClassName={settingsButtonClassName} placement={settingsPlacement} activeMode={activeMode}/>:null}
  <Modal open={!!editor} title="编辑工作流预设" footer={null} width="min(1200px, 95vw)" destroyOnHidden centered
   styles={{body:{padding:0,height:"min(720px, calc(100dvh - 160px))",minHeight:260,overflow:"hidden"}}}
   onCancel={()=>{setEditor(null);setCatalogRevision(current=>current+1);}}>
   {editor?<div className="h-full min-h-0 min-w-0 w-full" data-comfy-preset-editor-content><Suspense fallback={<div className="p-4">正在加载工作流预设…</div>}>
    <ComfyWorkflowPanel key={editor.id} context="preset" node={editor} onChange={applyPresetEdit}
     onClose={()=>{setEditor(null);setCatalogRevision(current=>current+1);}}/>
   </Suspense></div>:null}
  </Modal>
 </>;
 const error=catalogError?`工作流预设目录加载失败：${catalogError}`:
  catalogFailures.length?`以下预设版本无法加载，请在工作流设置中重新导入：${catalogFailures.map(failure=>`${failure.name} (${failure.presetId}): ${failure.message}`).join("；")}`:
  boundPresetError?`当前绑定的工作流版本无法加载，请重新导入该版本：${boundPresetError}`:undefined;
 const supportsLayout=Boolean(activeMode&&useCase?.mediaCapabilities?.modes.some(mode=>mode.id===activeMode&&mode.enabled&&mode.layout&&useCase.modeBindings?.[mode.id]));
 return {settings,slots,error:error??assignment?.errors.join("；"),supportsLayout};
}
