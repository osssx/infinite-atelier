import {useEffect,useRef,useState} from "react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {useEffectiveConfig,resolveModelChannel,modelOptionName} from "@/stores/use-config-store";
import {modelChannelProvider,ensureSqliteModelChannelForExecution} from "@/features/backend-sync/model-channel-autoroute";
import {DramaInlineFeedback} from "./drama-feedback";
import {useCandidateFieldSession,type EpisodeOptimizeScope,type WholeEpisodeChanges,type WholeEpisodeField} from "./drama-episode-candidate-state";
import type {DramaEpisode} from "./drama-episode-fields";

const labels:Record<WholeEpisodeField,string>={title:"集标题",synopsis:"剧情梗概",events:"剧情事件",ending:"本集结尾",targetDurationSec:"目标时长",scenePlans:"场次规划"};
const fields=Object.keys(labels) as WholeEpisodeField[];
type ScenePreview=NonNullable<WholeEpisodeChanges["scenePlans"]>[number]&{unresolvedCount?:number};
type Proposal={changes:WholeEpisodeChanges;linkedFields:WholeEpisodeField[];warnings:string[];beforeScenePlans?:ScenePreview[];instruction:string};
type Round={before:WholeEpisodeChanges;after:WholeEpisodeChanges;instruction:string};
type Result=Omit<Proposal,"instruction">&{runId:string;episodeId:string;revision:number};
function baseline(episode:DramaEpisode,field:WholeEpisodeField){
 if(field==="scenePlans")return (episode.sequences??[]).map(sequence=>({title:sequence.title,eventIndices:(sequence.eventRefs??[]).map(ref=>(episode.eventItems??[]).findIndex(item=>item.id===ref))}));
 if(field==="targetDurationSec")return episode.targetDurationSec??null;
 return episode[field];
}
function renderValue(value:unknown,field:WholeEpisodeField,events:string[]){
 if(field==="scenePlans")return (value as ScenePreview[]).map((scene,i)=>
  `场次 ${i+1}：${scene.title}\n`+([...scene.eventIndices.map(index=>index<0?"待核对的旧事件引用":`事件 ${index+1}：${events[index]??"待核对"}`),...(scene.unresolvedCount?[`${scene.unresolvedCount} 个待核对的旧事件引用`]:[])].join("\n")||"未关联事件")).join("\n\n")||"暂无场次";
 if(field==="events")return (value as string[]).map((item,index)=>`${index+1}. ${item}`).join("\n")||"暂无事件";
 if(field==="targetDurationSec")return value===null?"未设置":value+" 秒";
 return String(value??"")||"未填写";
}

function validChanges(changes:WholeEpisodeChanges,episode:DramaEpisode,draft:WholeEpisodeChanges){
 const entries=Object.entries(changes);
 const events=changes.events??draft.events??episode.events;
 return entries.every(([field,value])=>{
  if(field==="events")return Array.isArray(value)&&value.length<=500&&value.every(item=>typeof item==="string"&&item.length<=12000);
  if(field==="targetDurationSec")return value===null||typeof value==="number"&&Number.isFinite(value)&&value>0;
  if(field==="scenePlans")return Array.isArray(value)&&value.length===(episode.sequences?.length??0)&&value.every(scene=>
   scene&&typeof scene==="object"&&Object.keys(scene).length===2&&typeof scene.title==="string"&&scene.title.trim()&&Array.isArray(scene.eventIndices)&&
    Array.isArray(events)&&new Set(scene.eventIndices).size===scene.eventIndices.length&&scene.eventIndices.every((index:unknown)=>typeof index==="number"&&Number.isSafeInteger(index)&&index>=0&&index<events.length));
  return ["title","synopsis","ending"].includes(field)&&typeof value==="string"&&value.length<=12000&&(field!=="title"||Boolean(value.trim()));
 });
}

