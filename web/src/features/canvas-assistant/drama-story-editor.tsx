import {useEffect,useRef,useState} from "react";
import {Copy,Pencil,Sparkles,Upload,X} from "lucide-react";
import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {useEffectiveConfig,resolveModelChannel,modelOptionName} from "@/stores/use-config-store";
import {modelChannelProvider,ensureSqliteModelChannelForExecution} from "@/features/backend-sync/model-channel-autoroute";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {awaitCanvasStorePersistence} from "@/stores/canvas/use-canvas-store";
import type {WorkspacePendingRegistration} from "./drama-creative-workspace";
import {DramaEditActions} from "./drama-edit-actions";
import {useDramaFeedback} from "./drama-feedback";
import {resolveStoryDraft,storyVersionConfirmed} from "./drama-story-state";
import type {StoryTextSource} from "./drama-story-upstream";
import {storyTextSyncPatch} from "./drama-story-upstream";
import {DramaStoryUpstreamPanel} from "./drama-story-upstream-panel";
import {applyStoryCandidate,createStoryTarget,storyAssistRequest,
 type StoryAssistMode,type StoryCandidateTarget} from "./drama-story-editor-utils";

type Candidate={target:StoryCandidateTarget;text:string};
const labels:Record<StoryAssistMode,string>={continue:"AI 续写",rewrite:"全文改写",polish:"全文润色",selection:"改写选中内容"};

