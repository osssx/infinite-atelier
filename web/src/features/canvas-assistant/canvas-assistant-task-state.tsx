import {useEffect,useRef,useState} from "react";
import {nanoid} from "nanoid";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {canvasCasPreviewUrl} from "@/features/backend-sync/canvas-cas";
import {subscribeSqliteJobEvents} from "@/features/backend-sync/sqlite-job-events";
import type {CanvasAssistantSession} from "@/types/canvas";
import type {AssistantContextScope} from "./canvas-assistant-context";
import {executeFrozenAssistantCanvasTaskStep,verifyFrozenAssistantTextDeliverable} from "./canvas-assistant-task-execution";
import {canLaunchAssistantRunSequenceStep,type AssistantRunSequenceView} from "./canvas-assistant-task-run-sequences";
import {StoryEventReviewPanel} from "./canvas-assistant-story-review";

type Step={id:string;kind:string;planVersion:number;status:string;actionDigest:string;
 approvalDecision?:string|null;approvalGrantId?:string|null;
 canRevokeApproval?:boolean;runMediaGrantId?:string|null;
 runSequenceId?:string|null;runIndex?:number|null;
 action?:{actions?:unknown[];agentRunId?:string;deliverableSpecDigest?:string;center?:{x:number;y:number};job?:{targetNodeId:string;executionMode:string;snapshot:{adapterKind?:string;provider?:string;channelId?:string;endpointBaseUrl?:string;task?:{kind?:string;model?:string}}}};
 result?:{jobId?:string;jobStatus?:string;artifactIds?:string[];bindings?:{nodeId:string}[];
 runId?:string;status?:string;exitCode?:number|null;artifactCount?:number};receiptTrust?:string};
type FactSummary={version?:number;source?:string;userTurns?:{total?:number};
 execution?:{currentPlan?:{stepCount?:number;trustedSteps?:number;unverifiedSuccess?:number;
  stages?:{needs_reconcile?:number}}}};
type SemanticNote={id:string;kind:"constraint"|"decision";text:string;provenance:"user_confirmed";
 contextPolicy:{includeContext:boolean;scope:AssistantContextScope;includedIds:string[]}};
type SemanticState={revision:number;goal?:{text:string;provenance:"user_confirmed"}|null;notes:SemanticNote[]};
type SemanticProposal={id:string;kind:"goal"|"constraint"|"decision";text:string;status:"pending"|"accepted"|"rejected";source:"model_suggested";contextPolicy:{includeContext:boolean;scope:AssistantContextScope;includedIds:string[]}};
type Task={id:string;chatSessionId:string;chatSessionIds?:string[];rootMessageId:string;originalRequest:string;
 activePlanVersion?:number;status:string;readOnly?:boolean;cancelRequestedAt?:number|null;summary?:FactSummary;semantic?:SemanticState;recoveryMode:"guidance_only"|"canvas_atomic"|"job_observation"|"skill_audit";steps?:Step[];lastError?:string|null};
type Recovery={canReplan:boolean;reason:string;planVersion:number;projectRevision:number;completedArtifacts?:number;failedJobs?:number};
type RunBudgetGrant={grantId:string;sequenceId:string;planVersion:number;
 maxJobs:number;consumedJobs:number;remainingJobs:number;allowedIndices:number[];
 expiresAt:number;active:boolean;revoked:boolean;executionStarted:boolean;
 modelScopeSummary?:{provider:string;kind:string;model:string};
 mode?:"model"|"local_comfy"|"local_comfy_media";comfyScopeSummary?:{instanceId:string;templateId:string;templateRevision:string}};
/** Refreshed Tabs may only associate a Grant with its original frozen Step.
 * Server independently verifies the full Comfy graph, CAS and grant in one
 * Job admission transaction.
 */
export function matchesActiveMediaGrant(step:Step,grant:RunBudgetGrant|null,task:Task|null,
 sequence:AssistantRunSequenceView|null,at=Date.now()):boolean{
 const action=grant&&sequence?.sequence?.actions[grant.allowedIndices[0]];
 if(!grant||!grant.active||grant.revoked||grant.mode!=="local_comfy_media"||
  grant.expiresAt<=at||grant.remainingJobs!==1||grant.allowedIndices.length!==1||
  !task||task.readOnly||task.cancelRequestedAt!=null||
  !["planning","ready","waiting_approval"].includes(task.status)||
  step.kind!=="comfy_workflow"||step.status!=="waiting_approval"||
  step.planVersion!==grant.planVersion||step.runSequenceId!==grant.sequenceId||
  step.runIndex!==grant.allowedIndices[0]||
  sequence?.sequence?.id!==grant.sequenceId||
  sequence.sequence.taskId!==task.id||
  sequence.sequence.planVersion!==grant.planVersion||
  action?.type!=="run_workflow"||
  !action.inputFromPrevious||
  action.nodeId!==step.action?.job?.targetNodeId)
  return false;
 return true;
}
type TaskCostReport={taskId:string;projectId:string;
 summary:{jobCount:number;reportedJobCount:number;unavailableJobCount:number;
 billingUnverifiedJobCount:number;notSubmittedJobCount:number;
 assistantInferenceCallCount:number;assistantInferenceUsageUnavailableCount:number;
 upstreamReportedTokens:{inputTokens:number;outputTokens:number;totalTokens:number};
 totalSettledAmountMicros:null};
 monetary:{currency:null;rateCardVersion:null;preflightMaxChargeMicros:null;
 reservationSupported:false;settlementSupported:false;
 hardCapSupported:false;settledAmountMicros:null;reason:string};
 jobs:{jobId:string;status:string;provider:string|null;model:string|null;metering:string;
 usage:{inputTokens:number;outputTokens:number;totalTokens:number}|null}[]};
type SafeContinuation={taskId:string;taskStatus:string;sequenceState:string;
 checkpoints:{kind:"skip"|"join";index:number}[];reconciledJobs:number;
 requiresApproval:boolean;requiresManualReview:boolean;reason:string|null;
 executionStarted:false;next:{index:number;type:string;nodeId:string}|null};
type FailureRecovery={canRecover:boolean;reason:string;planVersion:number;projectRevision:number;
 failureReason?:string;sourceJobId?:string;fallbackAction?:{type:"run_node";nodeId:string;mode?:string};
 evidenceDigest?:string};
type Args={projectId:string;activeChatId:string|null;session?:CanvasAssistantSession;
 open:boolean;sending:boolean;includeContext:boolean;scope:AssistantContextScope;includedIds:string[];comfyInstanceId?:string|null;
 onDraft:(value:string)=>void;
 onStartChat?:()=>string;
 onRunSequenceStep?:(taskId:string,view:AssistantRunSequenceView,grantId?:string,grantMode?:string)=>Promise<void>;
 onGenerateSemanticProposals?:(taskId:string,turnMessageId:string,signal:AbortSignal)=>Promise<void>};
type TaskResponse={task:Task;existing?:boolean;executionStarted?:boolean};
const taskStatusLabel:Record<string,string>={planning:"待规划",ready:"可继续",waiting_approval:"等待确认",running:"执行中",waiting_external:"等待外部",blocked:"已阻断",needs_reconcile:"需要对账",cancelling:"正在取消",failed:"失败",completed:"已完成",cancelled:"已结束记录"};

