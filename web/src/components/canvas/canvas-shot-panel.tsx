import {Button, Checkbox, ConfigProvider, Drawer, Select, Space, Tag} from "antd";
import {useEffect,useState,type CSSProperties} from "react";
import {ChevronDown,ChevronUp,Film,Trash2} from "lucide-react";
import type {CanvasNodeData, CanvasShot} from "@/types/canvas";
import {canvasCasUrl} from "@/features/backend-sync/canvas-cas";
import {useCanvasComfyExecution} from "@/features/comfy-workflow/canvas-execution-visual";
import {isComfyRunActive} from "@/features/comfy-workflow/run-status";
import {acquireMediaPreview} from "@/services/media-preview-storage";
import type {CanvasTheme} from "@/lib/canvas-theme";

export type ShotCheck = {shotId:string;state:"ready"|"takeReady"|"waiting"|"choose"|"blocked";reason?:string};
export type ShotBatchItem = {shotId:string;status:string;reason?:string;jobId?:string;tail?:{blobId:string};choices?:Array<{artifactId:string;storageKey?:string}>;retryCount?:number;retryFromJobId?:string};

const checkLabels={ready:"可立即提交",takeReady:"前镜已就绪 · 待确认",waiting:"等待前镜生成",choose:"需选择成品",blocked:"需修复"};
const batchLabels:Record<string,string>={pending:"待提交",waiting:"等待前镜",choose:"需选择成品",queued:"已入队",preparing:"准备中",submitting:"提交中",running:"生成中",collecting:"正在收集产物",succeeded:"已完成",failed:"失败",blocked:"已暂停",stopped:"已停止",cancelled:"已取消",submission_unknown:"待核实"};
const batchReasons:Record<string,string>={
 shot_group_changed:"镜头组或承接顺序变化，请重新检查",
 stale_generation_source:"镜头配置或素材变化，请重新检查",
 shot_previous_failed:"前镜失败或提交状态待核实。请先处理前镜任务",
 shot_handoff_artifact_missing:"前镜缺少可用成品，请检查落图状态或选用本地成品",
 shot_handoff_source_changed:"已选用的前镜成品变化，请重新检查",
 backend_prior_job_not_terminal:"此镜头已有活动或待核实任务，请先处理原任务",
 shot_retry_limit_exceeded:"该镜头已达到显式重试次数上限，请另建批次",
 audio_extraction_tool_unavailable:"本地 FFmpeg 不可用",
};

export function shotTakes(shot:CanvasShot,nodes:CanvasNodeData[]){
 const takes=new Map<string,NonNullable<CanvasShot["take"]>>();
 for(const node of nodes){
  const artifact=node.metadata?.comfyArtifact,model=node.metadata?.modelArtifact;
  const key=node.metadata?.storageKey;
  if(node.type!=="video"||!key?.startsWith("cas:"))continue;
  if(artifact?.workflowNodeId===shot.generationNodeId)takes.set(key,{storageKey:key,artifactId:artifact.artifactId,jobId:artifact.runId});
  else if(model?.sourceNodeId===shot.generationNodeId)takes.set(key,{storageKey:key,artifactId:model.artifactId,jobId:model.jobId});
  else if(node.id===shot.generationNodeId)takes.set(key,{storageKey:key});
 }
 if(shot.take&&!takes.has(shot.take.storageKey))takes.set(shot.take.storageKey,shot.take);
 return [...takes.values()];
}

function ShotProgress({nodeId,item}:{nodeId:string;item:ShotBatchItem}){
 const execution=useCanvasComfyExecution(nodeId);
 const live=execution?.runId===item.jobId?execution:undefined;
 const status=live?.status??item.status;
 if(!item.jobId||!isComfyRunActive(status))return null;
 const progress=status==="running"?live?.progress:undefined;
 const value=progress?.value;
 const percent=typeof value==="number"&&Number.isFinite(value)?Math.round(Math.max(0,Math.min(1,value))*100):undefined;
 const label=progress?.nodeName??batchLabels[status]??"任务进行中";
 return <div className="space-y-1 text-xs">
  <div className="flex justify-between gap-2"><span>{label}</span>{percent!==undefined&&
    <span>{progress?.step!=null&&progress?.steps!=null?`${progress.step}/${progress.steps} · `:""}{percent}%</span>}</div>
  <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
   className="h-1.5 overflow-hidden rounded-full bg-[var(--shot-fill)]">
   <div className={`h-full rounded-full bg-[var(--shot-muted)] ${percent===undefined?"w-1/3 motion-safe:animate-pulse":"transition-[width]"}`}
    style={percent===undefined?undefined:{width:`${percent}%`}}/>
  </div>
 </div>;
}

