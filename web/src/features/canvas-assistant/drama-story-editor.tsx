import {useContext,useEffect,useMemo,useRef,useState} from "react";
import {ArrowRight,Copy,Pencil,Sparkles,Upload,X} from "lucide-react";
import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {useEffectiveConfig,resolveModelChannel,modelOptionName} from "@/stores/use-config-store";
import {modelChannelProvider,ensureSqliteModelChannelForExecution} from "@/features/backend-sync/model-channel-autoroute";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {awaitCanvasStorePersistence} from "@/stores/canvas/use-canvas-store";
import type {WorkspacePendingRegistration,StoryCandidateResolution} from "./drama-creative-workspace";
import {DramaEditActions} from "./drama-edit-actions";
import {useDramaFeedback} from "./drama-feedback";
import {resolveStoryDraft,storyVersionConfirmed} from "./drama-story-state";
import type {StoryTextSource} from "./drama-story-upstream";
import {storySourceSummary} from "./drama-story-upstream";
import {DramaStoryHistoryNavigationContext} from "./drama-story-history-navigation";
import {applyStoryCandidate,storyAssistLabels,storyTargetForOperation,storyTargetLabel,storyAssistRequest,
 type StoryAssistOperation,type StoryContinuationScope,type StorySelection} from "./drama-story-editor-utils";
import {DramaStoryCandidatePanel,type StoryCandidate} from "./drama-story-candidate-panel";

