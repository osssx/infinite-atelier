import {useCallback,useEffect,useRef,useState} from "react";
import {Alert,App,Button,Drawer,Empty,Input,Spin,Tag,Tooltip} from "antd";
import {RefreshCw,Trash2} from "lucide-react";
import {canvasApi,CanvasApiError} from "./canvas-api";

export type CanvasJobArtifact={artifactId:string;kind:string;status:string;reason:string|null;nodeId:string|null};
export type CanvasJobHistoryItem={
 id:string;projectId:string;sourceNodeId:string|null;
 createdAt:number;updatedAt:number;status:string;lastOutcome:string|null;executionMode:string;
 kind:"model"|"comfy"|"other";modelKind:string|null;
 reconciliationEligible:boolean;hasSkillSnapshot?:boolean;
 closureEligible?:boolean;operatorClosedUnverified?:boolean;
 artifacts:CanvasJobArtifact[];artifactsTruncated:boolean;
};
export type SkillAudit={
 jobId:string;sourceNodeId:string;status:string;canReplay:boolean;
 versionPins:Array<{skillId:string;version:string;name:string}>;
 toolEvents:Array<{eventId:number;at:number;status:"started"|"completed";round:number;callId:string;name:string;skillId:string|null}>;
 summary?:{rounds:number;calls:number}
};
export async function getCanvasSkillAudit(projectId:string,jobId:string):Promise<SkillAudit>{
 return canvasApi("/api/v1/projects/"+encodeURIComponent(projectId)+"/jobs/"+
  encodeURIComponent(jobId)+"/skill-audit");
}
type ReplayIntent={idempotencyKey:string;expectedProjectRevision:number};
const replayIntents=new Map<string,ReplayIntent>();
const keyFor=(projectId:string,jobId:string)=>
 "atelier:skill-replay:v1:"+encodeURIComponent(projectId)+":"+encodeURIComponent(jobId);
const validReplayIntent=(x:unknown):x is ReplayIntent=>
 !!x&&typeof x==="object"&&"idempotencyKey" in x&&
 typeof x.idempotencyKey==="string"&&/^[0-9a-f-]{36}$/.test(x.idempotencyKey)&&
 "expectedProjectRevision" in x&&typeof x.expectedProjectRevision==="number"&&
 Number.isSafeInteger(x.expectedProjectRevision)&&x.expectedProjectRevision>0;
function loadReplayIntent(projectId:string,jobId:string):ReplayIntent|null{
 const key=keyFor(projectId,jobId);
 if(replayIntents.has(key))return replayIntents.get(key)!;
 let saved:string|null=null;
 try{saved=localStorage.getItem(key)}
 catch{try{saved=sessionStorage.getItem(key)}catch{/* memory-only fallback */}}
 if(saved===null)return null;
 let obj:unknown;
 try{obj=JSON.parse(saved)}catch{throw Error("skill_replay_intent_corrupt")}
 if(!validReplayIntent(obj))throw Error("skill_replay_intent_corrupt");
 replayIntents.set(key,obj);return obj;
}
function saveReplayIntent(projectId:string,jobId:string,intent:ReplayIntent){
 const key=keyFor(projectId,jobId);
 replayIntents.set(key,intent);
 try{localStorage.setItem(key,JSON.stringify(intent))}
 catch{try{sessionStorage.setItem(key,JSON.stringify(intent))}catch{/* memory-only fallback */}}
}
function clearReplayIntent(projectId:string,jobId:string){
 const key=keyFor(projectId,jobId);
 replayIntents.delete(key);
 try{localStorage.removeItem(key)}catch{/* memory-only fallback */}
 try{sessionStorage.removeItem(key)}catch{/* memory-only fallback */}
}
export function hasPendingSkillReplay(projectId:string,jobId:string){
 try{return loadReplayIntent(projectId,jobId)!==null}
 catch{return true} // Corrupt persisted intent fails closed, never creates a new POST.
}
type ReplayResult={found:boolean;jobId?:string;status?:string};
async function lookupReplayResult(projectId:string,jobId:string,key:string){
 return canvasApi<ReplayResult>("/api/v1/projects/"+encodeURIComponent(projectId)+
  "/jobs/"+encodeURIComponent(jobId)+"/replay-status?idempotencyKey="+
  encodeURIComponent(key));
}
/** A pending request is resolved only via read-only GET; it is NEVER
 * retransmitted automatically with a fresh paid idempotency key.
 */