export function DramaStoryEditor({node,projectId,onChange,onConfirmVersion,onSnapshotDraft,versionBusy,onPendingChange,upstreamSources=[]}:{
 node:CanvasNodeData;projectId:string;onChange:(patch:Partial<CanvasNodeMetadata>)=>Promise<void>;
 onConfirmVersion?:(draft:string)=>Promise<void>;onSnapshotDraft?:()=>Promise<void>;
 versionBusy:boolean;onPendingChange?:WorkspacePendingRegistration;
 upstreamSources?:readonly StoryTextSource[];
}){
 const theme=canvasThemes[useThemeStore(state=>state.theme)];
 const config=useEffectiveConfig();
 const feedback=useDramaFeedback()?.api;
 const source=resolveStoryDraft(node);
 const [editing,setEditing]=useState(false),[aiOpen,setAiOpen]=useState(false);
 const [saving,setSaving]=useState(false),[importing,setImporting]=useState(false);
 const saveLock=useRef(false),syncLock=useRef(false),importLock=useRef(false),aiLock=useRef(false);
 const taskRef=useRef<ReturnType<NonNullable<typeof feedback>["beginTask"]>>(null);
 const mounted=useRef(true);
 const [baseline,setBaseline]=useState(source),[draft,setDraft]=useState(source);
 const [selection,setSelection]=useState<{start:number;end:number}|null>(null);
 const [instruction,setInstruction]=useState("");
 const [candidate,setCandidate]=useState<Candidate|null>(null);
 const [busy,setBusy]=useState(false),[confirming,setConfirming]=useState(false);
 const [syncing,setSyncing]=useState(false);
 const [error,setError]=useState(""),[notice,setNotice]=useState("");
 const inputRef=useRef<HTMLTextAreaElement>(null);
 const controller=useRef<AbortController|null>(null),requestId=useRef(0);
 const live=useRef({source,baseline,draft,candidate});live.current={source,baseline,draft,candidate};
 const linkedSources=useRef(upstreamSources);linkedSources.current=upstreamSources;
 const externalConflict=source!==baseline,dirty=draft!==baseline;
 const confirmed=storyVersionConfirmed(node);
 const locked=saving||syncing||confirming||busy||importing||versionBusy;
 const selectionText=selection&&selection.start<selection.end?draft.slice(selection.start,selection.end):"";
 const secondary="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium disabled:opacity-40";
 const primary="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold disabled:opacity-40";
 const control={background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text};
 const accent={background:theme.node.text,color:theme.node.panel};
 useEffect(()=>{
  if(!saving&&!syncing&&source!==baseline&&draft===baseline){
   setDraft(source);setBaseline(source);setSelection(null);
  }
 },[source,baseline,draft,saving,syncing]);
 useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;controller.current?.abort();requestId.current++;taskRef.current?.end();};},[]);
 useEffect(()=>{if(editing)inputRef.current?.focus();},[editing]);
 const save=async()=>{
  const value=live.current;
  if(saveLock.current||syncLock.current||aiLock.current||importLock.current)throw Error("当前操作尚未完成");
  if(value.candidate)throw Error("请先采用或放弃 AI 候选");
  if(value.source!==value.baseline)throw Error("故事已在其他位置更新，请核对新版本，不能覆盖原文");
  if(value.draft===value.baseline){setEditing(false);return;}
  saveLock.current=true;setSaving(true);setError("");setNotice("");
  const task=feedback?.beginTask("保存故事草案",undefined,true);
  try{
   task?.phase("持久化草案");
   await onChange({dramaDraft:value.draft,content:value.draft});
   setBaseline(value.draft);
   live.current={...live.current,source:value.draft,baseline:value.draft};
   setEditing(false);setSelection(null);
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
 useEffect(()=>{
  if(!onPendingChange)return;
  onPendingChange(candidateId,candidate?async()=>{throw Error("请先采用或放弃 AI 候选，再切换页面");}:null);
  return ()=>onPendingChange(candidateId,null);
 },[!!candidate,onPendingChange,candidateId]);
 const capture=()=>{
  const textarea=inputRef.current;
  setSelection(textarea&&textarea.selectionEnd>textarea.selectionStart?
   {start:textarea.selectionStart,end:textarea.selectionEnd}:null);
 };
 const changeDraft=(value:string)=>{setDraft(value);setSelection(null);setError("");setNotice("");};
 const stop=()=>{
  controller.current?.abort();controller.current=null;requestId.current++;
  taskRef.current?.end();taskRef.current=null;aiLock.current=false;
  setBusy(false);setNotice("已停止等待 AI 候选，原文未改变");
 };
 const request=async(mode:StoryAssistMode)=>{
  if(aiLock.current||saveLock.current||syncLock.current||importLock.current||confirming||candidate||externalConflict||versionBusy)return;
  const id=++requestId.current,abort=new AbortController();
  controller.current=abort;aiLock.current=true;setBusy(true);
  const task=feedback?.beginTask("AI 故事创作",labels[mode],true);
  taskRef.current=task??null;
  setError("");setNotice("");
  try{
   if(!draft.trim())throw Error("请先输入故事起始文字");
   if(mode==="selection"&&!selectionText.trim())throw Error("请在正文中先选中需要改写的片段");
   const target=mode==="selection"
    ?createStoryTarget(mode,draft,selection!.start,selection!.end)
    :mode==="continue"?createStoryTarget(mode,draft,selection?.end??draft.length)
    :createStoryTarget(mode,draft);
   const payload=storyAssistRequest(target,instruction);
   const channel=resolveModelChannel(config,config.textModel);
   const provider=modelChannelProvider(channel,"text");
   if(!channel||!provider||provider==="volcengine_ark")throw Error("请先在设置中配置可用的在线文本模型");
   task?.phase("同步模型渠道");
   await ensureSqliteModelChannelForExecution(channel,provider);
   if(id!==requestId.current||abort.signal.aborted)return;
   task?.phase("生成候选");
   const result=await canvasApi<{candidate:string}>(
     "/api/v1/projects/"+encodeURIComponent(projectId)+"/drama-pipeline/story-edit","POST",
     {nodeId:node.id,channelId:channel.id,provider,baseUrl:channel.baseUrl,
      model:modelOptionName(config.textModel),...payload},abort.signal);
    if(id!==requestId.current||abort.signal.aborted)return;
    if(!result.candidate?.trim())throw Error("模型没有返回可用的文字");
    setCandidate({target,text:result.candidate});
    setNotice("已生成候选。审核并点击采用后才会写入编辑草稿");
  }catch(cause){
   if(id!==requestId.current||abort.signal.aborted)return;
   if(cause instanceof Error&&cause.name==="AbortError")return;
   setError(cause instanceof Error?cause.message:"AI 请求失败");
  }finally{
   task?.end();
   if(id===requestId.current){controller.current=null;taskRef.current=null;aiLock.current=false;setBusy(false);}
  }
 };
 const adopt=()=>{
  if(!candidate||externalConflict||locked)return;
  try{
   setEditing(true);setDraft(applyStoryCandidate(draft,candidate.target,candidate.text));
   setCandidate(null);setSelection(null);setError("");
   setNotice("已应用到编辑草稿，点击“保存草案”才会更新故事节点");
  }catch(cause){setError(cause instanceof Error?cause.message:"候选已失效");}
 };
 const applyUpstream=async(selected:StoryTextSource,mode:"replace"|"append"):Promise<boolean>=>{
  if(syncLock.current||saveLock.current||aiLock.current||importLock.current)return false;
  syncLock.current=true;setSyncing(true);
  const task=feedback?.beginTask("同步上游文本",selected.title,true);
  try{
   const state=live.current;
   if(state.source!==state.baseline||state.draft!==state.baseline||state.candidate||busy||confirming)
    throw Error("当前故事存在未保存修改或 AI 候选，请先处理再刷新");
   const current=upstreamSources.find(item=>item.nodeId===selected.nodeId&&item.edgeId===selected.edgeId);
   if(!current||current.digest!==selected.digest)
    throw Error("上游连接或内容已变化，请重新比较");
   const needsBackup=mode==="replace"&&!!state.draft.trim()&&state.draft!==selected.content;
   if(needsBackup&&onSnapshotDraft){
    await onSnapshotDraft();
    const now=live.current;
    if(now.source!==state.source||now.baseline!==state.baseline||now.draft!==state.draft||
     now.candidate!==state.candidate)throw Error("备份期间故事内容发生变化，刷新已取消");
   }
   const stillConnected=linkedSources.current.find(item=>item.nodeId===selected.nodeId&&item.edgeId===selected.edgeId);
   if(!stillConnected||stillConnected.digest!==selected.digest)throw Error("上游内容在备份期间变化，请重新比较");
   const patch=storyTextSyncPatch(selected,mode,state.draft);
   await onChange(patch);
   setDraft(patch.dramaDraft??"");setBaseline(patch.dramaDraft??"");
   live.current={...state,source:patch.dramaDraft??"",baseline:patch.dramaDraft??"",draft:patch.dramaDraft??""};
   setSelection(null);setError("");
   setNotice(mode==="replace"?(needsBackup&&onSnapshotDraft?"已导入上游新草案，旧草案已备份，确认版本不变":"已导入上游新草案，确认版本不变"):"已追加上游文本到草案，确认版本不变");
   return true;
  }catch(error){setError(error instanceof Error?error.message:"无法同步上游文本");return false;}
  finally{task?.end();syncLock.current=false;setSyncing(false);}
 };
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
       if(!file||importLock.current||saveLock.current||syncLock.current||aiLock.current)return;
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
    <button type="button" className={secondary} style={control} aria-expanded={aiOpen} disabled={busy||!!candidate}
     onClick={()=>setAiOpen(open=>!open)}><Sparkles size={13}/>{aiOpen?"收起 AI 创作":"AI 创作"}</button>
    {onConfirmVersion&&<button className={primary} type="button" style={accent}
     disabled={!draft.trim()||locked||externalConflict||!!candidate||confirmed&&!dirty}
     onClick={()=>void confirm()}>{confirming?"确认中…":"确认故事版本"}</button>}
   </div>
  </div>
  <DramaStoryUpstreamPanel sources={upstreamSources} sync={node.metadata?.dramaTextSourceSync}
   draft={draft} blocked={dirty||!!candidate||locked||externalConflict}
   onApply={applyUpstream} theme={theme}/>
  <div className={"grid min-h-0 min-w-0 flex-1 gap-3 "+(aiOpen?"xl:grid-cols-[minmax(0,2.5fr)_minmax(300px,1fr)]":"grid-cols-1")}>
   <div className="flex min-h-0 min-w-0 flex-col gap-2">
    <textarea ref={inputRef} aria-label="故事完整正文" data-story-textarea=""
     data-story-mode={editing?"editing":"reading"}
     className={"thin-scrollbar min-h-[240px] w-full min-w-0 flex-1 resize-none rounded-lg px-4 py-3 text-sm leading-7 outline-none focus-visible:ring-2 "+(editing?"border":"border-l-2")}
     style={{...control,background:editing?theme.node.fill:theme.toolbar.activeBg,borderColor:editing?theme.node.stroke:theme.node.activeStroke}}
     value={draft} readOnly={!editing||saving||importing||syncing||confirming||versionBusy} placeholder={editing?"撰写、粘贴或导入故事原文…":"尚无故事正文，点击编辑开始创作"}
     onChange={event=>{if(editing&&!saveLock.current&&!importLock.current&&!syncLock.current&&!confirming&&!versionBusy)changeDraft(event.target.value);}}
     onSelect={capture} onKeyUp={capture} onMouseUp={capture}
     onKeyDown={event=>{
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="s"){
       event.preventDefault();if(editing&&!locked&&!candidate)void saveRef.current().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));
      }
     }}/>
    {editing&&<DramaEditActions theme={theme} label="故事正文" confirmText="保存草案"
     disabled={locked||!!candidate||externalConflict} onConfirm={()=>void saveRef.current().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)))}
     onCancel={()=>{if(!saveLock.current&&!syncLock.current&&!aiLock.current&&!importLock.current&&!candidate){setDraft(source);setBaseline(source);setEditing(false);setSelection(null);setError("");setNotice("");}}}/>}
    {editing&&<span className="text-right text-[11px]" style={{color:theme.node.muted}}>Ctrl / Cmd + S 保存</span>}
    {externalConflict&&!saving&&!syncing&&<div role="alert" className="text-xs">故事已在其他位置更新，请取消编辑后核对最新内容。</div>}
    {error&&<p role="alert" className="break-words text-xs">{error}</p>}
    {notice&&!error&&<p role="status" className="text-xs" style={{color:theme.node.muted}}>{notice}</p>}
   </div>
   {aiOpen&&<aside aria-label="故事 AI 创作" className="thin-scrollbar flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto rounded-xl border p-3" style={control}>
    <div className="flex shrink-0 items-center justify-between gap-2">
     <strong className="flex items-center gap-1.5 text-sm"><Sparkles size={16}/>AI 创作</strong>
     <span className="truncate text-[11px]" style={{color:theme.node.muted}}>{modelOptionName(config.textModel)}</span>
    </div>
    <p className="text-xs leading-relaxed" style={{color:theme.node.muted}}>
     AI 结果只作为候选，不会自动覆盖原文。续写默认插入选区末尾或全文末尾。
    </p>
    <label className="grid shrink-0 gap-1.5 text-xs font-medium">补充要求（可选）
     <textarea aria-label="AI 写作要求" rows={2} maxLength={2500}
      className="w-full resize-y rounded-lg border p-2 text-xs leading-relaxed" style={control}
      value={instruction} onChange={event=>setInstruction(event.target.value)}
      placeholder="例如：保持角色设定、节奏更紧凑、增加悬念"/>
    </label>
    <div className="grid shrink-0 grid-cols-2 gap-2">
     {(["continue","rewrite","polish","selection"] as const).map(mode=>
      <button type="button" className={secondary} style={control} key={mode} aria-label={labels[mode]}
       disabled={locked||!!candidate||externalConflict||!draft.trim()||(mode==="selection"&&!selectionText)}
       onClick={()=>void request(mode)}>{labels[mode]}</button>)}
    </div>
    {busy&&<div className="flex items-center justify-between text-xs">
     <span role="status">AI 生成中…</span>
     <button type="button" className={secondary} style={control} onClick={stop}><X size={12}/>停止等待</button>
    </div>}
    {candidate?<div data-story-ai-candidate="" className="flex min-h-[180px] flex-1 flex-col gap-2 rounded-lg border p-2.5"
     style={{borderColor:theme.node.stroke,background:theme.toolbar.activeBg}}>
     <strong className="text-xs">{labels[candidate.target.mode]} · 候选</strong>
     <textarea aria-label="AI 候选内容" className="thin-scrollbar min-h-[150px] w-full flex-1 resize-y rounded-lg border p-2 text-xs leading-6"
      style={control} value={candidate.text}
      onChange={event=>setCandidate(old=>old?{...old,text:event.target.value}:old)}/>
     {candidate.target.baseline!==draft&&<p role="alert" className="text-xs">正文已发生变化，候选已过期。</p>}
     <div className="flex gap-2">
      <button className={secondary+" flex-1"} type="button" style={control}
       onClick={()=>{setCandidate(null);setError("");setNotice("已放弃候选，故事正文未改变");}}>放弃候选</button>
      <button className={primary+" flex-1"} type="button" style={accent}
       disabled={locked||externalConflict||candidate.target.baseline!==draft||!candidate.text.trim()} onClick={adopt}>采用候选</button>
     </div>
    </div>:<div className="grid min-h-[100px] flex-1 place-items-center rounded-lg border border-dashed p-4 text-center text-xs"
     style={{borderColor:theme.node.stroke,color:theme.node.muted}}>
     AI 候选将在这里预览，可修改、采用或放弃。
    </div>}
   </aside>}
  </div>
 </section>;
}