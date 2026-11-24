import {lazy,memo,Suspense,useEffect,useRef,useState} from "react";
import {BookOpenText,Boxes,ChevronLeft,ChevronRight,Clapperboard,Pencil,RefreshCw} from "lucide-react";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import type {CanvasNodeData} from "@/types/canvas";
import {canvasApi,CanvasApiError} from "@/features/backend-sync/canvas-api";
import {awaitCanvasStorePersistence} from "@/stores/canvas/use-canvas-sqlite-store";

const DramaNodeQuickEditor=lazy(()=>import("./drama-node-quick-editor").then(m=>({default:m.DramaNodeQuickEditor})));
type Kind="assets"|"episodes"|"storyboard";
type Group={episodeId:string;total:number;sequenceIds:string[]};
type Scope={versionId:string|null;total:number;groups:Group[];entries:Record<string,unknown>[];
 entryDigests?:{id:string;digest:string}[]};
type Data={draft:Scope;confirmed:Scope};
type Selected={entry:Record<string,unknown>;digest:string|null;key:string};
const empty:Scope={versionId:null,total:0,groups:[],entries:[]};

function scopePath(projectId:string,nodeId:string,draft:boolean,params=""){
 return `/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/revision-scope?nodeId=${encodeURIComponent(nodeId)}&draft=${draft}${params}`;
}
function short(value:unknown,max=110){
 const str=typeof value==="string"?value.trim():"";
 return str.length>max?str.slice(0,max)+"…":str;
}
/** Summary-only indexed card. The form and full creative workspace stay unmounted
 * until the user explicitly chooses to edit.
 */
