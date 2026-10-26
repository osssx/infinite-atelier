import {useCallback,useEffect,useRef,useState} from "react";
import {Alert,App,Button,Drawer,Empty,Input,Spin,Tag,Tooltip} from "antd";
import {RefreshCw} from "lucide-react";
import {canvasApi} from "./canvas-api";

export type CanvasJobArtifact={artifactId:string;kind:string;status:string;reason:string|null;nodeId:string|null};
export type CanvasJobHistoryItem={
 id:string;projectId:string;sourceNodeId:string|null;
 createdAt:number;updatedAt:number;status:string;lastOutcome:string|null;executionMode:string;
 kind:"model"|"comfy"|"other";modelKind:string|null;
 reconciliationEligible:boolean;
 artifacts:CanvasJobArtifact[];artifactsTruncated:boolean;
};
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
  setJobs([]);setNextBefore(null);
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
 return <Drawer title="SQLite 任务历史" open={open} width={540} onClose={onClose}
  extra={<Button size="small" icon={<RefreshCw size={13}/>}
   onClick={()=>void refresh()} disabled={loading}>刷新任务</Button>}>
  <div className="space-y-3">
   <Alert type="info" showIcon message="历史任务从 SQLite 读取。落图重试只处理已有产物，不会重新提交付费生成。"/>
   <div className="flex items-center justify-between">
    <span className="text-xs opacity-65">当前项目 · 按创建时间倒序（每页 20 条）</span>
    <Button size="small" loading={working==="refresh"}
     onClick={()=>void refreshCanvas()}>刷新画布产物</Button>
   </div>
   {error?<Alert type="error" showIcon message="读取任务失败" description={error}/>:null}
   {loading&&!jobs.length?<div className="py-8 text-center"><Spin/></div>:null}
   {!loading&&!error&&!jobs.length?<Empty description="尚无 SQLite 任务记录"/>:null}
   {jobs.map(job=><div key={job.id} className="rounded-lg border p-3 space-y-2"
    style={{borderColor:"var(--ant-color-border-secondary)"}}>
    <div className="flex items-center justify-between gap-2">
     <span className="text-sm font-medium">
      {job.kind==="comfy"?"ComfyUI 工作流":job.kind==="model"?
       "模型"+(job.modelKind?" · "+job.modelKind:""):"任务"}
     </span>
     <Tag color={job.status==="succeeded"?"success":job.status==="failed"?"error":
      ["submission_unknown","blocked_credential"].includes(job.status)?"warning":"default"}>
      {statuses[job.status]??job.status}
     </Tag>
    </div>
    <div className="text-xs opacity-65">
     {new Date(job.createdAt).toLocaleString()} · 来源 {job.sourceNodeId??"无"}
    </div>
    <Tooltip title={job.id}>
     <div className="break-all font-mono text-xs opacity-50">{job.id}</div>
    </Tooltip>
    {job.lastOutcome&&job.lastOutcome!=="succeeded"?
     <div className="text-xs opacity-70">最近执行结果：{attemptReasons[job.lastOutcome]??job.lastOutcome}</div>:null}
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
      description="只有原始 ComfyUI 提交标记与冻结工作流图均匹配才能恢复。其他渠道或证据不足时保持未知，不会重新提交收费任务。"/>:null}
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
