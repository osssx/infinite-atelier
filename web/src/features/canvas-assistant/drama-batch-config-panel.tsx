import {useEffect,useMemo,useRef,useState} from "react";
import {Button} from "antd";
import type {CanvasTheme} from "@/lib/canvas-theme";
import type {CanvasNodeData} from "@/types/canvas";
import {useEffectiveConfig} from "@/stores/use-config-store";
import {applyDramaProduction,type DramaVideoInput,type DramaShotProduction} from "./drama-pipeline-media";
import {auditDramaProduction,dramaMediaModes,type DramaProductionAudit} from "./drama-production-audit";
import {dramaNodeControl,dramaNodePrimary} from "./drama-node-style";
import {DramaInlineFeedback,useDramaFeedback} from "./drama-feedback";
import {dramaVideoFeedback} from "./drama-video-feedback";
import type {DramaBatchCreateResult} from "./drama-video-config";

type Props={
 inputs:DramaVideoInput[];episodes:{id:string;title:string;sequences?:{id:string;title:string}[]}[];
 configs?:ReadonlyMap<string,CanvasNodeData>;missingFor:(input:DramaVideoInput)=>string[];
 disabled:boolean;theme:CanvasTheme;production?:Record<string,DramaShotProduction>;
 productionStyle?:string;confirmedRevisionId?:string;initialEpisodeId?:string;
 onCreateSelected:(inputs:DramaVideoInput[])=>DramaBatchCreateResult|void;onCreateBatch?:(shotIds:string[])=>Promise<void>;
 onLocate?:(shotId:string,episodeId:string)=>void;canLocate?:(shotId:string)=>boolean;
};
type Result={key:string;state:"pending"|"ready"|"failed";error?:string;audit?:DramaProductionAudit;stage?:"audit"|"create"};
const pageSize=15;
const settingFor=(input:DramaVideoInput,production:Record<string,DramaShotProduction>):DramaShotProduction=>
 production[input.shot.id]??{mode:input.referenceImages.length?"omni_reference":"text_to_video"};
const modeFor=(setting:DramaShotProduction)=>setting.gridInput?"grid":setting.mode;
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);