export function DramaStoryEditor({node,projectId,onChange,onConfirmVersion,versionBusy,onPendingChange,upstreamSources=[]}:{
 node:CanvasNodeData;projectId:string;onChange:(patch:Partial<CanvasNodeMetadata>)=>Promise<void>;
 onConfirmVersion?:(draft:string)=>Promise<void>;
 versionBusy:boolean;onPendingChange?:WorkspacePendingRegistration;
 upstreamSources?:readonly StoryTextSource[];
}){
 const theme=canvasThemes[useThemeStore(state=>state.theme)];
 const config=useEffectiveConfig();
 const feedback=useDramaFeedback()?.api;
 const openHistory=useContext(DramaStoryHistoryNavigationContext);
 const source=resolveStoryDraft(node);
 const [editing,setEditing]=useState(false),[aiOpen,setAiOpen]=useState(false);
 const [saving,setSaving]=useState(false),[importing,setImporting]=useState(false);
 const saveLock=useRef(false),importLock=useRef(false),aiLock=useRef(false);
 const taskRef=useRef<ReturnType<NonNullable<typeof feedback>["beginTask"]>>(null);
 const mounted=useRef(true);
 const [baseline,setBaseline]=useState(source),[draft,setDraft]=useState(source);
 const [selection,setSelection]=useState<StorySelection|null>(null);
 const [operation,setOperation]=useState<StoryAssistOperation>("continue");
 const [continuationScope,setContinuationScope]=useState<StoryContinuationScope>("end");
 const [instruction,setInstruction]=useState("");
 const [candidate,setCandidate]=useState<StoryCandidate|null>(null);
 const [candidateEdit,setCandidateEdit]=useState<string|null>(null);
 const [closeIntent,setCloseIntent]=useState(false);
 const [busy,setBusy]=useState(false),[confirming,setConfirming]=useState(false);
 const [error,setError]=useState(""),[notice,setNotice]=useState("");
 const inputRef=useRef<HTMLTextAreaElement>(null);
 const controller=useRef<AbortController|null>(null),requestId=useRef(0);
 const sourceContext=JSON.stringify({sync:node.metadata?.dramaTextSourceSync??null,
  links:upstreamSources.map(x=>[x.nodeId,x.edgeId,x.digest]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
 const live=useRef({source,baseline,draft,candidate,sourceContext,candidateEdit});
 live.current={source,baseline,draft,candidate,sourceContext,candidateEdit};
 const externalConflict=source!==baseline,dirty=draft!==baseline;
 const confirmed=storyVersionConfirmed(node);
 const locked=saving||confirming||busy||importing||versionBusy;
 const selected=!!selection&&selection.start<selection.end;
 const preview=useMemo(()=>{
  if(!aiOpen)return {target:null,issue:""};
  try{
   const target=storyTargetForOperation(operation,draft,selection,continuationScope);
   storyAssistRequest(target,instruction);
   return {target,issue:""};
  }catch(cause){return {target:null,issue:cause instanceof Error?cause.message:"无法生成候选"};}
 },[aiOpen,operation,draft,selection,continuationScope,instruction]);
 const candidateStale=!!candidate&&(candidate.target.baseline!==draft||candidate.sourceBaseline!==source||
  candidate.sourceContext!==sourceContext||externalConflict);
 const canAdopt=!!candidate&&!candidateStale&&!locked&&candidateEdit===null&&!!candidate.text.trim();
 const secondary="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium disabled:opacity-40";
 const primary="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold disabled:opacity-40";
 const control={background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text};
 const accent={background:theme.node.text,color:theme.node.panel};
 useEffect(()=>{
  if(!saving&&source!==baseline&&draft===baseline){
   setDraft(source);setBaseline(source);setSelection(null);setContinuationScope("end");
  }
 },[source,baseline,draft,saving]);
 useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;controller.current?.abort();requestId.current++;taskRef.current?.end();};},[]);
 useEffect(()=>{if(editing)inputRef.current?.focus();},[editing]);
 const save=async()=>{
  const value=live.current;
  if(saveLock.current||aiLock.current||importLock.current)throw Error("当前操作尚未完成");
  if(value.candidate)throw Error("请先采用或舍弃 AI 候选");
  if(value.source!==value.baseline)throw Error("故事已在其他位置更新，请核对新版本，不能覆盖原文");
  if(value.draft===value.baseline){setEditing(false);return;}
  saveLock.current=true;setSaving(true);setError("");setNotice("");
  const task=feedback?.beginTask("保存故事草案",undefined,true);
  try{
   task?.phase("持久化草案");
   await onChange({dramaDraft:value.draft,content:value.draft});
   setBaseline(value.draft);
   live.current={...live.current,source:value.draft,baseline:value.draft};
   setEditing(false);setSelection(null);setContinuationScope("end");
   const notice="故事草案已保存，尚未确认版本";
   if(feedback)feedback.notify("story-save","success",notice);else setNotice(notice);
  }catch(cause){setError(cause instanceof Error?cause.message:"故事草案保存失败");throw cause;}
  finally{task?.end();saveLock.current=false;setSaving(false);}
 };
 const saveRef=useRef(save);saveRef.current=save;
 const pendingId=node.id+":story",candidateId=node.id+":story-candidate";
 useEffect(()=>{
  if(!onPendingChange)return;
  onPendingChange(pendingId,dirty?()=>saveRef.current():null);
  return ()=>onPendingChange(pendingId,null);
 },[dirty,onPendingChange,pendingId]);
 const capture=()=>{
  const textarea=inputRef.current;
  if(!textarea)return;
  const next={start:textarea.selectionStart,end:textarea.selectionEnd};
  setSelection(next);
  if(next.start<next.end)setContinuationScope("cursor");
 };
 const changeDraft=(value:string)=>{
  live.current={...live.current,draft:value};setDraft(value);setSelection(null);setContinuationScope("end");setError("");setNotice("");
 };
 const stop=()=>{
  controller.current?.abort();controller.current=null;requestId.current++;
  taskRef.current?.end();taskRef.current=null;aiLock.current=false;
  setBusy(false);setNotice("已停止等待 AI 候选，原文未改变");
 };
 const request=async()=>{
  const value=live.current;
  if(aiLock.current||saveLock.current||importLock.current||confirming||value.candidate||value.source!==value.baseline||versionBusy)return;
  if(!preview.target||preview.target.baseline!==value.draft){setError(preview.issue||"正文已变化，请重新定位");return;}
  const target=preview.target,scope=continuationScope;
  const id=++requestId.current,abort=new AbortController();
  controller.current=abort;aiLock.current=true;setBusy(true);
  const task=feedback?.beginTask("AI 故事创作",storyAssistLabels[target.mode]+" · "+storyTargetLabel(target,scope),true);
  taskRef.current=task??null;
  setError("");setNotice("");
  const active=()=>mounted.current&&id===requestId.current&&!abort.signal.aborted;
  try{
   const payload=storyAssistRequest(target,instruction);
   const channel=resolveModelChannel(config,config.textModel);
   const provider=modelChannelProvider(channel,"text");
   if(!channel||!provider||provider==="volcengine_ark")throw Error("请先在设置中配置可用的在线文本模型");
   task?.phase("同步模型渠道");
   await ensureSqliteModelChannelForExecution(channel,provider);
   if(!active())return;
   if(live.current.source!==value.source||live.current.draft!==value.draft||live.current.sourceContext!==value.sourceContext)
    throw Error("同步渠道期间正文或关联来源已变化，请重新生成");
   task?.phase("生成候选");
   const result=await canvasApi<{candidate:string}>(
    "/api/v1/projects/"+encodeURIComponent(projectId)+"/drama-pipeline/story-edit","POST",
    {nodeId:node.id,channelId:channel.id,provider,baseUrl:channel.baseUrl,
     model:modelOptionName(config.textModel),...payload},abort.signal);
   if(!active())return;
   if(typeof result.candidate!=="string"||!result.candidate.trim())throw Error("模型没有返回可用的文字");
   const next={target,text:result.candidate,sourceBaseline:value.source,sourceContext:value.sourceContext,continuationScope:scope};
   live.current={...live.current,candidate:next,candidateEdit:null};
   setCandidate(next);setCandidateEdit(null);setCloseIntent(false);
   setNotice("已生成候选。审核并点击采用后才会写入编辑草稿");
  }catch(cause){
   if(!active())return;
   if(cause instanceof Error&&cause.name==="AbortError")return;
   setError(cause instanceof Error?cause.message:"AI 请求失败");
  }finally{
   task?.end();
   if(id===requestId.current){controller.current=null;taskRef.current=null;aiLock.current=false;setBusy(false);}
  }
 };
 const adopt=():{dirty:boolean}|null=>{
  const state=live.current,chosen=state.candidate;
  if(!chosen||state.candidateEdit!==null||state.source!==state.baseline||locked||aiLock.current||saveLock.current||importLock.current)return null;
  try{
   if(chosen.sourceBaseline!==state.source||chosen.sourceContext!==state.sourceContext)throw Error("正文或关联来源已变化，候选已过期");
   const next=applyStoryCandidate(state.draft,chosen.target,chosen.text);
   live.current={...state,draft:next,candidate:null,candidateEdit:null};
   setEditing(true);setDraft(next);setCandidate(null);setCandidateEdit(null);setSelection(null);setContinuationScope("end");setError("");
   setNotice("已应用到编辑草稿，点击“保存草案”才会更新故事节点");
   if(closeIntent)setAiOpen(false);setCloseIntent(false);
   return {dirty:next!==state.baseline};
  }catch(cause){setError(cause instanceof Error?cause.message:"候选已失效");return null;}
 };
 const discard=()=>{
  const state=live.current;
  live.current={...state,candidate:null,candidateEdit:null};
  setCandidate(null);setCandidateEdit(null);setError("");setNotice("已舍弃候选，故事正文未改变");
  if(closeIntent)setAiOpen(false);setCloseIntent(false);
  return {dirty:state.draft!==state.baseline};
 };
 const updateCandidateEdit=(value:string|null)=>{
  live.current={...live.current,candidateEdit:value};setCandidateEdit(value);
 };
 const confirmCandidateEdit=()=>{
  const state=live.current;
  if(!state.candidate||!state.candidateEdit?.trim()||locked)return;
  const next={...state.candidate,text:state.candidateEdit};
  live.current={...state,candidate:next,candidateEdit:null};
  setCandidate(next);setCandidateEdit(null);
 };
 const candidateResolution=useRef<StoryCandidateResolution>({canAdopt,adopt,discard});
 candidateResolution.current={canAdopt,adopt,discard};
 useEffect(()=>{
  if(!onPendingChange)return;
  onPendingChange(candidateId,candidate?async()=>{throw Error("请先采用或舍弃 AI 候选，再保存草案");}:null,
   candidate?{canAdopt,adopt:()=>candidateResolution.current.adopt(),discard:()=>candidateResolution.current.discard()}:undefined);
  return ()=>onPendingChange(candidateId,null);
 },[!!candidate,canAdopt,onPendingChange,candidateId]);
 const confirm=async()=>{
  setError("");setConfirming(true);
  try{
   if(candidate)throw Error("请先采用或放弃 AI 候选");
   await saveRef.current();
   await awaitCanvasStorePersistence(projectId);
   await onConfirmVersion?.(live.current.draft);
   setNotice("故事版本已确认");
  }catch(cause){setError(cause instanceof Error?cause.message:"故事版本确认失败");}
  finally{setConfirming(false);}
 };
 return <section data-story-full-editor="" className="flex h-full min-h-0 flex-col gap-3"
  style={{color:theme.node.text}}>
  <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
   <div className="flex items-center gap-1.5">
    <strong className="text-sm">故事正文</strong>
    {!editing&&<button type="button" aria-label="编辑故事正文" title="编辑故事正文" disabled={locked}
     className="inline-grid size-7 place-items-center rounded-md hover:opacity-80 disabled:opacity-45"
     style={{color:theme.node.muted}} onClick={()=>setEditing(true)}><Pencil size={13}/></button>}
    <button type="button" aria-label="复制故事正文" title="复制故事正文" disabled={!draft}
     className="inline-grid size-7 place-items-center rounded-md hover:opacity-80 disabled:opacity-45" style={{color:theme.node.muted}}
     onClick={async()=>{try{await navigator.clipboard.writeText(draft);
      if(feedback)feedback.notify("story-copy","success","故事正文已复制");else setNotice("故事正文已复制");
     }catch{setError("复制失败，请检查剪贴板权限");}}}><Copy size={13}/></button>
   </div>
   <div className="flex flex-wrap items-center gap-2">
    <span className="text-[11px]" style={{color:theme.node.muted}}>
     {draft.length} 字符 · {draft.split(/\r?\n/).filter(line=>line.trim()).length} 段{dirty?" · 未保存":""}
    </span>
    <label className={secondary+(locked||dirty||candidate?" opacity-45":" cursor-pointer")} style={control}><Upload size={13}/>导入 TXT / MD
     <input className="sr-only" type="file" accept=".txt,.md,text/plain,text/markdown"
      disabled={locked||dirty||!!candidate||externalConflict}
      onChange={async event=>{
       const file=event.currentTarget.files?.[0];event.currentTarget.value="";
       if(!file||importLock.current||saveLock.current||aiLock.current)return;
       const before=live.current;importLock.current=true;setImporting(true);
       const task=feedback?.beginTask("读取故事文件",file.name,true);
       try{
        const value=await file.text();
        if(!mounted.current)return;
        if(live.current.source!==before.source||live.current.draft!==before.draft||live.current.candidate)throw Error("读取期间故事已经变化，请重新导入");
        changeDraft(value);setEditing(true);
       }catch(e){if(mounted.current)setError(e instanceof Error?e.message:"无法读取故事文件");}
       finally{task?.end();importLock.current=false;if(mounted.current)setImporting(false);}
      }}/>
    </label>
    <button type="button" className={secondary} style={control} aria-expanded={aiOpen} disabled={busy}
     onClick={()=>{if(aiOpen&&live.current.candidate){setCloseIntent(true);return;}setAiOpen(open=>!open);}}><Sparkles size={13}/>{aiOpen?"收起 AI 创作":"AI 创作"}</button>
    {onConfirmVersion&&<button className={primary} type="button" style={accent}
     disabled={!draft.trim()||locked||externalConflict||!!candidate||confirmed&&!dirty}
     onClick={()=>void confirm()}>{confirming?"确认中…":"确认故事版本"}</button>}
   </div>
  </div>
  {(upstreamSources.length>0||node.metadata?.dramaTextSourceSync)&&<div data-story-source-status="" className="flex min-w-0 shrink-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px]" style={control}>
   <span className="shrink-0 font-medium">文本来源</span>
   <span role="status" className="min-w-0 flex-1 truncate" title={storySourceSummary(upstreamSources,node.metadata?.dramaTextSourceSync)}
    style={{color:theme.node.muted}}>{storySourceSummary(upstreamSources,node.metadata?.dramaTextSourceSync)}</span>
   <button type="button" className={secondary+" !min-h-7 shrink-0 !px-2"} style={control} disabled={!openHistory||locked}
    onClick={()=>openHistory?.()}>查看来源<ArrowRight size={12}/></button>
  </div>}
  <div className={"grid min-h-0 min-w-0 flex-1 gap-3 "+(aiOpen?"grid-rows-[minmax(240px,1fr)_minmax(280px,1fr)] xl:grid-cols-[minmax(0,2.5fr)_minmax(300px,1fr)] xl:grid-rows-1":"grid-cols-1")}>
   <div className="flex min-h-0 min-w-0 flex-col gap-2">
    <textarea ref={inputRef} aria-label="故事完整正文" data-story-textarea=""
     data-story-mode={editing?"editing":"reading"}
     className={"thin-scrollbar min-h-[240px] w-full min-w-0 flex-1 resize-none rounded-lg px-4 py-3 text-sm leading-7 outline-none focus-visible:ring-2 "+(editing?"border":"border-l-2")}
     style={{...control,background:editing?theme.node.fill:theme.toolbar.activeBg,borderColor:editing?theme.node.stroke:theme.node.activeStroke}}
     value={draft} readOnly={!editing||saving||importing||confirming||busy||versionBusy} placeholder={editing?"撰写、粘贴或导入故事原文…":"尚无故事正文，点击编辑开始创作"}
     onChange={event=>{if(editing&&!saveLock.current&&!importLock.current&&!aiLock.current&&!confirming&&!versionBusy)changeDraft(event.target.value);}}
     onSelect={capture} onKeyUp={capture} onMouseUp={capture}
     onKeyDown={event=>{
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="s"){
       event.preventDefault();if(editing&&!locked&&!candidate)void saveRef.current().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));
      }
     }}/>
    {editing&&<DramaEditActions theme={theme} label="故事正文" confirmText="保存草案"
     disabled={locked||!!candidate||externalConflict} onConfirm={()=>void saveRef.current().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)))}
     onCancel={()=>{if(!saveLock.current&&!aiLock.current&&!importLock.current&&!candidate){setDraft(source);setBaseline(source);setEditing(false);setSelection(null);setContinuationScope("end");setError("");setNotice("");}}}/>}
    {editing&&<span className="text-right text-[11px]" style={{color:theme.node.muted}}>Ctrl / Cmd + S 保存</span>}
    {externalConflict&&!saving&&<div role="alert" className="text-xs">故事已在其他位置更新，请取消编辑后核对最新内容。</div>}
    {error&&<p role="alert" className="break-words text-xs">{error}</p>}
    {notice&&!error&&<p role="status" className="text-xs" style={{color:theme.node.muted}}>{notice}</p>}
   </div>
   {aiOpen&&<aside aria-label="故事 AI 创作" className="thin-scrollbar flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto rounded-xl border p-3" style={control}>
    <div className="flex shrink-0 items-center justify-between gap-2">
     <strong className="flex items-center gap-1.5 text-sm"><Sparkles size={16}/>AI 创作</strong>
     <span className="truncate text-[11px]" style={{color:theme.node.muted}}>{modelOptionName(config.textModel)}</span>
    </div>
    <p className="text-xs leading-relaxed" style={{color:theme.node.muted}}>
     生成结果仅为候选，采用后仍需保存草案，不会自动确认故事版本。
    </p>
    <div className="grid shrink-0 grid-cols-3 gap-1.5" aria-label="AI 创作操作">
     {([["continue","续写"],["rewrite","改写"],["polish","润色"]] as const).map(([value,label])=>
      <button key={value} type="button" aria-label={label} aria-pressed={operation===value} disabled={locked||!!candidate}
       className={secondary+" !px-2"} style={operation===value?{...control,background:theme.toolbar.activeBg,borderColor:theme.node.activeStroke}:control}
       onClick={()=>setOperation(value)}>{label}</button>)}
    </div>
    <div className="grid shrink-0 gap-1.5 rounded-md border p-2 text-xs" style={control}>
     {operation==="continue"?<>
      <span className="font-medium">插入位置</span>
      <div className="grid grid-cols-2 gap-1.5">
       <button type="button" aria-pressed={continuationScope==="cursor"} disabled={locked||!!candidate||!selection}
        className={secondary+" !min-h-7 !px-1"} style={continuationScope==="cursor"?{...control,borderColor:theme.node.activeStroke}:control}
        onClick={()=>setContinuationScope("cursor")}>{selected?"选区末尾":"当前光标"}</button>
       <button type="button" aria-pressed={continuationScope==="end"} disabled={locked||!!candidate}
        className={secondary+" !min-h-7 !px-1"} style={continuationScope==="end"?{...control,borderColor:theme.node.activeStroke}:control}
        onClick={()=>setContinuationScope("end")}>文末</button>
      </div>
     </>:<span className="font-medium">处理范围：{selected?"当前选区":"全文"}</span>}
     <span data-story-ai-scope="" className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>
      {preview.target?storyTargetLabel(preview.target,continuationScope):operation==="continue"?"点击正文定位光标，或直接在文末续写":"选中正文片段即可局部处理，未选中时处理全文"}
     </span>
    </div>
    <label className="grid shrink-0 gap-1.5 text-xs font-medium">补充要求（可选）
     <textarea aria-label="AI 写作要求" rows={2} maxLength={2500}
      className="w-full resize-y rounded-lg border p-2 text-xs leading-relaxed" style={control}
      value={instruction} disabled={locked||!!candidate} onChange={event=>setInstruction(event.target.value)}
      placeholder="例如：保持角色设定、节奏更紧凑、增加悬念"/>
    </label>
    {!candidate&&!busy&&preview.issue&&<p role="status" className="break-words text-xs" style={{color:theme.node.muted}}>{preview.issue}</p>}
    {busy?<div className="flex shrink-0 items-center justify-between gap-2 text-xs">
     <span role="status">AI 生成中…</span>
     <button type="button" className={secondary} style={control} onClick={stop}><X size={12}/>停止等待</button>
    </div>:<button type="button" className={primary+" shrink-0"} style={accent}
     disabled={locked||!!candidate||externalConflict||!preview.target} onClick={()=>void request()}>生成候选</button>}
    {candidate?<DramaStoryCandidatePanel candidate={candidate} theme={theme} stale={candidateStale} locked={locked}
     editBuffer={candidateEdit} closeIntent={closeIntent}
     onEdit={()=>updateCandidateEdit(candidate.text)} onChange={updateCandidateEdit} onConfirmEdit={confirmCandidateEdit}
     onCancelEdit={()=>updateCandidateEdit(null)} onAdopt={()=>{adopt();}} onDiscard={()=>{discard();}}
     onContinueViewing={()=>setCloseIntent(false)}
     onCopy={async()=>{try{await navigator.clipboard.writeText(live.current.candidateEdit??live.current.candidate?.text??"");
       if(feedback)feedback.notify("story-candidate-copy","success","AI 候选已复制");else setNotice("AI 候选已复制");
      }catch{setError("复制失败，请检查剪贴板权限");}}}/>
     :<div className="grid min-h-[100px] flex-1 place-items-center rounded-lg border border-dashed p-4 text-center text-xs"
     style={{borderColor:theme.node.stroke,color:theme.node.muted}}>
     AI 候选将在这里对照原文预览，可编辑、复制、采用或舍弃。
    </div>}
   </aside>}
  </div>
 </section>;
}