export async function lookupPendingSkillReplay(projectId:string,jobId:string):
 Promise<{id:string;existing:true;status?:string}>{
 const intent=loadReplayIntent(projectId,jobId);
 if(!intent)throw Error("skill_replay_no_pending_request");
 const result=await lookupReplayResult(projectId,jobId,intent.idempotencyKey);
 if(!result.found||typeof result.jobId!=="string")
  throw Error("skill_replay_result_unknown：请求可能仍在处理，已保留原幂等键；不会重复提交。");
 clearReplayIntent(projectId,jobId);
 return {id:result.jobId,existing:true,status:result.status};
}
const replayInFlight=new Map<string,Promise<{id:string;existing?:boolean}>>();
async function performCanvasSkillReplay(projectId:string,jobId:string):Promise<{id:string;existing?:boolean}>{
 // A browser retry/reload must not turn an uncertain response into a second paid Job.
 if(hasPendingSkillReplay(projectId,jobId))
  return lookupPendingSkillReplay(projectId,jobId);
 const project=await canvasApi<{revision:number}>("/api/v1/projects/"+encodeURIComponent(projectId));
 const intent={expectedProjectRevision:project.revision,idempotencyKey:crypto.randomUUID()};
 saveReplayIntent(projectId,jobId,intent); // record before ANY potentially billable HTTP POST
 try{
  const result=await canvasApi<{id:string;existing?:boolean}>(
   "/api/v1/projects/"+encodeURIComponent(projectId)+"/jobs/"+
   encodeURIComponent(jobId)+"/replay-skills","POST",{
    expectedProjectRevision:intent.expectedProjectRevision,
    idempotencyKey:intent.idempotencyKey,requestFingerprint:intent.idempotencyKey
   });
  clearReplayIntent(projectId,jobId);
  return result;
 }catch(e){
  try{return await lookupPendingSkillReplay(projectId,jobId)}
  catch(lookupError){
   // Only a definitive non-ambiguous HTTP rejection can safely reset a
   // pending request; timeouts/5xx/network errors retain the original intent.
   if(e instanceof CanvasApiError&&e.status>=400&&e.status<500&&
      e.status!==408&&e.status!==429&&
      lookupError instanceof Error&&lookupError.message.startsWith("skill_replay_result_unknown")){
    clearReplayIntent(projectId,jobId);
    throw e;
   }
   throw Error("冻结 Skill 重放提交结果未知。已保留原幂等键，请重新打开任务历史点击『核实提交结果』；不会自动创建另一笔付费任务。");
  }
 }
}
/** One browser tab also joins an in-flight confirmation rather than racing
 * two distinct UUIDs before the first project revision GET finishes.
 */
export async function replayCanvasSkillJob(projectId:string,jobId:string):
 Promise<{id:string;existing?:boolean}>{
 const key=keyFor(projectId,jobId);
 const current=replayInFlight.get(key);
 if(current)return current;
 const pending=performCanvasSkillReplay(projectId,jobId);
 replayInFlight.set(key,pending);
 try{return await pending}finally{
  if(replayInFlight.get(key)===pending)replayInFlight.delete(key);
 }
}
export type CanvasScriptAsset={referenceIndex:number;kind:"video"|"audio";role:string;
 blobId:string;mimeType:string;status:string;remoteAssetId:string|null;
 finalizeStage?:"uploaded"|"finalizing"|"completed"|null;expectedAssetId?:string|null;
 chunkProgress?:{total:number;uploaded:number;uncertain:number}|null;
 updatedAt:number|null};
export type CanvasScriptAssetAudit={jobId:string;projectId:string;jobStatus:string;
 submissionNeverStarted:boolean;canResume:boolean;canResumePreparation?:boolean;assets:CanvasScriptAsset[]};
const assetBase=(projectId:string,jobId:string)=>"/api/v1/projects/"+
 encodeURIComponent(projectId)+"/jobs/"+encodeURIComponent(jobId);
export async function getCanvasScriptAssets(projectId:string,jobId:string):Promise<CanvasScriptAssetAudit>{
 return canvasApi(assetBase(projectId,jobId)+"/assets");
}
export async function reconcileCanvasScriptAsset(projectId:string,jobId:string,
 referenceIndex:number,action:"confirm"|"reject",expectedUpdatedAt:number,
 remoteAssetId?:string):Promise<{status:string}>{
 return canvasApi(assetBase(projectId,jobId)+"/assets/"+referenceIndex+"/reconcile",
  "POST",{action,expectedUpdatedAt,operatorConfirmed:true,
   ...(action==="confirm"?{remoteAssetId}:{} )});
}
export async function auditCanvasScriptChunks(projectId:string,jobId:string,
 referenceIndex:number,expectedUpdatedAt:number):Promise<{verified:boolean;reason?:string;verifiedParts?:number}>{
 return canvasApi(assetBase(projectId,jobId)+"/assets/"+referenceIndex+"/audit-chunks",
  "POST",{expectedUpdatedAt});
}
export async function resumeCanvasScriptAssets(projectId:string,jobId:string):
 Promise<{jobId:string;status:string;resumed:true}>{
 return canvasApi(assetBase(projectId,jobId)+"/resume-assets","POST",{});
}
type Page={jobs:CanvasJobHistoryItem[];nextBefore:string|null};
const statuses:Record<string,string>={
 queued:"等待执行",preparing:"准备中",submitting:"提交中",
 running:"生成中",collecting:"收集产物",succeeded:"生成成功",
 failed:"生成失败",cancelled:"已取消",
 submission_unknown:"提交结果未知",blocked_credential:"密钥不可用",
 materialized:"已写入画布",blocked:"落图受阻",retry:"落图等待重试",pending:"等待落图"
};
const attemptReasons:Record<string,string>={
 prepare_failed:"准备任务失败（尚未提交到模型）",not_accepted:"远端明确拒绝了提交",
 remote_failed:"远程任务确认失败",submission_unknown:"可能已提交，尚未查明结果",
 blocked_credential:"执行所需密钥不可用",process_restarted:"后端在处理时重启",
 poll_failed:"远程任务查询暂时失败",collect_pending:"产物收集中，后端将安全重试下载",
 remote_pending:"远程任务仍在执行",interrupted:"任务执行被中断"
};
const reasons:Record<string,string>={
 materialization_source_changed:"来源节点或上游输入已改变，需恢复原输入后重试",
 materialization_source_deleted:"生成时的来源节点已删除",
 materialization_port_mismatch:"工作流输出端口已变更或不兼容",
 materialization_project_deleted:"项目已删除",
 materialization_node_collision:"产物节点 ID 已与现有节点冲突",
 materialization_link_conflict:"产物连接与当前画布不兼容",
 materialization_edge_collision:"产物边 ID 已被占用",
 materialization_identity_conflict:"产物身份与现有节点冲突",
 materialization_blob_unavailable:"产物文件暂不可用，后端会按退避策略重试",
 materialization_blob_mismatch:"产物校验不一致",
 materialization_text_invalid:"产物文本编码无效"
};
export const canRetryCanvasMaterialization=(job:CanvasJobHistoryItem,artifact:CanvasJobArtifact)=>
 job.status==="succeeded"&&artifact.status==="blocked";