export const DramaNodeSummaryCard=memo(function DramaNodeSummaryCard({node,projectId,onOpen}:{
 node:CanvasNodeData;projectId:string;
 onOpen:(nodeId:string,focus?:{episodeId?:string;sequenceId?:string;shotId?:string;assetId?:string})=>Promise<void>;
}){
 const kind:Kind=node.type==="drama:assets"?"assets":node.type==="drama:storyboard"?"storyboard":"episodes";
 const isAssets=kind==="assets";
 const appearance=useThemeStore(state=>state.theme);
 const theme=canvasThemes[appearance];
 const [data,setData]=useState<Data|null>(null);
 const [view,setView]=useState<"confirmed"|"draft">("confirmed");
 const [episodeId,setEpisodeId]=useState("");
 const [offset,setOffset]=useState(0);
 const [selected,setSelected]=useState<Selected|null>(null);
 const [editing,setEditing]=useState<Selected|null>(null);
 const [busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [refresh,setRefresh]=useState(0);
 const initializedFor=useRef("");
 const scopeKey=`${projectId}:${node.id}`;
 useEffect(()=>{setEditing(null);setSelected(null);setData(null);initializedFor.current="";},[scopeKey]);
 useEffect(()=>{
  let live=true;const abort=new AbortController();
  setLoading(true);setError("");
  const readSummaries=()=>Promise.all([false,true].map(draft=>canvasApi<Scope>(
   scopePath(projectId,node.id,draft,"&summaryOnly=true"),"GET",undefined,abort.signal)));
  // Newly added canvas nodes can render before the debounced project PATCH.
  // Flush that pending save and retry once instead of requiring a manual refresh.
  void readSummaries().catch(async error=>{
   if(!(error instanceof CanvasApiError)||error.code!=="text_node_not_found"||abort.signal.aborted)
    throw error;
   await awaitCanvasStorePersistence(projectId);
   if(abort.signal.aborted)throw error;
   return readSummaries();
  }).then(([confirmed,draft])=>{
    if(!live)return;
    setData({confirmed,draft});
    if(initializedFor.current!==scopeKey){
     initializedFor.current=scopeKey;
     setView(confirmed.total>0?"confirmed":"draft");
     setOffset(0);setEpisodeId("");
    }else{
     setView(previous=>previous==="draft"&&draft.total===0&&confirmed.total>0?"confirmed":
      previous==="confirmed"&&confirmed.total===0&&draft.total>0?"draft":previous);
    }
   }).catch(e=>{if(live)setError(e instanceof Error?e.message:"无法读取摘要");})
    .finally(()=>{if(live)setLoading(false)});
  return ()=>{live=false;abort.abort()};
 },[projectId,node.id,scopeKey,node.metadata?.creativePayloadRef,node.metadata?.dramaDraft,
    node.metadata?.dramaConfirmed,node.metadata?.dramaConfirmedVersionId,refresh]);
 const current=data?.[view]??empty;
 const activeEpisode=kind==="storyboard"?
  current.groups.find(group=>group.episodeId===episodeId)?.episodeId??current.groups[0]?.episodeId??"":"";
 const count=kind==="storyboard"?(current.groups.find(g=>g.episodeId===activeEpisode)?.total??0):current.total;
 const pageOffset=Math.min(offset,Math.max(0,count-1));
 const selectionKey=`${scopeKey}:${view}:${activeEpisode}:${pageOffset}`;
 useEffect(()=>{
  if(!data||current.total===0){setSelected(null);return;}
  let live=true;const abort=new AbortController();setSelected(null);
  const params=`&offset=${pageOffset}&limit=1`+
   (kind==="storyboard"&&activeEpisode?`&episodeId=${encodeURIComponent(activeEpisode)}`:"");
  void canvasApi<Scope>(scopePath(projectId,node.id,view==="draft",params),"GET",undefined,abort.signal)
   .then(response=>{
    if(!live)return;
    const entry=response.entries[0];
    setSelected(entry?{entry,digest:response.entryDigests?.find(item=>item.id===entry.id)?.digest??null,key:selectionKey}:null);
    setError("");
   })
   .catch(e=>{if(live)setError(e instanceof Error?e.message:"无法读取条目");});
  return ()=>{live=false;abort.abort()};
 },[data,projectId,node.id,view,kind,activeEpisode,pageOffset,selectionKey]);
 const activeSelection=selected?.key===selectionKey?selected:null;
 const entry=activeSelection?.entry;
 const index=pageOffset;
 const title=isAssets?"资产规划":kind==="episodes"?"剧集规划":"分镜配置";
 const isEpisodes=kind==="episodes";
 const prev=()=>setOffset(i=>Math.max(0,i-1));
 const next=()=>setOffset(i=>Math.min(count-1,i+1));
 const refreshDraft=()=>{setEditing(null);setView("draft");setRefresh(i=>i+1);};
 const primaryButton="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-opacity hover:opacity-85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40";
 const secondaryButton="inline-flex h-8 min-w-0 items-center justify-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition-colors hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40";
 const buttonPrimaryStyle={background:theme.node.text,color:theme.node.panel,outlineColor:theme.node.activeStroke};
 const buttonSecondaryStyle={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke,outlineColor:theme.node.activeStroke};
 const iconButtonStyle={color:theme.node.muted,borderColor:theme.node.stroke,background:theme.toolbar.panel,outlineColor:theme.node.activeStroke};
 const total=kind==="episodes"?(data?.draft.total??0):(current.total);
 const confirmedTotal=data?.confirmed.total??0;
 return <section aria-label={title+"摘要"} data-drama-summary-kind={kind} data-drama-card-theme={appearance}
  className="flex h-full min-h-0 w-full flex-col gap-2 overflow-hidden px-3 pb-3 pt-2.5 text-sm"
  style={{color:theme.node.text,colorScheme:appearance}}
  onPointerDown={event=>{if((event.target as Element).closest("button,select,input,textarea,form"))event.stopPropagation()}}
  onMouseDown={event=>{if((event.target as Element).closest("button,select,input,textarea,form"))event.stopPropagation()}}
  onDoubleClick={event=>event.stopPropagation()}>
  <header className="flex shrink-0 items-center justify-between gap-2">
   <div className="flex min-w-0 items-center gap-2">
    <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-lg"
     style={{background:theme.toolbar.activeBg,color:theme.node.text}}>
     {isAssets?<Boxes size={15}/>:isEpisodes?<BookOpenText size={15}/>:<Clapperboard size={15}/>}
    </span>
    <strong className="truncate text-[13px] font-semibold tracking-tight">{title}</strong>
   </div>
   <div className="flex shrink-0 items-center gap-1.5">
    {!editing&&<button type="button" aria-label={"刷新"+title+"摘要"} title="刷新摘要"
     className="grid size-7 place-items-center rounded-md border border-transparent transition-colors hover:opacity-75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
     style={{color:theme.node.muted,outlineColor:theme.node.activeStroke}}
     onClick={()=>setRefresh(i=>i+1)}><RefreshCw size={13}/></button>}
    <span className="rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide"
     style={{background:editing||view==="draft"?theme.toolbar.activeBg:theme.node.panel,
      borderColor:theme.node.stroke,color:theme.node.muted}}>
     {editing?"编辑草案":view==="draft"?"草案":"已确认"}
    </span>
   </div>
  </header>
  {editing&&kind!=="assets"?<Suspense fallback={<p role="status" className="text-xs" style={{color:theme.node.muted}}>正在加载轻量编辑器…</p>}>
   <DramaNodeQuickEditor key={selectionKey+":"+String(editing.entry.id)}
    kind={kind} projectId={projectId} nodeId={node.id} entry={editing.entry} expectedDigest={editing.digest!}
    position={index+1} total={count}
    onSaved={refreshDraft} onReload={refreshDraft} onCancel={()=>setEditing(null)}/>
  </Suspense>:loading?
   <p role="status" className="flex-1 text-xs" style={{color:theme.node.muted}}>正在读取摘要…</p>:
   error?<div role="alert" className="flex min-h-0 flex-1 flex-col items-start gap-2 text-xs">
    <p className="line-clamp-3 break-all" style={{color:theme.node.text}}>{error}</p>
    <button type="button" className={secondaryButton} style={buttonSecondaryStyle}
     onClick={()=>setRefresh(i=>i+1)}>重试</button>
   </div>:<>
   <div className="flex shrink-0 items-center justify-between gap-2">
    <p className="truncate text-[11px] tabular-nums" style={{color:theme.node.muted}}>
     {isAssets?`草案 ${data?.draft.total??0} 项 · 已确认 ${confirmedTotal} 项`:isEpisodes?`已规划 ${total} 集 · 已确认 ${confirmedTotal} 集`:`${current.groups.length} 集 · ${current.total} 镜头`}
    </p>
    {(data?.draft.total??0)>0&&confirmedTotal>0&&
     <label className="flex shrink-0 items-center gap-1 text-[11px]" style={{color:theme.node.muted}}>
      <span className="sr-only">查看</span>
      <select aria-label={title+"版本"} className="max-w-[78px] rounded-md border px-1.5 py-1 text-[11px] font-medium outline-none focus-visible:ring-2"
       style={{background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text}}
       value={view} onChange={event=>{setOffset(0);setEpisodeId("");setView(event.target.value as "draft"|"confirmed")}}>
       <option value="confirmed">已确认</option><option value="draft">草案</option>
      </select>
     </label>}
   </div>
   {kind==="storyboard"&&current.groups.length>1&&
    <select aria-label="摘要选择剧集" className="w-full min-w-0 shrink-0 rounded-lg border px-2 py-1.5 text-xs outline-none focus-visible:ring-2"
     style={{background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text}}
     value={activeEpisode} onChange={event=>{setEpisodeId(event.target.value);setOffset(0)}}>
     {current.groups.map(g=><option key={g.episodeId} value={g.episodeId}>
      {g.episodeId}（{g.total} 镜头）</option>)}
    </select>}
   <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border px-3 py-2.5"
    style={{background:theme.node.panel,borderColor:theme.node.stroke}}>
    {current.total===0?
     <div className="flex min-h-0 flex-1 flex-col justify-center gap-1">
      <strong className="text-xs">尚无{isAssets?"资产内容":isEpisodes?"剧集内容":"镜头内容"}</strong>
      <p className="text-[11px] leading-4" style={{color:theme.node.muted}}>打开完整编辑器开始规划</p>
     </div>:<>
     <div className="mb-1.5 flex shrink-0 items-center justify-between gap-2">
      <span className="truncate text-[10px] font-semibold tracking-wide" style={{color:theme.node.muted}}>
       {isAssets?`当前资产 · ${({character:"角色",scene:"场景",prop:"道具"} as Record<string,string>)[String(entry?.kind)]??""}`:isEpisodes?`当前剧集 · 第 ${index+1} 集`:`当前镜头 · 第 ${index+1} 条`}
      </span>
      {count>1&&<nav aria-label="摘要条目切换" className="flex shrink-0 items-center gap-1">
       <button type="button" aria-label="上一条摘要" title="上一条摘要"
        className="grid size-6 place-items-center rounded-md border transition-opacity hover:opacity-70 disabled:opacity-30"
        style={iconButtonStyle} disabled={index===0} onClick={prev}><ChevronLeft size={13}/></button>
       <span className="min-w-[30px] text-center text-[10px] tabular-nums" style={{color:theme.node.muted}}>
        {index+1} / {count}
       </span>
       <button type="button" aria-label="下一条摘要" title="下一条摘要"
        className="grid size-6 place-items-center rounded-md border transition-opacity hover:opacity-70 disabled:opacity-30"
        style={iconButtonStyle} disabled={index>=count-1} onClick={next}><ChevronRight size={13}/></button>
      </nav>}
     </div>
     <strong className="block shrink-0 truncate text-[13px] font-semibold leading-5" title={isEpisodes?String(entry?.title??""):undefined}>
      {isAssets?short(entry?.name,64)||"未命名资产":isEpisodes?short(entry?.title,64)||`第 ${index+1} 集`:
       `镜头 ${String(entry?.order??index+1)} · ${short(entry?.shotSize,30)||"未设置景别"}`}
     </strong>
     <div className="mt-2 min-h-0 flex-1 overflow-y-auto thin-scrollbar" data-canvas-no-zoom>
      <p className="mb-1 text-[10px] font-medium" style={{color:theme.node.muted}}>
       {isAssets?"资产描述":isEpisodes?"剧情概要":"画面描述"}
      </p>
      <p className="break-words text-xs leading-[1.55]" style={{color:theme.node.text,opacity:.85}}>
       {isEpisodes?short(entry?.synopsis,300)||"暂无概要":short(entry?.description,300)||(isAssets?"暂无描述":"暂无画面描述")}
      </p>
      {!isEpisodes&&typeof entry?.durationSec==="number"&&
       <p className="mt-1.5 text-[10px] tabular-nums" style={{color:theme.node.muted}}>时长 {entry.durationSec} 秒</p>}
     </div>
    </>}
   </div>
   {!isAssets&&view==="confirmed"&&(data?.draft.total??0)>0&&
    <button type="button" className="shrink-0 self-start text-[11px] underline underline-offset-2"
     style={{color:theme.node.muted}} onClick={()=>setView("draft")}>
     快速编辑请切换至「草案」。
    </button>}
   <footer className="flex shrink-0 gap-2">
    {!isAssets&&view==="draft"&&activeSelection?.digest&&
     <button type="button" aria-label={"快速编辑"+(isEpisodes?"当前剧集":"当前镜头")}
      className={secondaryButton+" flex-1"} style={buttonSecondaryStyle}
      onClick={()=>setEditing(activeSelection)}><Pencil size={12} aria-hidden="true"/>快速编辑</button>}
    <button type="button" aria-label={"打开"+title+"完整编辑器"} disabled={busy}
     className={primaryButton+" flex-[1.25]"} style={buttonPrimaryStyle}
     onClick={()=>{
      setBusy(true);setError("");
      void onOpen(node.id,isAssets?{assetId:typeof entry?.id==="string"?entry.id:undefined}:isEpisodes?{episodeId:String(entry?.id??"")}:
       {episodeId:activeEpisode,sequenceId:String(entry?.sequenceId??""),shotId:String(entry?.id??"")})
       .catch(e=>setError(e instanceof Error?e.message:"打开编辑器失败")).finally(()=>setBusy(false));
     }}>
     <span className="truncate">{busy?"正在加载完整编辑器…":"打开完整编辑器 ↗"}</span>

    </button>
   </footer>
  </>}
 </section>;
});
