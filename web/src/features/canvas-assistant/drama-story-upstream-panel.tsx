import {useEffect,useState} from "react";
import {ArrowDownToLine,ChevronDown,GitCompareArrows,RefreshCw} from "lucide-react";
import {canvasThemes} from "@/lib/canvas-theme";
import type {StoryTextSource,StoryTextSync} from "./drama-story-upstream";
import {storySourceParagraphChanges,storySourceState,storyTextDigest} from "./drama-story-upstream";

export function DramaStoryUpstreamPanel({sources,sync,draft,blocked,onApply,theme}:{
 sources:readonly StoryTextSource[];sync?:StoryTextSync;draft:string;blocked:boolean;
 onApply:(source:StoryTextSource,mode:"replace"|"append")=>Promise<boolean>;
 theme:(typeof canvasThemes)[keyof typeof canvasThemes];
}){
 const [chosen,setChosen]=useState("");
 const [details,setDetails]=useState(false);
 const [compare,setCompare]=useState(false);
 useEffect(()=>{if(!sources.length){setCompare(false);setDetails(false);}},[sources.length]);
 const primary=sources.find(item=>item.nodeId===sync?.nodeId&&item.edgeId===sync?.edgeId);
 const selected=sources.find(item=>item.edgeId===chosen)??primary??sources[0];
 const status=storySourceState(sources,sync);
 const changed=selected&&(!sync||sync.edgeId!==selected.edgeId||
  sync.nodeId!==selected.nodeId||selected.digest!==sync.digest);
 if(!sources.length&&!sync)return null;
 const compareStats=compare&&selected?storySourceParagraphChanges(draft,selected.content):null;
 const fieldStyle={background:theme.node.fill,color:theme.node.text,borderColor:theme.node.stroke};
 const action="inline-flex min-h-7 shrink-0 items-center justify-center gap-1 rounded-md border px-2.5 text-[11px] font-medium transition-opacity hover:opacity-80 disabled:opacity-40";
 const statusLabel=({none:"未连接来源",available:"可导入新来源",current:"上游已同步",
  updated:"上游文本有更新",disconnected:"已同步来源断开",replaced:"原同步来源已替换",
  multiple:"检测到多个上游文本，请选择"} as const)[status];
 const edited=!!sync&&storyTextDigest(draft)!==sync.baselineDigest;
 const allow=Boolean(selected?.content.trim())&&!blocked;
 return <section data-story-upstream-panel="" className="shrink-0 overflow-hidden rounded-lg border"
  style={{borderColor:theme.node.stroke,background:theme.node.panel,color:theme.node.text}}>
  <div data-story-upstream-compact="" className="flex min-h-9 min-w-0 flex-wrap items-center gap-1.5 px-2.5 py-1 sm:flex-nowrap">
   <strong className="shrink-0 text-xs">上游同步</strong>
   <span role="status" className="min-w-0 flex-1 truncate text-[11px]" style={{color:theme.node.muted}}
    title={statusLabel+(selected?" · "+selected.title:status==="disconnected"?" · 当前草案已保留":"")}>
    {statusLabel}{status==="disconnected"?" · 草案已保留":selected?" · "+selected.title:""}{edited?" · 草案已编辑":""}
   </span>
   {selected&&<div className="order-3 flex w-full shrink-0 items-center gap-1 sm:order-none sm:w-auto">
    <button type="button" className={action} style={fieldStyle} disabled={!selected.content.trim()}
     onClick={()=>{setCompare(value=>!value);setDetails(false);}}>
     <GitCompareArrows size={12} aria-hidden="true"/>{compare?"收起比较":"比较差异"}</button>
    <button type="button" className={action} style={fieldStyle} disabled={!allow}
     onClick={()=>void onApply(selected,"append").then(ok=>{if(ok)setCompare(false);})}>
     <ArrowDownToLine size={12} aria-hidden="true"/>追加草案</button>
    <button type="button" className={action} style={fieldStyle} disabled={!allow}
     onClick={()=>{setCompare(true);setDetails(false);}}>
     <RefreshCw size={12} aria-hidden="true"/>刷新草案</button>
   </div>}
   <button type="button" className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] hover:opacity-80"
    aria-label="同步详情" aria-expanded={details} style={{color:theme.node.muted}}
    onClick={()=>setDetails(value=>!value)}>
    <ChevronDown size={13} className={details?"rotate-180 transition-transform":"transition-transform"} aria-hidden="true"/>
    <span className="hidden sm:inline">详情</span>
   </button>
  </div>
  {(details||compare)&&<div data-story-upstream-details=""
   className="space-y-2 border-t px-2.5 py-2" style={{borderColor:theme.node.stroke}}>
   {sources.length>1&&<label className="flex items-center gap-2 text-xs">
    来源文本
    <select aria-label="选择故事上游文本" className="min-w-0 max-w-full flex-1 rounded-md border px-2 py-1.5"
     style={fieldStyle} value={selected?.edgeId??""} onChange={event=>{setChosen(event.target.value);setCompare(false);}}>
     {sources.map(item=><option key={item.edgeId} value={item.edgeId}>{item.title} · {item.nodeId}</option>)}
    </select>
   </label>}
   {details&&<p className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>
    {status==="disconnected"?"原同步来源已断开，当前故事内容保持不变。":
     selected?"来源："+selected.title+" · "+selected.content.length+" 字符。":"来源未连接。"}
    {" "}已确认故事版本不受同步影响。
    {changed?" 上游有尚未导入的内容，可先比较差异后刷新。":""}
    {edited?" 当前草案在上次同步后有修改，同步时不会自动合并本地改写。":""}
   </p>}
   {blocked&&selected&&<p role="alert" className="text-[11px]" style={{color:theme.node.muted}}>
    请先保存当前故事编辑或处理 AI 候选，再刷新上游内容。
   </p>}
   {compare&&selected&&<div data-story-upstream-compare="" className="space-y-2">
    <p className="text-[11px]" style={{color:theme.node.muted}}>
     当前草案 {compareStats?.currentParagraphs} 段 · 来源 {compareStats?.incomingParagraphs} 段 ·
     同位置差异约 {compareStats?.changedParagraphs} 段
    </p>
    <div className="grid gap-2 md:grid-cols-2">
     <label className="grid min-w-0 gap-1 text-xs">当前故事草案
      <textarea aria-label="当前故事对比正文" readOnly value={draft} rows={4}
       className="min-w-0 max-h-48 resize-y rounded-md border p-2 text-xs leading-5" style={fieldStyle}/></label>
     <label className="grid min-w-0 gap-1 text-xs">上游文本内容
      <textarea aria-label="上游文本对比正文" readOnly value={selected.content} rows={4}
       className="min-w-0 max-h-48 resize-y rounded-md border p-2 text-xs leading-5" style={fieldStyle}/></label>
    </div>
    <div className="flex flex-wrap items-center justify-end gap-2">
     <span className="mr-auto text-[11px]" style={{color:theme.node.muted}}>确认版本和下游内容保持不变</span>
     <button type="button" className={action} style={fieldStyle} onClick={()=>setCompare(false)}>取消</button>
     <button type="button" className={action} style={fieldStyle} disabled={!allow}
      onClick={()=>void onApply(selected,"replace").then(ok=>{if(ok)setCompare(false);})}>用上游替换当前草案</button>
    </div>
   </div>}
  </div>}
 </section>;
}