export const canReconcileUnknownJob=(job:CanvasJobHistoryItem)=>
 job.kind==="comfy"&&job.status==="submission_unknown"&&job.reconciliationEligible;
export const canCloseUnknownModelJob=(job:CanvasJobHistoryItem)=>
 job.kind==="model"&&job.status==="submission_unknown"&&job.closureEligible===true;
export async function closeCanvasUnknownModelJob(projectId:string,job:CanvasJobHistoryItem):
 Promise<{closed:true;existing:boolean;jobId:string;status:string}>{
 return canvasApi("/api/v1/projects/"+encodeURIComponent(projectId)+"/jobs/"+
  encodeURIComponent(job.id)+"/close-unverified","POST",{
   confirmationJobId:job.id,expectedUpdatedAt:job.updatedAt,
   acknowledgePossibleCharge:true
  });
}

/** Only completed jobs can leave history; uncertain and active tasks must stay visible. */
export const canRemoveCanvasJobHistory=(job:CanvasJobHistoryItem)=>
 ["succeeded","failed","cancelled"].includes(job.status);
export async function removeCanvasJobHistory(projectId:string,jobId:string):Promise<void>{
 await canvasApi<{hidden:true;jobId:string}>("/api/v1/projects/"+encodeURIComponent(projectId)+
  "/jobs/"+encodeURIComponent(jobId)+"/history","DELETE");
}

