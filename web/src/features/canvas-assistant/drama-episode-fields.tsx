import {useContext,useEffect,useRef,useState,type CSSProperties} from "react";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {GitBranch,Layers3,Plus,Split,Merge,BookText,Trash2,AlertTriangle,Pencil} from "lucide-react";
import {DramaEditActions as EpisodeEditActions} from "./drama-edit-actions";
import {DramaInlineFeedback,useDramaFieldFeedback} from "./drama-feedback";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {needsEpisodeEventNormalization,normalizeEpisodeEvents} from "../../../server/drama-episode-links.mjs";
import {splitEpisodeSequence,mergeEpisodeSequences} from "../../../server/drama-sequence-relations.mjs";
import {CandidateFieldContext,useCandidateFieldSession,type EpisodeCandidateChanges} from "./drama-episode-candidate-state";
import {DramaEpisodeAiControls} from "./drama-episode-ai-controls";

export type DramaEpisode={
 id:string;title:string;synopsis:string;events:string[];
 eventItems?:{id:string;text:string;replaces?:string[];status?:string}[];
 sourceRefs:string[];ending:string;targetDurationSec?:number;
 sequences?:{id:string;title:string;sourceRefs?:string[];eventRefs?:string[];replaces?:string[]}[];
};

type EpisodeFieldKey="title"|"duration"|"synopsis"|"events"|"ending";
type EpisodeFieldProps={
 id:EpisodeFieldKey;label:string;value:string;disabled:boolean;theme:ReturnType<typeof canvasThemeForField>;
 onConfirm:(value:string)=>void|Promise<void>;multiline?:boolean;rows?:number;type?:"text"|"number";
 count?:(value:string)=>string;placeholder?:string;
};
function canvasThemeForField(appearance:"light"|"dark"){return canvasThemes[appearance];}
type EpisodeFieldTheme=ReturnType<typeof canvasThemeForField>;
function EpisodeReadEditField({id,label,value,disabled,theme,onConfirm,multiline=false,rows=2,type="text",count,placeholder="未填写"}:EpisodeFieldProps){
 const [editing,setEditing]=useState(false);
 const [draft,setDraft]=useState(value);
 const [aiBlocked,setAiBlocked]=useState(false);
 const inputRef=useRef<HTMLInputElement|HTMLTextAreaElement|null>(null);
 const [baseline,setBaseline]=useState(value);
 const [saving,setSaving]=useState(false);
 const updated=useDramaFieldFeedback();
 const [error,setError]=useState("");
 const stale=editing&&baseline!==value;
 const valid=type!=="number"||draft.trim()===""||(Number.isFinite(Number(draft))&&Number(draft)>0);
 const text=editing?draft:value;
 const headingStyle={color:theme.node.muted};
 const inputStyle={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke,
  "--tw-ring-color":theme.node.activeStroke} as CSSProperties;
 const begin=()=>{setError("");setBaseline(value);setDraft(value);setEditing(true);};
 const cancel=()=>{if(saving)return;setAiBlocked(false);setError("");setEditing(false);setDraft(value);};
 const confirm=async(propagate=false)=>{
  if(disabled||saving||stale||!valid||aiBlocked){if(propagate)throw Error(aiBlocked?"请先应用或放弃 AI 优化建议，再保存候选":"请先核对当前字段，再保存候选");return;}
  setSaving(true);setError("");
  try{
   if(draft!==value){await onConfirm(draft);if(!fieldSession.candidate)updated(label);}
   setEditing(false);
  }catch(error){setError(error instanceof Error?error.message:"剧集保存失败，请检查版本后重试");if(propagate)throw error;}
  finally{setSaving(false);}
 };
 const fieldSession=useCandidateFieldSession(editing,()=>confirm(true));
 const optimize=fieldSession.optimization&&id!=="duration"?fieldSession.optimization:undefined;
 const editorClass="w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm leading-relaxed outline-none transition-shadow focus-visible:ring-2"+(optimize?" pr-12":"");
 const editor=multiline?
  <textarea ref={element=>{inputRef.current=element;}} aria-label={label==="剧情事件（每行一条）"?"剧情事件":label}
   className={"thin-scrollbar block resize-y "+editorClass} style={inputStyle} rows={rows} value={draft} disabled={disabled}
   onChange={event=>setDraft(event.target.value)}/>:
  <input ref={element=>{inputRef.current=element;}} aria-label={label} type={type} min={type==="number"?"0.1":undefined}
   step={type==="number"?"0.1":undefined} maxLength={type==="text"?12000:undefined}
   className={editorClass} style={inputStyle} value={draft} disabled={disabled} onChange={event=>setDraft(event.target.value)}/>;
 return <section data-episode-editable-field={id} data-episode-field-mode={editing?"editing":"reading"}
  aria-label={label+"区域"} className={editing
   ?"min-w-0 space-y-3 rounded-xl border p-3 sm:p-4"
   :"min-w-0 space-y-1.5 border border-transparent"}
  style={editing?{background:theme.node.fill,borderColor:theme.node.stroke}:undefined}>
  <div className="flex min-h-7 items-center justify-between gap-2 text-xs font-medium" style={headingStyle}>
   <div className="flex min-w-0 items-center gap-1.5">
    <span>{label}</span>
    {!editing&&<button type="button" aria-label={"编辑"+label} title={"编辑"+label}
      className="inline-grid size-7 shrink-0 place-items-center rounded-md border border-transparent hover:opacity-80 focus-visible:outline focus-visible:outline-2"
      style={{color:theme.node.muted,outlineColor:theme.node.activeStroke}} disabled={disabled||fieldSession.otherEditing}
      onClick={begin}><Pencil size={13} aria-hidden="true"/></button>}
   </div>
   <div className="flex shrink-0 items-center gap-2">
    {editing&&<span className="rounded-md px-2 py-0.5 text-[11px] font-semibold"
      style={{background:theme.toolbar.activeBg,color:theme.toolbar.activeText}}>编辑中</span>}
    {count&&<span className="text-[11px] font-normal tabular-nums">{count(text)}</span>}
   </div>
  </div>
  {editing?<>
   {optimize&&id!=="duration"?<DramaEpisodeAiControls scope={optimize} field={id}
    draft={draft} inputRef={inputRef} theme={theme} disabled={disabled||saving||stale} onApply={setDraft} onBlockingChange={setAiBlocked}>{editor}</DramaEpisodeAiControls>:editor}
   {stale&&<DramaInlineFeedback theme={theme}>内容已在其他位置更新，请取消并重新编辑。</DramaInlineFeedback>}
   {!valid&&<DramaInlineFeedback theme={theme}>目标时长必须是大于 0 的数字，或留空。</DramaInlineFeedback>}
   {error&&<DramaInlineFeedback theme={theme} level="error" error={error}/>}
   {saving&&<DramaInlineFeedback theme={theme} level="info" pending>正在保存{fieldSession.candidate?"候选":"剧集草案"}…</DramaInlineFeedback>}
   <EpisodeEditActions theme={theme} label={label} confirmText={fieldSession.candidate?"保存候选":undefined} disabled={disabled||saving||stale||!valid||aiBlocked}
    onCancel={cancel} onConfirm={()=>void confirm()}/>
  </>:
   <div data-episode-readonly={id} aria-label={label+"内容"}
    className={"min-w-0 rounded-md border-l-2 px-3 py-2.5 text-sm leading-relaxed "+(id==="title"?"font-semibold":"")}
    style={{background:theme.toolbar.activeBg,color:value.trim()?theme.node.text:theme.node.muted,
     borderLeftColor:theme.node.stroke}}>
    {id==="events"&&value.trim()?<ol className="space-y-2">
      {value.split("\n").filter(line=>line.trim()).map((line,index)=>
       <li key={index} className="flex min-w-0 gap-2">
        <span className="w-5 shrink-0 text-right text-[11px] tabular-nums" style={headingStyle}>{index+1}.</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{line}</span>
       </li>)}
     </ol>:<div className="whitespace-pre-wrap break-words">{value.trim()?value:placeholder}</div>}
   </div>}
 </section>;
}
type EpisodeSequence=NonNullable<DramaEpisode["sequences"]>[number];
function SequenceReadEditFields({sequence,index,items,theme,disabled,onConfirm,startEditing=false}:{
 sequence:EpisodeSequence;index:number;
 items:NonNullable<DramaEpisode["eventItems"]>;theme:ReturnType<typeof canvasThemeForField>;disabled:boolean;
 onConfirm:(next:EpisodeSequence)=>void|Promise<void>;startEditing?:boolean;
}){
 const [editing,setEditing]=useState(startEditing);
 const [title,setTitle]=useState(sequence.title);
 const [aiBlocked,setAiBlocked]=useState(false);
 const titleRef=useRef<HTMLInputElement|HTMLTextAreaElement|null>(null);
 const [refs,setRefs]=useState((sequence.sourceRefs??[]).join("\n"));
 const [eventRefs,setEventRefs]=useState([...(sequence.eventRefs??[])]);
 const [baseline,setBaseline]=useState(sequence);
 const [saving,setSaving]=useState(false);
 const updated=useDramaFieldFeedback();
 const [error,setError]=useState("");
 const resolveRef=(ref:string)=>{
  const exact=items.filter(item=>item.id===ref);
  if(exact.length===1)return exact[0];
  const text=items.filter(item=>item.text===ref);
  return text.length===1?text[0]:undefined;
 };
 const stale=editing&&(baseline.title!==sequence.title||
  (baseline.sourceRefs??[]).join("\n")!==(sequence.sourceRefs??[]).join("\n")||
  (baseline.eventRefs??[]).join("\n")!==(sequence.eventRefs??[]).join("\n"));
 const begin=()=>{setError("");setBaseline(sequence);setTitle(sequence.title);setRefs((sequence.sourceRefs??[]).join("\n"));
  setEventRefs([...(sequence.eventRefs??[])]);setEditing(true);};
 const cancel=()=>{if(saving)return;setAiBlocked(false);setError("");setEditing(false);setTitle(sequence.title);setRefs((sequence.sourceRefs??[]).join("\n"));
  setEventRefs([...(sequence.eventRefs??[])]);};
 const confirm=async(propagate=false)=>{
  if(stale||disabled||saving||aiBlocked){if(propagate)throw Error(aiBlocked?"请先应用或放弃 AI 优化建议，再保存候选":"请先核对当前场次，再保存候选");return;}
  const sourceRefs=refs.split("\n").map(ref=>ref.trim()).filter(Boolean);
  const next={...sequence,title,sourceRefs,eventRefs};
  setSaving(true);setError("");
  try{
   if(title!==sequence.title||sourceRefs.join("\n")!==(sequence.sourceRefs??[]).join("\n")||
     eventRefs.join("\n")!==(sequence.eventRefs??[]).join("\n")){await onConfirm(next);if(!fieldSession.candidate)updated("场次详情");}
   setEditing(false);
  }catch(error){setError(error instanceof Error?error.message:"场次保存失败，请检查版本后重试");if(propagate)throw error;}
  finally{setSaving(false);}
 };
 const fieldSession=useCandidateFieldSession(editing,()=>confirm(true));
 const control={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke,
  "--tw-ring-color":theme.node.activeStroke} as CSSProperties;
 const titleEditor=<input ref={element=>{titleRef.current=element;}} aria-label={`场次 ${index+1} 名称`}
  className={"w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm leading-relaxed outline-none transition-shadow focus-visible:ring-2"+(fieldSession.optimization?" pr-12":"")}
  style={control} value={title} disabled={disabled} onChange={event=>setTitle(event.target.value)}/>;
 return <div data-episode-sequence-mode={editing?"editing":"reading"}
  className={editing?"min-w-0 space-y-3 rounded-xl border p-3 sm:p-4":"min-w-0 space-y-2"}
  style={editing?{background:theme.node.fill,borderColor:theme.node.stroke}:undefined}
  aria-label={"场次 "+(index+1)+" 详情"}>
   <div className="flex min-h-7 items-center gap-1.5">
    <strong className="text-xs">场次详情</strong>
    {editing&&<span className="rounded-md px-2 py-0.5 text-[11px] font-semibold"
     style={{background:theme.toolbar.activeBg,color:theme.toolbar.activeText}}>编辑中</span>}
    {!editing&&<button type="button" aria-label={"编辑场次 "+(index+1)+" 详情"} title="编辑场次详情"
      disabled={disabled||fieldSession.otherEditing} className="inline-grid size-7 shrink-0 place-items-center rounded-md border border-transparent hover:opacity-80 focus-visible:outline focus-visible:outline-2"
      style={{color:theme.node.muted,outlineColor:theme.node.activeStroke}} onClick={begin}>
      <Pencil size={13} aria-hidden="true"/>
     </button>}
   </div>
   {editing?<>
    <div className="grid min-w-0 gap-1.5">
     <span style={{color:theme.node.muted}}>场次名称</span>
     {fieldSession.optimization?<DramaEpisodeAiControls scope={fieldSession.optimization} field="sequenceTitle" sequenceId={sequence.id}
      draft={title} inputRef={titleRef} theme={theme} disabled={disabled||saving||stale} onApply={setTitle} onBlockingChange={setAiBlocked}>{titleEditor}</DramaEpisodeAiControls>:titleEditor}
    </div>
    <label className="grid min-w-0 gap-1.5">
     <span style={{color:theme.node.muted}}>场次原文段落 ID（每行一个）</span>
     <textarea aria-label={`场次 ${index+1} 原文段落`} className="thin-scrollbar w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm leading-relaxed outline-none transition-shadow focus-visible:ring-2"
      style={control} rows={2} value={refs} disabled={disabled} onChange={event=>setRefs(event.target.value)}/>
    </label>
    <div className="space-y-1.5">
     <span style={{color:theme.node.muted}}>本场关联剧情事件</span>
     {items.filter(item=>item.text.trim()).map((item,index)=>
      <label key={item.id||index} className="flex items-start gap-2">
       <input type="checkbox" className="mt-0.5" disabled={disabled}
        checked={eventRefs.some(ref=>resolveRef(ref)?.id===item.id)}
        onChange={change=>setEventRefs(current=>change.target.checked?
         [...new Set([...current.filter(ref=>ref!==item.text||ref===item.id),item.id])]:current.filter(ref=>resolveRef(ref)?.id!==item.id))}/>
       <span className="break-words">{item.text}</span>
      </label>)}
     {eventRefs.filter(ref=>!resolveRef(ref)).map((ref,index)=><div key={index} className="flex flex-wrap items-center gap-2 text-xs">
      <span className="break-all">待核对的旧事件引用：{ref}</span>
      <button type="button" disabled={disabled} className="rounded-md border px-2 py-1" style={control}
       onClick={()=>setEventRefs(current=>current.filter(item=>item!==ref))}>移除此引用</button>
     </div>)}
    </div>
    {stale&&<DramaInlineFeedback theme={theme}>场次已在其他位置更新，请取消并重新编辑。</DramaInlineFeedback>}
    {error&&<DramaInlineFeedback theme={theme} level="error" error={error}/>}
    {saving&&<DramaInlineFeedback theme={theme} level="info" pending>正在保存{fieldSession.candidate?"候选场次":"场次草案"}…</DramaInlineFeedback>}
    <EpisodeEditActions theme={theme} confirmText={fieldSession.candidate?"保存候选":undefined} label={"场次 "+(index+1)+" 详情"}
     disabled={disabled||saving||stale||aiBlocked} onCancel={cancel} onConfirm={()=>void confirm()}/>
   </>:
    <div data-episode-sequence-readonly="" className="grid min-w-0 gap-2 rounded-md border-l-2 px-3 py-2.5 text-xs leading-relaxed"
     style={{background:theme.toolbar.activeBg,color:theme.node.text,borderLeftColor:theme.node.stroke}}>
     <p><span style={{color:theme.node.muted}}>名称：</span>{sequence.title||"未命名场次"}</p>
     <p className="break-words"><span style={{color:theme.node.muted}}>原文段落：</span>{sequence.sourceRefs?.join("、")||"未设置"}</p>
     <div>
      <span style={{color:theme.node.muted}}>关联事件：</span>
      <span>{sequence.eventRefs?.length??0} 条</span>
      {sequence.eventRefs?.length? <ul className="mt-1 list-inside list-disc space-y-1">
       {sequence.eventRefs.map(ref=><li key={ref} className="break-words">
        {resolveRef(ref)?.text??ref}
       </li>)}
      </ul>:null}
     </div>
    </div>}
    {(sequence.eventRefs??[]).some(ref=>!resolveRef(ref))&&
      <DramaInlineFeedback theme={theme}>事件引用缺失或有歧义，请重新选择关联的剧情事件。</DramaInlineFeedback>}
    {(sequence.replaces?.length??0)>0&&<p className="text-[11px]">替代旧场次：{sequence.replaces?.join("、")}。请审核旧镜头的场次迁移。</p>}
  </div>;
}

