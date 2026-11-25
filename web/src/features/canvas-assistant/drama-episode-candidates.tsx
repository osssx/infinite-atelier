import {useCallback,useEffect,useState} from "react";
import {Trash2,RefreshCw} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import {DramaEpisodeFields} from "./drama-episode-fields";
import {CandidateFieldContext,candidateRevision,hasEpisodeDetails,type DramaRun,type EpisodeCandidateChanges} from "./drama-episode-candidate-state";
import {DramaInlineFeedback} from "./drama-feedback";
import type {WorkspacePendingRegistration} from "./drama-creative-workspace";

export function DramaEpisodeCandidates({run,projectId,theme,disabled,activeKey,onEditingChange,onPendingChange,onPatch,onRemove,onDiscard,onReload,onConfirmingChange}:{
 run:DramaRun;projectId?:string;theme:CanvasTheme;disabled:boolean;activeKey:string|null;
 onEditingChange:(runId:string,key:string|null)=>void;onPendingChange?:WorkspacePendingRegistration;
 onPatch:(run:DramaRun,id:string,changes:EpisodeCandidateChanges)=>Promise<void>;
 onRemove:(run:DramaRun,id:string)=>Promise<void>;onDiscard:(run:DramaRun)=>Promise<void>;onReload:()=>void;
 onConfirmingChange:(runId:string,confirming:boolean)=>void;
}){
 const [selected,setSelected]=useState("");
 const [confirm,setConfirm]=useState<{kind:"episode"|"run";id?:string;revision:number}|null>(null);
 const [error,setError]=useState("");
 const confirming=Boolean(confirm);
 useEffect(()=>{onConfirmingChange(run.id,confirming);return ()=>onConfirmingChange(run.id,false);},[confirming,run.id,onConfirmingChange]);
 const episodes=run.candidate?.episodes??[];
 const active=episodes.find(e=>e.id===selected)??episodes[0];
 const revision=candidateRevision(run),ready=run.status==="ready";
 const discardable=["ready","failed","interrupted","cancelled"].includes(run.status);
 const removed=run.candidate?.manualChanges?.removedEpisodeIds.length??0;
 const count=run.candidate?.episodeCount??episodes.length;
 const locked=disabled||Boolean(activeKey);
 const setActiveKey=useCallback((key:string|null)=>onEditingChange(run.id,key),[run.id,onEditingChange]);
 const style={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 const muted={color:theme.node.muted};
 const action="inline-flex min-h-7 shrink-0 items-center justify-center gap-1 rounded-md border px-2 py-1 text-xs hover:opacity-75 disabled:opacity-40";
 const remove=async()=>{
  if(!confirm||locked)return;
  if(confirm.revision!==revision){setError("候选已更新，请重新确认删除。");setConfirm(null);return;}
  setError("");
  try{
   if(confirm.kind==="run")await onDiscard(run);
   else if(confirm.id)await onRemove(run,confirm.id);
   setConfirm(null);
  }catch(cause){setError(cause instanceof Error?cause.message:"删除失败");}
 };
 return <section data-episode-candidate-editor={run.id} className="min-w-0 space-y-3">
  <div className="flex flex-wrap items-center justify-between gap-2">
   {run.candidate&&<span className="text-xs" style={muted}>原始生成 {run.candidate.manualChanges?.originalEpisodeIds.length??count} 集 · 当前候选 {count} 集
    {revision>0&&" · 已手动修改"}{removed>0&&" · 已移除 "+removed+" 集"}</span>}
   {ready&&hasEpisodeDetails(run)&&<button type="button" aria-label="刷新候选内容" title="刷新候选内容" className={action+" ml-auto"} style={style} disabled={locked||!!confirm} onClick={onReload}><RefreshCw size={12}/></button>}
   {discardable&&<button type="button" className={action} style={style} disabled={locked||!!confirm}
    onClick={()=>{setError("");setConfirm({kind:"run",revision});}}><Trash2 size={12}/>删除生成记录</button>}
  </div>
  {(ready||run.status==="adopted")&&!hasEpisodeDetails(run)&&<div className="flex items-center gap-2">
   <span className="text-xs" style={muted}>尚未加载候选详情，加载后才可查看完整内容。</span>
   <button type="button" className={action} style={style} disabled={locked} onClick={onReload}><RefreshCw size={12}/>重新加载候选</button>
  </div>}
  {removed>0&&<DramaInlineFeedback theme={theme} level="info">手动移除的候选不会进入草案；若对应已有正式草案剧集，采用时保留原内容。</DramaInlineFeedback>}
  {episodes.length>0&&<div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(180px,0.32fr)_minmax(0,1fr)]">
   <div aria-label="候选剧集目录" className="thin-scrollbar max-h-[420px] min-w-0 space-y-1 overflow-y-auto rounded-lg border p-2" style={style}>
    {episodes.map((episode,index)=><button type="button" key={episode.id} aria-pressed={active?.id===episode.id}
     aria-label={`选择候选第 ${index+1} 集：${episode.title}`} disabled={locked||!!confirm}
     onClick={()=>{setSelected(episode.id);setError("");}}
     className="block w-full min-w-0 rounded-md border px-2.5 py-2 text-left text-xs disabled:opacity-60"
     style={{...style,background:active?.id===episode.id?theme.toolbar.activeBg:theme.node.panel}}>
     <span className="block truncate font-semibold">第 {index+1} 集 · {episode.title}</span>
     <span className="mt-1 block truncate" style={muted}>{episode.synopsis}</span>
     {run.candidate?.manualChanges?.editedEpisodeIds.includes(episode.id)&&<span className="text-[11px]" style={muted}>已修改</span>}
    </button>)}
   </div>
   {active&&<article className="min-w-0 space-y-2">
    <header className="flex flex-wrap items-center gap-2">
     <strong className="min-w-0 flex-1 truncate text-sm">{active.title}</strong>
     <span className="text-[11px]" style={muted}>{active.sourceRefs?.length??0} 个原文引用</span>
     {ready&&<button type="button" aria-label={"删除候选剧集 "+active.title} className={action} style={style}
      disabled={locked||episodes.length<=1||!!confirm} title={episodes.length<=1?"最后一集请删除整条生成记录":undefined}
      onClick={()=>{setError("");setConfirm({kind:"episode",id:active.id,revision});}}><Trash2 size={12}/>删除本集</button>}
    </header>
    <CandidateFieldContext.Provider value={{activeKey,setActiveKey,register:onPendingChange,runId:run.id,optimization:projectId&&ready?{projectId,runId:run.id,episodeId:active.id,revision}:undefined}}>
     <DramaEpisodeFields key={active.id} episodes={[active]} expanded={false} candidateMode disabled={!ready||disabled||!!confirm}
      onChange={()=>{}} onCandidatePatch={(id,changes)=>onPatch(run,id,changes)}/>
    </CandidateFieldContext.Provider>
   </article>}
  </div>}
  {confirm&&<div role="alertdialog" aria-label="确认删除候选" className="space-y-2 rounded-lg border p-3" style={style}>
   <strong className="text-xs">{confirm.kind==="run"?"确定删除整条生成记录？":"确定移除当前剧集候选？"}</strong>
   <p className="text-xs" style={muted}>仅影响候选记录，不会直接修改正式草案、已确认版本或分镜。{confirm.kind==="run"?"删除后不再显示此生成记录。":"采用时保留同 ID 的原草案剧集。"}</p>
   <div className="flex justify-end gap-2">
    <button type="button" className={action} style={style} disabled={disabled} onClick={()=>setConfirm(null)}>取消</button>
    <button type="button" className={action} style={{...style,background:theme.node.text,color:theme.node.panel}} disabled={locked}
     onClick={()=>void remove()}>确认删除候选</button>
   </div>
  </div>}
  {error&&<DramaInlineFeedback theme={theme} level="error" error={error}/>}
  {activeKey&&<DramaInlineFeedback theme={theme} level="info">请先保存或取消当前字段，才能切换剧集、收起候选或采用。</DramaInlineFeedback>}
 </section>;
}
