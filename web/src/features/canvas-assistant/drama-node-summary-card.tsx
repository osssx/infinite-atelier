import {lazy,memo,Suspense,useEffect,useRef,useState} from "react";
import type {CanvasNodeData} from "@/types/canvas";
import {canvasApi} from "@/features/backend-sync/canvas-api";

const DramaNodeQuickEditor=lazy(()=>import("./drama-node-quick-editor").then(m=>({default:m.DramaNodeQuickEditor})));
type Kind="episodes"|"storyboard";
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
/** Tiny indexed page/entry reader. The CAS editor chunk is not imported or
 * mounted until the user explicitly starts a draft edit.
 */
export const DramaNodeSummaryCard=memo(function DramaNodeSummaryCard({node,projectId,onOpen}:{
 node:CanvasNodeData;projectId:string;
 onOpen:(nodeId:string,focus?:{episodeId?:string;sequenceId?:string;shotId?:string})=>Promise<void>;
}){
 const kind:Kind=node.type==="drama:storyboard"?"storyboard":"episodes";
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
 // Reading or paging is local-only UI state, not a Canvas revision.
 useEffect(()=>{
  let live=true;const abort=new AbortController();
  setLoading(true);setError("");
  void Promise.all([false,true].map(draft=>canvasApi<Scope>(
   scopePath(projectId,node.id,draft,"&summaryOnly=true"),"GET",undefined,abort.signal)))
   .then(([confirmed,draft])=>{
    if(!live)return;
    setData({confirmed,draft});
    if(initializedFor.current!==scopeKey){
     initializedFor.current=scopeKey;
     setView(confirmed.total>0?"confirmed":"draft");
     setOffset(0);setEpisodeId("");
    }else{
     // A save or a new confirmed version must not silently reset an explicit
     // draft selection back to confirmed.
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
 const status=view==="confirmed"?"已确认":"草案";
 const title=kind==="episodes"?"剧集规划":"分镜配置";
 const prev=()=>setOffset(i=>Math.max(0,i-1));
 const next=()=>setOffset(i=>Math.min(count-1,i+1));
 const refreshDraft=()=>{setEditing(null);setView("draft");setRefresh(i=>i+1);};
 return <section aria-label={title+"摘要"}
  className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-3 text-sm"
  onPointerDown={event=>{if((event.target as Element).closest("button,select,input,textarea"))event.stopPropagation()}}
  onMouseDown={event=>{if((event.target as Element).closest("button,select,input,textarea"))event.stopPropagation()}}
  onDoubleClick={event=>event.stopPropagation()}>
  <div className="flex shrink-0 items-center justify-between gap-2">
   <strong>{title}</strong>
   <div className="flex items-center gap-1.5">
    {!editing&&<button type="button" aria-label={"刷新"+title+"摘要"} className="text-xs underline opacity-75"
     onClick={()=>setRefresh(i=>i+1)}>刷新</button>}
    <span className="rounded border px-1.5 py-0.5 text-xs opacity-75">{status}</span>
   </div>
  </div>
  {editing?<Suspense fallback={<p role="status">正在加载轻量编辑器…</p>}>
   <DramaNodeQuickEditor key={scopeKey+":"+String(editing.entry.id)}
    kind={kind} projectId={projectId} nodeId={node.id}
    entry={editing.entry} expectedDigest={editing.digest!}
    onSaved={refreshDraft} onReload={refreshDraft} onCancel={()=>setEditing(null)}/>
  </Suspense>:loading?<p role="status" className="opacity-70">正在读取摘要…</p>:error?
   <div role="alert" className="min-h-0 text-xs">
    <p className="line-clamp-2 break-all">{error}</p>
    <button type="button" className="underline" onClick={()=>setRefresh(i=>i+1)}>重试</button>
   </div>:<>
   <p className="truncate text-xs opacity-70">
    {kind==="episodes"?
     `已规划 ${data?.draft.total??0} 集 · 已确认 ${data?.confirmed.total??0} 集`:
     `${current.groups.length} 集 · ${current.total} 镜头`}
   </p>
   {(data?.draft.total??0)>0&&(data?.confirmed.total??0)>0&&
    <label className="flex items-center gap-2 text-xs">查看
     <select aria-label={title+"版本"} className="min-w-0 rounded border bg-transparent px-1" value={view}
      onChange={event=>setView(event.target.value as "draft"|"confirmed")}>
      <option value="confirmed">已确认</option><option value="draft">草案</option>
     </select>
    </label>}
   {kind==="storyboard"&&current.groups.length>1&&
    <select aria-label="摘要选择剧集" className="min-w-0 rounded border bg-transparent p-1 text-xs"
     value={activeEpisode} onChange={event=>{setEpisodeId(event.target.value);setOffset(0)}}>
     {current.groups.map(g=><option key={g.episodeId} value={g.episodeId}>
      {g.episodeId}（{g.total} 镜头）</option>)}
    </select>}
   {current.total===0?<p className="min-h-0 flex-1 text-xs opacity-70">尚无内容，可打开完整编辑器规划。</p>:
    <div className="min-h-0 flex-1 overflow-hidden">
     <div className="flex items-center justify-between gap-2">
      <strong className="truncate text-xs">{kind==="episodes"?
       short(entry?.title,64)||`第 ${index+1} 集`:
       `镜头 ${String(entry?.order??index+1)} · ${short(entry?.shotSize,30)||"未设置景别"}`}</strong>
      {kind==="storyboard"&&typeof entry?.durationSec==="number"&&
       <span className="shrink-0 text-xs">{entry.durationSec}秒</span>}
     </div>
     <p className="mt-1 line-clamp-2 break-words text-xs opacity-75">
      {kind==="episodes"?short(entry?.synopsis)||"无剧情概要":short(entry?.description)||"无画面描述"}
     </p>
    </div>}
   {count>1&&<div className="flex items-center justify-between gap-2 text-xs">
    <button type="button" aria-label="上一条摘要" disabled={index===0} onClick={prev}>上一条</button>
    <span>{index+1} / {count}</span>
    <button type="button" aria-label="下一条摘要" disabled={index>=count-1} onClick={next}>下一条</button>
   </div>}
   {view==="confirmed"&&(data?.draft.total??0)>0&&<p className="text-xs opacity-65">快速编辑请切换至「草案」。</p>}
   <div className="mt-auto flex shrink-0 gap-2">
    {view==="draft"&&activeSelection?.digest&&
     <button type="button" aria-label={"快速编辑"+(kind==="episodes"?"当前剧集":"当前镜头")}
      className="rounded border px-2 py-1.5 text-xs" onClick={()=>setEditing(activeSelection)}>快速编辑</button>}
    <button type="button" aria-label={"打开"+title+"完整编辑器"} disabled={busy}
     className="min-w-0 flex-1 rounded-md border px-2 py-1.5 text-xs font-medium hover:opacity-80 disabled:opacity-40"
     onClick={()=>{
      setBusy(true);setError("");
      void onOpen(node.id,kind==="episodes"?{episodeId:String(entry?.id??"")}:
       {episodeId:activeEpisode,sequenceId:String(entry?.sequenceId??""),shotId:String(entry?.id??"")})
       .catch(e=>setError(e instanceof Error?e.message:"打开编辑器失败")).finally(()=>setBusy(false));
     }}>
     {busy?"正在加载完整编辑器…":"打开完整编辑器 ↗"}
    </button>
   </div>
  </>}
 </section>;
});