/** Confirmed shots only. No model execution, automatic overwrite or implicit partial creation. */
export function DramaBatchConfigPanel({inputs,episodes,configs,missingFor,disabled,theme,production={},productionStyle,
 confirmedRevisionId,initialEpisodeId,onCreateSelected,onCreateBatch,onLocate,canLocate}:Props){
 const config=useEffectiveConfig();
 const [mode,setMode]=useState<"create"|"group">("create");
 const [episode,setEpisode]=useState(initialEpisodeId??"");
 const [sequence,setSequence]=useState("");
 const [status,setStatus]=useState("all");
 const [page,setPage]=useState(0);
 const [createIds,setCreateIds]=useState<string[]>([]);
 const [groupIds,setGroupIds]=useState<string[]>([]);
 const [results,setResults]=useState<Record<string,Result>>({});
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const feedback=useDramaFeedback()?.api;
 const [summary,setSummary]=useState<{title:string;level:"success"|"warning"|"error";failedIds:string[]}|null>(null);
 const live=useRef(true),running=useRef(false);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 // A result is valid only for the precise confirmed snapshot, production setting,
 // reference requirements and effective channel configuration used for its audit.
 const configKey=JSON.stringify([config,productionStyle,confirmedRevisionId]);
 const rows=useMemo(()=>inputs.map(input=>{
  const setting=settingFor(input,production);
  const missing=setting.mode==="omni_reference"&&!setting.gridInput?missingFor(input):[];
  const key=JSON.stringify([configKey,input,setting,missing]);
  return {input,setting,missing,key,id:input.shot.id,configured:Boolean(configs?.has(input.shot.id))};
 }),[inputs,production,missingFor,configs,configKey]);
 const latest=useRef({rows,disabled,onCreateSelected,onCreateBatch});
 latest.current={rows,disabled,onCreateSelected,onCreateBatch};
 const selected=mode==="create"?createIds:groupIds;
 const setSelected=mode==="create"?setCreateIds:setGroupIds;
 const eligible=(row:typeof rows[number])=>mode==="create"?!row.configured:row.configured;
 const resultFor=(row:typeof rows[number])=>results[row.id]?.key===row.key?results[row.id]:undefined;
 const chosen=rows.filter(row=>eligible(row)&&selected.includes(row.id));
 const passed=chosen.filter(row=>resultFor(row)?.state==="ready"&&resultFor(row)?.audit?.input);
 const failed=chosen.filter(row=>resultFor(row)?.state==="failed");
 const episodeIds=[...new Set(inputs.map(input=>input.shot.episodeId))];
 const activeEpisode=episodeIds.includes(episode)?episode:"";
 const sequenceOptions=Array.from(new Map(rows.filter(row=>!activeEpisode||row.input.shot.episodeId===activeEpisode)
  .flatMap(({input:{shot}})=>shot.sequenceId?[[shot.episodeId+"/"+shot.sequenceId,
   episodes.find(ep=>ep.id===shot.episodeId)?.sequences?.find(seq=>seq.id===shot.sequenceId)?.title??"未命名场次"] as const]:[])).entries());
 const scope=rows.filter(({input:{shot}})=>(!activeEpisode||shot.episodeId===activeEpisode)&&
  (!sequence||(sequence==="unassigned"?!shot.sequenceId:shot.episodeId+"/"+shot.sequenceId===sequence)));
 const filtered=scope.filter(row=>(mode==="create"||row.configured)&&(status==="all"||
  (status==="missing"&&!row.configured)||(status==="configured"&&row.configured)||
  (status==="failed"&&resultFor(row)?.state==="failed")||
  (status==="ready"&&!row.configured&&resultFor(row)?.state==="ready")));
 const pages=Math.max(1,Math.ceil(filtered.length/pageSize)),safePage=Math.min(page,pages-1);
 const visible=filtered.slice(safePage*pageSize,(safePage+1)*pageSize);
 const pageEligible=visible.filter(eligible);
 const scopeEligible=filtered.filter(eligible);
 const setMany=(ids:string[],checked:boolean)=>setSelected(old=>checked?[...new Set([...old,...ids])]:old.filter(id=>!ids.includes(id)));
 const control=dramaNodeControl(theme),card={background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke};
 const muted={color:theme.node.muted};
 const lock=disabled||busy;
 const audit=async()=>{
  if(lock||running.current||!chosen.length)return;
  const task=feedback?.beginTask("正在预检所选镜头",`${chosen.length} 个镜头`,true);
  if(feedback&&!task)return;
  running.current=true;setBusy(true);setError("");setSummary(null);
  const queue=[...chosen];
  let completed=0;const outcomes=new Map<string,Result>();
  task?.phase(`已检查 0 / ${queue.length}`);
  setResults(old=>({...old,...Object.fromEntries(queue.map(row=>[row.id,{key:row.key,state:"pending" as const}]))}));
  let index=0;
  try{
   await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{
    while(live.current&&index<queue.length){
     const row=queue[index++];
     let result:Result;
     try{
      const transformed=applyDramaProduction(row.input,row.setting);
      const output=await auditDramaProduction(transformed,config,{setting:row.setting,missingReferenceIds:row.missing,
       visualStyle:productionStyle,sourceRevisionId:confirmedRevisionId});
      result=output.ready&&output.input?{key:row.key,state:"ready",audit:output}:
       {key:row.key,state:"failed",error:output.error??"媒体输入预检未通过"};
     }catch(e){result={key:row.key,state:"failed",error:errorText(e)};}
     outcomes.set(row.id,result);completed++;task?.phase(`已检查 ${completed} / ${queue.length}`);
     if(live.current)setResults(old=>({...old,[row.id]:result}));
    }
   }));
   if(live.current){
    const valid=queue.filter(row=>latest.current.rows.some(next=>next.id===row.id&&next.key===row.key&&!next.configured));
    const pass=valid.filter(row=>outcomes.get(row.id)?.state==="ready").length;
    const failedIds=valid.filter(row=>outcomes.get(row.id)?.state==="failed").map(row=>row.id);
    const stale=queue.length-valid.length;
    const title=`预检完成：通过 ${pass} 项，失败 ${failedIds.length} 项${stale?`，已变化 ${stale} 项需重新预检`:""}`;
    const level=failedIds.length||stale?"warning":"success";
    setSummary({title,level,failedIds});feedback?.notify("batch-audit",level,title);
   }
  }finally{task?.end();running.current=false;if(live.current)setBusy(false);}
 };
 const create=()=>{
  if(lock||running.current||!passed.length)return;
  const current=latest.current;
  if(current.disabled||passed.some(row=>!current.rows.some(next=>next.id===row.id&&next.key===row.key&&!next.configured))){
   setError("镜头或生产设置已变化，请重新预检。");return;
  }
  try{
   const items=passed.map(row=>resultFor(row)!.audit!.input!);
   setError("");setSummary(null);
   const outcome=current.onCreateSelected(items);
   if(!outcome)throw Error("创建服务未返回结果，请刷新配置列表后检查。");
   const created=new Set(outcome.createdShotIds.filter(id=>passed.some(row=>row.id===id)));
   const failedRows=passed.filter(row=>!created.has(row.id));
   const failureById=new Map(outcome.failures.map(item=>[item.shotId,item.error]));
   setCreateIds(old=>old.filter(id=>!created.has(id)));
   setResults(old=>{
    const next={...old};for(const id of created)delete next[id];
    for(const row of failedRows)next[row.id]={key:row.key,state:"failed",stage:"create",error:failureById.get(row.id)??"未收到创建成功结果，请重新预检"};
    return next;
   });
   const remainingFailures=[...new Set([...failed.map(row=>row.id),...failedRows.map(row=>row.id)])];
   const title=`已创建 ${created.size} 项视频配置，创建失败 ${failedRows.length} 项${failed.length?`，另有 ${failed.length} 项预检未通过`:""}`;
   const level=remainingFailures.length?"warning":"success";
   setSummary({title,level,failedIds:remainingFailures});feedback?.notify("batch-create",level,title);
  }catch(e){setError(errorText(e));}
 };
 const group=async()=>{
  if(lock||running.current||chosen.length<2||!latest.current.onCreateBatch)return;
  const task=feedback?.beginTask("正在组建镜头组",`${chosen.length} 个镜头`,true);
  if(feedback&&!task)return;
  running.current=true;setBusy(true);setError("");setSummary(null);task?.phase("校验视频配置与组建镜头组");
  try{await latest.current.onCreateBatch(chosen.map(row=>row.id));if(live.current){setGroupIds([]);setSummary({title:`已组建 ${chosen.length} 个镜头，等待批量预检`,level:"success",failedIds:[]});}}
  catch(e){if(live.current)setError(errorText(e));}
  finally{task?.end();running.current=false;if(live.current)setBusy(false);}
 };
 if(!rows.length)return <p className="rounded-xl border border-dashed p-4 text-xs" style={control}>确认分镜后可批量创建视频配置。</p>;
 return <section aria-label="批量创建配置" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden text-xs" style={{color:theme.node.text}}>
  <div className="flex shrink-0 flex-wrap items-center gap-2">
   <Button size="small" style={mode==="create"?dramaNodePrimary(theme):control} disabled={lock} onClick={()=>{setMode("create");setStatus("all");setPage(0);setSummary(null);setError("");}}>批量创建视频配置</Button>
   {onCreateBatch&&<Button size="small" style={mode==="group"?dramaNodePrimary(theme):control} disabled={lock} onClick={()=>{setMode("group");setStatus("all");setPage(0);setSummary(null);setError("");}}>组建批量生成镜头组</Button>}
   <span className="ml-auto" style={muted}>仅准备配置，不自动生成媒体</span>
  </div>
  <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
   {[["镜头总数",scope.length],["已配置",scope.filter(r=>r.configured).length],["待创建",scope.filter(r=>!r.configured).length],["操作未通过",scope.filter(r=>resultFor(r)?.state==="failed").length]].map(([label,count])=>
    <div key={label} className="rounded-lg border px-3 py-2" style={card}><div style={muted}>{label}</div><strong className="text-lg tabular-nums">{count}</strong></div>)}
  </div>
  <div className="flex shrink-0 flex-wrap items-center gap-2">
   <select aria-label="批量创建配置剧集" className="rounded-lg border px-2 py-2" style={control} disabled={lock} value={activeEpisode} onChange={e=>{setEpisode(e.target.value);setSequence("");setPage(0);}}>
    <option value="">全部剧集</option>{episodeIds.map(id=><option key={id} value={id}>{episodes.find(ep=>ep.id===id)?.title??"未命名剧集"}</option>)}
   </select>
   <select aria-label="批量配置场次" className="rounded-lg border px-2 py-2" style={control} disabled={lock} value={sequence} onChange={e=>{setSequence(e.target.value);setPage(0);}}>
    <option value="">全部场次</option><option value="unassigned">未指定场次</option>{sequenceOptions.map(([id,title])=><option key={id} value={id}>{title}</option>)}
   </select>
   {mode==="create"&&<select aria-label="批量配置状态" className="rounded-lg border px-2 py-2" style={control} disabled={lock} value={status} onChange={e=>{setStatus(e.target.value);setPage(0);}}>
    <option value="all">全部状态</option><option value="missing">未配置</option><option value="configured">已配置</option><option value="ready">预检通过</option><option value="failed">操作失败</option>
   </select>}
   <Button size="small" style={control} disabled={lock||!scopeEligible.length} onClick={()=>setMany(scopeEligible.map(r=>r.id),true)}>全选筛选结果</Button>
   <Button size="small" style={control} disabled={lock||!selected.length} onClick={()=>setSelected([])}>清空选择</Button>
  </div>
  <div className="thin-scrollbar min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg border" style={{...card,scrollbarColor:theme.node.code.scrollbar+" transparent"}}>
   <table className="w-full min-w-[640px] table-fixed text-left" aria-label="批量镜头列表">
    <thead className="sticky top-0 z-10" style={{background:theme.node.panel}}><tr className="border-b" style={{borderColor:theme.node.stroke}}>
     <th className="w-10 p-2"><input aria-label="选择当前页" type="checkbox" style={{accentColor:theme.node.activeStroke}} disabled={lock||!pageEligible.length}
      checked={pageEligible.length>0&&pageEligible.every(row=>selected.includes(row.id))} onChange={e=>setMany(pageEligible.map(r=>r.id),e.target.checked)}/></th>
     <th className="p-2">镜头 / 场次</th><th className="w-28 p-2">输入模式</th><th className="w-16 p-2">时长</th><th className="w-48 p-2">状态 / 预检</th>
    </tr></thead>
    <tbody>{visible.map(row=>{
     const shot=row.input.shot,result=resultFor(row),ep=episodes.find(item=>item.id===shot.episodeId);
     const title=ep?.sequences?.find(item=>item.id===shot.sequenceId)?.title??"未指定场次";
     return <tr key={row.id} className="border-b align-top" style={{borderColor:theme.node.stroke,background:selected.includes(row.id)?theme.toolbar.activeBg:undefined}}>
      <td className="p-2"><input type="checkbox" aria-label={"选择镜头 "+shot.order+" · "+shot.description} style={{accentColor:theme.node.activeStroke}} disabled={lock||!eligible(row)}
       checked={eligible(row)&&selected.includes(row.id)} onChange={e=>setMany([row.id],e.target.checked)}/></td>
      <td className="min-w-0 p-2"><strong className="block truncate" title={shot.description}>镜头 {shot.order} · {shot.description||"未填写"}</strong><span className="block truncate" style={muted}>{ep?.title??"未命名剧集"} · {title}</span></td>
      <td className="p-2 break-words">{dramaMediaModes.find(item=>item.id===modeFor(row.setting))?.label??modeFor(row.setting)}</td>
      <td className="p-2 tabular-nums">{row.setting.durationSec??shot.durationSec??"—"} 秒</td>
      <td className="p-2 break-words"><span>{result?.state==="failed"?(result.stage==="create"?"创建失败":"预检失败"):row.configured?"已配置":result?.state==="ready"?"预检通过":result?.state==="pending"?"核验中":"待创建"}</span>
       {result?.state==="failed"&&<DramaInlineFeedback theme={theme} level="error">{dramaVideoFeedback(result.error)}</DramaInlineFeedback>}
       {onLocate&&(!canLocate||canLocate(row.id))&&<button type="button" className="mt-1 block underline underline-offset-2 disabled:opacity-40" disabled={lock} onClick={()=>onLocate(row.id,shot.episodeId)}>定位镜头</button>}
      </td>
     </tr>;
    })}{!visible.length&&<tr><td colSpan={5} className="p-6 text-center" style={muted}>没有匹配的镜头</td></tr>}</tbody>
   </table>
  </div>
  <div className="flex shrink-0 flex-wrap items-center justify-between gap-2" style={muted}>
   <span>{filtered.length} 条 · 第 {safePage+1} / {pages} 页 · 每页 {pageSize} 镜</span>
   <div className="flex gap-2"><Button size="small" style={control} disabled={lock||safePage===0} onClick={()=>setPage(safePage-1)}>上一页</Button><Button size="small" style={control} disabled={lock||safePage>=pages-1} onClick={()=>setPage(safePage+1)}>下一页</Button></div>
  </div>
  {error&&<DramaInlineFeedback theme={theme} level="error">{dramaVideoFeedback(error)}</DramaInlineFeedback>}
  {summary&&<div data-drama-batch-result="" className="flex shrink-0 items-center gap-2"><div className="min-w-0 flex-1"><DramaInlineFeedback theme={theme} level={summary.level}>{summary.title}</DramaInlineFeedback></div>{summary.failedIds.length>0&&<Button size="small" style={control} disabled={lock} onClick={()=>{setEpisode("");setSequence("");setStatus("failed");setPage(0);}}>查看失败项</Button>}</div>}
  <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t pt-3" style={{borderColor:theme.node.stroke}}>
   <div><strong>已选 {chosen.length} 镜</strong>{mode==="create"&&<span className="ml-2" style={muted}>通过 {passed.length} · 失败 {failed.length} · 待检 {chosen.length-passed.length-failed.length}</span>}</div>
   <div className="flex flex-wrap gap-2">
    {mode==="create"?<><Button style={control} loading={busy} disabled={lock||!chosen.length} onClick={()=>void audit()}>预检所选镜头</Button>
     <Button style={dramaNodePrimary(theme)} disabled={lock||!passed.length} onClick={create}>创建通过的 {passed.length} 项</Button></>:
     <Button style={dramaNodePrimary(theme)} loading={busy} disabled={lock||chosen.length<2} onClick={()=>void group()}>组建所选镜头并进入批量预检（{chosen.length}）</Button>}
   </div>
  </div>
 </section>;
}