export async function getCanvasJobHistory(projectId:string,before?:string):Promise<Page>{
 return canvasApi<Page>("/api/v1/projects/"+encodeURIComponent(projectId)+
  "/jobs?limit=20"+(before?"&before="+encodeURIComponent(before):""));
}
export async function retryCanvasMaterialization(projectId:string,artifactId:string):Promise<void>{
 await canvasApi<{requeued:boolean}>(
  "/api/v1/projects/"+encodeURIComponent(projectId)+"/materializations/"+
  encodeURIComponent(artifactId)+"/retry","POST",{}
 );
}
export async function recoverCanvasPendingMaterialization(
 projectId:string,artifactId:string
):Promise<{artifactId:string;status:string;reason:string|null}>{
 return canvasApi("/api/v1/projects/"+encodeURIComponent(projectId)+
  "/materializations/"+encodeURIComponent(artifactId)+"/recover","POST",{});
}
export async function reconcileCanvasUnknownJob(
 projectId:string,jobId:string,remoteTaskId:string
):Promise<{verified:boolean;status:string;reason?:string}>{
 return canvasApi("/api/v1/projects/"+encodeURIComponent(projectId)+"/jobs/"+
  encodeURIComponent(jobId)+"/reconcile","POST",{remoteTaskId});
}
export function CanvasJobHistory({projectId,open,onClose,onObserveJob,onRefreshCanvas}:{
 projectId:string;open:boolean;onClose:()=>void;
 onObserveJob:(jobId:string)=>void;onRefreshCanvas:()=>Promise<boolean>;
}){
 const {message,modal}=App.useApp();
 const currentProject=useRef(projectId);
 currentProject.current=projectId;
 const [jobs,setJobs]=useState<CanvasJobHistoryItem[]>([]);
 const [nextBefore,setNextBefore]=useState<string|null>(null);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [working,setWorking]=useState<string|null>(null);
 const [reconcilingJob,setReconcilingJob]=useState<string|null>(null);
 const [skillAudits,setSkillAudits]=useState<Record<string,SkillAudit>>({});
 const [skillAuditOpen,setSkillAuditOpen]=useState<string|null>(null);
 const [remoteTaskInput,setRemoteTaskInput]=useState("");
 const [assetAudits,setAssetAudits]=useState<Record<string,CanvasScriptAssetAudit>>({});
 const [assetAuditOpen,setAssetAuditOpen]=useState<string|null>(null);
 const [assetIdInputs,setAssetIdInputs]=useState<Record<string,string>>({});
 const inflight=useRef(new Set<string>());
 const refresh=useCallback(async(silent=false)=>{
  if(!silent)setLoading(true);
  try{
   const page=await getCanvasJobHistory(projectId);
   if(currentProject.current!==projectId)return;
   setJobs(current=>silent&&current.length>page.jobs.length?
    [...page.jobs,...current.filter(old=>!page.jobs.some(x=>x.id===old.id))]:page.jobs);
   if(!silent)setNextBefore(page.nextBefore);
   setError(null);
  }catch(e){if(!silent)setError(String(e))}
  finally{if(!silent)setLoading(false)}
 },[projectId]);
 useEffect(()=>{
  if(!open)return;
  setJobs([]);setNextBefore(null);setSkillAudits({});setSkillAuditOpen(null);
  setAssetAudits({});setAssetAuditOpen(null);setAssetIdInputs({});
  void refresh();
  const timer=setInterval(()=>{void refresh(true)},6000);
  return()=>clearInterval(timer);
 },[open,refresh]);
 async function more(){
  if(!nextBefore||loading)return;
  setLoading(true);
  try{
   const page=await getCanvasJobHistory(projectId,nextBefore);
   if(currentProject.current!==projectId)return;
   setJobs(current=>[...current,...page.jobs.filter(item=>!current.some(x=>x.id===item.id))]);
   setNextBefore(page.nextBefore);setError(null);
  }catch(e){setError(String(e))}
  finally{setLoading(false)}
 }
 async function inspectSkills(job:CanvasJobHistoryItem){
  if(!job.hasSkillSnapshot)return;
  setWorking(job.id);setSkillAuditOpen(job.id);
  try{
   const audit=await getCanvasSkillAudit(projectId,job.id);
   if(currentProject.current!==projectId)return;
   setSkillAudits(old=>({...old,[job.id]:audit}));
  }catch(e){message.error("读取 Skill 审计失败："+String(e));setSkillAuditOpen(null)}
  finally{setWorking(null)}
 }
 function confirmSkillReplay(job:CanvasJobHistoryItem){
  if(!skillAudits[job.id]?.canReplay||working)return;
  const pending=hasPendingSkillReplay(projectId,job.id);
  modal.confirm({
   title:pending?"核实已有冻结 Skill 提交结果？":"使用冻结 Skill 版本重新生成？",
   content:pending?"此前一次付费任务的提交回执不确定。本次只读查询该请求的幂等键，不会重新提交或产生新的计费请求。":
    "将使用原任务保存的 Skill 内容、模型、提示词及密钥版本，新建一次可能收费的模型任务。仅原任务成功且来源节点及其上游输入未改变时允许。结果作为新节点追加；不修改或重试旧任务。",
   okText:pending?"只查询提交结果":"确认新建付费任务",cancelText:"取消",
   onOk:async()=>{
    setWorking(job.id);
    try{
     const started=await replayCanvasSkillJob(projectId,job.id);
     message.success((pending||started.existing?"已确认已有冻结 Skill 任务：":"已创建新的冻结 Skill 任务：")+started.id);
     onObserveJob(started.id);
     await refresh();
    }catch(e){
     if(hasPendingSkillReplay(projectId,job.id)){
      message.warning("提交结果尚未确认，已保留原请求标识。请使用『核实待确认提交结果』只读查询；不会重新付费提交。");
      return; // close the charged-submit dialog; next action is read-only
     }
     message.error("冻结 Skill 重生成失败："+String(e));throw e
    }finally{setWorking(null)}
   }
  });
 }
 function confirmReconcile(job:CanvasJobHistoryItem){
  if(!canReconcileUnknownJob(job)||!remoteTaskInput.trim()||working)return;
  const remoteTaskId=remoteTaskInput.trim();
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(remoteTaskId)){
   message.error("远端任务 ID 格式无效");return;
  }
  modal.confirm({
   title:"核实已有 ComfyUI 任务",
   content:"只查询本地 ComfyUI 的历史记录，要求工作流图和原始随机提交标记均匹配。证据匹配后恢复轮询/收集，不会重新提交 /prompt。任务 ID 错误或历史记录尚未出现时将保持未知。",
   okText:"验证远端历史",cancelText:"取消",
   onOk:async()=>{
    setWorking(job.id);
    try{
     const result=await reconcileCanvasUnknownJob(projectId,job.id,remoteTaskId);
     if(result.verified){
      message.success("已核实原始远端任务，恢复已有任务的状态观察");
      onObserveJob(job.id);
      setReconcilingJob(null);setRemoteTaskInput("");
     }else message.warning(result.reason==="remote_evidence_absent"?
      "尚未找到远端任务历史；不能判断是否提交成功":
      "远端历史与原始任务不匹配，已拒绝恢复");
     await refresh();
    }catch(e){message.error("人工对账失败："+String(e));throw e}
    finally{setWorking(null)}
   }
  });
 }
 async function inspectAssets(job:CanvasJobHistoryItem){
  if(job.kind!=="model"||job.modelKind!=="video"||working)return;
  setWorking(job.id);
  try{
   const audit=await getCanvasScriptAssets(projectId,job.id);
   if(currentProject.current!==projectId)return;
   setAssetAuditOpen(job.id);setAssetAudits(old=>({...old,[job.id]:audit}));
  }catch(e){message.error("读取远端素材核对记录失败："+String(e))}
  finally{setWorking(null)}
 }
 async function auditChunks(job:CanvasJobHistoryItem,asset:CanvasScriptAsset){
  if(working||asset.updatedAt===null||!asset.chunkProgress?.uncertain)return;
  setWorking(job.id);
  try{
   const result=await auditCanvasScriptChunks(projectId,job.id,
    asset.referenceIndex,asset.updatedAt);
   const current=await getCanvasScriptAssets(projectId,job.id);
   if(currentProject.current===projectId)setAssetAudits(old=>({...old,[job.id]:current}));
   if(result.verified)message.success("服务商已确认未知分片的 ETag。可核对后显式恢复原任务。");
   else message.warning("服务商未提供全部未知分片的可信 ETag；仍禁止重传。");
  }catch(e){message.error("只读分片核对失败："+String(e))}
  finally{setWorking(null)}
 }
 function confirmAsset(job:CanvasJobHistoryItem,asset:CanvasScriptAsset,action:"confirm"|"reject"){
  if(working||asset.status!=="uploading"||asset.updatedAt===null)return;
  const candidate=assetIdInputs[job.id+":"+asset.referenceIndex]?.trim()??"";
  if(action==="confirm"&&!/^[A-Za-z0-9_-]{1,128}$/.test(candidate)){
   message.error("请输入已从服务商核实的有效素材 ID");return;
  }
  modal.confirm({
   title:action==="confirm"?"确认远端素材已经上传成功？":"确认服务商未接收该素材？",
   content:action==="confirm"?
    "此 ID 必须已经在服务商素材列表中核实，并与当前任务的素材匹配。系统不会向服务商核实 ID；确认后允许后续恢复并可能触发一次付费视频生成。":
    "只将本次不确定上传标记为拒绝，不会删除远端文件；此任务无法通过该入口恢复。",
   okText:action==="confirm"?"我已人工核实素材 ID":"标记拒绝",
   okType:action==="reject"?"danger":"primary",cancelText:"取消",
   onOk:async()=>{
    setWorking(job.id);
    try{
     await reconcileCanvasScriptAsset(projectId,job.id,asset.referenceIndex,action,
      asset.updatedAt!,action==="confirm"?candidate:undefined);
     const audit=await getCanvasScriptAssets(projectId,job.id);
     if(currentProject.current===projectId)setAssetAudits(old=>({...old,[job.id]:audit}));
     message.success(action==="confirm"?"已保存人工确认结果":"已记录服务商拒绝");
    }catch(e){message.error("确认素材失败："+String(e));throw e}
    finally{setWorking(null)}
   }
  });
 }
 function confirmAssetResume(job:CanvasJobHistoryItem){
  const audit=assetAudits[job.id];
  if(!audit?.canResume||working)return;
  modal.confirm({
   title:audit.canResumePreparation?"继续尚未完成的素材分片上传？":"从已核实的素材恢复视频生成？",
   content:audit.canResumePreparation?
    "服务商已确认结果未知分片。恢复原任务后会继续发送尚未开始的分片 PUT、完成确认，并可能提交一次收费的视频生成；已确认分片不会重传。":
    "所有远端素材 ID 均已确认。恢复同一个原始任务，将使用冻结参数发起一次可能收费的视频生成请求，不重新上传已确认的素材。请确认服务商中的素材和当前任务确实匹配。",
   okText:"确认恢复并允许生成",cancelText:"取消",
   onOk:async()=>{
    setWorking(job.id);
    try{
     await resumeCanvasScriptAssets(projectId,job.id);
     message.success("原任务已恢复排队，远端素材不会重复上传");
     setAssetAuditOpen(null);onObserveJob(job.id);await refresh();
    }catch(e){message.error("恢复任务失败："+String(e));throw e}
    finally{setWorking(null)}
   }
  });
 }
 function confirmCloseUnknownModelJob(job:CanvasJobHistoryItem){
  if(!canCloseUnknownModelJob(job)||working)return;
  modal.confirm({
   title:"人工结束结果未知的模型任务？",
   content:<div className="space-y-2 text-sm">
    <p>原任务 {job.id} 的远端提交结果无法核实，服务商可能已经收到请求并计费。</p>
    <p><strong>本操作只解除本地对同一节点后续提交的阻挡。</strong>不会取消远端请求、退费、找回结果或再次提交旧任务。</p>
    <p>建议先核对服务商请求记录和账单。之后如果再次点击“生成”，将创建一笔独立的新请求，可能再次收费。</p>
    <p>原始任务记录和“提交结果未知”证据将永久保留在任务历史中。</p>
   </div>,
   okText:"我理解可能重复计费，结束等待",
   okType:"danger",cancelText:"暂不处理",
   onOk:async()=>{
    setWorking(job.id);
    try{
     await closeCanvasUnknownModelJob(projectId,job);
     message.success("原任务已人工结束等待；未证明远端未计费。现在可以手动发起一笔新任务。");
     await refresh();
    }catch(e){
     message.error("人工结束失败："+String(e));throw e;
    }finally{setWorking(null)}
   }
  });
 }
 function confirmRemove(job:CanvasJobHistoryItem){
  if(!canRemoveCanvasJobHistory(job)||working)return;
  modal.confirm({
   title:"删除这条任务历史？",
   content:"仅从历史列表移除。原始任务记录、生成产物和已写入的画布节点将保留。移除后无法再从历史列表恢复该任务的受阻产物。",
   okText:"删除记录",okType:"danger",cancelText:"取消",
   onOk:async()=>{
    setWorking(job.id);
    try{
     await removeCanvasJobHistory(projectId,job.id);
     message.success("已从任务历史列表移除，生成产物仍保留");
     setSkillAuditOpen(current=>current===job.id?null:current);
     setSkillAudits(old=>{const next={...old};delete next[job.id];return next});
     await refresh();
    }catch(error){message.error("删除任务历史失败："+String(error));throw error}
    finally{setWorking(null)}
   }
  });
 }
 async function retry(job:CanvasJobHistoryItem,artifact:CanvasJobArtifact){
  if(!canRetryCanvasMaterialization(job,artifact)||inflight.current.has(artifact.artifactId))return;
  inflight.current.add(artifact.artifactId);setWorking(artifact.artifactId);
  try{
   await retryCanvasMaterialization(projectId,artifact.artifactId);
   onObserveJob(job.id);
   message.success("仅将现有产物重新加入落图队列，不会再次执行模型生成");
   await refresh();
  }catch(e){message.error("落图重试失败："+String(e))}
  finally{inflight.current.delete(artifact.artifactId);setWorking(null)}
 }
 async function recover(job:CanvasJobHistoryItem,artifact:CanvasJobArtifact){
  if(job.status!=="succeeded"||artifact.status!=="pending"||
   inflight.current.has(artifact.artifactId))return;
  inflight.current.add(artifact.artifactId);setWorking(artifact.artifactId);
  try{
   const result=await recoverCanvasPendingMaterialization(projectId,artifact.artifactId);
   if(result.status==="materialized"){
    const applied=await onRefreshCanvas();
    if(!applied)message.warning("产物已安全保存，但当前画布存在更改，需手动刷新");
    else message.success("已有产物已落图；未重新提交模型生成");
   }else message.warning("落图处理结果："+(statuses[result.status]??result.status)+
    (result.reason?"（"+(reasons[result.reason]??result.reason)+"）":""));
   onObserveJob(job.id);
   await refresh();
  }catch(e){message.error("落图处理失败："+String(e))}
  finally{inflight.current.delete(artifact.artifactId);setWorking(null)}
 }
 async function refreshCanvas(){
  setWorking("refresh");
  try{
   const applied=await onRefreshCanvas();
   if(applied)message.success("已检查画布；现有产物已同步");
   else message.warning("当前画布有未保存更改或节点冲突，无法安全刷新；请先保存并检查原始来源节点");
   await refresh();
  }catch(e){message.error("刷新画布失败："+String(e))}
  finally{setWorking(null)}
 }
 return <Drawer title="任务历史" open={open} width={540} onClose={onClose}
  extra={<Button size="small" icon={<RefreshCw size={13}/>}
   onClick={()=>void refresh()} disabled={loading}>刷新任务</Button>}>
  <div className="space-y-3">
   <div className="flex items-center justify-between">
    <span className="text-xs opacity-65">当前项目 · 按创建时间倒序（每页 20 条）</span>
    <Button size="small" loading={working==="refresh"}
     onClick={()=>void refreshCanvas()}>刷新画布产物</Button>
   </div>
   {error?<Alert type="error" showIcon message="读取任务失败" description={error}/>:null}
   {loading&&!jobs.length?<div className="py-8 text-center"><Spin/></div>:null}
   {!loading&&!error&&!jobs.length?<Empty description="暂无任务记录"/>:null}
   {jobs.map(job=><div key={job.id} className="rounded-lg border p-3 space-y-2"
    style={{borderColor:"var(--ant-color-border-secondary)"}}>
    <div className="flex items-center justify-between gap-2">
     <span className="text-sm font-medium">
      {job.kind==="comfy"?"ComfyUI 工作流":job.kind==="model"?
       "模型"+(job.modelKind?" · "+job.modelKind:""):"任务"}
     </span>
     <div className="flex items-center gap-1">
      <Tag color={job.status==="succeeded"?"success":job.status==="failed"?"error":
       ["submission_unknown","blocked_credential"].includes(job.status)?"warning":"default"}>
       {job.operatorClosedUnverified?"已人工结束（结果未证实）":statuses[job.status]??job.status}
      </Tag>
      <Tooltip title={canRemoveCanvasJobHistory(job)?"删除历史记录":"任务尚未结束，不能删除"}>
       <Button type="text" size="small" danger icon={<Trash2 size={14}/>}
        aria-label="删除历史记录" disabled={!canRemoveCanvasJobHistory(job)||Boolean(working)}
        loading={working===job.id} onClick={()=>confirmRemove(job)}/>
      </Tooltip>
     </div>
    </div>
    <div className="text-xs opacity-65">
     {new Date(job.createdAt).toLocaleString()} · 来源 {job.sourceNodeId??"无"}
    </div>
    <Tooltip title={job.id}>
     <div className="break-all font-mono text-xs opacity-50">{job.id}</div>
    </Tooltip>
    {job.lastOutcome&&job.lastOutcome!=="succeeded"?
     <div className="text-xs opacity-70">最近执行结果：{attemptReasons[job.lastOutcome]??job.lastOutcome}</div>:null}
    {job.hasSkillSnapshot?<div className="space-y-2 text-xs">
     <Button size="small" loading={working===job.id}
      onClick={()=>void inspectSkills(job)}>
      {skillAuditOpen===job.id?"刷新 Skill 审计":"查看 Skill 版本与工具审计"}
     </Button>
     {skillAuditOpen===job.id&&skillAudits[job.id]?<div className="rounded border p-2 space-y-2"
      style={{borderColor:"var(--ant-color-border-secondary)"}}>
      <div className="font-medium">冻结版本（不会读取当前浏览器 Skill）</div>
      {skillAudits[job.id].versionPins.map(pin=><div key={pin.skillId} className="break-all">
       {pin.name} · {pin.skillId} · {pin.version}
      </div>)}
      <div className="font-medium">工具调用事件 · {skillAudits[job.id].toolEvents.length} 条</div>
      {skillAudits[job.id].toolEvents.length?
       skillAudits[job.id].toolEvents.map(item=><div key={item.eventId}>
        第 {item.round} 轮 · {item.name} · {item.skillId??"目录"} ·
        {item.status==="started"?"开始":"完成"} ·
        {new Date(item.at).toLocaleTimeString()}
       </div>):<span className="opacity-60">尚无工具事件</span>}
      <div className="text-xs opacity-60">仅展示只读工具名称、轮数与固定版本；不显示工具参数、Skill 正文或 API Key。</div>
      {skillAudits[job.id].canReplay?<Button size="small" type="primary"
       loading={working===job.id} onClick={()=>confirmSkillReplay(job)}>
       {hasPendingSkillReplay(projectId,job.id)?"核实待确认提交结果（不重新执行）":"使用冻结版本创建新任务"}
      </Button>:<div className="opacity-60">原任务未成功，不允许从未知提交状态重新执行。</div>}
     </div>:null}
    </div>:null}
    {job.kind==="model"&&job.modelKind==="video"&&
      job.status==="failed"&&job.lastOutcome==="prepare_failed"?
     <div className="space-y-2 text-xs">
      <Button size="small" loading={working===job.id}
       onClick={()=>void inspectAssets(job)}>核对远端素材上传</Button>
      {assetAuditOpen===job.id&&assetAudits[job.id]?
       <div className="rounded border p-2 space-y-2"
        style={{borderColor:"var(--ant-color-border-secondary)"}}>
        <Alert type="warning" showIcon message="必须先查阅服务商素材记录"
         description="系统无法自动证实未知上传是否成功。切勿猜测远端素材 ID；确认后恢复任务可能产生视频生成费用。"/>
        {assetAudits[job.id].assets.map(asset=>
         <div key={asset.referenceIndex} className="border-b pb-2 space-y-1">
          <div>{asset.kind==="video"?"参考视频":"参考音频"} #{asset.referenceIndex+1}
           {" · "}{asset.status==="uploading"?"结果未知":
            asset.status==="active"?"已确认":
            asset.status==="rejected"?"已拒绝":asset.status}</div>
          <div className="font-mono opacity-60 break-all">{asset.blobId.slice(0,16)}…</div>
          {asset.chunkProgress?<div>
           分片确认：{asset.chunkProgress.uploaded}/{asset.chunkProgress.total}
           {asset.chunkProgress.uncertain>0?" · "+asset.chunkProgress.uncertain+" 片结果未知，禁止自动重传":""}
          </div>:null}
          {asset.status==="uploading"&&asset.chunkProgress?.uncertain?
           <Button size="small" loading={working===job.id}
            onClick={()=>void auditChunks(job,asset)}>
            从服务商只读核对未知分片 ETag
           </Button>:null}
          {asset.finalizeStage?<div className="text-amber-600 dark:text-amber-400">
           {asset.finalizeStage==="uploaded"?"文件 PUT 已完成，尚未完成服务商确认":
            asset.finalizeStage==="finalizing"?"服务商完成确认结果未知，禁止自动再次确认":
            "服务商已完成确认"}
           {asset.expectedAssetId?" · 申请 ID："+asset.expectedAssetId:""}
          </div>:null}
          {asset.status==="active"?<div>远端 ID：{asset.remoteAssetId}</div>:null}
          {asset.status==="uploading"?<>
           <Input size="small" placeholder="经服务商核实的素材 ID"
            maxLength={128} value={assetIdInputs[job.id+":"+asset.referenceIndex]??""}
            onChange={e=>setAssetIdInputs(old=>({...old,
             [job.id+":"+asset.referenceIndex]:e.target.value}))}/>
           <div className="flex gap-2">
            <Button size="small" type="primary" loading={working===job.id}
             onClick={()=>confirmAsset(job,asset,"confirm")}>确认素材 ID</Button>
            <Button size="small" danger loading={working===job.id}
             onClick={()=>confirmAsset(job,asset,"reject")}>确认未接收</Button>
           </div>
          </>:null}
         </div>)}
        {assetAudits[job.id].canResume?
         <Button size="small" type="primary" loading={working===job.id}
          onClick={()=>confirmAssetResume(job)}>{assetAudits[job.id].canResumePreparation?
           "继续剩余分片并允许视频生成":"恢复原任务并允许视频生成"}</Button>:
         <div className="opacity-65">有素材未核实或无法恢复；不会重复上传或发起生成。</div>}
       </div>:null}
     </div>:null}
    {canCloseUnknownModelJob(job)?
     <Button size="small" danger loading={working===job.id}
      onClick={()=>confirmCloseUnknownModelJob(job)}>
      人工结束等待（保留计费风险）
     </Button>:null}
    {job.operatorClosedUnverified?
     <Alert type="warning" showIcon message="原任务已人工结束等待，远端结果及计费仍未证实"
      description="本地已允许新的独立提交；旧任务没有被远端取消，也没有被认定为未计费。审计记录仍然保留。"/>:null}
    {canReconcileUnknownJob(job)?
     <div className="space-y-2">
      <Button size="small" onClick={()=>{
       setReconcilingJob(current=>current===job.id?null:job.id);
       setRemoteTaskInput("");
      }}>人工核对 ComfyUI 任务</Button>
      {reconcilingJob===job.id?
       <div className="space-y-2">
        <div className="text-xs opacity-70">从 ComfyUI 的 History 查找原任务 ID。禁止使用另一任务 ID 替代原任务。</div>
        <Input size="small" placeholder="ComfyUI prompt_id"
         value={remoteTaskInput} maxLength={128}
         onChange={event=>setRemoteTaskInput(event.target.value)} />
        <Button size="small" type="primary" loading={working===job.id}
         disabled={!remoteTaskInput.trim()}
         onClick={()=>confirmReconcile(job)}>核实并恢复原任务</Button>
       </div>:null}
     </div>:null}
    {job.status==="submission_unknown"?
     <Alert type="warning" showIcon message="远程是否接收尚未核实；禁止重新提交"
      description={job.kind==="comfy"?"只有原始 ComfyUI 提交标记与冻结工作流图均匹配才能恢复。证据不足时保持未知，不会重复提交。":"模型可能已接收付费请求；无法证明是否计费，保持未知状态且不自动重新提交。"}/>:null}
    {job.status==="blocked_credential"?
     <Alert type="warning" showIcon message="密钥不可用"
      description="核查后端渠道密钥及原任务状态，不要将其作为新任务重发。"/>:null}
    {job.status==="succeeded"&&job.artifacts.length===0?
     <div className="text-xs opacity-70">生成成功，但尚无可落图的产物记录；请检查后端收集日志。</div>:null}
    {job.artifacts.map(artifact=><div key={artifact.artifactId}
     className="rounded-md border px-2 py-2 text-xs space-y-1"
     style={{borderColor:"var(--ant-color-border-secondary)"}}>
     <div className="flex justify-between gap-2 items-center">
      <span>{artifact.kind} · {statuses[artifact.status]??artifact.status}</span>
      {job.status==="succeeded"&&artifact.status==="pending"?
       <Button size="small" loading={working===artifact.artifactId}
        onClick={()=>void recover(job,artifact)}>立即尝试落图</Button>:null}
      {canRetryCanvasMaterialization(job,artifact)?
       <Button size="small" loading={working===artifact.artifactId}
        onClick={()=>void retry(job,artifact)}>重新尝试落图</Button>:null}
     </div>
     {artifact.reason?<p className="opacity-70">{reasons[artifact.reason]??artifact.reason}
      <span className="ml-1 opacity-60">({artifact.reason})</span></p>:null}
     {artifact.nodeId?<div className="opacity-60">节点：{artifact.nodeId}</div>:null}
    </div>)}
    {job.artifactsTruncated?<p className="text-xs opacity-70">产物记录较多，仅展示前 100 条。</p>:null}
   </div>)}
   {nextBefore?<div className="py-3 text-center"><Button loading={loading}
    onClick={()=>void more()}>加载更早任务</Button></div>:null}
  </div>
 </Drawer>;
}
