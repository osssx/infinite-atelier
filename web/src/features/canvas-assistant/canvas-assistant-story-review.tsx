import {useEffect,useRef,useState} from "react";
import {nanoid} from "nanoid";
import {canvasApi} from "@/features/backend-sync/canvas-api";

/** Editorial audit, NOT a Canvas mutation authorization or Task completion. */
export type StoryEventComparison={
 eventId:string;label:string;sourceShotIndex:number;
 revisionShotIndex:number|null;detected:boolean;warnings:string[];
 decision:"pending"|"acknowledge_candidate"|"request_revision"
};
export type StoryEventReview={
 version:1;kind:"story_event_editorial_review";
 taskId:string;turnMessageId:string;snapshotDigest:string;
 projectRevision:number;activePlanVersion:number;semanticRevision:number;
 source:{requestId:string;digest:string};
 revision:{requestId:string;digest:string};
 comparison:StoryEventComparison[];
 reviewStatus:"pending"|"recorded_only"|"no_source_candidates";
 warnings:{id:string;code:string;afterEventId:string|null}[];
 userConfirmed:false;semanticReview:"pending";
 canvasExecutionAuthorized:false;taskCompletionAuthorized:false
};
export type StoryReviewDecision="acknowledge_candidate"|"request_revision";
/** Only suggests what to inspect next. An actual Canvas Step always needs
 * its own server-side frozen plan, authorization and source checks.
 */
