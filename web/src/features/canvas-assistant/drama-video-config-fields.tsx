import { useEffect, useRef, useState, type CSSProperties } from "react";
import {Clapperboard,Pencil} from "lucide-react";
import { Button } from "antd";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData } from "@/types/canvas";
import {applyDramaProduction,type DramaVideoInput,type DramaShotProduction} from "./drama-pipeline-media";
import { dramaNodeControl, dramaNodePrimary } from "./drama-node-style";
import {useEffectiveConfig,type AiConfig} from "@/stores/use-config-store";
import {DramaVideoTargetPicker,DramaVideoParameterFields,dramaVideoTargetLabel} from "./drama-video-generation-settings";
import {prepareDramaProduction} from "./drama-media-preflight";
import {auditDramaProduction,dramaMediaModes,listDramaProductionCapabilities,type DramaProductionAudit,type DramaProductionCapabilities} from "./drama-production-audit";
import {canvasCasUrl} from "@/features/backend-sync/canvas-cas";
import {DramaEditActions} from "./drama-edit-actions";
import {DramaInlineFeedback,useDramaFieldFeedback} from "./drama-feedback";

import {DramaReferenceImagePicker,DramaImagePreview,type ReferenceImage} from "./drama-reference-image-picker";
import type {WorkspacePendingRegistration} from "./drama-creative-workspace";

type VideoImageField="firstFrame"|"lastFrame"|"gridImage";
const imageSlots=(setting:DramaShotProduction):{key:VideoImageField;label:string}[]=>setting.gridInput?[{key:"gridImage",label:"分镜网格图"}]:
 setting.mode==="first_last_frame"?[{key:"firstFrame",label:"首帧"},{key:"lastFrame",label:"尾帧"}]:
 setting.mode==="first_frame"?[{key:"firstFrame",label:"首帧"}]:[];
function VideoImageSlot({name,storageKey,images,theme}:{name:string;storageKey?:string;images:ReferenceImage[];theme:CanvasTheme}){
 return <div className="min-w-0 space-y-1 rounded-lg border p-2" style={{borderColor:theme.node.stroke}}>
  <p className="text-xs font-medium">{name} · {storageKey?"已选择":"未选择"}</p>
  {storageKey&&<div className="max-w-48"><DramaImagePreview key={storageKey} image={images.find(image=>image.key===storageKey)??{key:storageKey,title:name}} theme={theme}/></div>}
 </div>;
}

/** Stage mode edits per shot, like the storyboard fields. Canvas image picking
 * closes the editor, so an explicitly picked image commits using its captured shot ID.
 */
