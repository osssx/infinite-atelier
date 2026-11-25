import {useEffect,useRef,useState} from "react";
import {RefreshCw} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import type {DramaEpisode} from "./drama-episode-fields";
import {DramaInlineFeedback} from "./drama-feedback";

export type EpisodeAdoptionSelection={episodeIds?:string[];reviewToken:string};
type Kind="added"|"replaced"|"deleted"|"reordered"|"unchanged"|"preserved";
type Item={id:string;kind:Kind;changed:boolean;reordered:boolean;beforeIndex:number;afterIndex:number;
 before:DramaEpisode|null;after:DramaEpisode|null;fields:string[];issues:string[];blocked:boolean;selectable:boolean;
 impact:{storyboards:number;shots:number;configs:number;missingSceneShots:number;missingEpisodeShots:number}};
export type EpisodeAdoptionPreview={runId:string;stage:"episodes";status:string;revision:number;reviewToken:string;
 sourceChanged:boolean;baselineChanged:boolean;identityConflict:boolean;globalBlocked:boolean;fullAdoptBlocked:boolean;
 impactUnknown:boolean;summary:Record<Kind,number>;items:Item[]};
const kinds:Record<Kind,string>={added:"新增",replaced:"修改",deleted:"删除",reordered:"重排",unchanged:"无变化",preserved:"保留原剧集"};
const names:Record<string,string>={title:"集标题",synopsis:"剧情梗概",events:"剧情事件",ending:"本集结尾",targetDurationSec:"目标时长",sourceRefs:"原文关联",eventItems:"事件身份",sequences:"场次规划"};
const issues:Record<string,string>={new_unresolved_event_refs:"存在新增的失效事件引用，请先修正场次关联。",
 legacy_unresolved_event_refs:"存在原草案遗留的事件引用，需人工复核。",
 event_needs_review:"存在新增或拆并事件，需人工复核关联。",
 new_unresolved_source_refs:"存在新增的无效原文引用，请先修正。",
 legacy_unresolved_source_refs:"存在原草案遗留的原文引用，需人工复核。"};
