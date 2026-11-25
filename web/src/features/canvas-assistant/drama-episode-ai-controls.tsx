import {useEffect,useRef,useState,type RefObject} from "react";
import {Sparkles} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {useEffectiveConfig,resolveModelChannel,modelOptionName} from "@/stores/use-config-store";
import {modelChannelProvider,ensureSqliteModelChannelForExecution} from "@/features/backend-sync/model-channel-autoroute";
import {DramaInlineFeedback} from "./drama-feedback";
import type {EpisodeOptimizeField,EpisodeOptimizeScope} from "./drama-episode-candidate-state";

type Range={start:number;end:number};
type Target={draft:string;mode:"field"|"selection";start:number;end:number};
type Proposal=Target&{replacement:string;value:string};
type Result={runId:string;episodeId:string;revision:number;field:EpisodeOptimizeField;sequenceId?:string;mode:Target["mode"];start:number;end:number;replacement:string;value:string};
const scopeKey=(scope:EpisodeOptimizeScope,field:EpisodeOptimizeField,sequenceId?:string)=>JSON.stringify([scope.projectId,scope.runId,scope.episodeId,scope.revision,field,sequenceId]);

/** Only mounted inside a candidate's active local field editor. Never writes
 * the run; applying the result changes just the parent's text buffer. */
