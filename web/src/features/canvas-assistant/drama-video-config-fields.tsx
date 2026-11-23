import { useEffect, useState, type CSSProperties } from "react";
import {Clapperboard,Pencil} from "lucide-react";
import { Button } from "antd";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData } from "@/types/canvas";
import {applyDramaProduction,type DramaVideoInput,type DramaShotProduction} from "./drama-pipeline-media";
import { dramaNodeControl, dramaNodePrimary } from "./drama-node-style";
import {useEffectiveConfig} from "@/stores/use-config-store";
import {prepareDramaProduction} from "./drama-media-preflight";
import {auditDramaProduction,dramaMediaModes,listDramaProductionCapabilities,type DramaProductionAudit,type DramaProductionCapabilities} from "./drama-production-audit";
import {canvasCasUrl} from "@/features/backend-sync/canvas-cas";
import {DramaEditActions} from "./drama-edit-actions";

/** Stage mode edits per shot, like the storyboard fields. Canvas image picking
 * closes the editor, so an explicitly picked image commits using its captured shot ID.
 */
function VideoModeField({shotId,setting,disabled,theme,capabilities,onChange,onPickImage}:{
 shotId:string;setting:DramaShotProduction;disabled:boolean;theme:CanvasTheme;
 capabilities:DramaProductionCapabilities|null;
 onChange?:(shotId:string,value:DramaShotProduction)=>void;
 onPickImage?:(onPick:(storageKey:string)=>void)=>void;
}){
 const [edit,setEdit]=useState<{baseline:string;value:DramaShotProduction}|null>(null);
 const stale=Boolean(edit&&edit.baseline!==JSON.stringify(setting));
 const effective=edit?.value??setting;
 const choice=effective.gridInput?"grid":effective.mode;
 const label=dramaMediaModes.find(item=>item.id===(setting.gridInput?"grid":setting.mode))?.label??setting.mode;
 const card={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 const field={...card,"--tw-ring-color":theme.node.activeStroke} as CSSProperties;
 const chooseMode=(mode:string)=>setEdit(current=>current?{...current,value:{
   ...current.value,gridInput:mode==="grid",
   mode:mode==="grid"?"omni_reference":mode as DramaShotProduction["mode"]}}:current);
 const pick=(key:"firstFrame"|"lastFrame"|"gridImage")=>{
  if(disabled||!onPickImage||!onChange||!edit||stale)return;
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
   <span>视频输入模式</span>
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
   <select aria-label="视频输入模式" className="w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm"
    style={field} disabled={disabled} value={choice} onChange={event=>chooseMode(event.target.value)}>
    {dramaMediaModes.map(item=>{
     const ability=capabilities?.modes.find(value=>value.mode===item.id);
     return <option key={item.id} value={item.id} disabled={ability?!ability.available:false}
      title={ability?.reason}>{item.label}{ability&&!ability.available?"（不支持）":""}</option>;
    })}
   </select>
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
    已选择分镜网格图 · {effective.gridImage}</p>}
   {!effective.gridInput&&(effective.mode==="first_frame"||effective.mode==="first_last_frame")&&
    <p className="break-all text-[11px]" style={{color:theme.node.muted}}>
     首帧：{effective.firstFrame?"已选择":"未选择"}
     {effective.mode==="first_last_frame"?" · 尾帧："+(effective.lastFrame?"已选择":"未选择"):""}
    </p>}
   {onPickImage&&(effective.gridInput||effective.mode==="first_frame"||effective.mode==="first_last_frame")&&
    <p className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>
     从画布选择图片后，会立即保存当前输入模式和所选图片，以便返回画布后继续配置。
    </p>}
   {stale&&<p role="alert" className="text-xs" style={{color:theme.node.muted}}>
    视频输入配置已在其他位置更新，请取消并重新编辑。
   </p>}
   <DramaEditActions label="视频输入模式" theme={theme} disabled={disabled||stale||!onChange}
    onCancel={()=>setEdit(null)}
    onConfirm={()=>{
     if(disabled||stale||!onChange)return;
     if(JSON.stringify(edit.value)!==JSON.stringify(setting))onChange(shotId,edit.value);
     setEdit(null);
    }}/>
  </>:
   <div data-video-mode-readonly="" className="rounded-md border-l-2 px-3 py-2.5 text-sm"
    style={{background:theme.toolbar.activeBg,borderLeftColor:theme.node.stroke,color:theme.node.text}}>
    <div>{label}</div>
    {setting.gridInput?<p className="mt-1 break-all text-xs" style={{color:theme.node.muted}}>
      网格图：{setting.gridImage?"已选择":"未选择"}</p>:
     (setting.mode==="first_frame"||setting.mode==="first_last_frame")?
     <p className="mt-1 text-xs" style={{color:theme.node.muted}}>
      首帧：{setting.firstFrame?"已选择":"未选择"}
      {setting.mode==="first_last_frame"?" · 尾帧："+(setting.lastFrame?"已选择":"未选择"):""}
     </p>:null}
   </div>}
 </section>;
}

