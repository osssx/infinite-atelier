import {useContext,useMemo,useRef,useState} from "react";
import {ChevronDown,Link2} from "lucide-react";
import {DramaStoryHistoryLayoutContext} from "./drama-story-history-layout";
import type {CanvasConnection,CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {useDramaFeedback} from "./drama-feedback";
import {DramaStoryUpstreamPanel} from "./drama-story-upstream-panel";
import {applyReviewedStorySource,type StorySourceComparison,type StorySyncMode,type StorySyncState,type StoryTextSource} from "./drama-story-upstream";
import {storyDirectDownstream,type StoryDownstreamStatus} from "./drama-story-impact";
import {resolveStoryDraft,storyVersionConfirmed,storyArtFields} from "./drama-story-state";

const statusLabels:Record<StoryDownstreamStatus,string>={recorded:"已记录当前版本",review:"版本变更 · 待复核",
 unknown:"缺少记录 · 待复核",unconfirmed:"等待故事确认",direct:"直连 · 待复核"};

/** Mounted only on history. Source mutations and historical operations share
 * the workspace task lock; the graph reader rechecks the reviewed snapshot. */
export function DramaStoryHistorySummary({node,sources,nodes,connections,versionBusy,onChange,onSnapshotDraft,getCurrent}:{
 node:CanvasNodeData;sources:readonly StoryTextSource[];nodes:readonly CanvasNodeData[];connections:readonly CanvasConnection[];
 versionBusy:boolean;onChange:(patch:Partial<CanvasNodeMetadata>)=>Promise<void>;onSnapshotDraft:()=>Promise<void>;
 getCurrent?:()=>StorySyncState|null;
}){
 const theme=canvasThemes[useThemeStore(state=>state.theme)];
 const feedback=useDramaFeedback();
 const layout=useContext(DramaStoryHistoryLayoutContext);
 const [reviewing,setReviewing]=useState(false),[downstreamOpen,setDownstreamOpen]=useState<string|null>(null);
 const onReviewChange=(active:boolean)=>{setReviewing(active);layout?.setReviewing(active);if(active){setError("");setNotice("");}};
 const [expanded,setExpanded]=useState(false),[visible,setVisible]=useState(30),[visualExpanded,setVisualExpanded]=useState(false);
 const [syncing,setSyncing]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const lock=useRef(false),live=useRef<StorySyncState>({node,sources});live.current={node,sources};
 const draft=resolveStoryDraft(node),paragraphs=node.metadata?.dramaSourceParagraphs??[];
 const impact=useMemo(()=>storyDirectDownstream(node,nodes,connections),[node,nodes,connections]);
 const visual=node.metadata?.dramaConfirmedVisual;
 const hasConfirmed=!!node.metadata?.dramaConfirmed?.trim()||!!node.metadata?.dramaConfirmedVersionId;
 const unresolved=impact.filter(item=>item.status!=="recorded").length;
 const apply=async(compare:StorySourceComparison,mode:StorySyncMode)=>{
  if(lock.current||versionBusy||feedback?.task)return false;
  lock.current=true;setSyncing(true);setError("");setNotice("");
  const task=feedback?.api.beginTask("同步上游文本",compare.source.title,true);
  try{
   const backedUp=await applyReviewedStorySource({compare,mode,getCurrent:()=>getCurrent?getCurrent():live.current,
    onBackup:onSnapshotDraft,onPersist:onChange,onPhase:phase=>task?.phase(phase)});
   const message=mode==="append"?"已追加上游文本到草案，已确认版本不变":
    backedUp?"已替换草案，旧草案已有恢复备份或历史版本；已确认版本不变":"已替换草案，已确认版本不变";
   setNotice(message);return true;
  }catch(cause){setError(cause instanceof Error?cause.message:"同步失败，请重试");return false;}
  finally{task?.end();lock.current=false;setSyncing(false);}
 };
 const panelStyle={background:theme.node.panel,borderColor:theme.node.stroke};
 return <section data-story-history-summary="" className={reviewing?"flex min-h-0 min-w-0 flex-1 flex-col text-xs":"min-w-0 space-y-2 text-xs"} style={{color:theme.node.text}}>
  <DramaStoryUpstreamPanel sources={sources} sync={node.metadata?.dramaTextSourceSync}
   draft={draft} blocked={versionBusy||syncing||Boolean(feedback?.task)} onApply={apply} theme={theme}
   onReviewChange={onReviewChange} wideReview={layout?.wideReview??true} error={error}/>
  <div style={{display:reviewing?"none":undefined}} className="space-y-2">
  {error&&<p role="alert" className="break-words rounded-md border p-2 text-xs" style={panelStyle}>{error}</p>}
  {notice&&!error&&<p role="status" className="break-words rounded-md border p-2 text-xs" style={panelStyle}>{notice}</p>}
  <section data-story-direct-downstream="" className="min-w-0 space-y-2 rounded-lg border p-3" style={panelStyle}>
   <div className="flex flex-wrap items-center justify-between gap-1.5">
    <strong className="text-xs">直接下游</strong>
    <span className="text-[11px]" style={{color:theme.node.muted}}>{impact.length} 个节点{unresolved>0?` · ${unresolved} 待核对`:""}</span>
   </div>
   <p className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>
    {!hasConfirmed?"故事尚无已确认版本。":storyVersionConfirmed(node)?"下游引用已确认故事。":"当前草案或美术修改尚未确认，下游仍使用已确认版本。"}
    {" 仅显示实际直连及记录的故事版本，不推断间接影响。"}
   </p>
   {impact.length?<ul className="min-w-0 divide-y" style={{borderColor:theme.node.stroke}}>
    {impact.map(item=><li key={item.nodeId} data-story-downstream-status={item.status} className="min-w-0" style={{borderColor:theme.node.stroke}}>
     <button type="button" aria-expanded={downstreamOpen===item.nodeId} onClick={()=>setDownstreamOpen(current=>current===item.nodeId?null:item.nodeId)}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-2 text-left hover:opacity-80">
      <Link2 size={14} className="shrink-0" style={{color:theme.node.muted}} aria-hidden="true"/>
      <span className="min-w-0 flex-1">
       <span className="block truncate font-medium" title={item.title}>{item.title}</span>
       {item.kind!==item.title&&<span className="block truncate text-[11px]" style={{color:theme.node.muted}} title={item.kind}>{item.kind}</span>}
      </span>
      <span className="inline-flex max-w-[48%] shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-tight" style={{borderColor:theme.node.stroke,color:theme.node.text}} title={statusLabels[item.status]}>
       <span aria-hidden="true" className={"size-1.5 shrink-0 rounded-full "+(item.status==="recorded"?"bg-emerald-500":item.status==="unconfirmed"?"bg-stone-400":"bg-amber-500")}/>{statusLabels[item.status]}
      </span>
      <ChevronDown size={14} aria-hidden="true" className={"shrink-0 transition-transform "+(downstreamOpen===item.nodeId?"rotate-180":"")} style={{color:theme.node.muted}}/>
     </button>
     {downstreamOpen===item.nodeId&&<div className="mb-2 ml-5 space-y-1 rounded-md px-2 py-1.5 text-[11px] leading-relaxed" style={{background:theme.toolbar.activeBg,color:theme.node.muted}}>
      <p>{item.connections} 条连线 · {item.kind}</p><p>{item.detail}</p>
     </div>}
    </li>)}
   </ul>:<p className="text-[11px]" style={{color:theme.node.muted}}>暂无直接下游节点。</p>}
  </section>
  <div className="rounded-lg border p-2.5" style={panelStyle}>
   <button type="button" data-story-paragraph-toggle="" aria-expanded={expanded} onClick={()=>{setExpanded(value=>!value);setVisible(30);}}
    className="flex w-full items-center justify-between gap-2 text-left font-medium">
    <span>已确认原文定位 · {paragraphs.length} 段</span><span style={{color:theme.node.muted}}>{expanded?"收起":"展开"}</span>
   </button>
   {expanded&&(paragraphs.length?<><ol className="mt-2 space-y-2">
    {paragraphs.slice(0,visible).map((paragraph,index)=><li key={paragraph.id} className="min-w-0 rounded-md p-2" style={{background:theme.toolbar.activeBg}}>
     <div className="flex flex-wrap gap-2 text-[11px]" style={{color:theme.node.muted}}>
      <span>第 {index+1} 段</span><span>{paragraph.status==="needs_review"?"待校对":"已定位"}</span>
      {!!paragraph.replaces?.length&&<span>关联旧段落 {paragraph.replaces.length} 个</span>}
     </div><p className="mt-1 whitespace-pre-wrap break-words leading-relaxed" style={{overflowWrap:"anywhere"}}>{paragraph.text.slice(0,200)}{paragraph.text.length>200?"…":""}</p>
    </li>)}
   </ol>{paragraphs.length>visible&&<button type="button" className="mt-2 w-full rounded border p-1.5 text-xs"
    style={{borderColor:theme.node.stroke}} onClick={()=>setVisible(count=>count+30)}>查看更多（{Math.min(visible,paragraphs.length)}/{paragraphs.length}）</button>}</>:
    <p className="mt-2" style={{color:theme.node.muted}}>暂无已确认段落。</p>)}
  </div>
  {visual&&<div className="rounded-lg border p-2.5" style={panelStyle}>
   <button type="button" aria-expanded={visualExpanded} onClick={()=>setVisualExpanded(value=>!value)}
    className="flex w-full items-center justify-between gap-2 text-left font-medium">
    <span>当前已确认美术快照</span><span style={{color:theme.node.muted}}>{visualExpanded?"收起":"展开"}</span>
   </button>
   {visualExpanded&&<><dl className="mt-2 space-y-2 break-words" style={{overflowWrap:"anywhere"}}>
    <div><dt className="font-medium">影片风格</dt><dd style={{color:theme.node.muted}}>{visual.visualStyle||"未设置"}</dd></div>
    {storyArtFields.map(({key,label})=><div key={key}><dt className="font-medium">{label}</dt>
     <dd className="whitespace-pre-wrap" style={{color:theme.node.muted}}>{visual.artDirection?.[key]||"未设置"}</dd></div>)}
   </dl>
   <p className="mt-2 text-[11px]" style={{color:theme.node.muted}}>历史正文恢复不会更改这份快照或当前美术草案。</p></>}
  </div>}
  </div>
 </section>;
}