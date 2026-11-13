import {useEffect,useState} from "react";
import {nanoid} from "nanoid";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import type {CanvasAssistantSession} from "@/types/canvas";
import type {AssistantContextScope} from "./canvas-assistant-context";
import {executeFrozenAssistantCanvasTaskStep} from "./canvas-assistant-task-execution";

type Step={id:string;kind:string;planVersion:number;status:string;actionDigest:string;
 action?:{actions?:unknown[];center?:{x:number;y:number};job?:{targetNodeId:string;executionMode:string;snapshot:{adapterKind?:string}}};
 result?:{jobId?:string;jobStatus?:string;artifactIds?:string[];bindings?:{nodeId:string}[];
 runId?:string;status?:string;exitCode?:number|null;artifactCount?:number};receiptTrust?:string};
type Task={id:string;chatSessionId:string;rootMessageId:string;originalRequest:string;
 status:string;recoveryMode:"guidance_only"|"canvas_atomic"|"job_observation"|"skill_audit";steps?:Step[];lastError?:string|null};
type Args={projectId:string;activeChatId:string|null;session?:CanvasAssistantSession;
 open:boolean;sending:boolean;includeContext:boolean;scope:AssistantContextScope;includedIds:string[];
 onDraft:(value:string)=>void};
type TaskResponse={task:Task;existing?:boolean;executionStarted?:boolean};
const taskStatusLabel:Record<string,string>={planning:"待规划",ready:"可继续",waiting_approval:"等待确认",running:"执行中",waiting_external:"等待外部",blocked:"已阻断",needs_reconcile:"需要对账",cancelling:"正在取消",failed:"失败",completed:"已完成",cancelled:"已结束记录"};