export function DramaWholeEpisodeOptimize({episode,scope,theme,disabled,onSave,onClose}:{
 episode:DramaEpisode;scope:EpisodeOptimizeScope;theme:CanvasTheme;disabled:boolean;
 onSave:(changes:WholeEpisodeChanges)=>Promise<void>;onClose:()=>void;
}){
 const config=useEffectiveConfig();
 const [draft,setDraft]=useState<WholeEpisodeChanges>({});
 const [history,setHistory]=useState<Round[]>([]);
 const [allowed,setAllowed]=useState<WholeEpisodeField[]>(["synopsis","events","ending"]);
 const [instruction,setInstruction]=useState("");
 const [proposal,setProposal]=useState<Proposal|null>(null);
 const [selected,setSelected]=useState<WholeEpisodeField[]>([]);
 const [busy,setBusy]=useState(false),[saving,setSaving]=useState(false);
 const [error,setError]=useState("");
 const flight=useRef<AbortController|null>(null);
 const key=JSON.stringify(scope),origin=useRef(key);
 const stale=origin.current!==key;
 const validDraft=validChanges(draft,episode,{});
 const lastApplied=history.at(-1);
 const live=useRef({key,disabled});live.current={key,disabled};
 const stop=()=>{flight.current?.abort();flight.current=null;setBusy(false);};
 useEffect(()=>()=>{flight.current?.abort();flight.current=null;},[]);
 const save=async(propagate=false)=>{
  if(disabled||stale||busy||saving||proposal||!validDraft){
   if(propagate)throw Error("请先处理整集 AI 建议，再保存候选");
   return;
  }
  setError("");setSaving(true);
  try{if(Object.keys(draft).length)await onSave(draft);onClose();}
  catch(cause){setError(cause instanceof Error?cause.message:"整集保存失败");if(propagate)throw cause;}
  finally{setSaving(false);}
 };
 useCandidateFieldSession(true,()=>save(true));
 const toggleField=(field:WholeEpisodeField)=>setAllowed(old=>old.includes(field)?old.filter(item=>item!==field):[...old,field]);
 const toggleSelected=(field:WholeEpisodeField)=>{
  if(!proposal)return;
  const group=proposal.linkedFields.includes(field)?proposal.linkedFields:[field];
  setSelected(old=>old.includes(field)?old.filter(item=>!group.includes(item)):[...new Set([...old,...group])]);
 };
 const generate=async()=>{
  if(disabled||stale||saving||flight.current||!allowed.length||!instruction.trim()||!validDraft)return;
  const controller=new AbortController();flight.current=controller;setBusy(true);setProposal(null);setError("");
  const current=()=>flight.current===controller&&!controller.signal.aborted&&live.current.key===key&&!live.current.disabled;
  try{
   const channel=resolveModelChannel(config,config.textModel),provider=modelChannelProvider(channel,"text");
   if(!channel||!provider||!["openai","openai_compatible","google_gemini"].includes(provider))throw Error("请先在设置中配置可用的文本模型");
   await ensureSqliteModelChannelForExecution(channel,provider);
   if(!current())return;
   const result=await canvasApi<Result>(
    `/api/v1/projects/${encodeURIComponent(scope.projectId)}/drama-pipeline/runs/${encodeURIComponent(scope.runId)}/episodes/${encodeURIComponent(scope.episodeId)}/optimize-episode`,"POST",
    {expectedRevision:scope.revision,fields:allowed,draftChanges:draft,instruction:instruction.trim(),
     previousInstructions:history.map(round=>round.instruction),channelId:channel.id,provider,baseUrl:channel.baseUrl,model:modelOptionName(config.textModel)},controller.signal);
   if(!current())return;
   const proposed=Object.keys(result.changes??{}) as WholeEpisodeField[];
   const linked=proposed.includes("events")&&proposed.includes("scenePlans");
   if(result.runId!==scope.runId||result.episodeId!==scope.episodeId||result.revision!==scope.revision||
    !proposed.length||proposed.some(field=>!allowed.includes(field))||!validChanges(result.changes,episode,draft)||!Array.isArray(result.warnings)||result.warnings.some(warning=>typeof warning!=="string")||
    !Array.isArray(result.linkedFields)||linked!==Boolean(result.linkedFields.length)||
    linked&&(result.linkedFields.length!==2||!result.linkedFields.includes("events")||!result.linkedFields.includes("scenePlans")))
    throw Error("drama_episode_optimize_result_invalid");
   setProposal({...result,instruction:instruction.trim()});setSelected(proposed);
  }catch(cause){if(current())setError(cause instanceof Error?cause.message:"AI 优化失败");}
  finally{if(flight.current===controller){flight.current=null;setBusy(false);}}
 };
 const apply=()=>{
  if(!proposal||!selected.length||disabled||stale)return;
  const changes=Object.fromEntries(selected.map(field=>[field,proposal.changes[field]])) as WholeEpisodeChanges;
  const next={...draft,...changes};
  setHistory(old=>[...old,{before:draft,after:next,instruction:proposal.instruction}].slice(-5));
  setDraft(next);setProposal(null);setSelected([]);setError("");
 };
 const style={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 const muted={color:theme.node.muted};
 const action="inline-flex min-h-7 items-center justify-center gap-1 rounded-md border px-2.5 py-1 text-xs hover:opacity-80 disabled:opacity-40";
 const locked=disabled||stale||busy||saving;
 const effectiveEvents=draft.events??episode.events,afterEvents=proposal?.changes.events??effectiveEvents;
 const hasDraft=Object.keys(draft).length>0;
 return <section data-whole-episode-optimize="" className="min-w-0 space-y-3 rounded-lg border p-3" style={style}>
  <header className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">整集 AI 优化</strong>
   <span className="text-xs" style={muted}>已应用 {history.length} 轮 · {hasDraft?"尚未保存":"未修改"}</span></header>
  <p className="text-xs" style={muted}>以当前候选及已应用修改为基础。仅修改勾选字段，保留场次身份及原文引用。</p>
  <div className="grid grid-cols-2 gap-2 text-xs">
   {fields.map(field=><label key={field} className="flex items-center gap-2">
    <input type="checkbox" checked={allowed.includes(field)} disabled={locked||!!proposal||field==="scenePlans"&&!episode.sequences?.length}
     onChange={()=>toggleField(field)}/>{labels[field]}</label>)}
  </div>
  <label className="grid gap-1 text-xs"><span style={muted}>修改意见（参考最近 {history.length} 轮已应用意见）</span>
   <textarea aria-label="整集 AI 修改意见" className="min-h-20 w-full resize-y rounded-md border p-2 text-sm" style={style} value={instruction}
    maxLength={2500} disabled={locked} onChange={event=>setInstruction(event.target.value)} placeholder="例如：加强剧情冲突，调整事件与场次分配并优化结尾"/></label>
  <div className="flex flex-wrap items-center justify-between gap-2">
   <span className="text-[11px]" style={muted}>{modelOptionName(config.textModel)||"未配置文本模型"}</span>
   {busy?<button type="button" className={action} style={style} onClick={stop}>停止等待</button>:
    <button type="button" className={action} style={style} disabled={locked||!instruction.trim()||!allowed.length||!validDraft}
     onClick={()=>void generate()}>{proposal?"重新优化整集":"生成整集建议"}</button>}
  </div>
  {busy&&<DramaInlineFeedback theme={theme} level="info" pending>正在生成整集优化建议…</DramaInlineFeedback>}
  {stale&&<DramaInlineFeedback theme={theme}>候选版本已变化，请取消并重新打开。</DramaInlineFeedback>}
  {error&&<DramaInlineFeedback theme={theme} level="error" error={error}/>}
  {proposal&&<section data-whole-episode-preview="" className="space-y-3">
   {proposal.linkedFields.length>0&&<DramaInlineFeedback theme={theme}>剧情事件和场次规划相互依赖，必须一起应用或放弃。</DramaInlineFeedback>}
   {proposal.warnings.map((warning,index)=><DramaInlineFeedback key={index} theme={theme}>{warning}</DramaInlineFeedback>)}
   {(Object.keys(proposal.changes) as WholeEpisodeField[]).map(field=><div key={field} className="space-y-2 rounded-md border p-2" style={style}>
    <label className="flex items-center gap-2 text-xs font-semibold">
     <input type="checkbox" aria-label={"应用"+labels[field]} checked={selected.includes(field)} onChange={()=>toggleSelected(field)} disabled={locked}/>{labels[field]}</label>
    <div className="grid min-w-0 gap-2 md:grid-cols-2">
     <div className="min-w-0"><p className="text-xs" style={muted}>修改前</p><pre className="thin-scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{renderValue(field==="scenePlans"&&proposal.beforeScenePlans?proposal.beforeScenePlans:Object.hasOwn(draft,field)?draft[field]:baseline(episode,field),field,effectiveEvents)}</pre></div>
     <div className="min-w-0"><p className="text-xs" style={muted}>优化后</p><pre className="thin-scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{renderValue(proposal.changes[field],field,afterEvents)}</pre></div>
    </div>
   </div>)}
   <div className="flex justify-end gap-2">
    <button type="button" className={action} style={style} onClick={()=>{setProposal(null);setSelected([]);}}>放弃整集建议</button>
    <button type="button" className={action} style={style} disabled={locked||!selected.length} onClick={apply}>应用选中修改</button>
   </div>
  </section>}
  {hasDraft&&<section data-whole-episode-draft="" className="space-y-2 rounded-md border p-2" style={style}>
   <strong className="text-xs">当前整集编辑缓冲区（未保存）</strong>
   {(Object.keys(draft) as WholeEpisodeField[]).map(field=><div key={field}><p className="text-xs" style={muted}>{labels[field]}</p>
    {field==="title"||field==="synopsis"||field==="ending"?<textarea aria-label={"整集编辑"+labels[field]} rows={field==="title"?1:3}
     className="w-full resize-y rounded-md border p-2 text-xs" style={style} maxLength={12000} disabled={locked||!!proposal}
     value={draft[field]??""} onChange={event=>setDraft(old=>({...old,[field]:event.target.value}))}/>:
     field==="targetDurationSec"?<input type="number" min="0.1" step="0.1" aria-label="整集编辑目标时长" className="w-full rounded-md border p-2 text-xs" style={style}
      disabled={locked||!!proposal} value={draft.targetDurationSec??""} onChange={event=>setDraft(old=>({...old,targetDurationSec:event.target.value===""?null:Number(event.target.value)}))}/>:
     <pre className="thin-scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{renderValue(draft[field],field,effectiveEvents)}</pre>}</div>)}
   {draft.events&&<p className="text-xs" style={muted}>事件与场次的引用将在保存时再次校验；新增或拆并事件请继续核对关联。</p>}
   <button type="button" className={action} style={style} disabled={locked||!!proposal||!lastApplied||lastApplied.after!==draft}
    title={lastApplied&&lastApplied.after!==draft?"已手动调整，不能覆盖后续输入":undefined}
    onClick={()=>{setDraft(lastApplied!.before);setHistory(old=>old.slice(0,-1));setError("");}}>撤销上轮整集修改</button>
  </section>}
  {!validDraft&&<DramaInlineFeedback theme={theme}>请核对编辑内容，标题不可为空，时长必须为正数或留空。</DramaInlineFeedback>}
  <div className="flex justify-end gap-2">
   <button type="button" className={action} style={style} disabled={saving} onClick={()=>{stop();onClose();}}>取消整集优化</button>
   <button type="button" className={action} style={{...style,background:theme.node.text,color:theme.node.panel}} disabled={locked||!!proposal||!hasDraft||!validDraft}
    onClick={()=>void save()}>保存整集候选</button>
  </div>
 </section>;
}