function EpisodeSnapshot({episode,index,theme}:{episode:DramaEpisode|null;index:number;theme:CanvasTheme}){
 if(!episode)return <p className="text-xs" style={{color:theme.node.muted}}>无对应剧集</p>;
 const events=episode.eventItems??[];
 return <div className="min-w-0 space-y-2 text-xs leading-relaxed">
  <strong className="block break-words">第 {index+1} 集 · {episode.title}</strong>
  <p style={{color:theme.node.muted}}>{episode.targetDurationSec??"未设定"}{episode.targetDurationSec?" 秒":""} · {(episode.sourceRefs??[]).length} 个原文引用</p>
  <p className="whitespace-pre-wrap break-words">{episode.synopsis}</p>
  <div><strong>剧情事件</strong><ol className="space-y-1">{episode.events.map((event,i)=><li key={i}>{i+1}. {event}</li>)}</ol></div>
  <div><strong>场次规划</strong>{(episode.sequences??[]).map((scene,i)=><div className="mt-1" key={scene.id}>
   {i+1}. {scene.title}
   <span className="block" style={{color:theme.node.muted}}>{(scene.eventRefs??[]).map(ref=>events.find(item=>item.id===ref)?.text??"待核对事件").join("、")||"未关联事件"} · {scene.sourceRefs?.length??0} 个原文引用</span>
  </div>)}</div>
  <div><strong>本集结尾</strong><p className="whitespace-pre-wrap">{episode.ending}</p></div>
 </div>;
}
export function DramaEpisodeAdoptionReview({runId,revision,path,theme,disabled,onAdopt}:{
 runId:string;revision:number;path:string;theme:CanvasTheme;disabled:boolean;
 onAdopt:(selection:EpisodeAdoptionSelection)=>Promise<void>;
}){
 const [open,setOpen]=useState(false),[preview,setPreview]=useState<EpisodeAdoptionPreview|null>(null);
 const [selected,setSelected]=useState<string[]>([]),[expanded,setExpanded]=useState<string|null>(null);
 const [loading,setLoading]=useState(false),[submitting,setSubmitting]=useState(false),[error,setError]=useState("");
 const [confirm,setConfirm]=useState<"all"|"selected"|null>(null);
 const flight=useRef<AbortController|null>(null);
 useEffect(()=>()=>{flight.current?.abort();flight.current=null;},[]);
 const refresh=async()=>{
  if(disabled||submitting)return;
  flight.current?.abort();
  const controller=new AbortController();flight.current=controller;
  setOpen(true);setPreview(null);setSelected([]);setExpanded(null);setConfirm(null);setError("");setLoading(true);
  try{
   const result=await canvasApi<EpisodeAdoptionPreview>(path+"/preview","GET",undefined,controller.signal);
   if(flight.current!==controller||controller.signal.aborted)return;
   if(result.stage!=="episodes"||!result.reviewToken||result.runId!==runId||result.status!=="ready"||result.revision!==revision||!Array.isArray(result.items))
    throw Error("drama_episode_review_conflict");
   setPreview(result);
  }catch(cause){if(!controller.signal.aborted&&flight.current===controller)setError(cause instanceof Error?cause.message:"无法读取剧集差异");}
  finally{if(flight.current===controller){flight.current=null;setLoading(false);}}
 };
 const close=()=>{flight.current?.abort();flight.current=null;setOpen(false);setLoading(false);setPreview(null);setConfirm(null);setSelected([]);setError("");};
 const submit=async()=>{
  if(!preview||!confirm||disabled||submitting||preview.globalBlocked||
   confirm==="all"&&preview.fullAdoptBlocked||confirm==="selected"&&!selected.length)return;
  setSubmitting(true);setError("");
  try{await onAdopt({reviewToken:preview.reviewToken,...(confirm==="selected"?{episodeIds:selected}:{})});close();}
  catch(cause){setError(cause instanceof Error?cause.message:"采用失败");setPreview(null);setSelected([]);setConfirm(null);}
  finally{setSubmitting(false);}
 };
 const style={background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text};
 const muted={color:theme.node.muted};
 const action="inline-flex min-h-7 items-center justify-center gap-1 rounded-md border px-2.5 py-1 text-xs hover:opacity-75 disabled:opacity-40";
 const primary={...style,background:theme.node.activeStroke,color:theme.node.panel,borderColor:theme.node.activeStroke};
 const locked=disabled||submitting||loading||Boolean(preview?.globalBlocked);
 const selectedItems=preview?.items.filter(item=>selected.includes(item.id))??[];
 const selectedRemovals=selectedItems.filter(item=>item.kind==="deleted").length;
 const fullRemovals=preview?.summary.deleted??0;
 // All deletion choices are opt-in; mass-select never selects removals.
 return <section data-episode-adoption-review="" className="min-w-0 space-y-2">
  {!open?<button type="button" className={action} style={primary} disabled={disabled} onClick={()=>void refresh()}>采用到草案</button>:
   <div className="min-w-0 space-y-3 rounded-lg border p-3" style={style}>
    <header className="flex flex-wrap items-center justify-between gap-2">
     <strong className="text-sm">剧集采用差异审核</strong>
     <div className="flex gap-2"><button type="button" className={action} style={style} disabled={disabled||loading||submitting} onClick={()=>void refresh()}><RefreshCw size={12}/>刷新差异</button>
      <button type="button" className={action} style={style} disabled={submitting} onClick={close}>关闭审核</button></div>
    </header>
    {loading&&<DramaInlineFeedback theme={theme} level="info" pending>正在检查当前草案及候选版本…</DramaInlineFeedback>}
    {error&&<DramaInlineFeedback theme={theme} level="error" error={error}/>}
    {preview&&<>
     <p className="text-xs" style={muted}>{Object.entries(kinds).map(([kind,label])=>label+" "+(preview.summary[kind as Kind]??0)).join(" · ")}</p>
     {preview.sourceChanged&&<DramaInlineFeedback theme={theme}>上游确认版本或生成配置已变化，请重新生成候选。</DramaInlineFeedback>}
     {preview.baselineChanged&&<DramaInlineFeedback theme={theme}>正式草案在生成后已发生变化，请重新生成候选。不会覆盖人工修改。</DramaInlineFeedback>}
     {preview.identityConflict&&<DramaInlineFeedback theme={theme}>剧集身份存在冲突，暂不可采用。</DramaInlineFeedback>}
     {preview.impactUnknown&&<DramaInlineFeedback theme={theme}>部分分镜内容无法解析，下游影响范围需人工核对。</DramaInlineFeedback>}
     <p className="text-xs" style={muted}>仅更新正式草案；确认版本后，下游分镜及视频配置才可能受影响。选择性采用保留未选中的原剧集及其顺序，本条生成记录采用后结束，不再重复采用剩余候选。</p>
     <button type="button" className={action} style={style} disabled={locked||!!confirm||!preview.items.some(item=>item.selectable&&!item.blocked&&item.kind!=="deleted")}
      onClick={()=>setSelected(preview.items.filter(item=>item.selectable&&!item.blocked&&item.kind!=="deleted").map(item=>item.id))}>选择全部新增和修改</button>
     <div className="thin-scrollbar max-h-[480px] min-w-0 space-y-2 overflow-auto pr-1">
      {preview.items.map(item=><article key={item.id} className="space-y-2 rounded-md border p-2" style={style}>
       <div className="flex flex-wrap items-center gap-2">
        {item.selectable&&<input type="checkbox" aria-label={"选择采用 "+(item.after?.title??item.before?.title??"剧集")} checked={selected.includes(item.id)}
         disabled={locked||item.blocked||!!confirm} onChange={event=>setSelected(old=>event.target.checked?[...new Set([...old,item.id])]:old.filter(id=>id!==item.id))}/>}
        <strong className="text-xs">{kinds[item.kind]} · {item.after?.title??item.before?.title??"已移除的新候选"}</strong>
        {item.reordered&&<span className="text-[11px]" style={muted}>第 {item.beforeIndex+1} → {item.afterIndex+1} 集（仅全量调整顺序）</span>}
        <button type="button" className={action+" ml-auto"} style={style} aria-expanded={expanded===item.id} onClick={()=>setExpanded(old=>old===item.id?null:item.id)}>{expanded===item.id?"收起对比":"查看对比"}</button>
       </div>
       {!!item.fields.length&&<p className="text-xs" style={muted}>变更：{item.fields.map(field=>names[field]??field).join("、")}</p>}
       {item.kind==="preserved"&&<p className="text-xs" style={muted}>{item.before?"手动移除的候选，原草案保留。":"已排除的新候选，不进入草案。"}</p>}
       {item.kind==="deleted"&&<DramaInlineFeedback theme={theme}>此操作会从正式草案删除该剧集，只有显式选择或全量采用才执行。</DramaInlineFeedback>}
       {item.impact.shots>0&&<p className="text-xs" style={muted}>确认后需核对 {item.impact.storyboards} 个分镜节点、{item.impact.shots} 个镜头、{item.impact.configs} 个视频配置。</p>}
       {(item.impact.missingSceneShots>0||item.impact.missingEpisodeShots>0)&&<DramaInlineFeedback theme={theme}>确认后可能有 {item.impact.missingSceneShots+item.impact.missingEpisodeShots} 个镜头失去剧集或场次关联，需人工处理。</DramaInlineFeedback>}
       {item.issues.map(issue=><DramaInlineFeedback key={issue} theme={theme}>{issues[issue]??"需要人工核对引用。"}</DramaInlineFeedback>)}
       {expanded===item.id&&<div className="grid min-w-0 gap-2 md:grid-cols-2">
        <div className="min-w-0 rounded-md border p-2" style={style}><p className="mb-2 text-xs font-medium" style={muted}>当前草案</p><EpisodeSnapshot episode={item.before} index={item.beforeIndex} theme={theme}/></div>
        <div className="min-w-0 rounded-md border p-2" style={style}><p className="mb-2 text-xs font-medium" style={muted}>全量采用后</p><EpisodeSnapshot episode={item.after} index={item.afterIndex} theme={theme}/></div>
       </div>}
      </article>)}
     </div>
     <div className="flex flex-wrap justify-end gap-2">
      <span className="mr-auto self-center text-xs" style={muted}>已选择 {selected.length} 项差异</span>
      <button type="button" className={action} style={style} disabled={locked||!!confirm||!selected.length} onClick={()=>setConfirm("selected")}>采用所选剧集</button>
      <button type="button" className={action} style={primary} disabled={locked||!!confirm||preview.fullAdoptBlocked} onClick={()=>setConfirm("all")}>全量采用</button>
     </div>
     {confirm&&<div role="alertdialog" aria-label="确认采用剧集" className="space-y-2 rounded-md border p-3" style={style}>
      <strong className="text-xs">{confirm==="all"?"确认全量采用？":"确认采用所选剧集？"}</strong>
      <p className="text-xs" style={muted}>{confirm==="all"?"采用完整计划（含顺序调整），手动排除项保留原草案。":"未选中的原草案及顺序不变，未选中的新候选不进入草案。"} 将删除 {confirm==="all"?fullRemovals:selectedRemovals} 集。仅更新草案，不自动确认版本。</p>
      <div className="flex justify-end gap-2"><button type="button" className={action} style={style} disabled={submitting} onClick={()=>setConfirm(null)}>取消</button>
       <button type="button" className={action} style={primary} disabled={locked} onClick={()=>void submit()}>确认采用</button></div>
     </div>}
    </>}
   </div>}
 </section>;
}