/** Task-associated Skill and Job runs are persisted before execution and observed by Run ID. */
export function useCanvasAssistantTasks({
 projectId,activeChatId,session,open,sending,includeContext,scope,includedIds,onDraft
}:Args){
 const [items,setItems]=useState<Task[]>([]);
 const [selectedId,setSelectedId]=useState<string|null>(null);
 const [detail,setDetail]=useState<Task|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [calls,setCalls]=useState<{id:string;kind:string;status:string;errorCode?:string|null}[]>([]);
 const [callsOpen,setCallsOpen]=useState(false);
 const [callRevision,setCallRevision]=useState(0);

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

 useEffect(()=>{
  if(!open||!selectedId){setCalls([]);return;}
  let alive=true;
  void canvasApi<{calls:{id:string;kind:string;status:string;errorCode?:string|null}[]}>(
   base+"/"+encodeURIComponent(selectedId)+"/model-calls","GET")
   .then(result=>{if(alive)setCalls(Array.isArray(result.calls)?result.calls:[]);},
    ()=>{if(alive)setCalls([]);});
  return ()=>{alive=false;};
 },[base,open,selectedId,callRevision]);

 const selected=items.find(item=>item.id===selectedId&&item.chatSessionId===activeChatId)??null;
 const currentTask=detail?.id===selected?.id?detail:selected;
 const activeTask=currentTask?.status==="cancelled"||currentTask?.status==="completed"?null:currentTask;
 const policy=()=>({includeContext,scope,includedIds:includeContext&&scope==="selection"?includedIds.slice(0,12):[]});
 const path=(id:string)=>base+"/"+encodeURIComponent(id);
 const observe=async(taskId:string|null,messageId:string,kind:"reply"|"error",text:string)=>{
  if(!taskId)return;
  try{
   const data=await canvasApi<TaskResponse>(path(taskId)+"/observations","POST",{
    requestId:messageId+"-result",kind,preview:text.slice(0,1800)||"无结果"});
   if(data.task?.id===taskId)setDetail(data.task);
   setCallRevision(value=>value+1);
  }catch{setError("任务结果未能保存；聊天记录不受影响。");}
 };
 const recordTurn=async(taskId:string|null,messageId:string,text:string,signal:AbortSignal)=>{
  if(!taskId)return;
  try{
   await canvasApi(path(taskId)+"/turns","POST",{
    requestId:messageId,messageId,text,contextPolicy:policy()
   },signal);
  }catch(error){setError("任务指令未写入持久记录；为避免未记账的模型调用，本轮任务推理已停止。");throw error;}
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
 const resumeCanvasStep=async(step:Step,decision?:"approve"|"reject")=>{
  if(!selected||busy||sending)return;
  setBusy(true);setError("");
  try{
   await executeFrozenAssistantCanvasTaskStep({projectId,taskId:selected.id,step:{
    stepId:step.id,planVersion:step.planVersion,actionDigest:step.actionDigest
   },decision,signal:new AbortController().signal});
   const latest=await canvasApi<TaskResponse>(path(selected.id),"GET");
   setDetail(latest.task);
   setItems(old=>old.map(task=>task.id===latest.task.id?latest.task:task));
  }catch(error){setError("步骤仍保存在任务中，未强行重放："+(error instanceof Error?error.message:"执行失败"));}
  finally{setBusy(false);}
 };
 const pendingCanvas=detail&&selected&&detail.id===selected.id?detail.steps?.filter(step=>step.kind==="canvas_mutation"&&
  ["waiting_approval","ready"].includes(step.status))??[]:[];
 const refreshTask=async(taskId:string)=>{
  const latest=await canvasApi<TaskResponse>(path(taskId),"GET");
  setDetail(latest.task);
  setItems(old=>old.map(task=>task.id===latest.task.id?latest.task:task));
 };
 const checkExternal=async()=>{
  if(!selected||busy||sending)return;
  setBusy(true);setError("");
  try{
   await canvasApi(path(selected.id)+"/reconcile","POST",{});
   await refreshTask(selected.id);
  }catch(error){setError("对账失败，不会重新提交 Job："+(error instanceof Error?error.message:"未知错误"));}
  finally{setBusy(false);}
 };
 const resumeExternal=async(step:Step,decision?:"approve"|"reject")=>{
  if(!selected||busy||sending)return;
  setBusy(true);setError("");
  const endpoint=path(selected.id)+"/steps/"+encodeURIComponent(step.id);
  try{
   if(decision)await canvasApi(endpoint+"/approval","POST",{
    requestId:step.id+"-external-"+decision,expectedPlanVersion:step.planVersion,
    actionDigest:step.actionDigest,decision
   });
   if(decision!=="reject"){
    if(step.status==="waiting_approval"&&decision!=="approve")throw Error("步骤尚未获批准");
    await canvasApi(endpoint+"/enqueue","POST",{
     requestId:step.id+"-external-enqueue",expectedPlanVersion:step.planVersion,
     actionDigest:step.actionDigest
    });
   }
   await canvasApi(path(selected.id)+"/reconcile","POST",{});
   await refreshTask(selected.id);
  }catch(error){setError("可凭原 Step 查询已有 Job，不会再次生成："+(error instanceof Error?error.message:"执行失败"));}
  finally{setBusy(false);}
 };
 const externalSteps=detail&&selected&&detail.id===selected.id?detail.steps?.filter(step=>
  ["model_job","comfy_workflow","materialize"].includes(step.kind))??[]:[];
 const skillSteps=detail&&selected&&detail.id===selected.id?
  detail.steps?.filter(step=>step.kind==="skill_script")??[]:[];
 const resumeSkill=async(step:Step,decision?:"approve"|"reject")=>{
  if(!selected||busy||sending)return;
  setBusy(true);setError("");
  const endpoint=path(selected.id)+"/steps/"+encodeURIComponent(step.id);
  try{
   if(decision)await canvasApi(endpoint+"/approval","POST",{
    requestId:step.id+"-skill-"+decision,expectedPlanVersion:step.planVersion,
    actionDigest:step.actionDigest,decision
   });
   if(decision!=="reject"){
    if(step.status==="waiting_approval"&&decision!=="approve")throw Error("步骤尚未批准");
    const run=await canvasApi<{run_id?:string;runId?:string;status:string;shouldLaunch?:boolean}>(
     endpoint+"/run-skill","POST",{
      requestId:step.id+"-skill-execute",expectedPlanVersion:step.planVersion,
      actionDigest:step.actionDigest
     });
    if(run.shouldLaunch===false&&run.status!=="completed")
     setError("原运行 "+(run.runId??"")+
      " 尚未确认完成；本轮没有重新执行 Skill。请核对运行记录。");
   }
   await refreshTask(selected.id);
  }catch(error){setError("Skill 已冻结；不会通过本次错误自动重新运行："+(error instanceof Error?error.message:"执行失败"));}
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
    <span>状态：{taskStatusLabel[detail?.id===selected.id?detail.status:selected.status]??selected.status}</span>
    <span>步骤：{detail?.id===selected.id?detail.steps?.length??0:0}</span>
    <span>{detail?.id===selected.id&&detail.recoveryMode==="skill_audit"?"Skill 执行有可信 Run ID":detail?.id===selected.id&&detail.recoveryMode==="job_observation"?"生成与落图分阶段对账":detail?.id===selected.id&&detail.recoveryMode==="canvas_atomic"?"画布操作有可信回执":"仅指导恢复"}</span>
    {activeTask?<>
     {!["waiting_external","needs_reconcile","cancelling","waiting_approval","blocked"].includes(activeTask.status)?
      <button type="button" className="canvas-assistant-link" disabled={busy||sending}
       title="只读取任务并填写继续指令，不自动运行" onClick={()=>void resume()}>继续</button>:null}
     <button type="button" className="canvas-assistant-link" disabled={busy||sending}
      title="停止跟踪任务，不取消已提交的模型或 ComfyUI Job" onClick={()=>void cancel()}>结束记录</button>
    </>:null}
   </div>
   {detail?.id===selected.id&&detail.lastError?
    <p role="status" className="mt-1 break-words">上次错误：{detail.lastError.slice(0,200)}</p>:null}

   {pendingCanvas.map(step=><div key={step.id} className="mt-2 rounded-md border p-2"
    style={{borderColor:"var(--assistant-border)"}}>
    <div className="font-medium">待恢复画布步骤：{step.id.slice(0,8)} · {step.status}</div>
    <details className="mt-1"><summary className="cursor-pointer">查看冻结操作与参数</summary>
     <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(step.action,null,2)}</pre>
    </details>
    <div className="mt-1 flex gap-3">
     {step.status==="waiting_approval"?<>
      <button type="button" className="canvas-assistant-link" disabled={busy||sending}
       onClick={()=>void resumeCanvasStep(step,"approve")}>确认并执行此步骤</button>
      <button type="button" className="canvas-assistant-link" disabled={busy||sending}
       onClick={()=>void resumeCanvasStep(step,"reject")}>拒绝此步骤</button>
     </>:<button type="button" className="canvas-assistant-link" disabled={busy||sending}
      onClick={()=>void resumeCanvasStep(step)}>继续已批准步骤</button>}
    </div>
   </div>)}
    {externalSteps.length?<div className="mt-2 text-[11px]">
      <button type="button" className="canvas-assistant-link" disabled={sending||busy}
       title="仅查询已有 Job、产物及物化记录，绝不重新调用生成服务"
       onClick={()=>void checkExternal()}>检查生成与落图状态（不重新提交）</button>
      <p className="mt-1">“结束记录”不会自动停止已提交的 Job；需要停止生成时请使用 Job 历史中的停止操作。</p>
      {externalSteps.map(step=><div key={step.id} className="mt-2 rounded-md border p-2"
       style={{borderColor:"var(--assistant-border)"}}>
       <div>{step.kind==="materialize"?"素材落图":step.kind==="comfy_workflow"?"ComfyUI 工作流":"模型生成"} · {taskStatusLabel[step.status]??step.status}
        {step.receiptTrust==="server_committed"?" · 可信回执":""}</div>
       {step.result?.jobId?<div className="break-all">Job ID：{step.result.jobId}</div>:null}
       {step.result?.artifactIds?.length?<div>已确认产物：{step.result.artifactIds.length} 项</div>:null}
       {step.kind!=="materialize"&&["waiting_approval","ready"].includes(step.status)?<>
        <details className="mt-1"><summary className="cursor-pointer">核对冻结的生成请求</summary>
         <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(step.action,null,2)}</pre>
        </details>
        <div className="mt-1 flex gap-3">
         {step.status==="waiting_approval"?<>
          <button type="button" className="canvas-assistant-link" disabled={busy||sending}
           title="将创建一个持久 Job，可能产生模型调用费用"
           onClick={()=>void resumeExternal(step,"approve")}>批准并入队（可能计费）</button>
          <button type="button" className="canvas-assistant-link" disabled={busy||sending}
           onClick={()=>void resumeExternal(step,"reject")}>拒绝本次生成</button>
         </>:<button type="button" className="canvas-assistant-link" disabled={busy||sending}
          onClick={()=>void resumeExternal(step)}>提交已批准的 Job</button>}
        </div>
       </>:null}
      </div>)}
     </div>:null}
   {skillSteps.length?<div className="mt-2 text-[11px]">
    {skillSteps.map(step=><div key={step.id} className="mt-2 rounded-md border p-2"
     style={{borderColor:"var(--assistant-border)"}}>
     <div>Skill 脚本 · {taskStatusLabel[step.status]??step.status}
      {step.receiptTrust==="server_committed"?" · 可信回执":""}</div>
     {step.result?.runId?<div className="break-all">Run ID：{step.result.runId}</div>:null}
     {step.status==="needs_reconcile"?<div role="status">上次执行结果不明；不会自动再次运行脚本</div>:null}
     {["waiting_approval","ready"].includes(step.status)?<>
      <details className="mt-1"><summary className="cursor-pointer">检查冻结 Skill、输入与输出路径</summary>
       <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(step.action,null,2)}</pre>
      </details>
      <div className="mt-1 flex gap-3">
       {step.status==="waiting_approval"?<>
        <button type="button" className="canvas-assistant-link" disabled={busy||sending}
         onClick={()=>void resumeSkill(step,"approve")}>批准并运行 Skill</button>
        <button type="button" className="canvas-assistant-link" disabled={busy||sending}
         onClick={()=>void resumeSkill(step,"reject")}>拒绝 Skill</button>
       </>:<button type="button" className="canvas-assistant-link" disabled={busy||sending}
        onClick={()=>void resumeSkill(step)}>运行已批准的 Skill</button>}
      </div>
     </>:null}
    </div>)}
   </div>:null}
  </div>:null}

   {selected?<div className="mt-1 text-[11px]" style={{color:"var(--assistant-muted)"}}>
    <button type="button" className="canvas-assistant-link" aria-expanded={callsOpen}
     onClick={()=>setCallsOpen(value=>!value)}>模型调用记录 ({calls.length})</button>
    {calls.some(item=>item.status==="needs_reconcile"||item.status==="submitting")?
     <span className="ml-2" role="status">存在结果不明的模型请求，不会自动重发</span>:null}
    {callsOpen?<div className="mt-1 max-h-28 overflow-y-auto">
     {calls.length?calls.slice(0,20).map(item=><div key={item.id} className="truncate"
      title={item.id}>{item.kind} · {item.status} · {item.id.slice(0,8)}</div>):
      <span>暂无调用记录</span>}
    </div>:null}
   </div>:null}

  {error?<p role="status" className="mt-1 text-[11px]" style={{color:"var(--assistant-error)"}}>{error}</p>:null}
 </section>;
 return {view,activeTaskId:activeTask?.id??null,recordTurn,observe};
}
