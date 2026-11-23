import {useEffect,useRef,useState} from "react";
import {Check,Sparkles,Upload,X} from "lucide-react";
import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {useEffectiveConfig,resolveModelChannel,modelOptionName} from "@/stores/use-config-store";
import {modelChannelProvider,ensureSqliteModelChannelForExecution} from "@/features/backend-sync/model-channel-autoroute";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {awaitCanvasStorePersistence} from "@/stores/canvas/use-canvas-store";
import type {WorkspacePendingRegistration} from "./drama-creative-workspace";
import type {StoryTextSource} from "./drama-story-upstream";
import {storyTextSyncPatch} from "./drama-story-upstream";
import {DramaStoryUpstreamPanel} from "./drama-story-upstream-panel";
import {applyStoryCandidate,createStoryTarget,storyAssistRequest,
 type StoryAssistMode,type StoryCandidateTarget} from "./drama-story-editor-utils";

type Candidate={target:StoryCandidateTarget;text:string};
const labels:Record<StoryAssistMode,string>={continue:"AI 续写",rewrite:"全文改写",polish:"全文润色",selection:"改写选中内容"};

export function DramaStoryEditor({node,projectId,onChange,onConfirmVersion,onSnapshotDraft,versionBusy,onPendingChange,upstreamSources=[]}:{
 node:CanvasNodeData;projectId:string;onChange:(patch:Partial<CanvasNodeMetadata>)=>void;
 onConfirmVersion:(draft:string)=>Promise<void>;onSnapshotDraft?:()=>Promise<void>;
 versionBusy:boolean;onPendingChange?:WorkspacePendingRegistration;
 upstreamSources?:readonly StoryTextSource[];
}){
 const theme=canvasThemes[useThemeStore(state=>state.theme)];
 const config=useEffectiveConfig();
 const source=node.metadata?.dramaDraft??node.metadata?.content??node.metadata?.dramaConfirmed??"";
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
 const confirmed=Boolean(source.trim())&&source===node.metadata?.dramaConfirmed;
 const selectionText=selection&&selection.start<selection.end?draft.slice(selection.start,selection.end):"";
 const secondary="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium disabled:opacity-40";
 const primary="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold disabled:opacity-40";
 const control={background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text};
 const accent={background:theme.node.text,color:theme.node.panel};
 useEffect(()=>{
  if(source!==baseline&&draft===baseline){
   setDraft(source);setBaseline(source);setSelection(null);setCandidate(null);
  }
 },[source,baseline,draft]);
 useEffect(()=>()=>{controller.current?.abort();requestId.current++;},[]);
 const save=()=>{
  const value=live.current;
  if(value.source!==value.baseline)throw Error("故事已在其他位置更新，请核对新版本，不能覆盖原文");
  if(value.draft!==value.baseline){
   onChange({dramaDraft:value.draft,content:value.draft});
   setBaseline(value.draft);
   live.current={...value,source:value.draft,baseline:value.draft};
   setNotice("故事草案已更新，尚未确认版本");
  }
 };
 const saveRef=useRef(save);saveRef.current=save;
 const pendingRef=useRef(candidate);pendingRef.current=candidate;
 const pendingId=node.id+":story";
 useEffect(()=>{
  if(!onPendingChange)return;
  onPendingChange(pendingId,candidate||dirty?async()=>{
   if(pendingRef.current)throw Error("请先采用或放弃 AI 候选，再切换页面");
   saveRef.current();
  }:null);
  return ()=>onPendingChange(pendingId,null);
 },[candidate,dirty,onPendingChange,pendingId]);
 const capture=()=>{
  const textarea=inputRef.current;
  setSelection(textarea&&textarea.selectionEnd>textarea.selectionStart?
   {start:textarea.selectionStart,end:textarea.selectionEnd}:null);
 };
 const changeDraft=(value:string)=>{setDraft(value);setSelection(null);setError("");setNotice("");};
 const stop=()=>{
  controller.current?.abort();controller.current=null;requestId.current++;
  setBusy(false);setNotice("已停止等待 AI 候选，原文未改变");
 };
 const request=async(mode:StoryAssistMode)=>{
  if(busy||confirming)return;
  setError("");setNotice("");
  try{
   if(mode==="selection"&&!selectionText.trim())throw Error("请在正文中先选中需要改写的片段");
   const target=mode==="selection"
    ?createStoryTarget(mode,draft,selection!.start,selection!.end)
    :mode==="continue"?createStoryTarget(mode,draft,selection?.end??draft.length)
    :createStoryTarget(mode,draft);
   const payload=storyAssistRequest(target,instruction);
   const channel=resolveModelChannel(config,config.textModel);
   const provider=modelChannelProvider(channel,"text");
   if(!channel||!provider||provider==="volcengine_ark")throw Error("请先在设置中配置可用的在线文本模型");
   await ensureSqliteModelChannelForExecution(channel,provider);
   const id=++requestId.current,abort=new AbortController();
   controller.current=abort;setBusy(true);
   try{
    const result=await canvasApi<{candidate:string}>(
     "/api/v1/projects/"+encodeURIComponent(projectId)+"/drama-pipeline/story-edit","POST",
     {nodeId:node.id,channelId:channel.id,provider,baseUrl:channel.baseUrl,
      model:modelOptionName(config.textModel),...payload},abort.signal);
    if(id!==requestId.current||abort.signal.aborted)return;
    if(!result.candidate?.trim())throw Error("模型没有返回可用的文字");
    setCandidate({target,text:result.candidate});
    setNotice("已生成候选。审核并点击采用后才会写入编辑草稿");
   }finally{
    if(id===requestId.current){controller.current=null;setBusy(false);}
   }
  }catch(cause){
   if(cause instanceof Error&&cause.name==="AbortError")return;
   setBusy(false);setError(cause instanceof Error?cause.message:"AI 请求失败");
  }
 };
 const adopt=()=>{
  if(!candidate)return;
  try{
   setDraft(applyStoryCandidate(draft,candidate.target,candidate.text));
   setCandidate(null);setSelection(null);setError("");
   setNotice("已应用到编辑草稿，点击“保存草案”才会更新故事节点");
  }catch(cause){setError(cause instanceof Error?cause.message:"候选已失效");}
 };
 const applyUpstream=async(selected:StoryTextSource,mode:"replace"|"append"):Promise<boolean>=>{
  if(syncing)return false;
  setSyncing(true);
  try{
   const state=live.current;
   if(state.source!==state.baseline||state.draft!==state.baseline||state.candidate||busy||confirming)
    throw Error("当前故事存在未保存修改或 AI 候选，请先处理再刷新");
   const current=upstreamSources.find(item=>item.nodeId===selected.nodeId&&item.edgeId===selected.edgeId);
   if(!current||current.digest!==selected.digest)
    throw Error("上游连接或内容已变化，请重新比较");
   if(mode==="replace"&&state.draft.trim()&&state.draft!==selected.content&&onSnapshotDraft){
    await onSnapshotDraft();
    const now=live.current;
    if(now.source!==state.source||now.baseline!==state.baseline||now.draft!==state.draft||
     now.candidate!==state.candidate)throw Error("备份期间故事内容发生变化，刷新已取消");
   }
   const stillConnected=linkedSources.current.find(item=>item.nodeId===selected.nodeId&&item.edgeId===selected.edgeId);
   if(!stillConnected||stillConnected.digest!==selected.digest)throw Error("上游内容在备份期间变化，请重新比较");
   const patch=storyTextSyncPatch(selected,mode,state.draft);
   onChange(patch);
   setDraft(patch.dramaDraft??"");setBaseline(patch.dramaDraft??"");
   live.current={...state,source:patch.dramaDraft??"",baseline:patch.dramaDraft??"",draft:patch.dramaDraft??""};
   setSelection(null);setError("");
   setNotice(mode==="replace"?"已导入上游新草案，旧草案已备份，确认版本不变":"已追加上游文本到草案，确认版本不变");
   return true;
  }catch(error){setError(error instanceof Error?error.message:"无法同步上游文本");return false;}
  finally{setSyncing(false);}
 };
 const confirm=async()=>{
  setError("");setConfirming(true);
  try{
   if(candidate)throw Error("请先采用或放弃 AI 候选");
   saveRef.current();
   await awaitCanvasStorePersistence(projectId);
   await onConfirmVersion(live.current.draft);
   setNotice("故事版本已确认");
  }catch(cause){setError(cause instanceof Error?cause.message:"故事版本确认失败");}
  finally{setConfirming(false);}
 };
 return <section data-story-full-editor="" className="flex h-full min-h-0 flex-col gap-3"
  style={{color:theme.node.text}}>
  <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
   <strong className="text-sm">故事正文</strong>
   <div className="flex flex-wrap items-center gap-2">
    <span className="text-[11px]" style={{color:theme.node.muted}}>
     {draft.length} 字符 · {draft.split(/\r?\n/).filter(line=>line.trim()).length} 段 · {dirty?"未保存":confirmed?"已确认":"草案"}
    </span>
    <label className={secondary+" cursor-pointer"} style={control}><Upload size={13}/>导入 TXT / MD
     <input className="sr-only" type="file" accept=".txt,.md,text/plain,text/markdown"
      onChange={async event=>{
       const file=event.currentTarget.files?.[0];event.currentTarget.value="";
       if(!file)return;
       try{changeDraft(await file.text());setCandidate(null);}catch{setError("无法读取故事文件");}
      }}/>
    </label>
    <button className={secondary} type="button" style={control} disabled={!dirty||externalConflict||confirming||busy||syncing}
     onClick={()=>{try{saveRef.current();setError("");}catch(cause){setError(String(cause));}}}>
     <Check size={13}/>保存草案
    </button>
    <button className={primary} type="button" style={accent}
     disabled={!draft.trim()||versionBusy||confirming||busy||syncing||externalConflict}
     onClick={()=>void confirm()}>{confirming?"确认中…":"确认故事版本"}</button>
   </div>
  </div>
  <DramaStoryUpstreamPanel sources={upstreamSources} sync={node.metadata?.dramaTextSourceSync}
   draft={draft} blocked={dirty||!!candidate||busy||confirming||syncing||externalConflict||versionBusy}
   onApply={applyUpstream} theme={theme}/>
  <div className="grid min-h-0 min-w-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,0.9fr)]">
   <div className="flex min-h-0 min-w-0 flex-col gap-2">
    <textarea ref={inputRef} aria-label="故事完整正文" data-story-textarea=""
     className="thin-scrollbar min-h-[240px] w-full min-w-0 flex-1 resize-none rounded-xl border px-4 py-3 text-sm leading-7 outline-none focus-visible:ring-2"
     style={{...control,background:theme.node.fill}}
     value={draft} placeholder="撰写、粘贴或导入故事原文…"
     onChange={event=>changeDraft(event.target.value)}
     onSelect={capture} onKeyUp={capture} onMouseUp={capture}
     onKeyDown={event=>{
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="s"){
       event.preventDefault();try{saveRef.current();}catch(cause){setError(String(cause));}
      }
     }}/>
    <div className="flex justify-between gap-2 text-[11px]" style={{color:theme.node.muted}}>
     <span>{selectionText?"已选择 "+selectionText.length+" 字符，可执行局部改写":"选中正文中的一段文字后，可仅改写该片段"}</span>
     <span>Ctrl / Cmd + S 保存</span>
    </div>
   </div>
   <aside aria-label="故事 AI 创作" className="flex min-h-0 min-w-0 flex-col gap-3 rounded-xl border p-3" style={control}>
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
       disabled={busy||confirming||(mode!=="continue"&&!draft.trim())||(mode==="selection"&&!selectionText)}
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
       disabled={candidate.target.baseline!==draft||!candidate.text.trim()} onClick={adopt}>采用候选</button>
     </div>
    </div>:<div className="grid min-h-[100px] flex-1 place-items-center rounded-lg border border-dashed p-4 text-center text-xs"
     style={{borderColor:theme.node.stroke,color:theme.node.muted}}>
     AI 候选将在这里预览，可修改、采用或放弃。
    </div>}
    {externalConflict&&<p role="alert" className="text-xs">故事已在其他位置更新，请先核对版本，本窗口不会覆盖新内容。</p>}
    {error&&<p role="alert" className="break-words text-xs">{error}</p>}
    {notice&&!error&&<p role="status" className="text-xs" style={{color:theme.node.muted}}>{notice}</p>}
   </aside>
  </div>
 </section>;
}