/** Task-associated Skill and Job runs are persisted before execution and observed by Run ID. */
export function useCanvasAssistantTasks({
 projectId,activeChatId,session,open,sending,includeContext,scope,includedIds,comfyInstanceId,onDraft,onStartChat,onRunSequenceStep,onGenerateSemanticProposals
}:Args){
 const [items,setItems]=useState<Task[]>([]);
 const [selectedId,setSelectedId]=useState<string|null>(null);
 const [detail,setDetail]=useState<Task|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [safeContinuationNotice,setSafeContinuationNotice]=useState("");
 const continuationIdentity=useRef("");
 const continuationEpoch=useRef(0);
 const identityKey=JSON.stringify([projectId,activeChatId,selectedId,open]);
 if(continuationIdentity.current!==identityKey){
  continuationIdentity.current=identityKey;continuationEpoch.current++;
 }
 const [calls,setCalls]=useState<{id:string;kind:string;status:string;errorCode?:string|null}[]>([]);
 const [callsOpen,setCallsOpen]=useState(false);
 const [callRevision,setCallRevision]=useState(0);
 const [eventsOpen,setEventsOpen]=useState(false);
 const [events,setEvents]=useState<{seq:number;stepId:string|null;kind:string;createdAt:number}[]>([]);
 const [eventsNext,setEventsNext]=useState(0);
 const [eventsMore,setEventsMore]=useState(false);
 const [eventsBusy,setEventsBusy]=useState(false);
 const eventScope=useRef(0);
 const [costReport,setCostReport]=useState<TaskCostReport|null>(null);
 const [costBusy,setCostBusy]=useState(false);
 const [costOpen,setCostOpen]=useState(false);
 const costEpoch=useRef(0);
 const [runSequence,setRunSequence]=useState<AssistantRunSequenceView|null>(null);
 const [runBudget,setRunBudget]=useState<RunBudgetGrant|null>(null);
 const [runBudgetConsent,setRunBudgetConsent]=useState(false);
 const [runMediaConsent,setRunMediaConsent]=useState(false);
 const mediaConsentKey=useRef("");
 const runBudgetConsentKey=useRef("");
 const [runBudgetLimit,setRunBudgetLimit]=useState(1);
 const runBudgetAttempted=useRef(new Set<string>());
 const runBudgetReadEpoch=useRef(0);
 const [otherTasks,setOtherTasks]=useState<Task[]>([]);
 const [showOtherTasks,setShowOtherTasks]=useState(false);
 const [taskExpanded,setTaskExpanded]=useState(false);
 const [linkCandidateId,setLinkCandidateId]=useState("");
 const [recovery,setRecovery]=useState<Recovery|null>(null);
 const [failureRecovery,setFailureRecovery]=useState<FailureRecovery|null>(null);
 const [semanticOpen,setSemanticOpen]=useState(false);
 const [semanticKind,setSemanticKind]=useState<"goal"|"constraint"|"decision">("constraint");
 const [semanticText,setSemanticText]=useState("");
 const [semanticEditingId,setSemanticEditingId]=useState<string|null>(null);
 const [proposals,setProposals]=useState<SemanticProposal[]>([]);
 const [proposalLoading,setProposalLoading]=useState(false);
 const proposalAbort=useRef<AbortController|null>(null);
 useEffect(()=>{setSemanticOpen(false);setSemanticText("");setSemanticEditingId(null);setSafeContinuationNotice("");proposalAbort.current?.abort();proposalAbort.current=null;},[selectedId]);
 useEffect(()=>()=>proposalAbort.current?.abort(),[]);

 const base="/api/v1/projects/"+encodeURIComponent(projectId)+"/assistant/tasks";
 useEffect(()=>{costEpoch.current++;setCostBusy(false);setCostOpen(false);setCostReport(null);},[selectedId,base]);
 useEffect(()=>{
  if(!open||!activeChatId){setItems([]);setSelectedId(null);setDetail(null);setShowOtherTasks(false);return;}
  setShowOtherTasks(false);setOtherTasks([]);
  let alive=true;
  setError("");
  void canvasApi<{tasks:Task[]}>(base+"?chatSessionId="+encodeURIComponent(activeChatId),"GET")
   .then(data=>{
    if(!alive)return;
    const next=Array.isArray(data.tasks)?data.tasks.filter(task=>
    task.chatSessionId===activeChatId||task.chatSessionIds?.includes(activeChatId)):[];
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

 useEffect(()=>{eventScope.current++;setEventsOpen(false);setEvents([]);setEventsNext(0);setEventsMore(false);},[selectedId]);
 // Read-only cost evidence, fetched only by user click. Never submit a Job.
 const loadCosts=async()=>{
  if(!open||!selectedId||costBusy)return;
  const taskId=selectedId,epoch=++costEpoch.current;
  setCostBusy(true);
  try{
   const value=await canvasApi<TaskCostReport>(base+"/"+encodeURIComponent(taskId)+"/cost-report","GET");
   if(epoch!==costEpoch.current||!value||value.taskId!==taskId)return;
   setCostReport(value);setCostOpen(true);
  }catch{
   if(epoch===costEpoch.current)setError("读取用量证据失败；没有生成 Job 或发起付费请求。");
  }finally{if(epoch===costEpoch.current)setCostBusy(false);}
 };
 const loadEvents=async(reset=false)=>{
  if(!selectedId||eventsBusy||sending)return;
  const scope=eventScope.current;
  setEventsBusy(true);
  try{
   const cursor=reset?0:eventsNext;
   const page=await canvasApi<{events:{seq:number;stepId:string|null;kind:string;createdAt:number}[];nextSeq:number;hasMore:boolean}>(
    base+"/"+encodeURIComponent(selectedId)+"/events?afterSeq="+cursor+"&limit=30","GET");
   if(scope!==eventScope.current)return;
   setEvents(old=>reset?page.events:[...old,...page.events.filter(e=>!old.some(p=>p.seq===e.seq))]);
   setEventsNext(page.nextSeq);setEventsMore(page.hasMore);setEventsOpen(true);
  }catch{if(scope===eventScope.current)setError("读取 Task 事件失败，没有执行任何外部操作。");}
  finally{setEventsBusy(false);}
 };
 useEffect(()=>{
  if(!open||!selectedId){setRunSequence(null);setRunBudget(null);return;}
  let alive=true;
  void canvasApi<AssistantRunSequenceView>(base+"/"+encodeURIComponent(selectedId)+"/run-sequences","GET")
   .then(value=>{if(alive)setRunSequence(value?.sequence?value:null);},()=>{if(alive)setRunSequence(null);});
  return ()=>{alive=false;};
 },[base,open,selectedId,detail]);
 useEffect(()=>{
  if(!open||!selectedId||!runSequence?.sequence){setRunBudget(null);return;}
  let active=true;const readEpoch=++runBudgetReadEpoch.current;
  void canvasApi<{grant:RunBudgetGrant|null}>(base+"/"+encodeURIComponent(selectedId)+"/run-budget","GET")
   .then(data=>{if(active&&readEpoch===runBudgetReadEpoch.current)setRunBudget(data.grant??null)},
    ()=>{if(active&&readEpoch===runBudgetReadEpoch.current)setRunBudget(null)});
  return ()=>{active=false};
 },[base,open,selectedId,runSequence?.sequence?.id,detail?.status]);
 const watchedJobIds=detail?.id===selectedId&&!detail?.readOnly?[...new Set((detail.steps??[])
  .map(step=>step.result?.jobId).filter((value):value is string=>
   typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value)))].sort().join(","):"";
 // Existing Job SSE is shared per Canvas tab. React only READS Task and Run
 // state after trustworthy terminal/materialization events, never POSTs a Job.
 useEffect(()=>{
  if(!open||!selectedId||!watchedJobIds)return;
  const ids=watchedJobIds.split(",");
  if(!ids.length)return;
  let alive=true,loading=false,dirty=false;
  const epoch=continuationEpoch.current,taskId=selectedId;
  const reload=()=>{
   if(loading){dirty=true;return;}
   loading=true;
   void (async()=>{
    do{
     dirty=false;
     const response=await canvasApi<TaskResponse>(base+"/"+encodeURIComponent(taskId),"GET");
     if(!alive||epoch!==continuationEpoch.current)return;
     if(response.task?.id===taskId){
      setDetail(response.task);
      setItems(items=>items.map(task=>task.id===taskId?response.task:task));
     }
    }while(dirty&&alive);
   })().catch(()=>{/* stale/partial network updates never trigger generation */})
    .finally(()=>{loading=false});
  };
  const unsubscribe=ids.map(jobId=>subscribeSqliteJobEvents(jobId,event=>{
   const payload=event.payload as {to?:string;status?:string}|undefined;
   if(event.kind==="artifact_materialized"||
    event.kind==="artifact_materialization"&&["materialized","blocked"].includes(payload?.status??"")||
    (event.kind==="job_status"||event.kind==="job_reconciliation_verified")&&["succeeded","failed","cancelled","submission_unknown","blocked_credential"].includes(payload?.to??""))
    reload();
  },reload));
  return ()=>{alive=false;unsubscribe.forEach(dispose=>dispose())};
 },[base,open,activeChatId,selectedId,watchedJobIds]);
 useEffect(()=>{
  if(!open||!selectedId||!detail||detail.id!==selectedId||!["planning","failed","blocked"].includes(detail.status)){
   setRecovery(null);return;
  }
  let alive=true;
  void canvasApi<Recovery>(base+"/"+encodeURIComponent(selectedId)+"/recovery","GET")
   .then(data=>{if(alive)setRecovery(data);},()=>{if(alive)setRecovery(null);});
  return ()=>{alive=false;};
 },[base,open,selectedId,detail]);
 useEffect(()=>{
  if(!open||!selectedId||!detail||detail.id!==selectedId||detail.status!=="failed"){
   setFailureRecovery(null);return;
  }
  let alive=true;
  void canvasApi<FailureRecovery>(base+"/"+encodeURIComponent(selectedId)+"/run-sequences/failure-recovery","GET")
   .then(data=>{if(alive)setFailureRecovery(data);},
    ()=>{if(alive)setFailureRecovery(null);});
  return ()=>{alive=false;};
 },[base,open,selectedId,detail]);
 const selected=items.find(item=>item.id===selectedId&&(item.chatSessionId===activeChatId||
  (activeChatId!==null&&item.chatSessionIds?.includes(activeChatId))))??null;
 const currentTask=detail?.id===selected?.id?detail:selected;
 const activeTask=currentTask?.readOnly||currentTask?.status==="cancelled"||currentTask?.status==="completed"?null:currentTask;
 // Recovery-critical tasks open details immediately; planning tasks stay compact.
 useEffect(()=>{
  setTaskExpanded(["waiting_approval","waiting_external","needs_reconcile","blocked","failed"].includes(currentTask?.status??""));
 },[selectedId,currentTask?.status]);
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
 /** Only an explicit user click may persist confirmed semantics. */
 const saveSemantic=async()=>{
  if(!activeTask||busy||sending||!semanticText.trim())return;
  const operation=semanticEditingId?"update_note":semanticKind==="goal"?"set_goal":
   semanticKind==="constraint"?"add_constraint":"add_decision";
  setBusy(true);setError("");
  try{
   const result=await canvasApi<TaskResponse>(path(activeTask.id)+"/semantic","POST",{
    requestId:nanoid(),expectedRevision:activeTask.semantic?.revision??0,operation,
    text:semanticText.trim(),...(semanticEditingId?{noteId:semanticEditingId}:{}),
    confirmed:true,contextPolicy:policy()
   });
   setDetail(result.task);setItems(old=>old.map(t=>t.id===result.task.id?result.task:t));
   setSemanticText("");setSemanticEditingId(null);
  }catch(error){setError("长期目标或约束未保存，可能已被其他会话修改，请刷新任务："+
   (error instanceof Error?error.message:"提交失败"));}
  finally{setBusy(false);}
 };
 const removeSemantic=async(operation:"remove_note"|"clear_goal",noteId?:string)=>{
  if(!activeTask||busy||sending)return;
  setBusy(true);setError("");
  try{
   const result=await canvasApi<TaskResponse>(path(activeTask.id)+"/semantic","POST",{
    requestId:nanoid(),expectedRevision:activeTask.semantic?.revision??0,
    operation,...(noteId?{noteId}:{}),confirmed:true,contextPolicy:policy()
   });
   setDetail(result.task);setItems(old=>old.map(t=>t.id===result.task.id?result.task:t));
   setSemanticText("");setSemanticEditingId(null);
  }catch{setError("移除长期事项失败，请刷新任务后重试；执行计划未改变。");}
  finally{setBusy(false);}
 };
 const fetchSemanticProposals=async(taskId:string)=>{
  const received=await canvasApi<{proposals:SemanticProposal[]}>(path(taskId)+"/semantic-proposals","GET");
  if(taskId===selectedId)setProposals(Array.isArray(received.proposals)?received.proposals:[]);
 };
 useEffect(()=>{
  if(!open||!selectedId){setProposals([]);return;}
  let live=true;
  void canvasApi<{proposals:SemanticProposal[]}>(path(selectedId)+"/semantic-proposals","GET")
   .then(data=>{if(live)setProposals(Array.isArray(data.proposals)?data.proposals:[]);},
    ()=>{if(live)setProposals([]);});
  return ()=>{live=false;};
 },[open,selectedId,base]);
 const generateSemanticProposals=async()=>{
  if(!activeTask||busy||sending||!onGenerateSemanticProposals)return;
  const controller=new AbortController(),taskId=activeTask.id,messageId=nanoid();
  proposalAbort.current=controller;setBusy(true);setProposalLoading(true);setError("");
  try{
   await recordTurn(taskId,messageId,"请求 AI 提议需要长期保留的目标、约束和决策（未经用户确认）",controller.signal);
   await onGenerateSemanticProposals(taskId,messageId,controller.signal);
   await fetchSemanticProposals(taskId);setCallRevision(v=>v+1);
  }catch(error){
   if(!controller.signal.aborted)setError("AI 记忆候选提取未完成（不会自动保存）："+
    (error instanceof Error?error.message:"模型请求失败"));
  }finally{
   if(proposalAbort.current===controller)proposalAbort.current=null;
   setBusy(false);setProposalLoading(false);
  }
 };
 const decideSemanticProposal=async(item:SemanticProposal,decision:"accept"|"reject")=>{
  if(!activeTask||busy||sending||item.status!=="pending")return;
  const taskId=activeTask.id;setBusy(true);setError("");
  try{
   await canvasApi(path(taskId)+"/semantic-proposals/decision","POST",{
    requestId:nanoid(),proposalId:item.id,decision,expectedRevision:activeTask.semantic?.revision??0,
    confirmed:true,contextPolicy:policy()});
   await refreshTask(taskId);
   await fetchSemanticProposals(taskId);
  }catch(error){setError("处理候选项失败（可能已被其他会话处理或当前画布授权不足），请刷新："+
   (error instanceof Error?error.message:"提交失败"));}
  finally{setBusy(false);}
 };
 const resumeCanvasStep=async(step:Step,decision?:"approve"|"reject")=>{  if(!selected||busy||sending)return;
  setBusy(true);setError("");
  try{
   await executeFrozenAssistantCanvasTaskStep({projectId,taskId:selected.id,step:{
    stepId:step.id,planVersion:step.planVersion,actionDigest:step.actionDigest,
    deliverableSpecDigest:step.action?.deliverableSpecDigest,runMediaGrantId:step.runMediaGrantId
   },decision,signal:new AbortController().signal});
  }catch(error){setError("步骤仍保存在任务中，未强行重放："+(error instanceof Error?error.message:"执行失败"));}
  finally{try{await refreshTask(selected.id);}catch{/* keep the recovery error visible */}finally{setBusy(false);}}
 };
 const pendingCanvas=detail&&selected&&detail.id===selected.id?detail.steps?.filter(step=>step.kind==="canvas_mutation"&&
  ["waiting_approval","ready"].includes(step.status))??[]:[];
 const unverifiedDeliverables=detail?.status==="ready"&&!detail.readOnly?detail.steps?.filter(step=>
  step.planVersion===detail.activePlanVersion&&step.status==="succeeded"&&
  step.receiptTrust==="server_committed"&&step.action?.deliverableSpecDigest)??[]:[];
 const verifyDeliverable=async(step:Step)=>{
  if(!selected||busy||sending)return;
  setBusy(true);setError("");
  try{await verifyFrozenAssistantTextDeliverable({projectId,taskId:selected.id,
   step:{stepId:step.id,planVersion:step.planVersion,actionDigest:step.actionDigest},
   signal:new AbortController().signal});}
  catch(error){setError(error instanceof Error?error.message:"交付验证失败");}
  finally{try{await refreshTask(selected.id);}catch{/* keep the verification error visible */}finally{setBusy(false);}}
 };
 const refreshTask=async(taskId:string)=>{
  const latest=await canvasApi<TaskResponse>(path(taskId),"GET");
  setDetail(latest.task);
  setItems(old=>old.map(task=>task.id===latest.task.id?latest.task:task));
 };
 const continueSafely=async()=>{
  if(!selected||busy||sending||!detail||detail.id!==selected.id||
   !Number.isInteger(detail.activePlanVersion)||!detail.activePlanVersion)return;
  setBusy(true);setError("");setSafeContinuationNotice("");
  const identity=continuationIdentity.current;
  const epoch=continuationEpoch.current;
  const isCurrent=()=>identity===continuationIdentity.current&&epoch===continuationEpoch.current;
  try{
   const response=await canvasApi<SafeContinuation>(path(selected.id)+"/continue-safe","POST",{
    requestId:nanoid(),expectedPlanVersion:detail.activePlanVersion
   });
   if(!isCurrent())return;
   const latest=await canvasApi<TaskResponse>(path(selected.id),"GET");
   if(!isCurrent())return;
   setDetail(latest.task);
   setItems(old=>old.map(task=>task.id===latest.task.id?latest.task:task));
   const current=await canvasApi<AssistantRunSequenceView>(path(selected.id)+"/run-sequences","GET");
   if(!isCurrent())return;
   setRunSequence(current?.sequence?current:null);
   const checkpoints=response.checkpoints.map(item=>
    (item.kind==="skip"?"跳过分支":"可信汇合")+" #"+(item.index+1)).join("、");
   const next=response.next?"；第 "+(response.next.index+1)+" 项仍需单独审批生成":"";
   setSafeContinuationNotice(
    (checkpoints?"已安全写入 "+checkpoints:"已核对现有 Job/Skill/落图记录，没有提交新的执行")+
    next+(response.reason?"；状态："+response.reason:"")+
    "。不会自动重试模型或 Skill。");
  }catch(error){
   if(isCurrent())setError("安全续行失败，未发起新 Job/Skill："+(error instanceof Error?error.message:"未知错误"));
  }finally{setBusy(false);}
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
  if(!selected||busy||sending||currentTask?.readOnly||currentTask?.cancelRequestedAt!=null)return;
  setBusy(true);setError("");
  const endpoint=path(selected.id)+"/steps/"+encodeURIComponent(step.id);
  try{
   // Keep a formerly media-granted frozen Step on the grant path even when
   // its cached expiry/remainingJobs is stale. Never silently switch a click
   // originally intended for the grant into an ordinary paid enqueue.
   const boundToMediaGrant=decision==="approve"&&
    runBudget?.mode==="local_comfy_media"&&
    step.kind==="comfy_workflow"&&step.status==="waiting_approval"&&
    step.runSequenceId===runBudget.sequenceId&&
    step.runIndex===runBudget.allowedIndices[0];
   if(boundToMediaGrant){
    // A refreshed Tab cannot infer new consent: it may only use the original
    // frozen Step with a *fresh* server grant for one authorized Job.
    const latest=await canvasApi<{grant:RunBudgetGrant|null}>(
     path(selected.id)+"/run-budget","GET");
    runBudgetReadEpoch.current++;
    setRunBudget(latest.grant);
    if(!matchesActiveMediaGrant(step,latest.grant,currentTask,runSequence))
     throw Error("原媒体授权已撤销、过期或不属于此冻结步骤，请重新核对任务");
    await canvasApi(endpoint+"/enqueue-authorized","POST",{
     requestId:step.id+"-external-authorized-"+latest.grant!.grantId,
     expectedPlanVersion:step.planVersion,actionDigest:step.actionDigest,
     grantId:latest.grant!.grantId
    });
    runBudgetReadEpoch.current++;setRunBudget({...latest.grant!,remainingJobs:0,active:false});
   }else{
    if(decision)await canvasApi(endpoint+"/approval","POST",{
     requestId:step.id+"-external-"+decision,expectedPlanVersion:step.planVersion,
     actionDigest:step.actionDigest,decision
    });
    if(decision!=="reject"){
     if(step.status==="waiting_approval"&&decision!=="approve")
      throw Error("步骤尚未获批准");
     await canvasApi(endpoint+"/enqueue","POST",{
      requestId:step.id+"-external-enqueue",expectedPlanVersion:step.planVersion,
      actionDigest:step.actionDigest
     });
    }
   }
   await canvasApi(path(selected.id)+"/reconcile","POST",{});
   await refreshTask(selected.id);
  }catch(error){setError("可凭原 Step 查询已有 Job，不会自动重试："+
   (error instanceof Error?error.message:"执行失败"));}
  finally{setBusy(false);}
 };
 const grantRunBudget=async()=>{
  const seq=runSequence?.sequence;
  if(!selected||!seq||seq.taskId!==selected.id||busy||sending||!runBudgetConsent||
   runBudgetConsentKey.current!==runBudgetScopeKey||runBudget?.active)return;
  const from=runSequence?.next?.index??((runSequence?.index??0)+1);
  const currentAction=runSequence?.next?.action??seq.actions[runSequence?.index??0];
  const kind=currentAction?.type==="run_workflow"?"local_comfy":"model";
  const indices=seq.actions.flatMap((action,index)=>
   index>=from&&action.type===(kind==="local_comfy"?"run_workflow":"run_node")&&
   (action.type==="run_workflow"?!action.inputFromPrevious:!action.join)?[index]:[]);
  if(!indices.length){setError("计划中没有可预授权的固定节点；动态连线必须逐项批准");return;}
  const maxJobs=Math.min(Math.max(1,runBudgetLimit),indices.length);
  setBusy(true);setError("");
  const epoch=continuationEpoch.current;
  try{
   const granted=await canvasApi<RunBudgetGrant>(path(selected.id)+"/run-budget","POST",{
    requestId:nanoid(),sequenceId:seq.id,expectedPlanVersion:seq.planVersion,
    maxJobs,allowedIndices:indices,expiresInMinutes:30,confirmed:true,
    ...(kind==="local_comfy"?{mode:"local_comfy"}:{})
   });
   if(epoch!==continuationEpoch.current)return;
   runBudgetReadEpoch.current++;
   setRunBudget(granted);setRunBudgetConsent(false);
   setSafeContinuationNotice("已冻结最多 "+maxJobs+" 次 Job 授权；有效期 30 分钟。这不是金额上限，已提交 Job 不会因撤销而自动取消。");
  }catch(error){
   if(epoch===continuationEpoch.current)setError("预授权失败，未生成任何任务："+
    (error instanceof Error&&error.message.includes("assistant_run_budget_payload_requires_approval")?
     "当前输入无法安全预先冻结，请逐项审批生成。":
     error instanceof Error&&error.message.includes("assistant_local_comfy_approval_required")?
      "请先人工批准同计划中的一个 ComfyUI 工作流。":
     error instanceof Error&&error.message.includes("assistant_local_comfy_scope_unsupported")?
      "当前工作流不符合静态同模板范围，请逐项审批生成。":error instanceof Error?error.message:"未知错误"));
  }finally{setBusy(false);}
 };
 const grantMediaWorkflow=async()=>{
  const seq=runSequence?.sequence;
  if(!selected||!seq||mediaIndex<1||!comfyInstanceId||busy||sending||
   runBudget?.active||!runMediaConsent||mediaConsentKey.current!==mediaScopeKey)return;
  setBusy(true);setError("");
  const epoch=continuationEpoch.current;
  try{
   const granted=await canvasApi<RunBudgetGrant>(path(selected.id)+"/run-budget","POST",{
    requestId:nanoid(),sequenceId:seq.id,expectedPlanVersion:seq.planVersion,
    mode:"local_comfy_media",instanceId:comfyInstanceId,allowedIndices:[mediaIndex],
    maxJobs:1,expiresInMinutes:30,confirmed:true
   });
   if(epoch!==continuationEpoch.current)return;
   runBudgetReadEpoch.current++;setRunBudget(granted);setRunMediaConsent(false);
   setSafeContinuationNotice("已批准本地媒体链：仅连接前驱唯一可信产物至已指定端口，最多运行一个下游 ComfyUI Job；遇多候选或证据失效将停止。");
  }catch(error){if(epoch===continuationEpoch.current)
   setError("媒体链授权失败，未修改画布或提交 Job："+(error instanceof Error?error.message:"未知错误"));}
  finally{setBusy(false);}
 };
 const revokeRunBudget=async()=>{
  if(!selected||busy||!runBudget)return;
  setBusy(true);setError("");
  try{
   const revoked=await canvasApi<RunBudgetGrant>(
    path(selected.id)+"/run-budget/"+encodeURIComponent(runBudget.grantId)+"/revoke","POST",
    {requestId:nanoid()});
   runBudgetReadEpoch.current++;setRunBudget(revoked);
   setSafeContinuationNotice("已撤销后续自动入队授权。已提交的 Job 不会因此自动取消。");
  }catch(error){setError("撤销授权失败："+(error instanceof Error?error.message:"未知错误"));}
  finally{setBusy(false);}
 };
 const resumeRunSequence=async()=>{
  if(!selected||!onRunSequenceStep||busy||sending)return;
  setBusy(true);setError("");
  try{
   const latest=await canvasApi<AssistantRunSequenceView>(path(selected.id)+"/run-sequences","GET");
   canLaunchAssistantRunSequenceStep(latest);
   await onRunSequenceStep(selected.id,latest);
   await refreshTask(selected.id);
   const status=await canvasApi<AssistantRunSequenceView>(path(selected.id)+"/run-sequences","GET");
   setRunSequence(status?.sequence?status:null);
  }catch(error){setError("顺序生成不会自动重试；请核对原计划与 Job："+
   (error instanceof Error?error.message:"请求失败"));}
  finally{setBusy(false);}
 };
 const refreshRunCandidates=async()=>{
  if(!selected||busy||sending)return;
  setBusy(true);setError("");
  try{
   const latest=await canvasApi<AssistantRunSequenceView>(path(selected.id)+"/run-sequences","GET");
   setRunSequence(latest?.sequence?latest:null);
  }catch(error){setError("候选刷新失败，未进行任何生成："+(error instanceof Error?error.message:"请求失败"));}
  finally{setBusy(false);}
 };
 const selectTrustedRunOutput=async(artifactId:string)=>{
  if(!selected||!runSequence?.sequence||runSequence.state!=="selection_required"||
   !runSequence.selectionCandidates?.some(option=>option.artifactId===artifactId&&option.addressable)||
   busy||sending)return;
  setBusy(true);setError("");
  try{
   const project=await canvasApi<{revision:number}>(
    "/api/v1/projects/"+encodeURIComponent(projectId),"GET");
   await canvasApi(path(selected.id)+"/run-sequences/select","POST",{
    requestId:nanoid(),runSequenceId:runSequence.sequence.id,runIndex:runSequence.index,
    artifactId,expectedPlanVersion:runSequence.sequence.planVersion,
    expectedProjectRevision:project.revision
   });
   const latest=await canvasApi<AssistantRunSequenceView>(path(selected.id)+"/run-sequences","GET");
   setRunSequence(latest?.sequence?latest:null);
   await refreshTask(selected.id);
  }catch(error){setError("产物尚未选定，未发起下游生成："+(error instanceof Error?error.message:"选择失败"));}
  finally{setBusy(false);}
 };
 const skipFrozenRunBranch=async()=>{
  if(!selected||!runSequence?.sequence||runSequence.state!=="skip_ready"||
   !runSequence.skip||busy||sending)return;
  setBusy(true);setError("");
  try{
   const latest=await canvasApi<AssistantRunSequenceView>(path(selected.id)+"/run-sequences","GET");
   if(latest.state!=="skip_ready"||latest.skip?.evidenceDigest!==runSequence.skip.evidenceDigest||
    latest.index!==runSequence.skip.index)throw Error("分支证据已变化，请先刷新任务");
   const project=await canvasApi<{revision:number}>("/api/v1/projects/"+encodeURIComponent(projectId),"GET");
   await canvasApi(path(selected.id)+"/run-sequences/skip","POST",{
    requestId:nanoid(),runSequenceId:latest.sequence!.id,runIndex:latest.skip.index,
    expectedPlanVersion:latest.sequence!.planVersion,expectedProjectRevision:project.revision,
    evidenceDigest:latest.skip.evidenceDigest
   });
   const status=await canvasApi<AssistantRunSequenceView>(path(selected.id)+"/run-sequences","GET");
   setRunSequence(status?.sequence?status:null);
   await refreshTask(selected.id);
  }catch(error){setError("分支未跳过，未发起任何生成："+(error instanceof Error?error.message:"请求失败"));}
  finally{setBusy(false);}
 };
 const confirmTrustedJoin=async()=>{
  if(!selected||!runSequence?.sequence||runSequence.state!=="join_ready"||
   !runSequence.join||busy||sending)return;
  setBusy(true);setError("");
  try{
   const latest=await canvasApi<AssistantRunSequenceView>(path(selected.id)+"/run-sequences","GET");
   if(latest.state!=="join_ready"||latest.join?.evidenceDigest!==runSequence.join.evidenceDigest)
    throw Error("汇合证据已经变化，请刷新状态");
   const project=await canvasApi<{revision:number}>("/api/v1/projects/"+encodeURIComponent(projectId),"GET");
   await canvasApi(path(selected.id)+"/run-sequences/join","POST",{
    requestId:nanoid(),runSequenceId:latest.sequence!.id,runIndex:3,
    expectedPlanVersion:latest.sequence!.planVersion,expectedProjectRevision:project.revision,
    evidenceDigest:latest.join.evidenceDigest
   });
   const status=await canvasApi<AssistantRunSequenceView>(path(selected.id)+"/run-sequences","GET");
   setRunSequence(status?.sequence?status:null);
   await refreshTask(selected.id);
  }catch(error){setError("Join 未提交，不会触发生成："+(error instanceof Error?error.message:"证据校验失败"));}
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
 const showOtherChatTasks=async()=>{
  if(busy||sending)return;
  if(showOtherTasks){setShowOtherTasks(false);return;}
  // An empty new chat has no ID until the first message is sent.
  // Establish a persisted empty session only when the user explicitly
  // chooses to link a Task; never require an unrelated model request.
  const chatId=activeChatId??onStartChat?.();
  if(!chatId)return;
  setBusy(true);setError("");
  try{
   const data=await canvasApi<{tasks:Task[]}>(base+"?chatSessionId="+encodeURIComponent(chatId)+
    "&includeOther=true&limit=100","GET");
   const available=(data.tasks??[]).filter(item=>item.chatSessionId!==chatId&&
    !item.chatSessionIds?.includes(chatId));
   setOtherTasks(available);setLinkCandidateId(available[0]?.id??"");setShowOtherTasks(true);
  }catch{setError("读取其他会话的任务失败，没有执行任何操作。");}
  finally{setBusy(false);}
 };
 const linkOtherChatTask=async()=>{
  if(!activeChatId||!linkCandidateId||busy||sending)return;
  setBusy(true);setError("");
  try{
   const value=await canvasApi<TaskResponse>(path(linkCandidateId)+"/link-chat","POST",{
    requestId:"link-"+linkCandidateId+"-"+activeChatId,chatSessionId:activeChatId
   });
   setItems(old=>[value.task,...old.filter(item=>item.id!==value.task.id)]);
   setSelectedId(value.task.id);setDetail(value.task);setShowOtherTasks(false);
   setOtherTasks([]);setLinkCandidateId("");
  }catch(error){setError("关联任务失败；不会重新执行任何步骤："+(error instanceof Error?error.message:"请求失败"));}
  finally{setBusy(false);}
 };
 const confirmFailureFallback=async()=>{
  if(!selected||!failureRecovery?.canRecover||!failureRecovery.evidenceDigest||
   busy||sending)return;
  setBusy(true);setError("");
  try{
   const check=await canvasApi<FailureRecovery>(
    path(selected.id)+"/run-sequences/failure-recovery","GET");
   if(!check.canRecover||check.evidenceDigest!==failureRecovery.evidenceDigest)
    throw Error("已验证的失败证据变化，请先完成 Job 对账");
   await canvasApi(path(selected.id)+"/run-sequences/failure-recovery","POST",{
    requestId:nanoid(),expectedPlanVersion:check.planVersion,
    expectedProjectRevision:check.projectRevision,evidenceDigest:check.evidenceDigest
   });
   await refreshTask(selected.id);
   const latest=await canvasApi<AssistantRunSequenceView>(path(selected.id)+"/run-sequences","GET");
   setRunSequence(latest?.sequence?latest:null);
   setFailureRecovery(null);setRecovery(null);
  }catch(error){setError("备用计划未启用，原失败 Job 不会重试："+(error instanceof Error?error.message:"恢复失败"));}
  finally{setBusy(false);}
 };
 const safelyReplan=async()=>{
  if(!selected||!recovery?.canReplan||busy||sending)return;
  setBusy(true);setError("");
  try{
   await canvasApi(path(selected.id)+"/replan","POST",{
    requestId:"safe-replan-"+selected.id+"-"+recovery.planVersion,
    expectedPlanVersion:recovery.planVersion,
    expectedProjectRevision:recovery.projectRevision
   });
   await refreshTask(selected.id);
   setRecovery(null);
   onDraft("请依据服务端可信回执重新规划剩余步骤。不得重放结果不明或已经成功的生成任务。");
  }catch(error){setError("不满足安全重新规划条件，原任务未重放："+(error instanceof Error?error.message:"请求失败"));}
  finally{setBusy(false);}
 };
 // Browser-present best-effort dispatch: existing node generators still freeze
 // the exact request; server grant admission is the authority for every Job.
 // Never retry the same index automatically after an unknown response/error.
 useEffect(()=>{
  const view=runSequence,next=view?.next,grant=runBudget,task=selected;
  if(!open||busy||sending||!task||!onRunSequenceStep||!view?.sequence||
   view.sequence.taskId!==task.id||view.state!=="ready"||!next||
   next.action.type!==(grant?.mode==="local_comfy"||grant?.mode==="local_comfy_media"?"run_workflow":"run_node")||
    (next.needsBinding&&grant?.mode!=="local_comfy_media")||!grant?.active||
   grant.sequenceId!==view.sequence.id||grant.planVersion!==view.sequence.planVersion||
   !grant.allowedIndices.includes(next.index)||grant.remainingJobs<1||detail?.readOnly||detail?.cancelRequestedAt!=null||
   !["planning","ready","waiting_approval"].includes(detail?.status??""))
   return;
  const key=task.id+":"+grant.grantId+":"+next.index;
  if(runBudgetAttempted.current.has(key))return;
  runBudgetAttempted.current.add(key);
  const taskId=task.id,epoch=continuationEpoch.current;
  void (async()=>{
   let failed=false;
   try{await onRunSequenceStep(taskId,view,grant.grantId,grant.mode);}
   catch(error){failed=true;if(epoch===continuationEpoch.current)
    setError("预授权自动步骤已停止；不会自动重复提交。请检查 Job/Task 回执："+(error instanceof Error?error.message:"未知错误"));}
   finally{
    if(epoch!==continuationEpoch.current)return;
    try{
     const latest=await canvasApi<TaskResponse>(path(taskId),"GET");
     if(epoch!==continuationEpoch.current)return;
     if(latest.task?.id===taskId){setDetail(latest.task);setItems(old=>old.map(item=>item.id===taskId?latest.task:item));}
     const current=await canvasApi<AssistantRunSequenceView>(path(taskId)+"/run-sequences","GET");
     if(epoch!==continuationEpoch.current)return;
     setRunSequence(current?.sequence?current:null);
     const authorized=await canvasApi<{grant:RunBudgetGrant|null}>(path(taskId)+"/run-budget","GET");
     if(epoch===continuationEpoch.current)setRunBudget(authorized.grant??null);
    }catch(error){if(!failed&&epoch===continuationEpoch.current)setError("无法刷新任务回执；不会重复提交："+(error instanceof Error?error.message:"未知错误"));}
   }
  })();
 },[open,busy,sending,selected?.id,onRunSequenceStep,
  runSequence?.state,runSequence?.next?.index,runBudget?.grantId,runBudget?.active,
  runBudget?.remainingJobs,detail?.readOnly,detail?.status]);
 const mediaIndex=runSequence?.sequence?.actions.findIndex((action,index)=>
  index>0&&index<=2&&action.type==="run_workflow"&&!!action.inputFromPrevious&&
  !action.when&&index>=(runSequence?.next?.index??runSequence?.index??0))??-1;
 const mediaAction=mediaIndex>=1?runSequence?.sequence?.actions[mediaIndex]:null;
 const mediaScopeKey=JSON.stringify([projectId,selectedId,activeChatId,runSequence?.sequence?.id,
  runSequence?.sequence?.planVersion,mediaIndex,mediaAction,comfyInstanceId]);
 useEffect(()=>{setRunMediaConsent(false);mediaConsentKey.current="";},[mediaScopeKey]);
 const currentBudgetAction=runSequence?.next?.action??
  runSequence?.sequence?.actions[runSequence?.index??0];
 const nextBudgetMode=currentBudgetAction?.type==="run_workflow"?"local_comfy":"model";
 const nextBudgetAction=nextBudgetMode==="local_comfy"?"run_workflow":"run_node";
 const runBudgetTargets=runSequence?.sequence?.actions.flatMap((action,index)=>
  index>=(runSequence.next?.index??((runSequence.index??0)+1))&&
  action.type===nextBudgetAction&&(action.type==="run_workflow"?
   !action.inputFromPrevious:!action.join)?
  [{index,nodeId:action.nodeId}]:[])??[];
 const runBudgetEligible=runBudgetTargets.length;
 const runBudgetAnchor=detail?.steps?.filter(step=>step.kind===
  (nextBudgetMode==="local_comfy"?"comfy_workflow":"model_job")&&
  step.approvalDecision==="approved"&&!step.approvalGrantId).at(-1);
 const runBudgetScopeKey=JSON.stringify([projectId,activeChatId,selectedId,runSequence?.sequence?.id,
  runSequence?.sequence?.planVersion,nextBudgetMode,runBudgetTargets,runBudgetLimit,runBudgetAnchor?.actionDigest]);
 useEffect(()=>{setRunBudgetConsent(false);runBudgetConsentKey.current="";},[runBudgetScopeKey]);
 const latestUserTurnId=[...(session?.messages??[])].reverse().find(m=>m.role==="user")?.id??null;
 const view=<section aria-label="任务状态" className="canvas-assistant-task"
  style={{borderColor:"var(--assistant-border)",color:"var(--assistant-text)"}}>
  <div className="canvas-assistant-task-selector">
   <span className="canvas-assistant-task-caption">当前任务</span>
   <select aria-label="任务列表" className="canvas-assistant-task-select"
    style={{background:"var(--assistant-surface)",borderColor:"var(--assistant-border)"}}
    value={selected?.id??""} disabled={sending||busy} onChange={e=>setSelectedId(e.target.value||null)}>
    <option value="">未关联任务</option>
    {items.map(task=><option key={task.id} value={task.id}>{task.originalRequest.slice(0,36)}</option>)}
   </select>
   {!selected&&session?.messages.some(message=>message.role==="user")?
    <button type="button" className="canvas-assistant-task-secondary-button" disabled={busy||sending}
     title="将最后一条用户要求记录为持久任务" onClick={()=>void remember()}>记录为任务</button>:null}
  </div>
  {selected?<div className="canvas-assistant-task-summary">
   <span className="canvas-assistant-task-status" data-status={currentTask?.status??selected.status}>
    {taskStatusLabel[currentTask?.status??selected.status]??currentTask?.status??selected.status}
   </span>
   <span className="canvas-assistant-task-steps">步骤 {currentTask?.steps?.length??0}</span>
   {currentTask?.readOnly?<span className="canvas-assistant-task-steps">只读归档（禁止恢复执行）</span>:null}
   <div className="canvas-assistant-task-quick-actions">
    {activeTask&&!["waiting_external","needs_reconcile","cancelling","waiting_approval","blocked"].includes(activeTask.status)?
     <button type="button" className="canvas-assistant-task-primary-action" disabled={busy||sending}
      title="只读取任务并填写继续指令，不自动运行" onClick={()=>void resume()}>继续</button>:null}
    <button type="button" className="canvas-assistant-task-details-toggle"
     aria-expanded={taskExpanded} aria-controls="canvas-assistant-task-content"
     onClick={()=>setTaskExpanded(value=>!value)}>{taskExpanded?"收起详情":"任务详情"}</button>
   </div>
  </div>:null}
  <div id="canvas-assistant-task-content" className="canvas-assistant-task-content"
   hidden={Boolean(selected)&&!taskExpanded}>
   {(activeChatId||onStartChat)?<div className="mt-1 text-[11px]">
    <button type="button" className="canvas-assistant-link" disabled={busy||sending}
    onClick={()=>void showOtherChatTasks()}>{showOtherTasks?"收起其他会话任务":"从其他会话关联任务"}</button>
   {showOtherTasks?<div className="mt-1 flex items-center gap-2">
    <select aria-label="其他会话任务" className="min-w-0 flex-1 rounded-md border px-1.5 py-1"
     style={{background:"var(--assistant-surface)",borderColor:"var(--assistant-border)"}}
     value={linkCandidateId} onChange={e=>setLinkCandidateId(e.target.value)}>
     {otherTasks.length?otherTasks.map(task=><option key={task.id} value={task.id}>
      {task.originalRequest.slice(0,48)}
     </option>):<option value="">没有其他会话任务</option>}
    </select>
    <button type="button" className="canvas-assistant-link"
     disabled={busy||sending||!linkCandidateId} onClick={()=>void linkOtherChatTask()}>
     关联并继续
    </button>
   </div>:null}
  </div>:null}
   {selected?<div className="canvas-assistant-task-detail-body text-[11px]" style={{color:"var(--assistant-muted)"}}>
    <div className="canvas-assistant-task-facts">
     {detail?.id===selected.id&&detail.summary?.source==="server_derived"?
      <span>{detail.readOnly?"历史摘要":"事实摘要"}：已记录续写 {detail.summary.userTurns?.total??0} 轮；
       当前计划可信步骤 {detail.summary.execution?.currentPlan?.trustedSteps??0}/{detail.summary.execution?.currentPlan?.stepCount??0}；
       待对账 {detail.summary.execution?.currentPlan?.stages?.needs_reconcile??0}</span>:null}
     {detail?.id===selected.id&&detail.steps?.length?<span>{currentTask?.readOnly?"历史完成回执":"可信完成"}：{detail.steps.filter(s=>s.status==="succeeded"&&s.receiptTrust==="server_committed").length}/{detail.steps.length}</span>:null}
     <span>{currentTask?.readOnly?"仅供历史查看":detail?.id===selected.id&&detail.recoveryMode==="skill_audit"?"Skill 执行有可信 Run ID":detail?.id===selected.id&&detail.recoveryMode==="job_observation"?"生成与落图分阶段对账":detail?.id===selected.id&&detail.recoveryMode==="canvas_atomic"?"画布操作有可信回执":"仅指导恢复"}</span>
     {activeTask?<button type="button" className="canvas-assistant-link" disabled={busy||sending}
      title="停止跟踪任务，不取消已提交的模型或 ComfyUI Job" onClick={()=>void cancel()}>结束记录</button>:null}
    </div>
    {detail?.id===selected.id?<div className="mt-2 rounded-md border p-2 text-[11px]"
     style={{borderColor:"var(--assistant-border)"}}>
     <button type="button" className="canvas-assistant-link" aria-expanded={semanticOpen}
       onClick={()=>setSemanticOpen(x=>!x)}>{semanticOpen?"收起长期目标与决策":"长期目标与决策"}</button>
      <button type="button" className="canvas-assistant-link" disabled={busy||sending}
       onClick={()=>void refreshTask(selected.id)}>刷新长期事项</button>
      {semanticOpen?<div className="mt-2 space-y-2">
      <p>原始目标：{detail.originalRequest.slice(0,240)}</p>
      <p>当前确认目标：{detail.semantic?.goal?.text??"沿用原始目标"}</p>
      {detail.semantic?.goal&&activeTask?<button type="button" className="canvas-assistant-link"
       disabled={busy||sending} onClick={()=>void removeSemantic("clear_goal")}>恢复原始目标</button>:null}
      {detail.semantic?.notes?.length?<ul className="space-y-1">
       {detail.semantic.notes.map(note=><li key={note.id} className="flex items-start gap-1">
        <span className="min-w-0 flex-1 break-words">{note.kind==="constraint"?"约束":"决策"}：{note.text}</span>
        {activeTask?<div className="flex shrink-0 gap-1">
         <button type="button" className="canvas-assistant-link" disabled={busy||sending}
          onClick={()=>{setSemanticKind(note.kind);setSemanticText(note.text);setSemanticEditingId(note.id);}}>编辑</button>
         <button type="button" className="canvas-assistant-link" disabled={busy||sending}
          onClick={()=>void removeSemantic("remove_note",note.id)}>移除</button>
        </div>:null}
       </li>)}
      </ul>:<p>尚未确认长期约束或决策。</p>}
       <div className="rounded-md border p-2" style={{borderColor:"var(--assistant-border)"}}>
        <div className="flex flex-wrap items-center gap-2">
         {activeTask&&onGenerateSemanticProposals?<button type="button" className="canvas-assistant-link"
          disabled={busy||sending} onClick={()=>void generateSemanticProposals()}
          title="调用当前配置的文本模型，仅生成未确认的候选项；不执行任何画布操作">
          {proposalLoading?"正在提取候选…":"提取 AI 记忆候选"}</button>:null}
         <button type="button" className="canvas-assistant-link" disabled={busy||sending}
          onClick={()=>void fetchSemanticProposals(selected.id).catch(()=>setError("读取记忆候选失败，请检查后端连接。"))}>刷新候选</button>
        </div>
        <p>AI 提案未经确认，不会自动成为长期记忆或执行回执。请逐项检查。</p>
        {proposals.length?<ul className="mt-1 space-y-1.5">
         {proposals.map(item=><li key={item.id} className="rounded border p-1.5"
          style={{borderColor:"var(--assistant-border)"}}>
          <p className="break-words">
           {item.kind==="goal"?"目标":item.kind==="constraint"?"约束":"决策"}建议：{item.text}
          </p>
          <div className="flex flex-wrap items-center gap-2">
           <span>{item.status==="pending"?"待人工确认":item.status==="accepted"?"已确认":"已拒绝"}</span>
           {item.contextPolicy.includeContext?<span>来源含画布上下文，确认时需要相应授权</span>:null}
           {activeTask&&item.status==="pending"?<>
            <button type="button" className="canvas-assistant-link" disabled={busy||sending}
             aria-label={"确认候选："+item.text}
             onClick={()=>void decideSemanticProposal(item,"accept")}>确认候选</button>
            <button type="button" className="canvas-assistant-link" disabled={busy||sending}
             aria-label={"拒绝候选："+item.text}
             onClick={()=>void decideSemanticProposal(item,"reject")}>拒绝候选</button>
           </>:null}
          </div>
         </li>)}
        </ul>:<p>暂无 AI 记忆候选。</p>}
       </div>
      {activeTask?<div className="space-y-1.5">
        <select aria-label="长期事项类型" className="w-full rounded-md border px-1.5 py-1"
        style={{background:"var(--assistant-surface)",borderColor:"var(--assistant-border)"}}
        value={semanticKind} disabled={busy||sending}
        onChange={e=>{setSemanticKind(e.target.value as "goal"|"constraint"|"decision");
         setSemanticText("");setSemanticEditingId(null);}}>
        <option value="goal">修订目标</option><option value="constraint">增加约束</option>
        <option value="decision">记录关键决策</option>
       </select>
       <textarea aria-label="长期事项内容" value={semanticText} rows={2}
        maxLength={semanticKind==="goal"?600:400} disabled={busy||sending}
        onChange={e=>setSemanticText(e.target.value)}
        className="w-full resize-y rounded-md border p-1.5"
        style={{background:"var(--assistant-surface)",borderColor:"var(--assistant-border)"}}
        placeholder="输入由你明确确认、希望跨会话保留的要求"/>
       <div className="flex items-center gap-2">
        <button type="button" className="canvas-assistant-link" disabled={busy||sending||!semanticText.trim()}
         onClick={()=>void saveSemantic()}>{semanticEditingId?"确认修改":"确认保存长期事项"}</button>
        {semanticEditingId?<button type="button" className="canvas-assistant-link"
         onClick={()=>{setSemanticEditingId(null);setSemanticText("");}}>取消编辑</button>:null}
       </div>
       <p>仅保存用户确认的长期意向；不自动修改执行计划、提交生成或认定任务成功。画布引用遵循本次授权范围。</p>
      </div>:<p>任务不可编辑，历史事项仅供查看。</p>}
     </div>:null}
    </div>:null}
    {detail?.id===selected.id?
     <StoryEventReviewPanel projectId={projectId} taskId={selected.id}
      turnMessageId={latestUserTurnId} disabled={busy||sending}
      frozenStep={pendingCanvas.find(step=>!!step.action?.agentRunId)??null}
      readOnly={!!currentTask?.readOnly||!activeTask}/>:null}
    {detail?.id===selected.id&&detail.lastError?
     <p role="status" className="mt-1 break-words">上次错误：{detail.lastError.slice(0,200)}</p>:null}

   {failureRecovery&&selected&&detail?.id===selected.id&&detail.status==="failed"?
    <div className="mt-2 rounded-md border p-2" style={{borderColor:"var(--assistant-border)"}}>
     {failureRecovery.canRecover&&failureRecovery.fallbackAction?
      <>
       <p>服务端确认失败：{failureRecovery.failureReason}（原 Job {failureRecovery.sourceJobId?.slice(0,12)}）。
        已冻结的独立备用目标为 {failureRecovery.fallbackAction.nodeId}。确认只创建新计划，原失败 Job 保留；备用生成仍需另行审批费用。</p>
       <button type="button" className="canvas-assistant-link"
        disabled={busy||sending} onClick={()=>void confirmFailureFallback()}>
        确认启用备用计划（不生成）
       </button>
      </>:
      <p>不能自动选择失败备用路径：{failureRecovery.reason}。
       结果不明、产物下载失败或缺少预先冻结的独立目标时，不会触发备用生成。</p>}
    </div>:null}
   {recovery&&selected&&detail?.id===selected.id&&(["failed","blocked"].includes(detail.status)||recovery.canReplan)?
    <div className="mt-2 rounded-md border p-2" style={{borderColor:"var(--assistant-border)"}}>
     <p>恢复条件：{recovery.canReplan?"已有足够的可信终态证据":"需先完成已有执行结果的对账"}</p>
     {recovery.canReplan?<button type="button" className="canvas-assistant-link"
      disabled={busy||sending} onClick={()=>void safelyReplan()}>安全重新规划（不会自动生成）</button>:
      <p className="break-words">原因：{recovery.reason}。不会重放未确认的生成或 Skill。</p>}
    </div>:null}
   {currentTask?.status==="ready"&&detail?.steps?.some(s=>s.kind==="materialize"&&s.status==="succeeded"&&s.receiptTrust==="server_committed")?
    <p className="mt-1 text-[11px]">已核对生成产物和落图；可点击「继续」编排下一步。不会自动重新发起生成。</p>:null}
   <div className="mt-1.5 text-[11px]">
    <button type="button" className="canvas-assistant-link" disabled={sending||costBusy}
     onClick={()=>costOpen?setCostOpen(false):void loadCosts()}>
     {costOpen?"收起生成用量":"查看生成用量（只读）"}
    </button>
    {costOpen&&costReport?.taskId===selected?.id?<div className="mt-1 rounded border p-2"
     style={{borderColor:"var(--assistant-border)"}}>
     <p>上游报告 tokens：输入 {costReport.summary.upstreamReportedTokens.inputTokens}、
      输出 {costReport.summary.upstreamReportedTokens.outputTokens}、
      合计 {costReport.summary.upstreamReportedTokens.totalTokens}。
      有用量回执 {costReport.summary.reportedJobCount}/{costReport.summary.jobCount} 个 Job。</p>
     <p>缺少用量 {costReport.summary.unavailableJobCount} 项，
      结果不明可能已计费 {costReport.summary.billingUnverifiedJobCount} 项，
      尚未提交 {costReport.summary.notSubmittedJobCount} 项；
      助手推理调用 {costReport.summary.assistantInferenceCallCount??0} 次
      （尚无独立用量回执，不包含在上方 token 合计中）。</p>
     <p>以上不是已核实账单，无法承诺美元金额上限；未报告用量不代表免费。</p>
     {costReport.jobs.slice(0,12).map(job=><div key={job.jobId} className="break-words">
      {job.jobId.slice(0,12)} · {job.model??job.provider??"未知渠道"} · {job.status} ·
      {job.metering==="upstream_reported"?
       ("上游报告 "+job.usage?.totalTokens+" tokens"):
       job.metering==="not_submitted"?"未提交":"费用待核实"}
     </div>)}
     <button type="button" className="canvas-assistant-link" disabled={costBusy}
      onClick={()=>void loadCosts()}>刷新用量回执（只读）</button>
    </div>:null}
   </div>
   <div className="mt-1.5 text-[11px]">
    <button type="button" className="canvas-assistant-link" disabled={sending||eventsBusy}
     onClick={()=>eventsOpen?setEventsOpen(false):void loadEvents(true)}>
     {eventsOpen?"收起任务事件":"查看任务事件（只读）"}
    </button>
    {eventsOpen?<div className="mt-1 max-h-40 overflow-y-auto rounded border px-2 py-1" style={{borderColor:"var(--assistant-border)"}}>
     {events.length?events.map(event=><div key={event.seq} className="break-words py-0.5">
      <span>{event.seq} · {event.kind}</span>{event.stepId?<span> · {event.stepId.slice(0,8)}</span>:null}
     </div>):<p>暂无事件记录</p>}
     {eventsMore?<button type="button" className="canvas-assistant-link" disabled={eventsBusy||sending}
      onClick={()=>void loadEvents()}>加载更多事件</button>:null}
    </div>:null}
   </div>
   {selected&&!detail?.readOnly&&detail?.id===selected.id&&
     !!detail.activePlanVersion&&(runSequence?.sequence||externalSteps.length||skillSteps.length)?<div className="mt-2 text-xs">
      <button type="button" className="canvas-assistant-link" disabled={busy||sending}
       title="仅使用持久 Job、物化和 Skill 回执，自动写入免付费的可信跳过/Join 检查点"
       onClick={()=>void continueSafely()}>安全续行（不提交新生成或 Skill）</button>
      {safeContinuationNotice?<p role="status" className="mt-1 break-words">{safeContinuationNotice}</p>:null}
     </div>:null}
    {runSequence?.sequence&&selected&&runSequence.sequence.taskId===selected.id?<div className="mt-2 rounded-md border p-2" style={{borderColor:"var(--assistant-border)"}}>
    <div className="font-medium">顺序生成计划：{runSequence.sequence.actions.length} 项 · {runSequence.state}</div>
    <p>无预授权时每项独立批准；只有上一项可信落图后才允许下一项。</p>
    {runBudget?.sequenceId===runSequence.sequence.id?
     <div className="mt-2 rounded border p-2 text-xs" style={{borderColor:"var(--assistant-border)"}}>
      <p>预授权：{runBudget.revoked?"已撤销":runBudget.active?"有效":"已失效或额度已用尽"}；
       已使用 {runBudget.consumedJobs}/{runBudget.maxJobs} 次 Job；有效期至
       {new Date(runBudget.expiresAt).toLocaleString()}。
       {runBudget.modelScopeSummary?<span>仅限 {runBudget.modelScopeSummary.provider} ·
        {runBudget.modelScopeSummary.model} · {runBudget.modelScopeSummary.kind}</span>:null}
        {runBudget.comfyScopeSummary?<span>本地 ComfyUI · 实例 {runBudget.comfyScopeSummary.instanceId} · 模板
         {runBudget.comfyScopeSummary.templateId} · {runBudget.comfyScopeSummary.templateRevision.slice(0,12)}</span>:null}</p>
      {runBudget.active?<button type="button" className="canvas-assistant-link"
       disabled={busy} onClick={()=>void revokeRunBudget()}>撤销剩余自动入队授权</button>:null}
     </div>:null}
    {!runBudget?.active&&mediaAction?.type==="run_workflow"&&mediaIndex>=1&&!detail?.readOnly?
     <div className="mt-2 rounded border p-2 text-xs" style={{borderColor:"var(--assistant-border)"}}>
      <p className="font-medium">本地 ComfyUI：可信媒体链预授权（仅一次）</p>
      <p>前一步生成的唯一可信 {mediaAction.inputFromPrevious?.sourceKind} 产物，
       连接到第 {mediaIndex+1} 项节点 {mediaAction.nodeId} 的
       {mediaAction.inputFromPrevious?.toPortId} 端口，然后提交一个本地 ComfyUI Job。
       多候选、输入冲突、缺失 CAS 或模板变化时停止；不会自动重新提交。</p>
      <p>ComfyUI 实例：{comfyInstanceId??"未选择"}；有效期 30 分钟，仅画布打开时尝试。</p>
      <label className="mt-2 flex items-start gap-2">
       <input type="checkbox" aria-label="确认本地媒体链自动绑定与生成"
        checked={runMediaConsent}
        onChange={event=>{setRunMediaConsent(event.target.checked);
         mediaConsentKey.current=event.target.checked?mediaScopeKey:"";}}/>
       <span>我确认允许连接上述唯一可信产物并自动执行一次下游工作流，消耗本地 GPU 资源。</span>
      </label>
      <button type="button" className="canvas-assistant-link mt-1"
       disabled={busy||sending||!comfyInstanceId||!runMediaConsent}
       onClick={()=>void grantMediaWorkflow()}>批准唯一媒体连线及一次 ComfyUI 生成</button>
     </div>:null}
    {!runBudget?.active&&runBudgetEligible>0&&!detail?.readOnly?
     <div className="mt-2 rounded border p-2 text-xs" style={{borderColor:"var(--assistant-border)"}}>
      {nextBudgetMode==="local_comfy"?
       <p>本地 ComfyUI：仅允许同实例、同模板版本、同参数与同输出端口的静态工作流。
        先人工批准一个 ComfyUI Step 作为冻结依据；动态连线、外部媒体和 Skill
        仍需逐项确认。仅在画布打开时尝试自动生成，消耗本地 GPU 资源。</p>:
       <p>模型生成：仅允许已冻结的同渠道与同模型固定请求；
        复杂输入和 Skill 仍需逐项批准，次数不是金额上限。</p>}
      <p>预授权目标：{runBudgetTargets.map(item=>"第 "+(item.index+1)+" 项 · "+item.nodeId).join("；")}</p>
      <p>人工审批锚点：{runBudgetAnchor?.id??(nextBudgetMode==="local_comfy"?"尚无人工批准的 ComfyUI 工作流":"尚无人工批准的模型步骤")}
       {runBudgetAnchor?.action?.job?.snapshot.provider?" · "+runBudgetAnchor.action.job.snapshot.provider:""}
       {runBudgetAnchor?.action?.job?.snapshot.task?.model?" · "+runBudgetAnchor.action.job.snapshot.task.model:""}</p>
      <label className="mt-1 flex items-center gap-2">
       最多新增 Job 数
       <select aria-label="最多新增 Job 数" value={Math.min(runBudgetLimit,runBudgetEligible)}
        onChange={event=>setRunBudgetLimit(Number(event.target.value))}
        className="rounded border bg-transparent px-1 py-0.5">
        {[1,2,3,4].filter(value=>value<=runBudgetEligible).map(value=>
         <option key={value} value={value}>{value}</option>)}
       </select>
      </label>
      <label className="mt-2 flex items-start gap-2">
       <input type="checkbox" checked={runBudgetConsent}
        onChange={event=>{setRunBudgetConsent(event.target.checked);runBudgetConsentKey.current=event.target.checked?runBudgetScopeKey:"";}}
        aria-label="确认预授权可能产生费用"/>
       <span>{nextBudgetMode==="local_comfy"?
        "我确认允许所列静态 ComfyUI 工作流在 30 分钟内最多提交上述次数的 Job，使用本地 GPU 资源；动态输入仍需单独批准。":
        "我确认允许所列固定模型节点在 30 分钟内最多提交上述次数的 Job，可能产生费用；无法保证美元金额上限。"}</span>
      </label>
      <button type="button" className="canvas-assistant-link mt-1" disabled={busy||sending||!runBudgetConsent}
       onClick={()=>void grantRunBudget()}>确认并启用有界自动生成</button>
     </div>:null}
    {runSequence.joins?.length?<p className="mt-1">已提交可信汇合检查点：第 1 项与执行分支均落图，未选择的分支已跳过。</p>:null}
    {runSequence.state==="join_ready"&&runSequence.join?<div className="mt-2">
     <p>汇合待确认：上游第 1 项 + 第 {runSequence.join.executedIndex+1} 项已可信落图，
      第 {runSequence.join.skippedIndex+1} 项具有服务端跳过回执。确认只写入 Join 回执，不发起生成。</p>
     <button type="button" className="canvas-assistant-link" disabled={busy||sending}
      onClick={()=>void confirmTrustedJoin()}>确认可信汇合（只写回执）</button>
    </div>:null}
    {runSequence.state==="awaiting_verified_join_evidence"?<p>汇合前驱的 Job、CAS、落图或跳过证据不完整；后继 Job 保持阻断。</p>:null}
    {runSequence.state==="join_evidence_invalidated"?<p>已提交的汇合回执与当前可信证据不符；不会执行后继 Job。</p>:null}
    {runSequence.branchSkips?.length?<p className="mt-1">
     已持久记录跳过：{runSequence.branchSkips.map(skip=>(skip.index+1)+"/"+runSequence.sequence!.actions.length).join("、")} 项（可信回执）
    </p>:null}
    {runSequence.state==="skip_ready"&&runSequence.skip?<div className="mt-2">
     <p>可信条件判断：第 1 项生成的 {runSequence.skip.action.when?.kind} 产物共 {runSequence.skip.count} 个，
      未满足第 {runSequence.skip.index+1} 项的 {runSequence.skip.action.when?.op} {runSequence.skip.action.when?.count} 条件。</p>
     <button type="button" className="canvas-assistant-link" disabled={busy||sending}
      onClick={()=>void skipFrozenRunBranch()}>确认跳过第 {runSequence.skip.index+1} 项（仅写回执，不生成）</button>
    </div>:null}
    {runSequence.state==="awaiting_verified_branch_evidence"?<p>前一项的 Job、Artifact 与落图证据尚未完全一致；无法判断分支，不会执行备用 Job。</p>:null}
    {runSequence.state==="branch_evidence_invalidated"?<p>已确认跳过的分支来源证据发生变化，任务已阻断；不会改选或重新发起生成。</p>:null}
    {runSequence.state==="ready"&&runSequence.next&&onRunSequenceStep?
     <button type="button" className="canvas-assistant-link" disabled={busy||sending}
      onClick={()=>void resumeRunSequence()}>
      {runSequence.next.needsBinding?
       "先连接可信产物，再生成第 "+(runSequence.next.index+1)+"/"+runSequence.sequence.actions.length+" 项（需审批）":
       "继续第 "+(runSequence.next.index+1)+"/"+runSequence.sequence.actions.length+" 项生成（需审批）"}
     </button>:null}
    {runSequence.outputs?.length?<div className="mt-1">
     <span>经服务端验证的落图引用：</span>
     {runSequence.outputs.slice(-8).map(output=><div key={output.artifactId} className="break-all">
      {output.kind} · 节点 {output.nodeId} · 产物 {output.artifactId.slice(0,12)}
     </div>)}
    </div>:null}
    {runSequence.next?.needsBinding&&runSequence.next.inputBinding?<p className="mt-1 break-words">下游需要先确认连线：{runSequence.next.inputBinding.sourceNodeId} → {runSequence.next.inputBinding.toNodeId}.{runSequence.next.inputBinding.toPortId}；连线成功后才会单独确认生成费用。</p>:null}
    {runSequence.state==="selection_required"&&runSequence.selectionCandidates?.length?
     <div className="mt-2 flex flex-col gap-2">
      <p>上一项生成了多个可信产物，请明确选择其中一个。选择将持久保存且不可直接改选；此操作不会触发生成，随后仍需分别审批连线和下游 Job。</p>
      <button type="button" className="canvas-assistant-link self-start"
       disabled={busy||sending} onClick={()=>void refreshRunCandidates()}>刷新候选（只读）</button>
      {runSequence.selectionCandidates.map((candidate,index)=>
       <div key={candidate.artifactId} className="flex items-center gap-2 rounded border p-2"
        style={{borderColor:"var(--assistant-border)"}}>
        {candidate.kind==="image"?
         <img className="h-16 w-16 shrink-0 rounded object-contain"
          src={canvasCasPreviewUrl("cas:"+candidate.sha256)??undefined}
          alt={"第 "+(index+1)+" 张候选图片"} loading="lazy"/>:null}
        <div className="min-w-0 flex-1 break-words">
         <div>候选 {index+1} · {candidate.kind} · 节点 {candidate.nodeId}</div>
         <div>输出 {candidate.portId??"默认"} · 条目 {candidate.itemKey?.slice(0,72)}</div>
         <div className="break-all opacity-70">产物 {candidate.artifactId.slice(0,16)}</div>
         {!candidate.addressable?<p>非当前主图：请先在画布图片集中切换为主图，再刷新候选。</p>:null}
        </div>
        <button type="button" className="canvas-assistant-link shrink-0"
         disabled={busy||sending||!candidate.addressable}
         onClick={()=>void selectTrustedRunOutput(candidate.artifactId)}>使用此产物</button>
       </div>)}
     </div>:null}
    {runSequence.state==="selection_invalidated"?<p>已选择的产物不再有完整可信证据；必须先恢复原 CAS/落图回执，不能自动改用另一张图片。</p>:null}
    {runSequence.state==="selection_overflow"?<p>可信产物超过单轮选择上限（32 项），请缩小生成数量后重新规划。</p>:null}
    {runSequence.state==="awaiting_verified_input"?<p>等待前一项的完整可信媒体产物及落图回执，不会提交下一项。</p>:null}
    {["binding_conflict","binding_unverified"].includes(runSequence.state)?<p>工作流输入连线与冻结计划不一致，请先核对当前节点连接；不会发起下游生成。</p>:null}
    {runSequence.state==="awaiting_materialization"?<p>等待产物落图对账，不能提前提交下一项。</p>:null}
   </div>:null}
   {pendingCanvas.map(step=><div key={step.id} className="mt-2 rounded-md border p-2"
    style={{borderColor:"var(--assistant-border)"}}>
    <div className="font-medium">待恢复画布步骤：{step.id.slice(0,8)} · {step.status}</div>
     {step.action?.agentRunId?<div className="mt-1 text-xs opacity-70">来源 Agent Run：{step.action.agentRunId}</div>:null}
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
     {step.status==="ready"&&(step.action?.agentRunId||step.canRevokeApproval)?<button type="button"
      className="canvas-assistant-link" disabled={busy||sending}
      onClick={()=>void resumeCanvasStep(step,"reject")}>撤销此步骤并允许重新规划</button>:null}
    </div>
   </div>)}
    {unverifiedDeliverables.map(step=><div key={step.id} className="mt-2 text-xs">
     <span>文本节点已提交，交付完整性尚待验证。</span>
     <button type="button" className="canvas-assistant-link" disabled={busy||sending}
      onClick={()=>void verifyDeliverable(step)}>验证已提交交付物（不重放画布）</button>
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
           onClick={()=>void resumeExternal(step,"approve")}>
            {matchesActiveMediaGrant(step,runBudget,currentTask,runSequence)?
             "使用原授权恢复一次本地 ComfyUI 生成":"批准并入队（可能计费）"}</button>
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
   </div>
   {error?<p role="status" className="canvas-assistant-task-error" style={{color:"var(--assistant-error)"}}>{error}</p>:null}
 </section>;
 return {view,activeTaskId:activeTask?.id??null,
  activeTaskOriginalRequest:activeTask?.originalRequest??null,recordTurn,observe,refreshTask};
}
