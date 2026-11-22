import {useRef,useState,type FormEvent} from "react";
import {canvasApi,type CanvasBackendProject} from "@/features/backend-sync/canvas-api";
import {commitAssistantCanvasGraphWithSaveBarrier} from "@/stores/canvas/use-canvas-store";

export type DramaQuickEditKind="episodes"|"storyboard";
export type DramaQuickEditEntry=Record<string,unknown>;

/** This small form is loaded ONLY after explicit quick-edit activation.
 * It never parses/rewrites a whole node draft or hydrates upstream payloads.
 */
export function DramaNodeQuickEditor({kind,projectId,nodeId,entry,expectedDigest,onSaved,onCancel,onReload}:{
 kind:DramaQuickEditKind;projectId:string;nodeId:string;entry:DramaQuickEditEntry;
 expectedDigest:string;onSaved:()=>void;onCancel:()=>void;onReload:()=>void;
}){
 const entryId=String(entry.id??"");
 // Freeze the snapshot witness: a concurrent card refresh cannot upgrade the
 // digest behind a form that is already being edited.
 const witness=useRef({entryId,digest:expectedDigest});
 const base=useRef({
  title:String(entry.title??""),synopsis:String(entry.synopsis??""),
  description:String(entry.description??""),
  duration:typeof entry.durationSec==="number"?String(entry.durationSec):""
 }).current;
 const operationId=useRef<string|null>(null);
 const [title,setTitle]=useState(String(entry.title??""));
 const [synopsis,setSynopsis]=useState(String(entry.synopsis??""));
 const [description,setDescription]=useState(String(entry.description??""));
 const [duration,setDuration]=useState(typeof entry.durationSec==="number"?String(entry.durationSec):"");
 const [saving,setSaving]=useState(false);
 const [error,setError]=useState("");
 const changed=kind==="episodes"
  ?title!==base.title||synopsis!==base.synopsis
  :description!==base.description||duration!==base.duration;
 const invalid=kind==="episodes"?!title.trim():
  duration!==""&&(!Number.isFinite(Number(duration))||Number(duration)<=0);
 const submit=async(event:FormEvent)=>{
  event.preventDefault();
  if(saving||!changed||invalid||!witness.current.entryId)return;
  const changes:Record<string,string|number|null>={};
  if(kind==="episodes"){
   if(title!==base.title)changes.title=title;
   if(synopsis!==base.synopsis)changes.synopsis=synopsis;
  }else{
   if(description!==base.description)changes.description=description;
   if(duration!==base.duration)
    changes.durationSec=duration===""?null:Number(duration);
  }
  if(!Object.keys(changes).length)return;
  setSaving(true);setError("");
  try{
   if(!operationId.current)operationId.current=crypto.randomUUID();
   const path=`/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/${kind==="episodes"?"entry-draft":"shot-draft"}`;
   const command={nodeId,operationId:operationId.current,expectedDigest:witness.current.digest,changes,
    ...(kind==="episodes"?{kind:"episodes",entryId:witness.current.entryId}:{shotId:witness.current.entryId})};
   await commitAssistantCanvasGraphWithSaveBarrier(projectId,({assertCurrent})=>{
    assertCurrent();
    return canvasApi<CanvasBackendProject>(path,"PATCH",command);
   },{textVersionNodeId:nodeId,keepCreativePointers:true,invalidateCreativeNodeId:nodeId});
   onSaved();
  }catch(cause){
   const message=cause instanceof Error?cause.message:String(cause);
   const digestConflict=/drama_candidate_conflict|digest|过期/i.test(message);
   const otherConflict=/revision|conflict|stale|冲突/i.test(message);
   setError((digestConflict?"草案已被其他操作修改，本次未覆盖任何内容。请重新读取后编辑。":
    otherConflict?"项目保存版本发生冲突，可能已提交到后端但本地尚未同步，请重新读取核对。":
    "保存未完成，请检查后重试。")+"（"+message+"）");
  }finally{setSaving(false);}
 };
 const field="w-full min-w-0 rounded border bg-transparent px-1.5 py-1 text-xs";
 return <form aria-label={kind==="episodes"?"剧集快速编辑":"镜头快速编辑"} onSubmit={event=>void submit(event)}
  className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden text-xs"
  onPointerDown={event=>event.stopPropagation()} onMouseDown={event=>event.stopPropagation()}
  onKeyDown={event=>event.stopPropagation()} onWheel={event=>event.stopPropagation()}>
  <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto thin-scrollbar">
   {kind==="episodes"?<>
    <label className="block">本集标题
     <input className={field} aria-label="快速编辑集标题" maxLength={12000} value={title} disabled={saving}
      onChange={event=>setTitle(event.target.value)}/>
    </label>
    <label className="block">剧情概要
     <textarea className={field} aria-label="快速编辑剧情概要" rows={2} maxLength={12000} value={synopsis} disabled={saving}
      onChange={event=>setSynopsis(event.target.value)}/>
    </label>
   </>:<>
    <label className="block">画面描述
     <textarea className={field} aria-label="快速编辑画面描述" rows={2} maxLength={20000} value={description} disabled={saving}
      onChange={event=>setDescription(event.target.value)}/>
    </label>
    <label className="block">时长（秒，可留空）
     <input className={field} aria-label="快速编辑镜头时长" type="number" step="any" min="0.1" value={duration} disabled={saving}
      onChange={event=>setDuration(event.target.value)}/>
    </label>
   </>}
   {invalid&&<p role="alert">请输入有效的{kind==="episodes"?"剧集标题":"镜头时长（大于 0 秒）"}。</p>}
   {error&&<div role="alert" className="break-all">
    <p>{error}</p>
    <button type="button" className="underline" disabled={saving}
      onClick={onReload}>重新读取最新草案（放弃本次输入）</button>
   </div>}
  </div>
  <div className="flex shrink-0 justify-end gap-2">
   <button type="button" className="rounded border px-2 py-1" disabled={saving} onClick={onCancel}>取消</button>
   <button type="submit" className="rounded border px-2 py-1 font-medium" disabled={saving||!changed||invalid}>
    {saving?"保存中…":"保存草案"}
   </button>
  </div>
 </form>;
}
