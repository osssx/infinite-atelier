import {Button, Checkbox, Drawer, Select, Space, Tag} from "antd";
import type {CanvasNodeData, CanvasShot} from "@/types/canvas";
import {canvasCasUrl} from "@/features/backend-sync/canvas-cas";

export type ShotCheck = {shotId:string;state:"ready"|"takeReady"|"waiting"|"choose"|"blocked";reason?:string};
export type ShotBatchItem = {shotId:string;status:string;reason?:string;jobId?:string;tail?:{blobId:string};choices?:Array<{artifactId:string;storageKey?:string}>};

const checkLabels={ready:"可立即提交",takeReady:"前镜已就绪 · 待确认",waiting:"等待前镜生成",choose:"需选择成品",blocked:"需修复"};
const batchLabels:Record<string,string>={pending:"待提交",waiting:"等待前镜",choose:"需选择成品",queued:"已入队",preparing:"准备中",submitting:"提交中",running:"生成中",collecting:"正在收集产物",succeeded:"已完成",failed:"失败",blocked:"已暂停",stopped:"已停止",cancelled:"已取消",submission_unknown:"待核实"};
const batchReasons:Record<string,string>={
 shot_group_changed:"镜头组或承接顺序变化，请重新检查",
 stale_generation_source:"镜头配置或素材变化，请重新检查",
 shot_previous_failed:"前镜失败或提交状态待核实。请先处理前镜任务",
 shot_handoff_artifact_missing:"前镜缺少可用成品，请检查落图状态或选用本地成品",
 shot_handoff_source_changed:"已选用的前镜成品变化，请重新检查",
 backend_prior_job_not_terminal:"此镜头已有活动或待核实任务，请先处理原任务",
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

export function CanvasShotPanel({title,shots,nodes,editable,busy,checks,items,excluded,onToggle,onClose,onEdit,onCheck,onConfirm,onStop,onSelectOutput,onResume}:{
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
 return <Drawer title={title} open width={560} onClose={onClose}>
  <Space wrap className="mb-4">
   <Button loading={busy} onClick={onCheck}>检查镜头</Button>
   <Button type="primary" disabled={busy||ready+takeReady+waiting===0} onClick={onConfirm}>{takeReady&&!ready&&!waiting?
    `提取尾帧并生成 ${takeReady} 镜`:`确认生成 ${ready+takeReady+waiting} 镜`}</Button>
   {hasPending&&<Button disabled={busy} onClick={onStop}>停止后续提交</Button>}
   {items.some(item=>item.status==="blocked")&&<Button disabled={busy} onClick={onResume}>重新检查并继续</Button>}
  </Space>
  {checks.length>0&&<p>{[ready&&`立即提交 ${ready} 镜`,takeReady&&`提取已有成品尾帧 ${takeReady} 镜`,waiting&&`等待前镜生成 ${waiting} 镜`,`跳过 ${checks.length-ready-takeReady-waiting} 镜`].filter(Boolean).join(" · ")}</p>}
  {shots.map((shot,index)=>{
   const node=nodes.find(value=>value.id===shot.generationNodeId),check=checks.find(value=>value.shotId===shot.shotId);
   const item=items.find(value=>value.shotId===shot.shotId),takes=shotTakes(shot,nodes);
   const take=shot.take??(takes.length===1?takes[0]:undefined);
   const generationLabel=item?(batchLabels[item.status]??item.status):takes.length?"已完成":undefined;
   const reason=check?.reason??(item?.reason&&(batchReasons[item.reason]??item.reason));
   return <section key={shot.shotId} className="mb-3 space-y-2 rounded-lg border border-solid border-current/15 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
     <strong><Checkbox disabled={busy} checked={!excluded.has(shot.shotId)} onChange={event=>onToggle(shot.shotId,event.target.checked)}>{index+1}. {node?.title||"节点已移除"}</Checkbox></strong>
     <Space wrap>{generationLabel&&<Tag>{generationLabel}</Tag>}{item&&item.status!=="succeeded"&&takes.length>0&&<Tag>已有成品</Tag>}{check&&<Tag>{checkLabels[check.state]}</Tag>}</Space>
    </div>
    {editable&&<Space wrap>
     <Select aria-label="镜头承接方式" value={shot.mode} disabled={busy} onChange={mode=>edit(index,{mode})} options={[
      {value:"independent",label:"独立开场"},{value:"continuity",label:"承接上一镜",disabled:index===0},
     ]}/>
     <Button disabled={busy||index===0} onClick={()=>move(index,-1)}>上移</Button>
     <Button disabled={busy||index===shots.length-1} onClick={()=>move(index,1)}>下移</Button>
     <Button disabled={busy} onClick={()=>onEdit(shots.filter(value=>value.shotId!==shot.shotId))}>移除</Button>
    </Space>}
    {shot.mode==="continuity"&&<div>前镜 {index>0?nodes.find(value=>value.id===shots[index-1].generationNodeId)?.title||`#${index}`:"缺失，请切换为独立开场"}</div>}
    {editable&&takes.length>1&&<Select aria-label="选定成品" placeholder="选择当前成品" value={take?.storageKey} onChange={key=>edit(index,{take:takes.find(value=>value.storageKey===key)})} options={takes.map((value,i)=>({value:value.storageKey,label:`成品 ${i+1} · ${value.storageKey.slice(4,12)}`}))}/>}
    {take&&<video controls preload="metadata" aria-label="当前成品" className="max-h-32 max-w-full" src={canvasCasUrl(take.storageKey)??undefined}/>}
    {Boolean(item?.choices?.length)&&<div className="flex flex-wrap gap-2">{item?.choices?.map((choice,i)=><div key={choice.artifactId}>
     {choice.storageKey&&<video controls preload="metadata" className="max-h-24 max-w-40" src={canvasCasUrl(choice.storageKey)??undefined}/>}
     <Button disabled={busy} onClick={()=>onSelectOutput(shot.shotId,choice.artifactId)}>使用成品 {i+1}</Button>
    </div>)}</div>}
    {item?.tail&&<img className="max-h-24" alt="接力尾帧" src={canvasCasUrl(`cas:${item.tail.blobId}`)??undefined}/>}
    {reason&&<div>{reason}</div>}
   </section>;
  })}
 </Drawer>;
}