function ShotThumbnail({storageKey,label}:{storageKey?:string;label:string}){
 const [poster,setPoster]=useState<string|undefined>();
 useEffect(()=>{
  setPoster(undefined);
  if(!storageKey)return;
  let active=true;
  const preview=acquireMediaPreview("video",storageKey,"selected");
  void preview.promise.then(url=>{if(active&&url)setPoster(url)}).catch(()=>{});
  return ()=>{active=false;preview.release();};
 },[storageKey]);
 return <div className="grid aspect-video w-20 shrink-0 place-items-center overflow-hidden rounded-lg bg-[var(--shot-fill)] sm:w-24" title={label}>
  {poster?<img src={poster} alt={label} className="h-full w-full object-contain"/>:<Film aria-label={label} className="size-5 opacity-40"/>}
 </div>;
}

export function CanvasShotPanel({title,theme,shots,nodes,editable,busy,checks,items,excluded,onToggle,onClose,onEdit,onCheck,onConfirm,onStop,onSelectOutput,onResume}:{
 theme:CanvasTheme;
 title:string;shots:CanvasShot[];nodes:CanvasNodeData[];editable:boolean;busy:boolean;checks:ShotCheck[];items:ShotBatchItem[];
 onClose:()=>void;onEdit:(shots:CanvasShot[])=>void;onCheck:()=>void;onConfirm:()=>void;onStop:()=>void;
 onSelectOutput:(shotId:string,artifactId:string)=>void;onResume:()=>void;
 excluded:Set<string>;onToggle:(shotId:string,enabled:boolean)=>void;
}){
 const ready=checks.filter(row=>row.state==="ready").length;
 const takeReady=checks.filter(row=>row.state==="takeReady").length;
 const waiting=checks.filter(row=>row.state==="waiting").length;
 const hasPending=items.some(item=>["pending","waiting","choose","ready","blocked"].includes(item.status));
 function edit(index:number,changes:Partial<CanvasShot>){onEdit(shots.map((shot,i)=>i===index?{...shot,...changes}:shot))}
 function move(index:number,offset:number){
  const next=[...shots];[next[index],next[index+offset]]=[next[index+offset],next[index]];onEdit(next);
 }
 const colors=theme.node;
 const surface={background:colors.panel,color:colors.text,"--shot-fill":colors.fill,"--shot-muted":colors.muted,
  "--shot-border":colors.stroke,"--shot-text":colors.text,"--shot-accent":theme.toolbar.activeBg} as CSSProperties;
 const badge={background:colors.fill,color:colors.text,borderColor:colors.stroke};
 return <ConfigProvider theme={{token:{colorBgContainer:colors.panel,colorBgElevated:colors.panel,colorText:colors.text,
  colorTextSecondary:colors.muted,colorTextPlaceholder:colors.placeholder,colorBorder:colors.stroke,colorBorderSecondary:colors.stroke,
  colorPrimary:colors.activeStroke,colorPrimaryHover:theme.toolbar.item,colorPrimaryActive:colors.activeStroke,
  colorTextLightSolid:theme.canvas.background,colorFillSecondary:colors.fill,colorFillTertiary:theme.toolbar.activeBg},
  components:{Button:{primaryColor:theme.canvas.background},Select:{optionSelectedBg:theme.toolbar.activeBg,optionActiveBg:colors.fill}}}}>
 <Drawer title={title} open width={560} onClose={onClose} styles={{section:surface,header:{borderColor:colors.stroke},footer:{borderColor:colors.stroke}}} footer={<div className="space-y-2">
  {checks.length>0&&<p className="mb-0 text-xs opacity-75">{[ready&&`立即提交 ${ready} 镜`,takeReady&&`提取已有成品尾帧 ${takeReady} 镜`,waiting&&`等待前镜生成 ${waiting} 镜`,checks.length-ready-takeReady-waiting>0&&`跳过 ${checks.length-ready-takeReady-waiting} 镜`].filter(Boolean).join(" · ")}</p>}
  <Space wrap>
   <Button loading={busy} onClick={onCheck}>检查镜头</Button>
   <Button type="primary" disabled={busy||ready+takeReady+waiting===0} onClick={onConfirm}>{takeReady&&!ready&&!waiting?
    `提取尾帧并生成 ${takeReady} 镜`:`确认生成 ${ready+takeReady+waiting} 镜`}</Button>
   {hasPending&&<Button disabled={busy} onClick={onStop}>停止后续提交</Button>}
   {items.some(item=>["blocked","failed","cancelled"].includes(item.status))&&<Button disabled={busy} onClick={onResume}>重新检查并继续</Button>}
  </Space>
 </div>}>
  {shots.map((shot,index)=>{
   const node=nodes.find(value=>value.id===shot.generationNodeId),check=checks.find(value=>value.shotId===shot.shotId);
   const item=items.find(value=>value.shotId===shot.shotId),takes=shotTakes(shot,nodes);
   const take=shot.take??(takes.length===1?takes[0]:undefined);
   const generationLabel=item?(batchLabels[item.status]??item.status):takes.length?"已完成":undefined;
   const reason=check?.reason??(item?.reason&&(batchReasons[item.reason]??item.reason));
   const predecessor=index>0?nodes.find(value=>value.id===shots[index-1].generationNodeId):undefined;
   return <section key={shot.shotId} className="mb-3 rounded-xl border border-solid border-[var(--shot-border)] p-3">
    <div className="flex items-start gap-3">
     <ShotThumbnail key={take?.storageKey} storageKey={take?.storageKey} label={take?"当前成品缩略图":"暂无已选成品"}/>
     <div className="min-w-0 flex-1 space-y-2">
      <div className="flex min-h-6 items-start justify-between gap-2">
       <Checkbox disabled={busy} checked={!excluded.has(shot.shotId)} onChange={event=>onToggle(shot.shotId,event.target.checked)}>
        <span className="font-semibold">{index+1}. {node?.title||"节点已移除"}</span>
       </Checkbox>
       <div className="flex flex-wrap justify-end gap-1">
        {generationLabel&&<Tag style={badge} className="m-0">{generationLabel}</Tag>}
         {item?.retryCount&&<Tag style={badge} className="m-0" title={item.retryFromJobId?`上一 Job：${item.retryFromJobId}`:undefined}>重试第 {item.retryCount} 次</Tag>}
        {item&&item.status!=="succeeded"&&takes.length>0&&<Tag style={badge} className="m-0">已有成品</Tag>}
        {check&&<Tag style={{...badge,background:colors.panel,borderColor:check.state==="blocked"?colors.muted:colors.stroke}} className="m-0">{checkLabels[check.state]}</Tag>}
       </div>
      </div>
      {editable&&<div className="flex flex-wrap items-center justify-between gap-2">
       <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select size="small" className="w-28" aria-label="镜头承接方式" value={shot.mode} disabled={busy} onChange={mode=>edit(index,{mode})} options={[
         {value:"independent",label:"独立开场"},{value:"continuity",label:"承接上一镜",disabled:index===0},
        ]}/>
        {takes.length>1&&<Select size="small" className="w-28" aria-label="选定成品" placeholder="选择成品" value={take?.storageKey}
         disabled={busy} onChange={key=>edit(index,{take:takes.find(value=>value.storageKey===key)})}
         options={takes.map((value,i)=>({value:value.storageKey,label:`成品 ${i+1}`,title:value.storageKey}))}/>}
       </div>
       <div className="flex shrink-0 items-center gap-1">
        <Button type="text" size="small" aria-label="上移" title="上移" icon={<ChevronUp className="size-4"/>} disabled={busy||index===0} onClick={()=>move(index,-1)}/>
        <Button type="text" size="small" aria-label="下移" title="下移" icon={<ChevronDown className="size-4"/>} disabled={busy||index===shots.length-1} onClick={()=>move(index,1)}/>
        <Button type="text" size="small" danger aria-label="移除镜头" title="移除镜头" icon={<Trash2 className="size-3.5"/>} disabled={busy} onClick={()=>onEdit(shots.filter(value=>value.shotId!==shot.shotId))}/>
       </div>
      </div>}
      {shot.mode==="continuity"&&<div className="flex min-h-6 items-center gap-2 rounded-md bg-[var(--shot-fill)] px-2 py-1 text-xs text-[var(--shot-muted)]">
       {item?.tail&&<img className="aspect-video w-9 shrink-0 rounded object-contain" alt="接力尾帧" title="接力尾帧" src={canvasCasUrl(`cas:${item.tail.blobId}`)??undefined}/>}
       <span className="min-w-0 truncate" title={predecessor?.title}>{index>0?`接自第 ${index} 镜${predecessor?.title?` · ${predecessor.title}`:""}`:"缺少前镜，请切换为独立开场"}</span>
      </div>}
      {item&&<ShotProgress nodeId={shot.generationNodeId} item={item}/>}
      {reason&&<div className="text-xs">{reason}</div>}
     </div>
    </div>
    {Boolean(item?.choices?.length)&&<div className="mt-3 flex flex-wrap gap-2 border-t border-solid border-[var(--shot-border)] pt-2">{item?.choices?.map((choice,i)=><button type="button" key={choice.artifactId}
     disabled={busy} className="space-y-1 rounded-md border border-solid border-[var(--shot-border)] bg-transparent p-1 text-xs text-inherit hover:bg-[var(--shot-accent)] focus-visible:outline-2 focus-visible:outline-[var(--shot-text)]"
     onClick={()=>onSelectOutput(shot.shotId,choice.artifactId)}>
     <ShotThumbnail storageKey={choice.storageKey} label={`成品 ${i+1} 缩略图`}/><span>使用成品 {i+1}</span>
    </button>)}</div>}
   </section>;
  })}
 </Drawer></ConfigProvider>;
}
