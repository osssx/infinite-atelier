import {useRef,useState,type FormEvent} from "react";
import {Check,RotateCcw,X} from "lucide-react";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {canvasApi,type CanvasBackendProject} from "@/features/backend-sync/canvas-api";
import {commitAssistantCanvasGraphWithSaveBarrier} from "@/stores/canvas/use-canvas-store";

export type DramaQuickEditKind="episodes"|"storyboard";
export type DramaQuickEditEntry=Record<string,unknown>;

/** This small form is loaded ONLY after explicit quick-edit activation.
 * It never parses/rewrites a whole node draft or hydrates upstream payloads.
 */
export function DramaNodeQuickEditor({kind,projectId,nodeId,entry,expectedDigest,position=1,total=1,onSaved,onCancel,onReload}:{
 kind:DramaQuickEditKind;projectId:string;nodeId:string;entry:DramaQuickEditEntry;
 expectedDigest:string;position?:number;total?:number;onSaved:()=>void;onCancel:()=>void;onReload:()=>void;
}){
 const appearance=useThemeStore(state=>state.theme);
 const theme=canvasThemes[appearance];
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
 const isEpisodes=kind==="episodes";
 const field="w-full min-w-0 rounded-lg border px-2.5 py-2 text-xs leading-relaxed outline-none transition-colors focus-visible:ring-2 disabled:opacity-60";
 const fieldStyle={background:theme.node.fill,color:theme.node.text,borderColor:theme.node.stroke,
  "--tw-ring-color":theme.node.activeStroke} as React.CSSProperties;
 const actionStyle={borderColor:theme.node.stroke,color:theme.node.text,
  background:theme.toolbar.panel,outlineColor:theme.node.activeStroke};
 const saveStyle={background:theme.node.text,color:theme.node.panel,outlineColor:theme.node.activeStroke};
 const onFieldEdit=()=>{operationId.current=null;setError("");};
 return <form aria-label={isEpisodes?"剧集快速编辑":"镜头快速编辑"} data-canvas-no-zoom
  data-drama-editor-theme={appearance} style={{colorScheme:appearance}}
  onSubmit={event=>void submit(event)}
  className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden text-xs"
  onPointerDown={event=>event.stopPropagation()} onMouseDown={event=>event.stopPropagation()}
  onKeyDown={event=>{
   event.stopPropagation();
   if((event.ctrlKey||event.metaKey)&&event.key==="Enter"&&!saving&&!invalid&&changed){
    event.preventDefault();event.currentTarget.requestSubmit();
   }
  }}>
  <div className="flex shrink-0 items-center justify-between gap-2">
   <span className="truncate text-[11px] font-medium" style={{color:theme.node.muted}}>
    {isEpisodes?"编辑当前剧集":"编辑当前镜头"} · {position} / {Math.max(total,1)}
   </span>
   <span aria-live="polite" className="shrink-0 text-[10px] font-medium"
    style={{color:changed?theme.node.text:theme.node.muted}}>
    {saving?"正在保存":changed?"有未保存修改":"尚未修改"}
   </span>
  </div>
  <div className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-xl border p-2.5 thin-scrollbar"
   style={{background:theme.node.panel,borderColor:theme.node.stroke}}>
   {isEpisodes?<>
    <label className="block space-y-1.5">
     <span className="block text-[11px] font-medium" style={{color:theme.node.muted}}>本集标题</span>
     <input className={field} style={fieldStyle} aria-label="快速编辑集标题" maxLength={12000}
      value={title} disabled={saving} onChange={event=>{onFieldEdit();setTitle(event.target.value)}}/>
    </label>
    <label className="block space-y-1.5">
     <span className="flex items-center justify-between text-[11px] font-medium" style={{color:theme.node.muted}}>
      剧情概要 <span className="tabular-nums opacity-70">{synopsis.length} 字</span>
     </span>
     <textarea className={field+" min-h-[92px] resize-y"} style={fieldStyle}
      aria-label="快速编辑剧情概要" rows={4} maxLength={12000} value={synopsis}
      disabled={saving} onChange={event=>{onFieldEdit();setSynopsis(event.target.value)}}/>
    </label>
   </>:<>
    <label className="block space-y-1.5">
     <span className="flex items-center justify-between text-[11px] font-medium" style={{color:theme.node.muted}}>
      画面描述 <span className="tabular-nums opacity-70">{description.length} 字</span>
     </span>
     <textarea className={field+" min-h-[92px] resize-y"} style={fieldStyle}
      aria-label="快速编辑画面描述" rows={4} maxLength={20000} value={description}
      disabled={saving} onChange={event=>{onFieldEdit();setDescription(event.target.value)}}/>
    </label>
    <label className="block space-y-1.5">
     <span className="block text-[11px] font-medium" style={{color:theme.node.muted}}>镜头时长（秒，可留空）</span>
     <input className={field} style={fieldStyle} aria-label="快速编辑镜头时长" type="number"
      step="any" min="0.1" value={duration} disabled={saving}
      onChange={event=>{onFieldEdit();setDuration(event.target.value)}}/>
    </label>
   </>}
   {invalid&&<p role="alert" className="rounded-lg px-2 py-1.5 text-[11px]"
    style={{background:theme.toolbar.activeBg,color:theme.node.text}}>
    请输入有效的{isEpisodes?"剧集标题":"镜头时长（大于 0 秒）"}。
   </p>}
   {error&&<div role="alert" className="space-y-2 rounded-lg border p-2 text-[11px]"
    style={{borderColor:theme.node.stroke,color:theme.node.text,background:theme.toolbar.activeBg}}>
    <p className="break-words">{error}</p>
    <button type="button" className="inline-flex items-center gap-1 underline underline-offset-2"
     disabled={saving} onClick={onReload}>
     <RotateCcw size={11} aria-hidden="true"/>重新读取最新草案（放弃本次输入）
    </button>
   </div>}
  </div>
  <footer className="flex shrink-0 items-center justify-end gap-2 border-t pt-2"
   style={{borderColor:theme.node.stroke}}>
   <button type="button"
    className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border px-3 text-xs font-medium transition-opacity hover:opacity-75 disabled:opacity-40"
    style={actionStyle} disabled={saving} onClick={onCancel}><X size={12} aria-hidden="true"/>取消</button>
   <button type="submit"
    className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-lg px-3 text-xs font-semibold transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
    style={saveStyle} disabled={saving||!changed||invalid}>
    <Check size={13} aria-hidden="true"/>{saving?"保存中…":"保存草案"}
   </button>
  </footer>
 </form>;
}