export function storyReviewReadiness(review:StoryEventReview|null){
 if(!review)return {ready:false,reason:"缺少当前审核快照"};
 if(!review.comparison.length)return {ready:false,reason:"未发现可供审核的原分镜关键事件"};
 if(review.comparison.some(e=>e.decision==="pending"))
  return {ready:false,reason:"仍有未处理的剧情事件"};
 if(review.comparison.some(e=>e.decision==="request_revision"))
  return {ready:false,reason:"存在用户标记为需要修订的事件"};
 if(review.warnings.length)
  return {ready:false,reason:"存在剧情遗漏或顺序变化，仍需修订或人工检查"};
 return {ready:true,reason:"当前剧情候选已检查；正式画布执行仍需独立步骤审批"};
}
export function StoryEventReviewPanel({projectId,taskId,turnMessageId,disabled,readOnly=false,frozenStep,
 getCanvasCenter,onPrepared}:{
 projectId:string;taskId:string;turnMessageId:string|null;
 disabled:boolean;readOnly?:boolean;
 frozenStep?:{id:string;actionDigest:string}|null;
 getCanvasCenter?:()=>{x:number;y:number};onPrepared?:()=>Promise<void>
}){
 const [expanded,setExpanded]=useState(false);
 const [review,setReview]=useState<StoryEventReview|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [checkedDigest,setCheckedDigest]=useState<string|null>(null);
 const token=useRef(0);
 const scope=JSON.stringify([projectId,taskId,turnMessageId,frozenStep?.id,frozenStep?.actionDigest]);
 const currentReview=review?.taskId===taskId&&review.turnMessageId===turnMessageId?review:null;
 useEffect(()=>{
  token.current++;setExpanded(false);setReview(null);setCheckedDigest(null);
  setBusy(false);setError("");
 },[scope]);
 useEffect(()=>()=>{token.current++;},[]);
 const endpoint="/api/v1/projects/"+encodeURIComponent(projectId)+"/assistant/tasks/"+
  encodeURIComponent(taskId)+"/story-events/review";
 const load=async({applyCheck=false}:{applyCheck?:boolean}={})=>{
  if(!turnMessageId)return;
  const serial=++token.current;setBusy(true);setError("");setCheckedDigest(null);
  try{
   const fresh=await canvasApi<StoryEventReview>(endpoint+"?turnMessageId="+encodeURIComponent(turnMessageId),"GET");
   if(serial!==token.current)return;
   if(fresh.taskId!==taskId||fresh.turnMessageId!==turnMessageId||
    !/^[a-f0-9]{64}$/.test(fresh.snapshotDigest))
    throw Error("审核快照与当前任务不匹配");
   setReview(fresh);
   if(applyCheck){
    if(currentReview&&currentReview.snapshotDigest!==fresh.snapshotDigest){
     setError("来源或版本已变化；此前审核快照已失效，请重新检查事件。");
    }else if(!storyReviewReadiness(fresh).ready){
     setError("应用前核对未通过："+storyReviewReadiness(fresh).reason);
    }else if(!frozenStep){
     setError("尚无待批准的冻结画布步骤，不能证明草案已绑定到将要执行的操作。");
    }else{
     const preflight=await canvasApi<{verified:boolean;reason:string;snapshotDigest:string;
      stepId:string;stepActionDigest?:string;canvasExecutionAuthorized:false}>(
      endpoint+"/preflight?turnMessageId="+encodeURIComponent(turnMessageId)+
      "&snapshotDigest="+fresh.snapshotDigest+
      "&stepId="+encodeURIComponent(frozenStep.id),"GET");
     if(serial!==token.current)return;
     if(preflight.verified&&preflight.snapshotDigest===fresh.snapshotDigest&&
      preflight.stepId===frozenStep.id&&
      preflight.stepActionDigest===frozenStep.actionDigest&&
      preflight.canvasExecutionAuthorized===false)
      setCheckedDigest(scope+"|"+fresh.snapshotDigest);
     else setError("冻结步骤来源未通过核验（"+preflight.reason+"），不得把旧审核当作执行授权。");
    }
   }
  }catch(e){
   if(serial!==token.current)return;
   setReview(null);setCheckedDigest(null);
   setError("无法核对当前 Task 分镜事件："+(e instanceof Error?e.message:"来源不可用")+
    "。没有执行画布操作或模型请求。");
  }finally{if(serial===token.current)setBusy(false);}
 };
 const decide=async(event:StoryEventComparison,decision:StoryReviewDecision)=>{
  if(disabled||readOnly||busy||!currentReview||!turnMessageId||event.decision!=="pending")return;
  const serial=++token.current;setBusy(true);setError("");setCheckedDigest(null);
  const snapshot=currentReview.snapshotDigest;
  try{
   const value=await canvasApi<{current:boolean;eventId:string;decision:string}>(
    endpoint,"POST",{
     requestId:nanoid(),turnMessageId,snapshotDigest:snapshot,
     eventId:event.eventId,decision,confirmed:true
    });
   if(serial!==token.current)return;
   if(value.current!==true||value.eventId!==event.eventId||
    value.decision!==decision)throw Error("审核回执已失效");
   const fresh=await canvasApi<StoryEventReview>(
    endpoint+"?turnMessageId="+encodeURIComponent(turnMessageId),"GET");
   if(serial!==token.current)return;
   if(fresh.snapshotDigest!==snapshot)throw Error("审核期间来源发生变化");
   setReview(fresh);
  }catch(e){
   if(serial!==token.current)return;
   setReview(null);setCheckedDigest(null);
   setError("审核未能确认："+(e instanceof Error?e.message:"当前快照失效")+
    "。请重新读取来源；没有执行画布操作。");
  }finally{if(serial===token.current)setBusy(false);}
 };
 // Explicit opt-in. This creates only a server-frozen waiting-approval Step.
 // Actual Graph mutation always requires the independent Step approval and
 // a second source+review check inside the SQLite commit transaction.
 const prepareApply=async()=>{
  if(!currentReview||!turnMessageId||disabled||readOnly||busy||frozenStep||
   !storyReviewReadiness(currentReview).ready)return;
  const serial=++token.current;setBusy(true);setError("");setCheckedDigest(null);
  try{
   const planned=await canvasApi<{stepId:string;status:string;existing?:boolean}>(
    endpoint+"/prepare-apply","POST",{
     requestId:nanoid(),turnMessageId,
     snapshotDigest:currentReview.snapshotDigest,
     center:getCanvasCenter?.()??{x:0,y:0},confirmed:true
    });
   if(serial!==token.current)return;
   if(!planned.stepId||planned.status!=="waiting_approval")
    throw Error("未收到可信的待审批画布步骤");
   await onPrepared?.();
   if(serial!==token.current)return;
   setError("已冻结待审批步骤 "+planned.stepId.slice(0,12)+
    "；尚未修改画布。请在任务详情中独立批准并执行该步骤。");
  }catch(e){
   if(serial!==token.current)return;
   setReview(null);
   setError("无法准备应用此轮分镜（未执行画布）："+
    (e instanceof Error?e.message:"来源不完整或审核失效"));
  }finally{if(serial===token.current)setBusy(false);}
 };
 const status=(e:StoryEventComparison)=>e.warnings.includes("prior_story_event_order_changed")?"顺序变化":
  !e.detected?"修订中未观察到":e.warnings.length?"需复核":"候选保留";
 return <div aria-label="剧情事件审核" className="mt-2 rounded-md border p-2 text-[11px]"
  style={{borderColor:"var(--assistant-border)"}}>
  <button type="button" className="canvas-assistant-link" aria-expanded={expanded}
   onClick={()=>{if(expanded){token.current++;setExpanded(false);setBusy(false);}
    else{setExpanded(true);void load();}}}>
   {expanded?"收起剧情事件审核":"剧情事件审核（只读差异）"}
  </button>
  {expanded?<div className="mt-2 space-y-2">
   <p>对照当前 Task 的上一版分镜与修订版。事件仅来自未确认 AI 草案，不是长期事实；审核不会写入画布。</p>
   {!turnMessageId?<p role="status">当前会话没有可对应的用户分镜修订回合。</p>:null}
   <button type="button" className="canvas-assistant-link" disabled={busy||!turnMessageId}
    onClick={()=>void load()}>{busy?"正在核对…":"刷新来源及事件差异"}</button>
   {error?<p role="alert" className="break-words" style={{color:"var(--assistant-error)"}}>{error}</p>:null}
   {currentReview?<div className="space-y-2">
    <p className="break-words">来源：{currentReview.source.requestId.slice(0,20)} · 修订：{currentReview.revision.requestId.slice(0,20)}；
     项目版本 {currentReview.projectRevision}，计划版本 {currentReview.activePlanVersion}，快照 {currentReview.snapshotDigest.slice(0,12)}…</p>
    {currentReview.comparison.length?<ul className="space-y-1.5">
     {currentReview.comparison.map(item=><li key={item.eventId} className="rounded border p-1.5"
      style={{borderColor:"var(--assistant-border)"}}>
      <p className="font-medium">{item.label}</p>
      <p>原第 {item.sourceShotIndex} 镜 → {item.revisionShotIndex===null?"修订缺失":"修订第 "+item.revisionShotIndex+" 镜"} · {status(item)}</p>
      <p>{item.decision==="pending"?"待编辑审核":
       item.decision==="request_revision"?"已标记需要修订":"已查看候选（非正式批准）"}</p>
      {item.decision==="pending"&&!readOnly?<div className="mt-1 flex flex-wrap gap-2">
       <button type="button" className="canvas-assistant-link" disabled={disabled||busy}
        aria-label={"已查看事件："+item.label}
        onClick={()=>void decide(item,"acknowledge_candidate")}>已查看</button>
       <button type="button" className="canvas-assistant-link" disabled={disabled||busy}
        aria-label={"要求修订事件："+item.label}
        onClick={()=>void decide(item,"request_revision")}>需要修订</button>
      </div>:null}
     </li>)}
    </ul>:<p>当前版本没有可提取的关键事件，不能自动宣称剧情一致。</p>}
    <p>审核记录：{currentReview.reviewStatus==="recorded_only"?"事件均已记录编辑决定":
     currentReview.reviewStatus==="no_source_candidates"?"没有事件候选":"仍有事件待审核"}。
     {storyReviewReadiness(currentReview).reason}。</p>
    {!frozenStep&&!readOnly&&storyReviewReadiness(currentReview).ready?
     <button type="button" className="canvas-assistant-task-primary-action"
      disabled={disabled||busy} onClick={()=>void prepareApply()}>
      准备应用已审核分镜（仅冻结步骤，仍需审批）
     </button>:null}
    {!frozenStep?<p>尚无与本轮关联的待批准画布步骤；只能记录编辑意见，不能应用草案。</p>:null}
   <button type="button" className="canvas-assistant-link" disabled={busy||!turnMessageId||!frozenStep||readOnly}
     onClick={()=>void load({applyCheck:true})}>核对冻结步骤的应用来源（只读）</button>
    {checkedDigest===scope+"|"+currentReview.snapshotDigest?
     <p role="status">当前快照 {currentReview.snapshotDigest.slice(0,12)}… 已完成编辑候选初核。
      这不是画布执行授权；仍须在独立冻结步骤中进行人工批准，且服务器会再次检查画布版本。</p>:null}
   </div>:null}
  </div>:null}
 </div>;
}