function VideoModeField({shotId,setting,disabled,theme,capabilities,config,shotDuration,onChange,onPickImage,images,projectId,onPendingChange,onEditingChange,onWaitForSave}:{
 shotId:string;setting:DramaShotProduction;disabled:boolean;theme:CanvasTheme;
 capabilities:DramaProductionCapabilities|null;config:AiConfig;shotDuration?:number;
 onChange?:(shotId:string,value:DramaShotProduction)=>void;
 onPickImage?:(onPick:(storageKey:string)=>void)=>void;
 images?:ReferenceImage[];projectId?:string;onPendingChange?:WorkspacePendingRegistration;onEditingChange?:(editing:boolean)=>void;onWaitForSave?:()=>Promise<void>;
}){
 const [edit,setEdit]=useState<{baseline:string;value:DramaShotProduction}|null>(null);
 const [saving,setSaving]=useState(false);
 const [saveError,setSaveError]=useState("");
 const [draftCapability,setDraftCapability]=useState<{key:string;value:DramaProductionCapabilities|null}|null>(null);
 const changedTarget=Boolean(edit&&JSON.stringify(edit.value.target??{kind:"inherit"})!==JSON.stringify(setting.target??{kind:"inherit"}));
 const draftKey=changedTarget?JSON.stringify([edit?.value.target,config]):"";
 const targetSetting=edit?.value.target;
 const draftResult=draftCapability?.key===draftKey?draftCapability:null;
 const checking=changedTarget&&!draftResult;
 const effectiveCapabilities=changedTarget?draftResult?.value??null:capabilities;
 useEffect(()=>{
  if(!draftKey){setDraftCapability(null);return;}
  let current=true;setDraftCapability(null);
  void listDramaProductionCapabilities(config,{mode:setting.mode,target:targetSetting}).then(value=>{
   if(current)setDraftCapability({key:draftKey,value});
  }).catch(()=>{if(current)setDraftCapability({key:draftKey,value:null});});
  return ()=>{current=false;};
 },[draftKey,config]);
 const updated=useDramaFieldFeedback();
 const inline=images!==undefined;
 const dirty=Boolean(edit&&JSON.stringify(edit.value)!==edit.baseline);
 const pendingKey="video-production:"+shotId;
 const commitRef=useRef<()=>Promise<void>>(async()=>{});
 commitRef.current=async()=>{
  if(!edit)return;
  if(disabled||saving||!onChange||(edit.baseline!==JSON.stringify(setting)&&JSON.stringify(edit.value)!==JSON.stringify(setting)))throw Error("视频输入配置已变化或暂不可保存，请取消后重试。");
  if(checking||changedTarget&&!effectiveCapabilities?.modes.some(mode=>mode.available))throw Error("请选择可用的视频渠道，等待能力检查完成。");
  if(edit.value.durationSec!==undefined&&(!Number.isFinite(edit.value.durationSec)||edit.value.durationSec<=0))throw Error("视频时长必须大于零。");
  setSaving(true);setSaveError("");
  try{
   if(dirty&&JSON.stringify(edit.value)!==JSON.stringify(setting))onChange(shotId,edit.value);
   await onWaitForSave?.();
   if(dirty)updated("视频输入模式");
   setEdit(null);
  }catch(error){setSaveError(error instanceof Error?error.message:"保存视频输入配置失败");throw error;}
  finally{setSaving(false);}
 };
 useEffect(()=>{
  onEditingChange?.(Boolean(edit));return ()=>onEditingChange?.(false);
 },[Boolean(edit),onEditingChange]);
 useEffect(()=>{
  if(!onPendingChange)return;
  onPendingChange(pendingKey,dirty?()=>commitRef.current():null);
  return ()=>onPendingChange(pendingKey,null);
 },[onPendingChange,pendingKey,dirty]);

 const stale=Boolean(edit&&edit.baseline!==JSON.stringify(setting)&&JSON.stringify(edit.value)!==JSON.stringify(setting));
 const effective=edit?.value??setting;
 const choice=effective.gridInput?"grid":effective.mode;
 const currentAbility=effectiveCapabilities?.modes.find(mode=>mode.mode===choice);
 const patchValue=(value:DramaShotProduction)=>setEdit(current=>current?{...current,value}:current);
 const invalidTarget=checking||changedTarget&&!effectiveCapabilities?.modes.some(mode=>mode.available);
 const label=dramaMediaModes.find(item=>item.id===(setting.gridInput?"grid":setting.mode))?.label??setting.mode;
 const card={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 const field={...card,"--tw-ring-color":theme.node.activeStroke} as CSSProperties;
 const chooseMode=(mode:string)=>setEdit(current=>current?{...current,value:{
   ...current.value,gridInput:mode==="grid",
   mode:mode==="grid"?"omni_reference":mode as DramaShotProduction["mode"]}}:current);
 const pick=(key:"firstFrame"|"lastFrame"|"gridImage")=>{
  if(disabled||!onPickImage||!onChange||!edit||stale||invalidTarget)return;
  const pending={...edit.value};
  // Canvas image selection closes the maximized editor before the callback runs.
  // Commit at explicit image selection so the mode and image survive unmount.
  onPickImage(storageKey=>{
   if(!storageKey)return;
   onChange(shotId,{...pending,[key]:storageKey});
   setEdit(null);
  });
 };
 return <section aria-label="视频输入模式区域" data-video-mode-field={edit?"editing":"reading"}
  className={edit?"min-w-0 space-y-3 rounded-xl border p-3 sm:p-4":"min-w-0 space-y-1.5"}
  style={edit?{...card,background:theme.node.fill}:undefined}>
  <div className="flex min-h-7 items-center gap-1.5 text-xs font-medium" style={{color:theme.node.muted}}>
   <span>生成设置</span>
   {!edit&&<button type="button" title="编辑视频输入模式" aria-label="编辑视频输入模式"
    className="inline-grid size-7 place-items-center rounded-md border border-transparent hover:opacity-80 focus-visible:outline focus-visible:outline-2"
    style={{color:theme.node.muted,outlineColor:theme.node.activeStroke}}
    disabled={disabled||!onChange}
    onClick={()=>setEdit({baseline:JSON.stringify(setting),value:{...setting}})}>
    <Pencil size={13} aria-hidden="true"/>
   </button>}
   {edit&&<span className="ml-auto shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold"
     style={{background:theme.toolbar.activeBg,color:theme.toolbar.activeText}}>编辑中</span>}
  </div>
  {edit?<>
   <DramaVideoTargetPicker config={config} value={effective} theme={theme} disabled={disabled||saving||stale} onChange={patchValue}/>
   <label className="block text-xs" style={{color:theme.node.muted}}>视频输入模式</label>
   <select aria-label="视频输入模式" className="w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm"
    style={field} disabled={disabled||saving||stale||checking||!effectiveCapabilities} value={choice} onChange={event=>chooseMode(event.target.value)}>
    {dramaMediaModes.map(item=>{
     const ability=effectiveCapabilities?.modes.find(value=>value.mode===item.id);
     return <option key={item.id} value={item.id} disabled={ability?!ability.available:false}
      title={ability?.reason}>{item.label}{ability&&!ability.available?"（不支持）":""}</option>;
    })}
   </select>
   {checking?<DramaInlineFeedback theme={theme} level="info" pending>正在检查所选渠道的输入能力…</DramaInlineFeedback>:
    changedTarget&&!effectiveCapabilities?<DramaInlineFeedback theme={theme}>无法读取所选渠道的能力，请重新选择。</DramaInlineFeedback>:
    currentAbility&&!currentAbility.available?<DramaInlineFeedback theme={theme}>{currentAbility.reason??"当前渠道不支持所选输入模式，请手动选择可用模式。"}</DramaInlineFeedback>:null}
   <DramaVideoParameterFields config={config} value={effective} capabilities={effectiveCapabilities} shotDuration={shotDuration} theme={theme}
    disabled={disabled||saving||stale||checking} editing onChange={patchValue}/>
   {inline?<div className="grid min-w-0 gap-2">
    {imageSlots(effective).map(slot=><div key={slot.key} className="min-w-0 space-y-2">
     <VideoImageSlot name={slot.label} storageKey={effective[slot.key]} images={images} theme={theme}/>
     <div className="flex flex-wrap items-start gap-2">
      <DramaReferenceImagePicker name={slot.label} images={images} boundKeys={[]} theme={theme} projectId={projectId}
       disabled={disabled||saving||stale||!onChange} selectLabel={(effective[slot.key]?"更换":"选择")+slot.label} confirmLabel="使用图片"
       onAdd={key=>setEdit(current=>current?{...current,value:{...current.value,[slot.key]:key}}:current)}/>
      {effective[slot.key]&&<button type="button" className="rounded-lg border px-2 py-2 text-xs" style={card} disabled={disabled||saving||stale}
       onClick={()=>setEdit(current=>{if(!current)return current;const value={...current.value};delete value[slot.key];return {...current,value};})}>清除{slot.label}</button>}
     </div>
    </div>)}
    {imageSlots(effective).length>0&&<p className="text-[11px]" style={{color:theme.node.muted}}>选图仅修改当前草稿，确认视频输入模式后才保存；取消将放弃本次全部更改。</p>}
   </div>:<>
   {effective.gridInput&&<button type="button" className="rounded-lg border px-3 py-2 text-xs"
    style={card} disabled={disabled||!onPickImage||!onChange||stale} onClick={()=>pick("gridImage")}>
    {effective.gridImage?"更换分镜网格图":"选择分镜网格图"}
   </button>}
   {(effective.mode==="first_frame"||effective.mode==="first_last_frame")&&!effective.gridInput&&
    <div className="flex flex-wrap gap-2">
     <button type="button" className="rounded-lg border px-3 py-2 text-xs" style={card}
      disabled={disabled||!onPickImage||!onChange||stale} onClick={()=>pick("firstFrame")}>
      {effective.firstFrame?"更换首帧":"选择首帧"}
     </button>
     {effective.mode==="first_last_frame"&&<button type="button" className="rounded-lg border px-3 py-2 text-xs"
      style={card} disabled={disabled||!onPickImage||!onChange||stale} onClick={()=>pick("lastFrame")}>
      {effective.lastFrame?"更换尾帧":"选择尾帧"}
     </button>}
    </div>}
   {effective.gridInput&&effective.gridImage&&<p className="break-all text-[11px]" style={{color:theme.node.muted}}>
    已选择分镜网格图</p>}
   {!effective.gridInput&&(effective.mode==="first_frame"||effective.mode==="first_last_frame")&&
    <p className="break-all text-[11px]" style={{color:theme.node.muted}}>
     首帧：{effective.firstFrame?"已选择":"未选择"}
     {effective.mode==="first_last_frame"?" · 尾帧："+(effective.lastFrame?"已选择":"未选择"):""}
    </p>}
   {onPickImage&&(effective.gridInput||effective.mode==="first_frame"||effective.mode==="first_last_frame")&&
    <p className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>
     从画布选择图片后，会立即保存当前输入模式和所选图片，以便返回画布后继续配置。
    </p>}
   </>}
   {saveError&&<DramaInlineFeedback theme={theme} level="error" error={saveError}/>}
   {saving&&<DramaInlineFeedback theme={theme} level="info" pending>正在保存视频输入配置…</DramaInlineFeedback>}
   {stale&&<DramaInlineFeedback theme={theme}>视频输入配置已在其他位置更新，请取消并重新编辑。</DramaInlineFeedback>}
   <DramaEditActions label="视频输入模式" theme={theme} disabled={disabled||saving||stale||!onChange||invalidTarget}
    onCancel={()=>{if(!saving){setEdit(null);setSaveError("");}}}
    onConfirm={()=>{void commitRef.current().catch(()=>{});}}/>
  </>:<>
   <div className="grid gap-1 text-xs">
    <span style={{color:theme.node.muted}}>视频渠道</span>
    <div className="rounded-md px-3 py-2 text-sm break-words" style={{background:theme.toolbar.activeBg}}>{dramaVideoTargetLabel(config,setting,capabilities)}</div>
   </div>
   <DramaVideoParameterFields config={config} value={setting} capabilities={capabilities} shotDuration={shotDuration} theme={theme} disabled={disabled} editing={false}/>
   <span className="block text-xs" style={{color:theme.node.muted}}>视频输入模式</span>
   <div data-video-mode-readonly="" className="rounded-md border-l-2 px-3 py-2.5 text-sm"
    style={{background:theme.toolbar.activeBg,borderLeftColor:theme.node.stroke,color:theme.node.text}}>
    <div>{label}</div>
    {inline?<div className="mt-2 grid gap-2 sm:grid-cols-2">{imageSlots(setting).map(slot=><VideoImageSlot key={slot.key} name={slot.label} storageKey={setting[slot.key]} images={images} theme={theme}/>)}</div>:setting.gridInput?<p className="mt-1 break-all text-xs" style={{color:theme.node.muted}}>
      网格图：{setting.gridImage?"已选择":"未选择"}</p>:
     (setting.mode==="first_frame"||setting.mode==="first_last_frame")?
     <p className="mt-1 text-xs" style={{color:theme.node.muted}}>
      首帧：{setting.firstFrame?"已选择":"未选择"}
      {setting.mode==="first_last_frame"?" · 尾帧："+(setting.lastFrame?"已选择":"未选择"):""}
     </p>:null}
   </div></>}
 </section>;
}

export function DramaVideoConfigFields({
    inputs, episodes, configs, missingCount, missingFor, hasUnconfirmedChanges, disabled, theme, onCreateSelected, onAction,
    productionStyle,production={},onProductionChange,onPickImage,onRefresh,confirmedRevisionId,onCreateBatch,
    expanded=false,initialEpisodeId,initialShotId,embedded=false,confirmedInput=true,images,projectId,onPendingChange,onEditingChange,onWaitForSave,
}: {
    inputs: DramaVideoInput[];
    expanded?:boolean;initialEpisodeId?:string;initialShotId?:string;embedded?:boolean;confirmedInput?:boolean;
    images?:ReferenceImage[];projectId?:string;onPendingChange?:WorkspacePendingRegistration;onEditingChange?:(editing:boolean)=>void;onWaitForSave?:()=>Promise<void>;
    episodes: {id: string; title: string}[];
    configs?: ReadonlyMap<string, CanvasNodeData>;
    missingCount: number;
    missingFor: (input: DramaVideoInput) => string[];
    hasUnconfirmedChanges: boolean;
    disabled: boolean;
    theme: CanvasTheme;
    onCreateSelected: (inputs:DramaVideoInput[]) => void;
    onCreateBatch?:(shotIds:string[])=>Promise<void>;
    onAction: (input: DramaVideoInput, existing?: CanvasNodeData) => void;
    productionStyle?:string;
    confirmedRevisionId?:string;
    production?:Record<string,DramaShotProduction>;
    onProductionChange?:(shotId:string,value:DramaShotProduction)=>void;
    onPickImage?:(onPick:(storageKey:string)=>void)=>void;
    onRefresh?:(id:string,input:DramaVideoInput,fields:{prompt:boolean;duration:boolean;references?:boolean;overwrite:boolean})=>void;
}) {
    const [episodeId, setEpisodeId] = useState(initialEpisodeId??"");
    const [shotId, setShotId] = useState(initialShotId??"");
    const [error,setError]=useState("");
    const [refreshPrompt,setRefreshPrompt]=useState(true);
    const [refreshReferences,setRefreshReferences]=useState(false);
    const [refreshDuration,setRefreshDuration]=useState(false);
    const [overwrite,setOverwrite]=useState(false);
    const [capabilities,setCapabilities]=useState<DramaProductionCapabilities|null>(null);
    const [auditResult,setAudit]=useState<{key:string;value:DramaProductionAudit}|null>(null);
    const [auditing,setAuditing]=useState(false);
    const [modeEditing,setModeEditing]=useState(false);
    const [videoTab,setVideoTab]=useState<"settings"|"prompt"|"references">("settings");
    useEffect(()=>{onEditingChange?.(modeEditing);return ()=>onEditingChange?.(false);},[modeEditing,onEditingChange]);

    const config=useEffectiveConfig();
    const episodeIds = [...new Set(inputs.map(({shot}) => shot.episodeId))];
    const activeEpisode = episodeIds.includes(episodeId) ? episodeId : (inputs.find(input=>input.shot.id===initialShotId)?.shot.episodeId??episodeIds[0]);
    const episodeInputs = inputs.filter(({shot}) => shot.episodeId === activeEpisode)
        .sort((a, b) => a.shot.order - b.shot.order);
    const active = episodeInputs.find(({shot}) => shot.id === shotId) ?? episodeInputs[0];
    const control = dramaNodeControl(theme);
    const muted = {color:theme.node.muted};
    const card = {background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
    const fieldStyle = {...card,"--tw-ring-color":theme.node.activeStroke} as CSSProperties;
    const existing = active?configs?.get(active.shot.id):undefined;
    const setting=active?(production[active.shot.id]??{
        mode:active.referenceImages.length?"omni_reference":"text_to_video",
    } as DramaShotProduction):undefined;
    let preview=active;
    let previewError="";
    if(active&&setting)try{preview=applyDramaProduction(active,setting);}
    catch(error){previewError=error instanceof Error?error.message:"输入配置无效";}
    const missing=active?missingFor(active):[];
    const requiredMissing=setting?.mode==="omni_reference"&&!setting.gridInput?missing:[];
    const auditKey=JSON.stringify([preview,setting,requiredMissing,productionStyle,confirmedRevisionId,previewError,confirmedInput,config]);
    const audit=auditResult?.key===auditKey?auditResult.value:null;
    useEffect(()=>{
        let current=true;
        setAudit(null);setCapabilities(null);setAuditing(Boolean(confirmedInput&&preview&&!previewError));
        void listDramaProductionCapabilities(config,setting).then(available=>{
            if(current)setCapabilities(available);
        }).catch(()=>{if(current)setCapabilities(null);});
        if(confirmedInput&&preview&&setting&&!previewError){
            void auditDramaProduction(preview,config,{setting,missingReferenceIds:requiredMissing,
                visualStyle:productionStyle,sourceRevisionId:confirmedRevisionId}).then(result=>{
                if(current)setAudit({key:auditKey,value:result});
            }).catch(error=>{
                if(current)setError(error instanceof Error?error.message:"媒体输入预检失败");
            }).finally(()=>{if(current)setAuditing(false);});
        }else setAuditing(false);
        return ()=>{current=false;};
    },[auditKey,config]);
    if (!active||!preview||!setting) return <p className="rounded-xl border border-dashed px-3 py-4" style={control}>
        确认分镜后可创建视频配置。
    </p>;
    const source = existing?.metadata?.dramaVideoSource;
    const referenceKeys = preview.referenceImages.flatMap(reference=>reference.storageKey?[reference.storageKey]:[]);
    const outdated = source && (source.visualStyle!==productionStyle||(source.promptShot??source.shot)!==JSON.stringify(active.shot)||
        JSON.stringify(source.referenceKeys)!==JSON.stringify(referenceKeys));
    const field = "w-full min-w-0 rounded-lg border px-3 py-1.5 leading-relaxed";
    return <section aria-label="镜头视频配置" data-video-config-layout={expanded?"expanded":"compact"}
        className={embedded?"min-w-0 space-y-3":expanded?
            "grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(116px,0.28fr)_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(220px,0.33fr)_minmax(0,1fr)] lg:grid-rows-1":
            "grid min-w-0 gap-3"} style={{color:theme.node.text}}>
        {!embedded&&(expanded?<aside aria-label="视频配置镜头目录"
            className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border" style={card}>
            <div className="grid shrink-0 gap-2 border-b p-3" style={{borderColor:theme.node.stroke}}>
                <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold">
                        <Clapperboard size={15} style={muted} aria-hidden="true"/>镜头目录
                    </span>
                    <span className="rounded-md px-2 py-1 text-[11px] font-medium tabular-nums"
                        style={{background:theme.toolbar.activeBg,color:theme.node.muted}}>{episodeInputs.length} 镜</span>
                </div>
                <label className="grid min-w-0 gap-1 text-xs" style={muted}>当前剧集
                    <select aria-label="选择视频配置剧集" className="w-full min-w-0 rounded-lg border px-2.5 py-2 text-xs"
                        style={fieldStyle} value={activeEpisode} onChange={event=>{
                            setEpisodeId(event.target.value);setShotId("");
                        }}>
                        {episodeIds.map(id=><option key={id} value={id}>
                            {episodes.find(episode=>episode.id===id)?.title||id}</option>)}
                    </select>
                </label>
            </div>
            <nav aria-label="视频配置镜头导航" className="thin-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto p-2"
                data-canvas-no-zoom="">
                {episodeInputs.map(({shot},index)=>{
                    const current=shot.id===active.shot.id;
                    const configured=Boolean(configs?.has(shot.id));
                    return <button type="button" key={shot.id} aria-pressed={current}
                        aria-label={`选择视频镜头 ${index+1}：${shot.shotSize||shot.id}`}
                        onClick={()=>{setShotId(shot.id);setError("");}}
                        className="flex w-full min-w-0 items-start gap-2.5 rounded-lg border px-3 py-3 text-left transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={current?{background:theme.toolbar.activeBg,color:theme.node.text,borderColor:theme.node.stroke,
                            outlineColor:theme.node.activeStroke}:{background:"transparent",color:theme.node.text,borderColor:"transparent",
                            outlineColor:theme.node.activeStroke}}>
                        <span className="mt-0.5 shrink-0 text-[11px] font-semibold tabular-nums" style={muted}>
                            {String(index+1).padStart(2,"0")}
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold">{shot.shotSize?.trim()||"未设置景别"}</span>
                            <span className="mt-1 block truncate text-[11px]" style={muted}>{shot.description?.trim()||"暂无画面描述"}</span>
                        </span>
                        <span className="shrink-0 rounded-md border px-1.5 py-0.5 text-[10px]"
                            style={{borderColor:theme.node.stroke,color:configured?theme.node.text:theme.node.muted,
                                background:configured?theme.toolbar.activeBg:theme.node.panel}}>
                            {configured?"已配置":"待配置"}
                        </span>
                    </button>;
                })}
            </nav>
        </aside>:
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="grid min-w-0 gap-1 text-xs">剧集
                <select className={field} style={control} value={activeEpisode} onChange={event=>{
                    setEpisodeId(event.target.value);setShotId("");
                }}>
                    {episodeIds.map(id => <option key={id} value={id}>{episodes.find(episode => episode.id === id)?.title || id}</option>)}
                </select>
            </label>
            <label className="grid min-w-0 gap-1 text-xs">镜头
                <select className={field} style={control} value={active.shot.id} onChange={event => setShotId(event.target.value)}>
                    {episodeInputs.map(({shot}, index) => <option key={shot.id} value={shot.id}>
                        镜头 {index + 1} · {shot.shotSize || shot.id}
                    </option>)}
                </select>
            </label>
        </div>)}
        <div aria-label="当前视频配置编辑区" data-canvas-no-zoom=""
            className={embedded?"min-w-0 space-y-3 rounded-xl border p-3":expanded?"thin-scrollbar min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain rounded-xl border p-3 sm:p-5":
                "grid min-w-0 gap-3 rounded-xl border p-3 sm:p-4"} style={card}>
            {embedded&&<header className="flex items-center justify-between gap-2 border-b pb-2" style={{borderColor:theme.node.stroke}}><h4 className="text-sm font-semibold">视频配置</h4><span className="text-xs" style={muted}>{!confirmedInput?"未确认":existing?"已配置":"待配置"}</span></header>}
            {expanded&&!embedded&&<header className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b pb-3"
                style={{borderColor:theme.node.stroke}}>
                <div className="min-w-0">
                    <p className="text-[11px] font-medium" style={muted}>
                        第 {episodeIds.indexOf(activeEpisode)+1} 集 · 镜头 {episodeInputs.findIndex(item=>item.shot.id===active.shot.id)+1}
                    </p>
                    <h3 className="mt-1 truncate text-base font-semibold">{active.shot.shotSize?.trim()||"未设置景别"}</h3>
                </div>
                <span className="shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium"
                    style={{...card,background:existing?theme.toolbar.activeBg:theme.node.panel}}>
                    {existing?"已配置":"待配置"} · {active.shot.durationSec??"—"} 秒
                </span>
            </header>}
            {!embedded&&<div className="grid min-w-0 gap-1.5">
                <span className="text-xs font-medium" style={{color:theme.node.muted}}>画面描述</span>
                <p data-storyboard-video-description="" className="min-w-0 rounded-md border-l-2 px-3 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap"
                    style={{background:theme.toolbar.activeBg,borderLeftColor:theme.node.stroke,color:theme.node.text}}>
                    {active.shot.description?.trim()||"未填写"}
                </p>
            </div>}
            {expanded&&<nav aria-label="视频配置页面" className="flex min-w-0 gap-1 border-b pb-1" style={{borderColor:theme.node.stroke}}>
                {([{id:"settings",label:"生成设置"},{id:"prompt",label:"提示词"},{id:"references",label:"参考素材"}] as const).map(item=><button type="button" key={item.id}
                    aria-pressed={videoTab===item.id} disabled={modeEditing||item.id!=="settings"&&!confirmedInput}
                    title={modeEditing?"请先保存或取消当前生成设置":undefined} className="min-h-7 rounded-md px-3 text-xs font-medium disabled:opacity-45"
                    style={videoTab===item.id?{background:theme.toolbar.activeBg,color:theme.node.text}:muted} onClick={()=>setVideoTab(item.id)}>{item.label}</button>)}
            </nav>}
            {expanded&&videoTab==="settings"&&<VideoModeField key={active.shot.id} shotId={active.shot.id}
                setting={setting} disabled={disabled} theme={theme} capabilities={capabilities} config={config} shotDuration={active.shot.durationSec}
                onPickImage={onPickImage} onChange={onProductionChange} images={images} projectId={projectId}
                onPendingChange={onPendingChange} onEditingChange={setModeEditing} onWaitForSave={onWaitForSave}/>}
            {!expanded&&<>
            <label className="grid gap-1.5 text-xs">视频输入模式
                <select aria-label="视频输入模式" className={field} style={control} disabled={disabled} value={setting.gridInput?"grid":setting.mode}
                    onChange={event=>onProductionChange?.(active.shot.id,{...setting,
                        gridInput:event.target.value==="grid",mode:event.target.value==="grid"?"omni_reference":event.target.value as DramaShotProduction["mode"]})}>
                    {dramaMediaModes.map(choice=>{
                        const availability=capabilities?.modes.find(item=>item.mode===choice.id);
                        return <option key={choice.id} value={choice.id} disabled={availability?!availability.available:false}
                            title={availability?.reason}>{choice.label}{availability&&!availability.available?"（不支持）":""}</option>;
                    })}                </select>
            </label>
            {setting.gridInput&&<Button style={control} disabled={disabled||!onPickImage} onClick={()=>onPickImage?.(key=>
                onProductionChange?.(active.shot.id,{...setting,gridImage:key}))}>{setting.gridImage?"更换分镜网格图":"选择分镜网格图"}</Button>}
            {(setting.mode==="first_frame"||setting.mode==="first_last_frame")&&
                <div className="flex flex-wrap gap-2">
                    <Button style={control} disabled={disabled||!onPickImage} onClick={()=>onPickImage?.(key=>
                        onProductionChange?.(active.shot.id,{...setting,firstFrame:key}))}>{setting.firstFrame?"更换首帧":"选择首帧"}</Button>
                    {setting.mode==="first_last_frame"&&<Button style={control} disabled={disabled||!onPickImage} onClick={()=>onPickImage?.(key=>
                        onProductionChange?.(active.shot.id,{...setting,lastFrame:key}))}>{setting.lastFrame?"更换尾帧":"选择尾帧"}</Button>}
                </div>}

                </>}
            {existing && !source && <p className="rounded-lg border px-3 py-2 text-xs" style={{...card,color:theme.node.muted}}>旧配置来源待核对。</p>}
            {outdated && <p role="status" className="rounded-lg border px-3 py-2 text-xs"
                style={{...card,background:theme.toolbar.activeBg}}>分镜或参考图已有更新，现有配置仍保留原设置。</p>}
            {confirmedInput&&existing&&source?.basePrompt&&onRefresh&&<details key={existing.id} className="min-w-0 rounded-lg border p-3 text-xs"
                style={card}>
                <summary className="cursor-pointer py-1 font-medium">选择采用的分镜更新</summary>
                <div className="mt-3 space-y-2 border-t pt-3" style={{borderColor:theme.node.stroke}}>
                <label className="flex min-w-0 items-center gap-2"><input type="checkbox" style={{accentColor:theme.node.activeStroke}} checked={refreshPrompt}
                    disabled={refreshReferences} onChange={event=>setRefreshPrompt(event.target.checked)}/> 镜头提示词</label>
                <label className="flex min-w-0 items-center gap-2"><input type="checkbox" style={{accentColor:theme.node.activeStroke}} checked={refreshDuration}
                    onChange={event=>setRefreshDuration(event.target.checked)}/> 镜头时长</label>
                <label className="flex min-w-0 items-center gap-2"><input type="checkbox" style={{accentColor:theme.node.activeStroke}} checked={refreshReferences}
                    onChange={event=>{setRefreshReferences(event.target.checked);if(event.target.checked)setRefreshPrompt(true);}}/> 参考图和输入模式</label>
                <label className="flex min-w-0 items-center gap-2"><input type="checkbox" style={{accentColor:theme.node.activeStroke}} checked={overwrite}
                    onChange={event=>setOverwrite(event.target.checked)}/> 覆盖所选字段中的人工修改</label>
                <pre className="thin-scrollbar max-h-36 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-2 text-xs"
                    style={{...card,background:theme.toolbar.activeBg}}>{active.prompt}</pre>
                <Button size="middle" style={control} disabled={disabled||modeEditing||(!refreshPrompt&&!refreshDuration)} onClick={async()=>{
                    try{
                        if(previewError)throw Error(previewError);
                        const selectedWorkflow=existing.metadata?.comfyWorkflowSelections?.video;
                        const prepared=refreshReferences?await prepareDramaProduction(preview,{...config,
                            videoModel:existing.metadata?.model||config.videoModel,
                            comfyWorkflowDefaults:{...config.comfyWorkflowDefaults,video:selectedWorkflow}}):preview;
                        onRefresh(existing.id,prepared,{prompt:refreshPrompt,duration:refreshDuration,references:refreshReferences,overwrite});
                        setError("");
                        setOverwrite(false);
                    }catch(error){setError(error instanceof Error?error.message:"更新失败");}
                }}>采用所选更新</Button>
                </div>
            </details>}
            {confirmedInput&&expanded&&videoTab==="prompt"&&<section aria-label="视频提示词" className="min-w-0 space-y-2">
                <div className="flex items-center justify-between text-xs"><strong>视频提示词</strong><span style={muted}>{setting.promptOverride?"已手动修改":"自动生成"}</span></div>
                <pre className="thin-scrollbar max-h-96 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 text-sm"
                    style={{...card,background:theme.toolbar.activeBg}}>{audit?.prompt??setting.promptOverride?.text??[preview.prompt,productionStyle&&"影片风格："+productionStyle].filter(Boolean).join("\n")}</pre>
            </section>}
            {confirmedInput&&expanded&&videoTab==="references"&&<section aria-label="视频参考素材" className="min-w-0 space-y-2 text-xs">
                <div className="flex justify-between"><strong>绑定素材</strong><span style={muted}>引用图片 {preview.referenceImages.length} 张</span></div>
                <div className="flex min-w-0 flex-wrap gap-2">
                    {preview.referenceImages.map((reference,index)=><div key={reference.id} className="grid max-w-28 gap-1">
                        {reference.storageKey&&<img loading="lazy" src={canvasCasUrl(reference.storageKey)??""} alt={reference.name} className="size-20 rounded object-cover"/>}
                        <span className="break-words text-xs">{index+1}. {reference.name}</span>
                    </div>)}
                </div>
                {!!requiredMissing.length&&<p role="alert">缺少 {requiredMissing.length} 项必需参考图</p>}
                {!preview.referenceImages.length&&!requiredMissing.length&&<p style={muted}>当前输入模式没有已绑定参考图。</p>}
            </section>}
            {confirmedInput&&<div aria-label="逐镜媒体输入预检" className="min-w-0 space-y-1 text-xs">
                {auditing&&<p role="status" style={muted}>正在核验工作流端口和媒体约束…</p>}
                {(previewError||audit&&!audit.ready)&&<DramaInlineFeedback theme={theme}>{!previewError&&requiredMissing.length&&setting.mode==="omni_reference"?`缺少 ${requiredMissing.length} 项必需参考图，请核对素材绑定`:previewError||audit?.error}。请选择可用模式，补齐素材或调整模板参数。</DramaInlineFeedback>}
            </div>}
            {!confirmedInput&&<p role="status" className="text-xs" style={muted}>请先确认当前镜头，再进行媒体预检和创建视频配置。</p>}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3" style={{borderColor:theme.node.stroke}}>
                <span className="min-w-0 text-[11px]" style={muted}>
                    {!confirmedInput?"未确认":auditing?"正在核验":audit?.ready?"输入预检通过":previewError||audit&&!audit.ready?"输入尚未通过预检":"等待预检"}
                </span>
                <Button size="middle" disabled={disabled||modeEditing||!existing&&(!confirmedInput||auditing||!audit?.ready||!!previewError)}
                    style={disabled ? control : dramaNodePrimary(theme)}
                    onClick={async () => {
                        try{
                            setError("");
                            if(existing){onAction(active,existing);return;}
                            if(!confirmedInput||!audit?.ready||!audit.input||auditing||previewError)
                                throw Error(previewError||audit?.error||"请先通过当前镜头输入预检");
                            onAction(audit.input,existing);
                        }
                        catch(error){setError(error instanceof Error?error.message:"输入配置无效");}
                    }}>{existing ? "打开配置" : "创建视频配置"}</Button>
            </div>
        {hasUnconfirmedChanges && <p className="text-xs" style={muted}>当前使用最近一次确认的分镜。</p>}
        {!embedded&&<DramaBatchConfigPanel inputs={inputs} episodes={episodes} configs={configs} missingCount={missingCount}
            missingFor={missingFor} disabled={disabled} theme={theme} production={production}
            productionStyle={productionStyle} confirmedRevisionId={confirmedRevisionId}
            initialEpisodeId={activeEpisode} onCreateSelected={onCreateSelected} onCreateBatch={onCreateBatch} embedded/>}
        {error&&<DramaInlineFeedback theme={theme} level="error" error={error}/>}
        </div>
    </section>;
}
/** Batch-only production preparation. No single-shot capability audit is mounted here. */
export function DramaBatchConfigPanel({inputs,episodes,configs,missingCount,missingFor,disabled,theme,production={},productionStyle,confirmedRevisionId,initialEpisodeId,onCreateSelected,onCreateBatch,embedded=false}:{
 inputs:DramaVideoInput[];episodes:{id:string;title:string}[];configs?:ReadonlyMap<string,CanvasNodeData>;
 missingCount:number;missingFor:(input:DramaVideoInput)=>string[];disabled:boolean;theme:CanvasTheme;
 production?:Record<string,DramaShotProduction>;productionStyle?:string;confirmedRevisionId?:string;initialEpisodeId?:string;
 onCreateSelected:(inputs:DramaVideoInput[])=>void;onCreateBatch?:(shotIds:string[])=>Promise<void>;embedded?:boolean;
}){
 const config=useEffectiveConfig();
 const [episodeId,setEpisodeId]=useState(initialEpisodeId??"");
 const [selected,setSelected]=useState<string[]>([]);
 const [batchShots,setBatchShots]=useState<string[]>([]);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const episodeIds=[...new Set(inputs.map(input=>input.shot.episodeId))];
 const activeEpisode=episodeIds.includes(episodeId)?episodeId:episodeIds[0];
 const episodeInputs=inputs.filter(input=>input.shot.episodeId===activeEpisode).sort((a,b)=>a.shot.order-b.shot.order);
 const selectedInputs=inputs.filter(input=>selected.includes(input.shot.id)&&!configs?.has(input.shot.id));
 const control=dramaNodeControl(theme),muted={color:theme.node.muted};
 const card={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 if(!inputs.length)return <p className="rounded-xl border border-dashed p-4 text-xs" style={control}>确认分镜后可批量创建视频配置。</p>;
 return <section aria-label="批量创建配置" className="thin-scrollbar min-h-0 min-w-0 space-y-3 overflow-y-auto overscroll-contain" style={{color:theme.node.text}}>
 {!embedded&&<div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3" style={card}>
  <label className="flex items-center gap-2 text-xs">当前剧集
   <select aria-label="批量创建配置剧集" className="rounded-lg border px-3 py-2 text-xs" style={control} value={activeEpisode} onChange={event=>setEpisodeId(event.target.value)}>
    {episodeIds.map(id=><option key={id} value={id}>{episodes.find(ep=>ep.id===id)?.title??id}</option>)}
   </select>
  </label>
  <span className="text-xs" style={muted}>已配置 {inputs.length-missingCount} / {inputs.length} · 仅创建配置，不执行生成</span>
 </div>}
        <details open={embedded?undefined:true} aria-label="批量创建视频配置" className="min-w-0 rounded-lg border p-3 text-xs" style={card}>
            <summary className="cursor-pointer py-1 font-semibold">批量创建视频配置 · {selectedInputs.length} 镜已选</summary>
            <div className="mt-3 space-y-3 border-t pt-3" style={{borderColor:theme.node.stroke}}>
            <div className="grid min-w-0 gap-1.5">
                {episodeInputs.filter(input=>!configs?.has(input.shot.id)).map(input=>
                    <label key={input.shot.id} className="flex min-w-0 items-start gap-2 break-words rounded-md px-2 py-1.5"
                        style={{background:theme.toolbar.activeBg}}>
                        <input type="checkbox" className="mt-0.5 shrink-0" style={{accentColor:theme.node.activeStroke}} disabled={disabled||busy}
                            checked={selected.includes(input.shot.id)} onChange={event=>{
                            const checked=event.target.checked;
                            setSelected(current=>checked?[...current,input.shot.id]:current.filter(id=>id!==input.shot.id));
                        }}/> 镜头 {input.shot.order} · {input.shot.description}
                    </label>)}
            </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs" style={muted}>已配置 {inputs.length - missingCount} / {inputs.length}</span>
            <Button size="middle" style={control} disabled={!selectedInputs.length || disabled || busy} onClick={async()=>{
                try{
                    setError("");setBusy(true);
                    const audits=await Promise.all(selectedInputs.map(async input=>{
                        const chosen=production[input.shot.id]??{
                            mode:input.referenceImages.length?"omni_reference":"text_to_video",
                        } as DramaShotProduction;
                        const transformed=applyDramaProduction(input,chosen);
                        return {shotId:input.shot.id,audit:await auditDramaProduction(transformed,config,{
                            setting:chosen,visualStyle:productionStyle,sourceRevisionId:confirmedRevisionId,
                            missingReferenceIds:chosen.mode==="omni_reference"&&!chosen.gridInput?missingFor(input):[],
                        })};
                    }));
                    const failures=audits.filter(item=>!item.audit.ready);
                    if(failures.length)throw Error("批量预检不通过："+failures.map(item=>
                        item.shotId+" · "+item.audit.error).join("；"));
                    onCreateSelected(audits.map(item=>item.audit.input!));
                    setSelected([]);
                }catch(error){setError(error instanceof Error?error.message:"输入配置无效");}finally{setBusy(false);}
            }}>创建所选视频配置（{selectedInputs.length}）</Button>
        </div>
            </div>
        </details>
        {onCreateBatch&&<details className="min-w-0 rounded-lg border p-3 text-xs" style={card} aria-label="P3 选镜头组建批量生成">
            <summary className="cursor-pointer py-1 font-semibold">从已配置镜头组建批量生成</summary>
            <div className="mt-3 space-y-3 border-t pt-3" style={{borderColor:theme.node.stroke}}>
            <p className="text-xs" style={muted}>仅准备本地 ComfyUI 镜头组。默认为独立镜头；
                用户可在镜头组中明确指定前镜成片的尾帧连续性，然后先检查再提交。
                这里不会自动运行模型或生成媒体。</p>
            <div className="grid min-w-0 gap-1.5">
                {inputs.filter(input=>configs?.has(input.shot.id)).map(input=>
                    <label key={input.shot.id} className="flex min-w-0 items-start gap-2 break-words rounded-md px-2 py-1.5"
                        style={{background:theme.toolbar.activeBg}}>
                        <input type="checkbox" className="mt-0.5 shrink-0" style={{accentColor:theme.node.activeStroke}} checked={batchShots.includes(input.shot.id)}
                            disabled={disabled||busy} onChange={event=>setBatchShots(current=>event.target.checked?
                                [...new Set([...current,input.shot.id])]:current.filter(id=>id!==input.shot.id))}/>
                        {episodes.find(item=>item.id===input.shot.episodeId)?.title??input.shot.episodeId} · 镜头 {input.shot.order} · {input.shot.description}                    </label>)}
            </div>
            <Button size="middle" style={control} disabled={disabled||busy||batchShots.filter(id=>inputs.some(input=>
                input.shot.id===id&&configs?.has(id))).length<2} onClick={async()=>{
                try{
                    setError("");setBusy(true);
                    const ids=inputs.filter(input=>batchShots.includes(input.shot.id)&&configs?.has(input.shot.id))
                        .map(input=>input.shot.id);
                    if(ids.length<2)throw Error("至少选择两个已创建视频 Config 的镜头");
                    await onCreateBatch(ids);
                    setBatchShots([]);
                }catch(error){setError(error instanceof Error?error.message:"镜头组创建失败");}finally{setBusy(false);}
            }}>组建所选镜头并进入批量预检（{batchShots.length}）</Button>
            </div>
        </details>}

 {error&&<DramaInlineFeedback theme={theme} level="error" error={error}/>}
 </section>;
}

