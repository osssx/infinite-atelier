import {memo,useEffect,useState} from "react";
import type {CanvasNodeData} from "@/types/canvas";
import {canvasApi} from "@/features/backend-sync/canvas-api";

type Kind="episodes"|"storyboard";
type Group={episodeId:string;total:number;sequenceIds:string[]};
type Scope={versionId:string|null;total:number;groups:Group[];entries:Record<string,unknown>[]};
type Data={draft:Scope;confirmed:Scope};
const empty:Scope={versionId:null,total:0,groups:[],entries:[]};

function scopePath(projectId:string,nodeId:string,draft:boolean,params=""){
 return `/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/revision-scope?nodeId=${encodeURIComponent(nodeId)}&draft=${draft}${params}`;
}
function short(value:unknown,max=110){
 const str=typeof value==="string"?value.trim():"";
 return str.length>max?str.slice(0,max)+"…":str;
}
/** Only a page of scoped data is fetched; no editor, whole draft, video Configs
 * or 3-second runs watcher can mount in the canvas node. Legacy inline nodes
 * use the same backend scope reader and do not parse large JSON in React.
 */
export const DramaNodeSummaryCard=memo(function DramaNodeSummaryCard({node,projectId,onOpen}:{
 node:CanvasNodeData;projectId:string;onOpen:(nodeId:string)=>Promise<void>;
}){
 const kind:Kind=node.type==="drama:storyboard"?"storyboard":"episodes";
 const [data,setData]=useState<Data|null>(null);
 const [view,setView]=useState<"confirmed"|"draft">("confirmed");
 const [episodeId,setEpisodeId]=useState("");
 const [offset,setOffset]=useState(0);
 const [entry,setEntry]=useState<Record<string,unknown>|null>(null);
 const [busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [refresh,setRefresh]=useState(0);
 // The selected episode/shot is view-only UI state, not a project graph edit.
 useEffect(()=>{
  let live=true;const abort=new AbortController();
  setLoading(true);setError("");
  void Promise.all([false,true].map(draft=>canvasApi<Scope>(
   scopePath(projectId,node.id,draft,"&summaryOnly=true"),"GET",undefined,abort.signal)))
   .then(([confirmed,draft])=>{if(!live)return;setData({confirmed,draft});
     setView(confirmed.total>0?"confirmed":"draft");setOffset(0);
   }).catch(e=>{if(live)setError(e instanceof Error?e.message:"无法读取摘要");})
    .finally(()=>{if(live)setLoading(false)});
  return ()=>{live=false;abort.abort()};
 },[projectId,node.id,node.metadata?.creativePayloadRef,node.metadata?.dramaDraft,
    node.metadata?.dramaConfirmed,node.metadata?.dramaConfirmedVersionId,refresh]);
 const current=data?.[view]??empty;
 const activeEpisode=kind==="storyboard"?
  current.groups.find(group=>group.episodeId===episodeId)?.episodeId??current.groups[0]?.episodeId??"":"";
 const count=kind==="storyboard"?(current.groups.find(g=>g.episodeId===activeEpisode)?.total??0):current.total;
 const pageOffset=Math.min(offset,Math.max(0,count-1));
 useEffect(()=>{
  if(!data||current.total===0){setEntry(null);return}
  let live=true;const abort=new AbortController();setEntry(null);
  const params=`&offset=${pageOffset}&limit=1`+
   (kind==="storyboard"&&activeEpisode?`&episodeId=${encodeURIComponent(activeEpisode)}`:"");
  void canvasApi<Scope>(scopePath(projectId,node.id,view==="draft",params),"GET",undefined,abort.signal)
   .then(response=>{if(live)setEntry(response.entries[0]??null)})
   .catch(e=>{if(live)setError(e instanceof Error?e.message:"无法读取条目")});
  return ()=>{live=false;abort.abort()};
 },[data,projectId,node.id,view,kind,activeEpisode,pageOffset]);
 const index=pageOffset;
 const status=view==="confirmed"?"已确认":"草案";
 const title=kind==="episodes"?"剧集规划":"分镜配置";
 const prev=()=>setOffset(i=>Math.max(0,i-1));
 const next=()=>setOffset(i=>Math.min(count-1,i+1));
 return <section aria-label={title+"摘要"} className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-3 text-sm"
  onPointerDown={event=>{if((event.target as Element).closest("button,select"))event.stopPropagation()}}
  onMouseDown={event=>{if((event.target as Element).closest("button,select"))event.stopPropagation()}}
  onDoubleClick={event=>event.stopPropagation()}>
  <div className="flex items-center justify-between gap-2">
   <strong>{title}</strong>
   <span className="rounded border px-1.5 py-0.5 text-xs opacity-75">{status}</span>
  </div>
  {loading?<p role="status" className="opacity-70">正在读取摘要…</p>:error?
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
      onChange={event=>{setView(event.target.value as "draft"|"confirmed");setOffset(0)}}>
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
  </>}
  <button type="button" aria-label={"打开"+title+"完整编辑器"} disabled={busy}
   className="mt-auto shrink-0 rounded-md border px-2 py-1.5 text-xs font-medium hover:opacity-80 disabled:opacity-40"
   onClick={()=>{setBusy(true);setError("");void onOpen(node.id).catch(e=>setError(e instanceof Error?e.message:"打开编辑器失败")).finally(()=>setBusy(false));}}>
   {busy?"正在加载完整编辑器…":"打开完整编辑器 ↗"}
  </button>
 </section>;
});