export function DramaEpisodeAiControls({scope,field,sequenceId,draft,inputRef,theme,disabled,onApply,onBlockingChange}:{
 scope:EpisodeOptimizeScope;field:EpisodeOptimizeField;sequenceId?:string;draft:string;
 inputRef:RefObject<HTMLInputElement|HTMLTextAreaElement|null>;theme:CanvasTheme;disabled:boolean;
 onApply:(text:string)=>void;onBlockingChange:(blocked:boolean)=>void;
}){
 const config=useEffectiveConfig();
 const [open,setOpen]=useState(false),[instruction,setInstruction]=useState("");
 const [selection,setSelection]=useState<Range|null>(null);
 const [mode,setMode]=useState<Target["mode"]>("field");
 const [proposal,setProposal]=useState<Proposal|null>(null),[busy,setBusy]=useState(false);
 const [error,setError]=useState(""),[notice,setNotice]=useState("");
 const flight=useRef<{id:number;controller:AbortController}|null>(null),serial=useRef(0);
 const key=scopeKey(scope,field,sequenceId);
 const live=useRef({draft,key,disabled});live.current={draft,key,disabled};
 const previous=useRef({draft,key});
 const blockRef=useRef(onBlockingChange);blockRef.current=onBlockingChange;
 const invalidate=()=>{
  flight.current?.controller.abort();flight.current=null;serial.current++;
  setBusy(false);setProposal(null);blockRef.current(false);
 };
 useEffect(()=>{
  if(previous.current.draft===draft&&previous.current.key===key)return;
  previous.current={draft,key};
  if(flight.current||proposal){invalidate();setNotice("编辑内容已变化，旧 AI 结果已失效。");}
  setSelection(null);setMode("field");
 },[draft,key]);
 useEffect(()=>()=>{flight.current?.controller.abort();flight.current=null;serial.current++;blockRef.current(false);},[]);
 const capture=()=>{
  const input=inputRef.current,start=input?.selectionStart??0,end=input?.selectionEnd??0;
  const range=end>start&&draft.slice(start,end).trim()?{start,end}:null;
  setSelection(range);setMode(range?"selection":"field");
 };
 const toggle=()=>{
  if(open){invalidate();setOpen(false);setError("");setNotice("");}
  else{capture();setOpen(true);setError("");setNotice("");}
 };
 const request=async()=>{
  if(disabled||flight.current||!instruction.trim())return;
  setError("");setNotice("");setProposal(null);
  if(draft.length>12000){setError("当前字段超过 12000 字符，请缩短后再优化。");blockRef.current(false);return;}
  if(mode==="selection"&&(!selection||!draft.slice(selection.start,selection.end).trim())){
   setError("请先选中要改写的文字。");blockRef.current(false);return;
  }
  const target:Target={draft,mode,start:mode==="selection"?selection!.start:0,end:mode==="selection"?selection!.end:draft.length};
  const id=++serial.current,controller=new AbortController();
  flight.current={id,controller};setBusy(true);blockRef.current(true);
  const current=()=>flight.current?.id===id&&!controller.signal.aborted&&live.current.key===key&&live.current.draft===target.draft;
  let previewReady=false;
  try{
   const channel=resolveModelChannel(config,config.textModel),provider=modelChannelProvider(channel,"text");
   if(!channel||!provider||!["openai","openai_compatible","google_gemini"].includes(provider))throw Error("请先在设置中配置可用的文本模型");
   await ensureSqliteModelChannelForExecution(channel,provider);
   if(!current()||live.current.disabled)return;
   const result=await canvasApi<Result>(
    `/api/v1/projects/${encodeURIComponent(scope.projectId)}/drama-pipeline/runs/${encodeURIComponent(scope.runId)}/episodes/${encodeURIComponent(scope.episodeId)}/optimize`,"POST",
    {expectedRevision:scope.revision,field,sequenceId,mode,draft:target.draft,
     selection:mode==="selection"?{start:target.start,end:target.end}:undefined,
     instruction:instruction.trim(),channelId:channel.id,provider,baseUrl:channel.baseUrl,model:modelOptionName(config.textModel)},controller.signal);
   if(!current()||live.current.disabled)return;
   const value=target.draft.slice(0,target.start)+result.replacement+target.draft.slice(target.end);
   if(result.runId!==scope.runId||result.episodeId!==scope.episodeId||result.revision!==scope.revision||
    result.field!==field||result.sequenceId!==sequenceId||result.mode!==target.mode||result.start!==target.start||result.end!==target.end||
    typeof result.replacement!=="string"||!result.replacement.trim()||value!==result.value||value.length>12000)
    throw Error("drama_episode_optimize_result_invalid");
   previewReady=true;setProposal({...target,replacement:result.replacement,value});
   setNotice("审核修改前后内容，应用后仍需保存候选。");
  }catch(cause){
   if(current())setError(cause instanceof Error?cause.message:"AI 优化失败");
  }finally{
   if(flight.current?.id===id){
    flight.current=null;setBusy(false);blockRef.current(previewReady);
    // A successful response keeps the preview blocking until applied/discarded.
   }
  }
 };
 useEffect(()=>{blockRef.current(busy||Boolean(proposal));},[busy,proposal]);
 const apply=()=>{
  if(disabled||busy||!proposal||proposal.draft!==draft||live.current.key!==key)return;
  const value=proposal.value;
  invalidate();onApply(value);setOpen(false);setNotice("");setError("");
 };
 const style={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 const muted={color:theme.node.muted};
 const action="inline-flex min-h-7 items-center justify-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:opacity-80 disabled:opacity-40";
 return <div data-episode-ai-optimize="" className="min-w-0 space-y-2">
  <button type="button" aria-expanded={open} className={action} style={style} disabled={disabled} onClick={toggle}>
   <Sparkles size={13} aria-hidden="true"/>AI 优化
  </button>
  {open&&<div className="min-w-0 space-y-2 rounded-lg border p-3" style={style}>
   <div className="flex flex-wrap items-center gap-2">
    <button type="button" className={action} aria-pressed={mode==="field"} style={{...style,background:mode==="field"?theme.toolbar.activeBg:theme.node.panel}}
     disabled={busy||!!proposal||disabled} onClick={()=>setMode("field")}>当前字段</button>
    <button type="button" className={action} aria-pressed={mode==="selection"} style={{...style,background:mode==="selection"?theme.toolbar.activeBg:theme.node.panel}}
     disabled={busy||!!proposal||disabled||!selection} onClick={()=>setMode("selection")}>选区改写</button>
    <button type="button" className={action} style={style} disabled={busy||!!proposal||disabled} onClick={capture}>读取当前选区</button>
   </div>
   {mode==="selection"&&selection&&<div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-md border p-2 text-xs" style={style}>{draft.slice(selection.start,selection.end)}</div>}
   <label className="grid gap-1 text-xs">
    <span style={muted}>修改意见</span>
    <textarea aria-label="候选 AI 修改意见" className="min-h-16 w-full resize-y rounded-md border p-2 text-xs leading-relaxed" style={style}
     value={instruction} maxLength={2500} disabled={disabled||busy} placeholder="例如：增强冲突，但保留现有剧情走向" onChange={e=>setInstruction(e.target.value)}/>
   </label>
   <div className="flex flex-wrap items-center justify-between gap-2">
    <span className="text-[11px]" style={muted}>{modelOptionName(config.textModel)||"未配置文本模型"} · 使用当前编辑内容</span>
    {busy?<button type="button" className={action} style={style} onClick={()=>{invalidate();setNotice("已停止等待 AI 结果，编辑内容未改变。");}}>停止等待</button>:
     <button type="button" className={action} style={style} disabled={disabled||!instruction.trim()} onClick={()=>void request()}>{proposal?"重新优化":"生成优化建议"}</button>}
   </div>
   {busy&&<DramaInlineFeedback theme={theme} level="info" pending>正在生成优化建议…</DramaInlineFeedback>}
   {error&&<DramaInlineFeedback theme={theme} level="error" error={error}/>}
   {notice&&<DramaInlineFeedback theme={theme} level="info">{notice}</DramaInlineFeedback>}
   {proposal&&<div data-episode-ai-preview="" className="space-y-2">
    <div className="grid min-w-0 gap-2 md:grid-cols-2">
     <div className="min-w-0"><p className="mb-1 text-xs font-medium" style={muted}>修改前</p>
      <pre className="thin-scrollbar max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 text-xs leading-relaxed" style={style}>{proposal.draft}</pre></div>
     <div className="min-w-0"><p className="mb-1 text-xs font-medium" style={muted}>优化后</p>
      <pre className="thin-scrollbar max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 text-xs leading-relaxed" style={style}>{proposal.value}</pre></div>
    </div>
    <div className="flex justify-end gap-2">
     <button type="button" className={action} style={style} onClick={()=>{invalidate();setNotice("已放弃 AI 建议，原编辑内容不变。");}}>放弃建议</button>
     <button type="button" className={action} style={{...style,background:theme.node.text,color:theme.node.panel}} disabled={disabled||busy||proposal.draft!==draft}
      onClick={apply}>应用到编辑内容</button>
    </div>
   </div>}
  </div>}
 </div>;
}
