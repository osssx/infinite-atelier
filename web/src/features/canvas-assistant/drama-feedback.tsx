import {createContext,useCallback,useContext,useEffect,useId,useMemo,useRef,useState} from "react";
import {AlertCircle,AlertTriangle,CheckCircle2,Info,LoaderCircle,X} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";

export type DramaFeedbackLevel="info"|"success"|"warning"|"error";
type Notice={key:string;level:DramaFeedbackLevel;title:string;detail?:string;serial:number};
type Task={id:number;title:string;target?:string;phase:string;startedAt:number;blockNavigation?:boolean};
type TaskHandle={phase:(value:string)=>void;end:()=>void};
type FeedbackApi={
 notify:(key:string,level:DramaFeedbackLevel,title:string,detail?:string)=>void;
 clear:(key:string)=>void;
 beginTask:(title:string,target?:string,blockNavigation?:boolean)=>TaskHandle|null;
 focusRun:(id:string)=>void;
 consumeRun:(id:string)=>void;
};
export const DramaFeedbackContext=createContext<{api:FeedbackApi;task:Task|null;focusRunId:string|null}|null>(null);
export const useDramaFeedback=()=>useContext(DramaFeedbackContext);
const errors:Record<string,string>={
 drama_candidate_invalid:"候选内容未通过结构或引用校验，请检查上游内容后重新生成。",
 drama_candidate_conflict:"草案或上游内容已变化，请刷新候选后重新审核。",
 drama_candidate_revision_conflict:"候选已在其他位置更新，请取消当前编辑并重新加载候选。",
 drama_candidate_revision_required:"候选版本已变化，请重新加载后采用。",
 drama_candidate_edit_invalid:"候选字段格式不正确，请检查内容。",
 drama_candidate_last_episode:"最后一集不能单独移除，请删除整条生成记录。",
 drama_candidate_not_discardable:"当前生成记录暂不可删除，请等待任务结束。",
 drama_candidate_not_ready:"候选当前不可编辑或采用，请刷新状态。",
 drama_episode_candidate_not_found:"该剧集候选已不存在，请重新加载。",
 drama_episode_optimize_invalid:"请检查目标字段、选区范围和修改意见。",
 drama_episode_optimize_result_invalid:"模型返回的优化内容格式不正确，请重新优化。",
 drama_episode_optimize_context_too_large:"优化上下文过长，请缩短当前字段或修改意见。",
 drama_episode_optimize_busy:"该候选已有优化请求正在处理，请稍后重试。",
 drama_episode_optimize_failed:"AI 优化失败，请检查文本模型渠道后重试。",
 shot_character_invalid:"镜头引用的角色或造型已失效，请检查资产引用。",
 shot_scene_invalid:"镜头引用的场景已失效，请检查资产引用。",
 project_revision_conflict:"项目内容已更新，请重新加载后保存。",
 drama_pipeline_generation_failed:"模型生成失败，请检查模型渠道或服务状态。",
};
export function describeDramaFeedbackError(value:unknown,fallback:string){
 const detail=value instanceof Error?value.message:typeof value==="string"?value:"";
 const code=Object.keys(errors).find(key=>detail.includes(key));
 return {title:code?errors[code]:fallback,detail:detail&&detail!==fallback?detail.slice(0,4000):undefined};
}
export function dramaRunStatus(status:string){
 return ({running:"生成中",ready:"待采用",adopted:"已采用",failed:"生成失败",cancelled:"已取消",interrupted:"已中断"} as Record<string,string>)[status]??"未知状态";
}

/** Owned by one keyed creative workspace, not by its mounted tab. */
export function useDramaFeedbackController(){
 const [notices,setNotices]=useState<Notice[]>([]);
 const [task,setTask]=useState<Task|null>(null);
 const [focusRunId,setFocusRunId]=useState<string|null>(null);
 const active=useRef<Task|null>(null),serial=useRef(0),live=useRef(true);
 const timers=useRef(new Map<string,ReturnType<typeof setTimeout>>());
 useEffect(()=>{live.current=true;return()=>{live.current=false;active.current=null;for(const timer of timers.current.values())clearTimeout(timer);timers.current.clear();}},[]);
 const clear=useCallback((key:string)=>{
  const timer=timers.current.get(key);if(timer)clearTimeout(timer);timers.current.delete(key);
  if(live.current)setNotices(current=>current.some(n=>n.key===key)?current.filter(n=>n.key!==key):current);
 },[]);
 const notify=useCallback<FeedbackApi["notify"]>((key,level,title,detail)=>{
  if(!live.current)return;
  const old=timers.current.get(key);if(old)clearTimeout(old);timers.current.delete(key);
  const notice={key,level,title,detail,serial:++serial.current};
  setNotices(current=>{
   if(level==="error"&&current.some(n=>n.key===key&&n.level===level&&n.title===title&&n.detail===detail))return current;
   const kept=current.filter(n=>n.key!==key);
   // Errors remain until dismissed or resolved. Transient notices are bounded.
   const next=[...kept,notice];
   const transient=next.filter(n=>n.level!=="error").slice(-3);
   return next.filter(n=>n.level==="error"||transient.includes(n));
  });
  if(level!=="error")timers.current.set(key,setTimeout(()=>clear(key),level==="success"?2000:level==="warning"?4000:3000));
 },[clear]);
 const beginTask=useCallback<FeedbackApi["beginTask"]>((title,target,blockNavigation)=>{
  if(!live.current||active.current)return null;
  const value={id:++serial.current,title,target,phase:"准备处理",startedAt:Date.now(),blockNavigation};
  active.current=value;setTask(value);
  return {phase:phase=>{if(live.current&&active.current?.id===value.id){active.current={...active.current,phase};setTask(active.current);}},
   end:()=>{if(active.current?.id===value.id){active.current=null;if(live.current)setTask(null);}}};
 },[]);
 const focusRun=useCallback((id:string)=>{if(live.current)setFocusRunId(id);},[]);
 const consumeRun=useCallback((id:string)=>{if(live.current)setFocusRunId(current=>current===id?null:current);},[]);
 const api=useMemo(()=>({notify,clear,beginTask,focusRun,consumeRun}),[notify,clear,beginTask,focusRun,consumeRun]);
 const context=useMemo(()=>({api,task,focusRunId}),[api,task,focusRunId]);
 return {context,notices,clear};
}