export function DramaEpisodeFields({episodes,expanded,disabled,control,onChange,initialEpisodeId,
 projectId,nodeId,onPatchEpisode,onReloadEpisode,onWaitForDraftSave,candidateMode=false,onCandidatePatch}:{
 episodes:DramaEpisode[];expanded:boolean;disabled:boolean;control?:CSSProperties;
 onChange:(episodes:DramaEpisode[])=>void;initialEpisodeId?:string;
 projectId?:string;nodeId?:string;
 onPatchEpisode?:(entryId:string,expectedDigest:string,changes:{title?:string;synopsis?:string;ending?:string},sequenceId?:string)=>Promise<void>;
 onReloadEpisode?:()=>Promise<void>;
 onWaitForDraftSave?:()=>Promise<void>;
 candidateMode?:boolean;onCandidatePatch?:(episodeId:string,changes:EpisodeCandidateChanges)=>Promise<void>;
}){
 const appearance=useThemeStore(state=>state.theme);
 const theme=canvasThemes[appearance];
 const [selected,setSelected]=useState(initialEpisodeId??"");
 const [recentlyAdded,setRecentlyAdded]=useState("");
 const openedAddedRef=useRef("");
 const [pendingDelete,setPendingDelete]=useState<{episodeId:string;sequenceId:string}|null>(null);
 const active=episodes.find(episode=>episode.id===selected)??episodes[0];
 const activeIndex=active?episodes.findIndex(episode=>episode.id===active.id):-1;
 const scopedCas=Boolean(expanded&&projectId&&nodeId&&onPatchEpisode);
 const candidateSession=useContext(CandidateFieldContext);
 const candidateFieldOpen=Boolean(candidateSession?.activeKey);
 const [episodeDigest,setEpisodeDigest]=useState<{id:string;digest:string;baseline:string}|null>(null);
 const [casBusy,setCasBusy]=useState(false);
 const [casError,setCasError]=useState("");
 const [casRefresh,setCasRefresh]=useState(0);
 const structuralSync=useRef(false);
 useEffect(()=>{
  if(!scopedCas||!active?.id||!projectId||!nodeId)return;
  let current=true;
  const controller=new AbortController();
  setEpisodeDigest(null);setCasError("");
  const url=`/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/revision-scope?`+
   `nodeId=${encodeURIComponent(nodeId)}&draft=true&entryId=${encodeURIComponent(active.id)}&limit=1`;
  const read=()=>canvasApi<{entries:DramaEpisode[];entryDigests:{id:string;digest:string}[]}>(
   url,"GET",undefined,controller.signal);
  void (async()=>{
   // Structural changes still use the full-draft autosave. Flush that change
   // before reading a digest, so a subsequent title CAS does not race it.
   if(structuralSync.current&&onWaitForDraftSave){
    await onWaitForDraftSave();
    if(!current)return;
    structuralSync.current=false;
   }
   const initial=await read();
   if(!current)return;
   let result=initial;
   if(!result.entries.some(entry=>entry.id===active.id)&&onWaitForDraftSave){
    await onWaitForDraftSave();
    if(!current)return;
    result=await read();
   }
   if(!current)return;
   const remote=result.entries.find(entry=>entry.id===active.id);
   const digest=result.entryDigests.find(item=>item.id===active.id)?.digest;
   if(!remote||!digest)throw Error("剧集版本不存在，请重新加载");
   // A refreshed digest must never legitimize overwriting unrelated remote edits.
   const fields=["title","synopsis","ending","targetDurationSec","events","eventItems",
    "sourceRefs","sequences"] as const;
   if(fields.some(key=>JSON.stringify(remote[key]??null)!==JSON.stringify(active[key]??null)))
    throw Error("服务器剧集内容已更新，请重新加载后再编辑，避免覆盖其他修改");
   setEpisodeDigest({id:active.id,digest,baseline:JSON.stringify(active)});
  })().catch(error=>{if(current)setCasError(error instanceof Error?error.message:"剧集版本读取失败");});
  return ()=>{current=false;controller.abort();};
 },[scopedCas,active?.id,projectId,nodeId,casRefresh]);
 const patchCas=(changes:{title?:string;synopsis?:string;ending?:string},sequenceId?:string):Promise<void>=>{
  if(!active||!onPatchEpisode||!episodeDigest||episodeDigest.id!==active.id||casBusy)
   return Promise.reject(Error("剧集版本尚未同步，请重新加载后重试"));
  if(!Object.keys(changes).length)return Promise.resolve();
  setCasBusy(true);setCasError("");
  return onPatchEpisode(active.id,episodeDigest.digest,changes,sequenceId)
   .then(()=>setCasRefresh(value=>value+1))
   .catch(error=>{
    const message=error instanceof Error?error.message:"剧集保存失败";
    const conflict=/conflict|digest|revision/i.test(message);
    setCasError(conflict?"剧集草案已发生冲突，服务器数据未被覆盖，请重新加载。":message);
    throw Error(conflict?"剧集版本冲突，请重新加载后重试":message);
   }).finally(()=>setCasBusy(false));
 };
 const edit=(patch:Partial<DramaEpisode>):void|Promise<void>=>{
  if(!active||disabled||casBusy)return;
  const keys=Object.keys(patch);
  if(candidateMode&&onCandidatePatch){
   // Event text is normalized only by the server; never transmit tentative
   // client-generated event IDs as authoritative candidate identity.
   if(Object.hasOwn(patch,"events"))return onCandidatePatch(active.id,{events:patch.events});
   const changes={...patch} as EpisodeCandidateChanges&{id?:string;eventItems?:DramaEpisode["eventItems"]};
   delete changes.id;delete changes.eventItems;
   if(Object.hasOwn(patch,"targetDurationSec"))changes.targetDurationSec=patch.targetDurationSec??null;
   return onCandidatePatch(active.id,changes);
  }
  if(scopedCas&&keys.length&&keys.every(key=>["title","synopsis","ending"].includes(key))){
   const changes=Object.fromEntries(keys.filter(key=>patch[key as keyof DramaEpisode]!==active[key as keyof DramaEpisode])
    .map(key=>[key,patch[key as "title"|"synopsis"|"ending"]])) as {title?:string;synopsis?:string;ending?:string};
   return Object.keys(changes).length?patchCas(changes):undefined;
  }
  const next={...active,...patch};
  const normalized=needsEpisodeEventNormalization(next)?normalizeEpisodeEvents(next,active):next;
  onChange(episodes.map(item=>item.id===active.id?normalized:item));
  if(scopedCas){
   structuralSync.current=true;
   setEpisodeDigest(null);
   setCasRefresh(value=>value+1);
  }
 };
 const structuralEdit=(patch:Partial<DramaEpisode>)=>{
  // Field confirmations surface their own errors. Structural actions use the
  // candidate mutation's persistent feedback instead of an unhandled rejection.
  void Promise.resolve(edit(patch)).catch(()=>{});
 };
 const editSequence=(original:EpisodeSequence,updated:EpisodeSequence):void|Promise<void>=>{
  if(!active)return;
  const titleOnly=original.title!==updated.title&&
   JSON.stringify(original.sourceRefs??[])===JSON.stringify(updated.sourceRefs??[])&&
   JSON.stringify(original.eventRefs??[])===JSON.stringify(updated.eventRefs??[])&&
   JSON.stringify(original.replaces??[])===JSON.stringify(updated.replaces??[]);
  if(scopedCas&&titleOnly&&recentlyAdded!==original.id)
   return patchCas({title:updated.title},original.id);
  return edit({sequences:active.sequences?.map(item=>item.id===original.id?updated:item)});
 };
 // The complete workspace can migrate the currently selected legacy draft.
 // Never write merely because a compact canvas summary is mounted. Wait for
 // an exact server baseline before a structural autosave in scoped mode.
 const needsNormalization=Boolean(active&&needsEpisodeEventNormalization(active));
 const autoNormalize=!candidateMode&&expanded&&needsNormalization&&(!scopedCas||!!onWaitForDraftSave);
 const migrated=useRef(new WeakSet<DramaEpisode>());
 useEffect(()=>{
  if(!autoNormalize||!active||disabled||casBusy||casError||migrated.current.has(active))return;
  if(scopedCas&&(episodeDigest?.id!==active.id||episodeDigest.baseline!==JSON.stringify(active)))return;
  migrated.current.add(active);
  const normalized=normalizeEpisodeEvents(active,active);
  if(JSON.stringify(normalized)===JSON.stringify(active))return;
  if(scopedCas){structuralSync.current=true;setEpisodeDigest(null);setCasRefresh(value=>value+1);}
  onChange(episodes.map(item=>item.id===active.id?normalized:item));
 },[autoNormalize,active,disabled,casBusy,casError,scopedCas,episodeDigest,episodes,onChange]);
 const scopedLocked=disabled||casBusy||autoNormalize||(scopedCas&&(!episodeDigest||!!casError));
 const pageSize=10;
 const [pageStart,setPageStart]=useState(0);
 const [serverPage,setServerPage]=useState<{offset:number;entries:DramaEpisode[];total:number}|null>(null);
 const [pageError,setPageError]=useState("");
 const paginated=scopedCas&&episodes.length>pageSize;
 const safePageStart=Math.min(Math.floor(pageStart/pageSize)*pageSize,
  Math.floor(Math.max(0,episodes.length-1)/pageSize)*pageSize);
 useEffect(()=>{
  if(!paginated||activeIndex<0)return;
  if(activeIndex<safePageStart||activeIndex>=safePageStart+pageSize)
   setPageStart(Math.floor(activeIndex/pageSize)*pageSize);
 },[paginated,active?.id,activeIndex,safePageStart]);
 useEffect(()=>{
  if(!paginated||!projectId||!nodeId)return;
  let current=true;
  const controller=new AbortController();
  setServerPage(null);setPageError("");
  const path=`/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/revision-scope?`+
   `nodeId=${encodeURIComponent(nodeId)}&draft=true&offset=${safePageStart}&limit=${pageSize}`;
  void canvasApi<{entries:DramaEpisode[];total:number}>(path,"GET",undefined,controller.signal)
   .then(result=>{if(current)setServerPage({offset:safePageStart,entries:result.entries,total:result.total});})
   .catch(error=>{if(current)setPageError(error instanceof Error?error.message:"剧集目录分页读取失败");});
  return ()=>{current=false;controller.abort();};
 },[paginated,projectId,nodeId,safePageStart,casRefresh,episodes]);
 const localPage=episodes.slice(safePageStart,safePageStart+pageSize);
 const serverPageMatches=serverPage?.offset===safePageStart&&serverPage.total===episodes.length&&
  serverPage.entries.length===localPage.length&&
  serverPage.entries.every((entry,index)=>JSON.stringify(entry)===JSON.stringify(localPage[index]));
 const directoryEpisodes=paginated?(serverPageMatches?serverPage.entries:localPage):episodes;
 const changePage=(offset:number)=>{
  const target=Math.max(0,Math.min(Math.floor(Math.max(0,episodes.length-1)/pageSize)*pageSize,offset));
  setPageStart(target);
  const episode=episodes[target];
  if(episode){setPendingDelete(null);setRecentlyAdded("");setSelected(episode.id);}
 };

 const field="w-full min-w-0 rounded-lg border px-3 py-2 text-sm leading-relaxed outline-none transition-colors focus-visible:ring-2 disabled:opacity-55";
 const fieldStyle={background:theme.node.fill,color:theme.node.text,borderColor:theme.node.stroke,
  "--tw-ring-color":theme.node.activeStroke} as CSSProperties;
 const cardStyle={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 const captionStyle={color:theme.node.muted};
 const smallAction="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-opacity hover:opacity-75 focus-visible:outline focus-visible:outline-2 disabled:opacity-40";
 if(!active)return <p className="rounded-xl border border-dashed px-4 py-5 text-sm leading-relaxed" style={cardStyle}>
  还没有剧集内容。设置目标集数后，点击「生成剧集候选」开始规划。
 </p>;
 return <fieldset disabled={disabled} data-episode-editor-layout={expanded?"expanded":"compact"}
  className={expanded
   ?"grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(116px,0.28fr)_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(220px,0.33fr)_minmax(0,1fr)] lg:grid-rows-1"
   :"grid min-w-0 gap-3"}
  style={{color:theme.node.text,colorScheme:appearance}}>
  {expanded?<aside aria-label="剧集导航" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border"
   style={cardStyle}>
   <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-3"
    style={{borderColor:theme.node.stroke}}>
    <div className="flex min-w-0 items-center gap-2">
     <BookText size={16} aria-hidden="true" style={captionStyle}/>
     <strong className="text-sm">剧集目录</strong>
    </div>
    <span className="rounded-md px-2 py-1 text-[11px] font-medium tabular-nums"
     style={{background:theme.toolbar.activeBg,color:theme.node.muted}}>{episodes.length} 集</span>
   </div>
   <div className="thin-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto p-2" data-canvas-no-zoom>
    {directoryEpisodes.map((episode,index)=>{
     const current=episode.id===active.id;
     const globalIndex=paginated?safePageStart+index:index;
     return <button type="button" key={episode.id} aria-pressed={current}
      aria-label={`选择第 ${globalIndex+1} 集：${episode.title||"未命名"}`}
      className="flex w-full min-w-0 items-start gap-2.5 rounded-lg border px-3 py-3 text-left transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={current?{background:theme.toolbar.activeBg,color:theme.node.text,
       borderColor:theme.node.stroke,outlineColor:theme.node.activeStroke}:
       {background:"transparent",color:theme.node.text,borderColor:"transparent",outlineColor:theme.node.activeStroke}}
      onClick={()=>{setPendingDelete(null);setRecentlyAdded("");setSelected(episode.id);}}>
      <span className="mt-0.5 shrink-0 text-[11px] font-semibold tabular-nums" style={captionStyle}>
       {String(globalIndex+1).padStart(2,"0")}
      </span>
      <span className="min-w-0 flex-1">
       <span className="block truncate text-xs font-semibold">{episode.title||"未命名剧集"}</span>
       <span className="mt-1 block truncate text-[11px]" style={captionStyle}>
        {episode.synopsis?.trim()||`${episode.events.length} 条剧情事件`}
       </span>
      </span>
      {current&&<span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full"
       style={{background:theme.node.activeStroke}}/>}
     </button>;
    })}
   </div>
   {paginated&&<div data-episode-scoped-directory="" className="shrink-0 space-y-1.5 border-t px-3 py-2"
    style={{borderColor:theme.node.stroke}}>
    <div className="flex justify-between gap-2 text-[11px]" style={captionStyle}>
     <span>{safePageStart+1}–{Math.min(safePageStart+pageSize,episodes.length)} / {episodes.length} 集</span>
     <span>每页 {pageSize} 集</span>
    </div>
    <div className="flex items-center gap-2">
     <button type="button" className={smallAction+" flex-1"} style={cardStyle} disabled={safePageStart===0}
      onClick={()=>changePage(safePageStart-pageSize)}>上一页</button>
     <button type="button" className={smallAction+" flex-1"} style={cardStyle}
      disabled={safePageStart+pageSize>=episodes.length}
      onClick={()=>changePage(safePageStart+pageSize)}>下一页</button>
    </div>
    {pageError&&<p role="status" className="break-words text-[11px]" style={captionStyle}>
     分页服务不可用，已使用当前草案目录：{pageError}</p>}
   </div>}
  </aside>:candidateMode?null:<select aria-label="选择剧集" className={field+" pr-7 font-medium"} style={fieldStyle}
   value={active.id} onChange={event=>{setPendingDelete(null);setRecentlyAdded("");setSelected(event.target.value);}}>
   {episodes.map((episode,index)=><option key={episode.id} value={episode.id}>
    第 {index+1} 集 · {episode.title||"未命名"}
   </option>)}
  </select>}
  <div aria-label="当前剧集编辑区"
   className={expanded?"thin-scrollbar min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain rounded-xl border p-3 sm:p-5":
    "grid min-w-0 gap-3 rounded-xl border p-3"} style={cardStyle} data-canvas-no-zoom>
   {expanded&&scopedCas&&<div aria-label="当前剧集 CAS 状态" className="flex min-w-0 items-center justify-between gap-2 text-xs">
    {casError?<DramaInlineFeedback theme={theme} level="error" error={casError}/>:!episodeDigest||casBusy?<DramaInlineFeedback theme={theme} level="info" pending>同步剧集版本中…</DramaInlineFeedback>:<span role="status" style={captionStyle}>单剧集精确保存已启用</span>}
    {casError&&<button type="button" className={smallAction} style={cardStyle} disabled={casBusy}
     onClick={()=>{
      setCasBusy(true);
      void Promise.resolve().then(()=>onReloadEpisode?.()).then(()=>{
       structuralSync.current=false;
       setCasError("");setCasRefresh(value=>value+1);
      }).catch(error=>setCasError(error instanceof Error?error.message:"重新加载剧集失败"))
       .finally(()=>setCasBusy(false));
     }}>重新加载剧集内容</button>}
   </div>}
   {expanded&&<header className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b pb-3"
    style={{borderColor:theme.node.stroke}}>
    <div className="min-w-0">
     <p className="text-[11px] font-medium" style={captionStyle}>第 {activeIndex+1} 集 · 剧集编辑</p>
     <h3 className="mt-1 truncate text-base font-semibold">{active.title||"未命名剧集"}</h3>
    </div>
    <span className="rounded-lg border px-2 py-1 text-[11px] tabular-nums"
     style={cardStyle}>{active.events.length} 条事件 · {active.sequences?.length??0} 场</span>
   </header>}
   <div className={expanded?"grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_190px]":"grid gap-3"}>
    <EpisodeReadEditField key={active.id+":title"} id="title" label="集标题" value={active.title}
     disabled={scopedCas?scopedLocked:disabled} theme={theme} onConfirm={title=>edit({title})}/>
    <EpisodeReadEditField key={active.id+":duration"} id="duration" label="目标时长（秒）"
     value={active.targetDurationSec===undefined?"":String(active.targetDurationSec)} placeholder="未设置"
     disabled={scopedLocked} theme={theme} type="number"
     onConfirm={duration=>edit({targetDurationSec:duration.trim()?Number(duration):undefined})}/>
   </div>
   <section className="grid min-w-0 gap-3" aria-label="剧情内容">
    <EpisodeReadEditField key={active.id+":synopsis"} id="synopsis" label="剧情梗概"
     value={active.synopsis} disabled={scopedCas?scopedLocked:disabled} theme={theme} multiline rows={expanded?5:3}
     count={value=>value.length+" 字"} onConfirm={synopsis=>edit({synopsis})}/>
    <EpisodeReadEditField key={active.id+":events"} id="events" label="剧情事件（每行一条）"
     value={active.events.join("\n")} disabled={scopedLocked} theme={theme} multiline rows={expanded?9:4}
     count={value=>value.split("\n").filter(line=>line.trim()).length+" 条"}
     onConfirm={text=>{
      if(candidateMode)return edit({events:text.split("\n")});
      const normalized=normalizeEpisodeEvents({...active,events:text.split("\n")},active);
      edit({events:normalized.events,eventItems:normalized.eventItems,sequences:normalized.sequences});
     }}/>
    <EpisodeReadEditField key={active.id+":ending"} id="ending" label="本集结尾"
     value={active.ending} disabled={scopedCas?scopedLocked:disabled} theme={theme} multiline rows={2}
     onConfirm={ending=>edit({ending})}/>
   </section>
   <section aria-label="场次规划" className="min-w-0 space-y-2 border-t pt-4" style={{borderColor:theme.node.stroke}}>
    <div className="flex flex-wrap items-center justify-between gap-2">
     <div className="flex items-center gap-2">
      <Layers3 size={16} style={captionStyle} aria-hidden="true"/>
      <h4 className="text-sm font-semibold">场次规划</h4>
      <span className="text-[11px] tabular-nums" style={captionStyle}>{active.sequences?.length??0} 场</span>
     </div>
     <button type="button" className={smallAction} style={cardStyle} disabled={candidateFieldOpen||(scopedCas?scopedLocked:disabled)}
      onClick={()=>{
        const sequences=active.sequences??[];
        const used=new Set(sequences.map(item=>item.title));
        let next=sequences.length+1;
        while(used.has(`新场次 ${next}`))next++;
        const id=`sequence_${crypto.randomUUID()}`;
        setPendingDelete(null);setRecentlyAdded(id);
        structuralEdit({sequences:[...sequences,{id,title:`新场次 ${next}`,sourceRefs:[],eventRefs:[]}]});
       }}>
      <Plus size={13} aria-hidden="true"/>添加场次
     </button>
    </div>
    <p className="text-[11px] leading-relaxed" style={captionStyle}>新增场次会自动展开；展开已有场次可编辑名称、来源与事件关联，或拆分、合并和删除。</p>
    {active.sequences?.map((sequence,index)=><details key={sequence.id}
     ref={element=>{
      if(element&&recentlyAdded===sequence.id&&openedAddedRef.current!==sequence.id){
       element.open=true;openedAddedRef.current=sequence.id;
      }
     }}
     className="min-w-0 rounded-lg border" style={cardStyle}>
     <summary onClick={event=>{if(candidateFieldOpen)event.preventDefault();}} className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-3">
      <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
       <GitBranch size={14} className="shrink-0" style={captionStyle} aria-hidden="true"/>
       <span className="truncate">场次 {index+1} · {sequence.title||"未命名"}</span>
      </span>
      <span className="shrink-0 text-[11px]" style={captionStyle}>
       {sequence.eventRefs?.length??0} 条事件 · 点击展开
      </span>
     </summary>
     <div className="grid min-w-0 gap-3 border-t p-3 text-xs" style={{borderColor:theme.node.stroke}}>
       <SequenceReadEditFields key={active.id+":"+sequence.id} sequence={sequence}
        index={index} items={active.eventItems??active.events.map(text=>({id:text,text}))}
        theme={theme} disabled={scopedCas?scopedLocked:disabled} startEditing={!candidateMode&&recentlyAdded===sequence.id}
        onConfirm={updated=>editSequence(sequence,updated)}/>
       <div className="flex flex-wrap gap-2 border-t pt-3" style={{borderColor:theme.node.stroke}}>
        <button type="button" className={smallAction} style={cardStyle} disabled={candidateFieldOpen||(scopedCas?scopedLocked:disabled)}
         onClick={()=>structuralEdit({sequences:splitEpisodeSequence(active,sequence.id).sequences})}>
         <Split size={12} aria-hidden="true"/>拆成两场
        </button>
        {index>0&&<button type="button" className={smallAction} style={cardStyle} disabled={candidateFieldOpen||(scopedCas?scopedLocked:disabled)} onClick={()=>
         structuralEdit({sequences:mergeEpisodeSequences(active,active.sequences![index-1].id,sequence.id).sequences})}>
         <Merge size={12} aria-hidden="true"/>并入上一场
        </button>}
         <button type="button" aria-label={`删除场次 ${index+1}：${sequence.title||"未命名"}`}
          className={smallAction+" ml-auto"} style={cardStyle} disabled={candidateFieldOpen||(scopedCas?scopedLocked:disabled)}
          onClick={()=>setPendingDelete({episodeId:active.id,sequenceId:sequence.id})}>
          <Trash2 size={12} aria-hidden="true"/>删除场次
         </button>
        </div>
        {pendingDelete?.episodeId===active.id&&pendingDelete.sequenceId===sequence.id&&
         <div role="alertdialog" aria-label={`确认删除场次 ${index+1}`}
          className="space-y-2 rounded-lg border p-3" style={{...cardStyle,background:theme.toolbar.activeBg}}>
          <div className="flex items-start gap-2">
           <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" style={captionStyle}/>
           <div className="min-w-0 space-y-1 text-xs">
            <p className="font-semibold">确定删除“{sequence.title||`场次 ${index+1}`}”？</p>
            <p className="leading-relaxed" style={captionStyle}>
             将仅从当前{candidateMode?"剧集候选":"剧集草案"}中移除此场次{(sequence.eventRefs?.length??0)>0?`（包含 ${sequence.eventRefs?.length} 项事件关联）`:""}。
             剧情事件及其他场次不会删除；已有分镜与视频配置也不会被自动修改。
             如有镜头引用该场次，需在确认新剧集规划后检查并迁移相关镜头。
            </p>
           </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
           <button type="button" className={smallAction} style={cardStyle}
            onClick={()=>setPendingDelete(null)}>取消</button>
           <button type="button" aria-label={`确认删除场次 ${index+1}`} disabled={candidateFieldOpen||(scopedCas?scopedLocked:disabled)}
            className={smallAction+" font-semibold"} style={{background:theme.node.text,color:theme.node.panel,borderColor:theme.node.stroke}}
            onClick={()=>{
             if(active.sequences?.some(item=>item.id===sequence.id)){
              structuralEdit({sequences:active.sequences.filter(item=>item.id!==sequence.id)});
             }
             setPendingDelete(null);setRecentlyAdded("");
            }}>确认删除</button>
          </div>
         </div>}
      </div>
    </details>)}
   </section>
  </div>
 </fieldset>;
}
