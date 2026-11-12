import {useEffect,useState} from "react";
import {nanoid} from "nanoid";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import type {CanvasAssistantSession} from "@/types/canvas";
import type {AssistantContextScope} from "./canvas-assistant-context";

type Task={id:string;chatSessionId:string;rootMessageId:string;originalRequest:string;
 status:string;recoveryMode:"guidance_only";steps?:{id:string;status:string}[];lastError?:string|null};
type Args={projectId:string;activeChatId:string|null;session?:CanvasAssistantSession;
 open:boolean;sending:boolean;includeContext:boolean;scope:AssistantContextScope;includedIds:string[];
 onDraft:(value:string)=>void};
type TaskResponse={task:Task;existing?:boolean;executionStarted?:boolean};

/** P0a tracks intent and client observations; it never certifies canvas/job completion. */
export function useCanvasAssistantTasks({
 projectId,activeChatId,session,open,sending,includeContext,scope,includedIds,onDraft
}:Args){
 const [items,setItems]=useState<Task[]>([]);
 const [selectedId,setSelectedId]=useState<string|null>(null);
 const [detail,setDetail]=useState<Task|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const base="/api/v1/projects/"+encodeURIComponent(projectId)+"/assistant/tasks";
 useEffect(()=>{
  if(!open||!activeChatId){setItems([]);setSelectedId(null);setDetail(null);return;}
  let alive=true;
  setError("");
  void canvasApi<{tasks:Task[]}>(base+"?chatSessionId="+encodeURIComponent(activeChatId),"GET")
   .then(data=>{
    if(!alive)return;
    const next=Array.isArray(data.tasks)?data.tasks.filter(task=>task.chatSessionId===activeChatId):[];
    setItems(next);setSelectedId(id=>next.some(task=>task.id===id)?id:next[0]?.id??null);
   },()=>{if(alive)setError("无法读取任务列表，普通聊天仍可用。");});
  return ()=>{alive=false;};
 },[base,open,activeChatId]);
 useEffect(()=>{
  if(!open||!selectedId){setDetail(null);return;}
  let alive=true;
  void canvasApi<TaskResponse>(base+"/"+encodeURIComponent(selectedId),"GET")
   .then(data=>{if(alive&&data.task?.id===selectedId)setDetail(data.task);},
    ()=>{if(alive)setError("读取任务详情失败。");});
  return ()=>{alive=false;};
 },[base,open,selectedId]);
 const selected=items.find(item=>item.id===selectedId&&item.chatSessionId===activeChatId)??null;
 const activeTask=selected?.status==="cancelled"||selected?.status==="completed"?null:selected;
 const policy=()=>({includeContext,scope,includedIds:includeContext&&scope==="selection"?includedIds.slice(0,12):[]});
 const path=(id:string)=>base+"/"+encodeURIComponent(id);
 const observe=async(taskId:string|null,messageId:string,kind:"reply"|"error",text:string)=>{
  if(!taskId)return;
  try{
   const data=await canvasApi<TaskResponse>(path(taskId)+"/observations","POST",{
    requestId:messageId+"-result",kind,preview:text.slice(0,1800)||"无结果"});
   if(data.task?.id===taskId)setDetail(data.task);
  }catch{setError("任务结果未能保存；聊天记录不受影响。");}
 };
 const recordTurn=async(taskId:string|null,messageId:string,text:string,signal:AbortSignal)=>{
  if(!taskId)return;
  try{
   await canvasApi(path(taskId)+"/turns","POST",{
    requestId:messageId,messageId,text,contextPolicy:policy()
   },signal);
  }catch{setError("任务指令未写入持久记录；聊天仍会继续。");}
 };
 const remember=async()=>{
  const last=session&&[...session.messages].reverse().find(item=>item.role==="user");
  if(!session||!last||busy||sending)return;
  setBusy(true);setError("");
  try{
   const data=await canvasApi<TaskResponse>(base,"POST",{
    requestId:nanoid(),chatSessionId:session.id,rootMessageId:last.id,
    originalRequest:last.text.slice(0,8000),contextPolicy:policy()
   });
   setItems(old=>[data.task,...old.filter(item=>item.id!==data.task.id)]);
   setDetail(data.task);setSelectedId(data.task.id);
  }catch{setError("记录任务失败，请检查后端连接。");}
  finally{setBusy(false);}
 };
 const resume=async()=>{
  if(!activeTask||busy||sending)return;
  setBusy(true);setError("");
  try{
   const data=await canvasApi<TaskResponse>(path(activeTask.id)+"/resume","POST",{requestId:nanoid()});
   setDetail(data.task);onDraft("继续");
  }catch{setError("读取任务失败；没有自动执行任何操作。");}
  finally{setBusy(false);}
 };
 const cancel=async()=>{
  if(!activeTask||busy||sending)return;
  setBusy(true);setError("");
  try{
   const data=await canvasApi<TaskResponse>(path(activeTask.id)+"/cancel","POST",{requestId:nanoid()});
   setItems(old=>old.map(item=>item.id===data.task.id?data.task:item));
   setDetail(data.task);
  }catch{setError("结束记录失败；已有生成任务不会受影响。");}
  finally{setBusy(false);}
 };
 const view=<section aria-label="任务状态" className="border-b px-3 py-2"
  style={{borderColor:"var(--assistant-border)",color:"var(--assistant-text)"}}>
  <div className="flex items-center gap-2">
   <span className="shrink-0 text-[11px] font-medium">当前任务</span>
   <select aria-label="任务列表" className="min-w-0 flex-1 rounded-md border px-1.5 py-1 text-[11px]"
    style={{background:"var(--assistant-surface)",borderColor:"var(--assistant-border)"}}
    value={selected?.id??""} disabled={sending||busy} onChange={e=>setSelectedId(e.target.value||null)}>
    <option value="">未关联任务</option>
    {items.map(task=><option key={task.id} value={task.id}>{task.originalRequest.slice(0,36)}</option>)}
   </select>
   {!selected&&session?.messages.some(message=>message.role==="user")?
    <button type="button" className="canvas-assistant-link" disabled={busy||sending}
     title="将最后一条用户要求记录为持久任务" onClick={()=>void remember()}>记录为任务</button>:null}
  </div>
  {selected?<div className="mt-1.5 text-[11px]" style={{color:"var(--assistant-muted)"}}>
   <div className="flex flex-wrap items-center gap-2">
    <span>状态：{selected.status==="cancelled"?"已结束记录":"待规划"}</span>
    <span>步骤：{detail?.id===selected.id?detail.steps?.length??0:0}</span>
    <span>仅指导恢复</span>
    {activeTask?<>
     <button type="button" className="canvas-assistant-link" disabled={busy||sending}
      title="只读取任务并填写继续指令，不自动运行" onClick={()=>void resume()}>继续</button>
     <button type="button" className="canvas-assistant-link" disabled={busy||sending}
      title="停止跟踪任务，不取消已提交的模型或 ComfyUI Job" onClick={()=>void cancel()}>结束记录</button>
    </>:null}
   </div>
   {detail?.id===selected.id&&detail.lastError?
    <p role="status" className="mt-1 break-words">上次错误：{detail.lastError.slice(0,200)}</p>:null}
  </div>:null}
  {error?<p role="status" className="mt-1 text-[11px]" style={{color:"var(--assistant-error)"}}>{error}</p>:null}
 </section>;
 return {view,activeTaskId:activeTask?.id??null,recordTurn,observe};
}