function tone(theme:CanvasTheme,level:DramaFeedbackLevel){
 const dark=theme.node.fill==="#292524";
 return level==="success"?(dark?"#86efac":"#15803d"):level==="error"?(dark?"#fca5a5":"#b91c1c"):level==="warning"?(dark?"#fcd34d":"#92400e"):theme.node.muted;
}
/** Field feedback stays beside the edited value; success uses the existing workspace Toast. */
export function useDramaFieldFeedback(){
 const api=useDramaFeedback()?.api;
 const id=useId();
 return (label:string)=>api?.notify("field:"+id,"success",label+"已更新草案");
}
export function DramaInlineFeedback({theme,level="warning",children,error,pending=false}:{theme:CanvasTheme;level?:DramaFeedbackLevel;children?:React.ReactNode;error?:string;pending?:boolean}){
 const message=error?describeDramaFeedbackError(error,"保存或读取失败，请检查后重试"):null;
 const conflict=error&&/drama_candidate_conflict|project_revision_conflict/.test(error);
 const title=conflict?"草案内容已变化，请重新加载后编辑。":message?.detail&&/[\u3400-\u9fff]/.test(error??"")&&!/^[a-z_]+(?:\s|:|：|$)/.test(error??"")?error:message?.title;
 const detail=message?.detail&&message.detail!==title?message.detail:undefined;
 const Icon=pending?LoaderCircle:level==="error"?AlertCircle:level==="warning"?AlertTriangle:Info;
 return <div data-drama-inline-feedback={pending?"pending":level} role={level==="error"||level==="warning"?"alert":"status"}
  className="flex min-w-0 items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs leading-relaxed"
  style={{background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text}}>
  <Icon size={14} aria-hidden="true" className={"mt-0.5 shrink-0"+(pending?" animate-spin":"")} style={{color:tone(theme,level)}}/>
  <div className="min-w-0 flex-1 break-words">{title??children}
   {detail&&<details className="mt-1" style={{color:theme.node.muted}}><summary className="cursor-pointer">技术详情</summary><pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all text-[11px]">{detail}</pre></details>}
  </div>
 </div>;
}
export function DramaFeedbackNotices({notices,clear,theme}:{notices:Notice[];clear:(key:string)=>void;theme:CanvasTheme}){
 const render=(notice:Notice)=>{
  const Icon=notice.level==="success"?CheckCircle2:notice.level==="error"?AlertCircle:notice.level==="warning"?AlertTriangle:Info;
  return <div key={notice.key} data-drama-feedback={notice.level} role={notice.level==="error"?"alert":"status"}
   className="pointer-events-auto min-w-0 rounded-lg border px-3 py-2 text-xs shadow-sm"
   style={{background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text}}>
   <div className="flex items-start gap-2"><Icon size={16} className="mt-0.5 shrink-0" style={{color:tone(theme,notice.level)}} aria-hidden="true"/>
    <div className="min-w-0 flex-1 break-words font-medium whitespace-pre-wrap">{notice.title}</div>
    <button type="button" aria-label="关闭提示" className="shrink-0 rounded p-0.5" style={{color:theme.node.muted}} onClick={()=>clear(notice.key)}><X size={14}/></button>
   </div>
   {notice.detail&&<details className="mt-1 pl-6"><summary className="cursor-pointer" style={{color:theme.node.muted}}>技术详情</summary>
    <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{notice.detail}</pre></details>}
  </div>;
 };
 const persistent=notices.filter(n=>n.level==="error"),transient=notices.filter(n=>n.level!=="error");
 return <>
  {persistent.length>0&&<div data-drama-feedback-errors="" className="thin-scrollbar max-h-36 shrink-0 space-y-1 overflow-y-auto">{persistent.map(render)}</div>}
  {transient.length>0&&<div data-drama-feedback-toasts="" className="pointer-events-none absolute right-2 top-12 z-20 flex w-[min(340px,calc(100%-16px))] max-w-[calc(100%-16px)] flex-col gap-2">{transient.map(render)}</div>}
 </>;
}
export function DramaTaskStatus({task,theme}:{task:Task;theme:CanvasTheme}){
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[task.id]);
 const seconds=Math.max(0,Math.floor((now-task.startedAt)/1000));
 const elapsed=[Math.floor(seconds/60),seconds%60].map(n=>String(n).padStart(2,"0")).join(":");
 return <div data-drama-task-status="" role="status" className="ml-auto flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs"
  style={{background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text}}>
  <LoaderCircle size={16} className="shrink-0 animate-spin" aria-hidden="true"/>
  <div className="min-w-0"><div className="truncate font-medium">{task.title}</div><div className="truncate text-[11px]" style={{color:theme.node.muted}}>{[task.target,task.phase].filter(Boolean).join(" · ")}</div></div>
  <span className="shrink-0 tabular-nums text-[11px]" style={{color:theme.node.muted}} aria-label="已用时间">{elapsed}</span>
 </div>;
}