export function DramaVideoConfigFields({
    inputs, episodes, configs, missingCount, missingFor, hasUnconfirmedChanges, disabled, theme, onCreateSelected, onAction,
    productionStyle,production={},onProductionChange,onPickImage,onRefresh,confirmedRevisionId,onCreateBatch,
    expanded=false,initialEpisodeId,initialShotId,
}: {
    inputs: DramaVideoInput[];
    expanded?:boolean;initialEpisodeId?:string;initialShotId?:string;
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
    const [selected, setSelected] = useState<string[]>([]);
    const [batchShots,setBatchShots]=useState<string[]>([]);
    const [error,setError]=useState("");
    const [refreshPrompt,setRefreshPrompt]=useState(true);
    const [refreshReferences,setRefreshReferences]=useState(false);
    const [refreshDuration,setRefreshDuration]=useState(false);
    const [overwrite,setOverwrite]=useState(false);
    const [capabilities,setCapabilities]=useState<DramaProductionCapabilities|null>(null);
    const [audit,setAudit]=useState<DramaProductionAudit|null>(null);
    const [auditing,setAuditing]=useState(false);
    const config=useEffectiveConfig();
    const episodeIds = [...new Set(inputs.map(({shot}) => shot.episodeId))];
    const activeEpisode = episodeIds.includes(episodeId) ? episodeId : episodeIds[0];
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
    const auditKey=JSON.stringify([preview,setting,requiredMissing,productionStyle,confirmedRevisionId,previewError]);
    useEffect(()=>{
        let current=true;
        setAudit(null);setCapabilities(null);setAuditing(Boolean(preview&&!previewError));
        void listDramaProductionCapabilities(config).then(available=>{
            if(current)setCapabilities(available);
        }).catch(()=>{if(current)setCapabilities(null);});
        if(preview&&setting&&!previewError){
            void auditDramaProduction(preview,config,{setting,missingReferenceIds:requiredMissing,
                visualStyle:productionStyle,sourceRevisionId:confirmedRevisionId}).then(result=>{
                if(current)setAudit(result);
            }).catch(error=>{
                if(current)setError(error instanceof Error?error.message:"媒体输入预检失败");
            }).finally(()=>{if(current)setAuditing(false);});
        }else setAuditing(false);
        return ()=>{current=false;};
    },[auditKey,config]);
    if (!active||!preview||!setting) return <p className="rounded-xl border border-dashed px-3 py-4" style={control}>
        确认分镜后可创建视频配置。
    </p>;
    const selectedInputs = inputs.filter(input=>selected.includes(input.shot.id)&&!configs?.has(input.shot.id));
    const source = existing?.metadata?.dramaVideoSource;
    const referenceKeys = preview.referenceImages.flatMap(reference=>reference.storageKey?[reference.storageKey]:[]);
    const outdated = source && (source.visualStyle!==productionStyle||(source.promptShot??source.shot)!==JSON.stringify(active.shot)||
        JSON.stringify(source.referenceKeys)!==JSON.stringify(referenceKeys));
    const field = "w-full min-w-0 rounded-lg border px-3 py-1.5 leading-relaxed";
    return <section aria-label="镜头视频配置" data-video-config-layout={expanded?"expanded":"compact"}
        className={expanded?
            "grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(116px,0.28fr)_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(220px,0.33fr)_minmax(0,1fr)] lg:grid-rows-1":
            "grid min-w-0 gap-3"} style={{color:theme.node.text}}>
        {expanded?<aside aria-label="视频配置镜头目录"
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
        </div>}
        <div aria-label="当前视频配置编辑区" data-canvas-no-zoom=""
            className={expanded?"thin-scrollbar min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain rounded-xl border p-3 sm:p-5":
                "grid min-w-0 gap-3 rounded-xl border p-3 sm:p-4"} style={card}>
            {expanded&&<header className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b pb-3"
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
            <div className="grid min-w-0 gap-1.5">
                <span className="text-xs font-medium" style={{color:theme.node.muted}}>画面描述</span>
                <p data-storyboard-video-description="" className="min-w-0 rounded-md border-l-2 px-3 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap"
                    style={{background:theme.toolbar.activeBg,borderLeftColor:theme.node.stroke,color:theme.node.text}}>
                    {active.shot.description?.trim()||"未填写"}
                </p>
            </div>
            {expanded?<VideoModeField key={active.shot.id} shotId={active.shot.id}
                setting={setting} disabled={disabled} theme={theme} capabilities={capabilities}
                onPickImage={onPickImage} onChange={onProductionChange}/>:
                <>
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
            {existing&&source?.basePrompt&&onRefresh&&<details key={existing.id} className="min-w-0 rounded-lg border p-3 text-xs"
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
                <Button size="middle" style={control} disabled={disabled||(!refreshPrompt&&!refreshDuration)} onClick={async()=>{
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
            <details aria-label="逐镜媒体输入预检" className="min-w-0 rounded-lg border p-3 text-xs"
                style={card}>
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 py-1 font-semibold">
                    <span>媒体输入预检与提示词</span>
                    <span className="text-[11px] font-normal" style={muted}>
                        {auditing?"核验中":previewError||audit&&!audit.ready?"需检查":audit?.ready?"预检通过":"待核验"} · 参考图 {preview.referenceImages.length} 张
                    </span>
                </summary>
            <div className="mt-3 grid min-w-0 gap-3 border-t pt-3 md:grid-cols-2" style={{borderColor:theme.node.stroke}}>
                <div className="grid min-w-0 content-start gap-2">
                    <strong>确认分镜与绑定素材</strong>
                    <p className="break-words whitespace-pre-wrap">{active.shot.description}</p>
                    <p className="text-xs">镜头 {active.shot.order} · 时长 {audit?.durationSeconds??active.shot.durationSec??(Number(config.videoSeconds)||6)} 秒
                        · 画幅 {audit?.aspectRatio??config.videoRatio} · 角色造型 {active.shot.characterVariantIds.length} 项
                        · 道具 {active.shot.propIds.length} 项</p>
                    <p>引用图片 {preview.referenceImages.length} 张
                        {referenceKeys.length>0?" · 已保存 CAS "+referenceKeys.length+" 张":""}</p>
                    <div className="flex min-w-0 flex-wrap gap-2">
                        {preview.referenceImages.map((reference,index)=><div key={reference.id}
                            className="grid max-w-28 gap-1">
                            {reference.storageKey&&<img loading="lazy" src={canvasCasUrl(reference.storageKey)??""}
                                alt={reference.name} className="size-20 rounded object-cover"/>}
                            <span className="break-words text-xs">{index+1}. {reference.name}</span>
                        </div>)}
                    </div>
                    {!!requiredMissing.length&&<p role="alert">缺少必需参考图：{requiredMissing.join("、")}</p>}
                </div>
                <div className="grid min-w-0 content-start gap-2">
                    <strong>实际提交 Prompt / 能力检查</strong>
                    <pre className="thin-scrollbar max-h-44 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-2 text-xs"
                        style={{...card,background:theme.toolbar.activeBg}}>{audit?.prompt??preview.prompt}</pre>
                    <p className="text-xs">执行渠道：{capabilities?.channel??"检查中"}
                        · {capabilities?.model??""} · {capabilities?.engine==="comfy"?"ComfyUI 工作流":"在线渠道"}</p>
                    {auditing&&<p role="status">正在核验工作流端口和媒体约束…</p>}
                    {!auditing&&!previewError&&audit?.ready&&<p role="status">输入预检通过，创建配置不会自动生成媒体。</p>}
                    {(previewError||audit&&!audit.ready)&&<p role="alert">
                        {previewError||audit?.error}。请选择可用模式，补齐素材或调整模板参数。
                    </p>}
                    {capabilities&&<p className="text-xs">
                        可用模式：{capabilities.modes.filter(item=>item.available).map(item=>item.label).join("、")||"无"}
                    </p>}
                    {outdated&&source&&<details>
                        <summary>与旧视频配置的差异（不会自动覆盖）</summary>
                        <p>旧时长 {source.seconds??"未知"} 秒 · 旧风格 {source.visualStyle??"未记录"}</p>
                        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{source.prompt}</pre>
                    </details>}
                </div>
            </div>
            </details>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3" style={{borderColor:theme.node.stroke}}>
                <span className="min-w-0 text-[11px]" style={muted}>
                    {auditing?"正在核验":audit?.ready?"输入预检通过":previewError||audit&&!audit.ready?"输入尚未通过预检":"等待预检"}
                </span>
                <Button size="middle" disabled={disabled||!existing&&(auditing||!audit?.ready||!!previewError)}
                    style={disabled ? control : dramaNodePrimary(theme)}
                    onClick={async () => {
                        try{
                            setError("");
                            if(existing){onAction(active,existing);return;}
                            if(!audit?.ready||!audit.input||auditing||previewError)
                                throw Error(previewError||audit?.error||"请先通过当前镜头输入预检");
                            onAction(audit.input,existing);
                        }
                        catch(error){setError(error instanceof Error?error.message:"输入配置无效");}
                    }}>{existing ? "打开配置" : "创建视频配置"}</Button>
            </div>
        {hasUnconfirmedChanges && <p className="text-xs" style={muted}>当前使用最近一次确认的分镜。</p>}
        <details aria-label="批量创建视频配置" className="min-w-0 rounded-lg border p-3 text-xs" style={card}>
            <summary className="cursor-pointer py-1 font-semibold">批量创建视频配置 · {selectedInputs.length} 镜已选</summary>
            <div className="mt-3 space-y-3 border-t pt-3" style={{borderColor:theme.node.stroke}}>
            <div className="grid min-w-0 gap-1.5">
                {episodeInputs.filter(input=>!configs?.has(input.shot.id)).map(input=>
                    <label key={input.shot.id} className="flex min-w-0 items-start gap-2 break-words rounded-md px-2 py-1.5"
                        style={{background:theme.toolbar.activeBg}}>
                        <input type="checkbox" className="mt-0.5 shrink-0" style={{accentColor:theme.node.activeStroke}} disabled={disabled}
                            checked={selected.includes(input.shot.id)} onChange={event=>{
                            const checked=event.target.checked;
                            setSelected(current=>checked?[...current,input.shot.id]:current.filter(id=>id!==input.shot.id));
                        }}/> 镜头 {input.shot.order} · {input.shot.description}
                    </label>)}
            </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs" style={muted}>已配置 {inputs.length - missingCount} / {inputs.length}</span>
            <Button size="middle" style={control} disabled={!selectedInputs.length || disabled} onClick={async()=>{
                try{
                    setError("");
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
                }catch(error){setError(error instanceof Error?error.message:"输入配置无效");}
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
                            disabled={disabled} onChange={event=>setBatchShots(current=>event.target.checked?
                                [...new Set([...current,input.shot.id])]:current.filter(id=>id!==input.shot.id))}/>
                        {episodes.find(item=>item.id===input.shot.episodeId)?.title??input.shot.episodeId} · 镜头 {input.shot.order} · {input.shot.description}                    </label>)}
            </div>
            <Button size="middle" style={control} disabled={disabled||batchShots.filter(id=>inputs.some(input=>
                input.shot.id===id&&configs?.has(id))).length<2} onClick={async()=>{
                try{
                    setError("");
                    const ids=inputs.filter(input=>batchShots.includes(input.shot.id)&&configs?.has(input.shot.id))
                        .map(input=>input.shot.id);
                    if(ids.length<2)throw Error("至少选择两个已创建视频 Config 的镜头");
                    await onCreateBatch(ids);
                    setBatchShots([]);
                }catch(error){setError(error instanceof Error?error.message:"镜头组创建失败");}
            }}>组建所选镜头并进入批量预检（{batchShots.length}）</Button>
            </div>
        </details>}
        {error&&<p role="alert" className="rounded-lg border px-3 py-2 text-xs" style={{...card,background:theme.toolbar.activeBg}}>{error}</p>}
        </div>
    </section>;
}
