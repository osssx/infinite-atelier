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
 function confirmRemove(job:CanvasJobHistoryItem){
  if(!canRemoveCanvasJobHistory(job)||working)return;
  modal.confirm({
   title:"删除这条任务历史？",
   content:"仅从历史列表移除。SQLite 原始任务记录、生成产物和已写入的画布节点将保留。移除后无法再从历史列表恢复该任务的受阻产物。",
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
    if(!applied)message.warning("产物已安全写入 SQLite，但当前画布存在更改，需手动刷新");
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
   if(applied)message.success("已检查 SQLite 画布；现有产物已同步");
   else message.warning("当前画布有未保存更改或节点冲突，无法安全刷新；请先保存并检查原始来源节点");
   await refresh();
  }catch(e){message.error("刷新 SQLite 画布失败："+String(e))}
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
       {statuses[job.status]??job.status}
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
