import {useState} from "react";
import {ArrowDownToLine,GitCompareArrows,RefreshCw} from "lucide-react";
import {canvasThemes} from "@/lib/canvas-theme";
import type {StoryTextSource,StoryTextSync} from "./drama-story-upstream";
import {storySourceParagraphChanges,storySourceState,storyTextDigest} from "./drama-story-upstream";

export function DramaStoryUpstreamPanel({sources,sync,draft,blocked,onApply,theme}:{
 sources:readonly StoryTextSource[];sync?:StoryTextSync;draft:string;blocked:boolean;
 onApply:(source:StoryTextSource,mode:"replace"|"append")=>Promise<boolean>;
 theme:(typeof canvasThemes)[keyof typeof canvasThemes];
}){
 const [chosen,setChosen]=useState("");
 const [compare,setCompare]=useState(false);
 const primary=sources.find(item=>item.nodeId===sync?.nodeId&&item.edgeId===sync?.edgeId);
 const selected=sources.find(item=>item.edgeId===chosen)??primary??sources[0];
 const status=storySourceState(sources,sync);
 const changed=selected&&(!sync||sync.edgeId!==selected.edgeId||
  sync.nodeId!==selected.nodeId||selected.digest!==sync.digest);
 if(!sources.length&&!sync)return null;
 const compareStats=selected?storySourceParagraphChanges(draft,selected.content):null;
 const fieldStyle={background:theme.node.fill,color:theme.node.text,borderColor:theme.node.stroke};
 const action="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium disabled:opacity-40";
 const statusLabel=({none:"未连接来源",available:"可导入新来源",current:"上游已同步",
  updated:"上游文本有更新",disconnected:"已同步来源断开",replaced:"原同步来源已替换",
  multiple:"检测到多个上游文本，请选择"} as const)[status];
 const allow=Boolean(selected?.content.trim())&&!blocked;
 return <section data-story-upstream-panel="" className="shrink-0 space-y-2 rounded-xl border p-3"
  style={{borderColor:theme.node.stroke,background:theme.node.panel,color:theme.node.text}}>
  <div className="flex flex-wrap items-center justify-between gap-2">
   <div className="min-w-0">
    <strong className="text-sm">上游文本同步</strong>
    <p role="status" className="mt-1 text-xs" style={{color:theme.node.muted}}>{statusLabel} · 已确认故事版本不会受刷新影响</p>
   </div>
   <div className="flex flex-wrap gap-2">
    {selected&&<button type="button" className={action} style={fieldStyle}
      disabled={!selected.content.trim()} onClick={()=>setCompare(value=>!value)}>
      <GitCompareArrows size={13} aria-hidden="true"/>{compare?"收起比较":"比较差异"}</button>}
    {selected&&<button type="button" className={action} style={fieldStyle}
      disabled={!allow} onClick={()=>void onApply(selected,"append").then(ok=>{if(ok)setCompare(false);})}>
      <ArrowDownToLine size={13} aria-hidden="true"/>追加草案</button>}
    {selected&&<button type="button" className={action} style={fieldStyle}
      disabled={!allow} onClick={()=>setCompare(true)}>
      <RefreshCw size={13} aria-hidden="true"/>刷新草案</button>}
   </div>
  </div>
  {sources.length>1?<label className="flex items-center gap-2 text-xs">
   来源文本
   <select aria-label="选择故事上游文本" className="min-w-0 max-w-full flex-1 rounded-lg border p-2"
    style={fieldStyle} value={selected?.edgeId??""} onChange={event=>{setChosen(event.target.value);setCompare(false);}}>
    {sources.map(item=><option key={item.edgeId} value={item.edgeId}>{item.title} · {item.nodeId}</option>)}
   </select>
  </label>:<p className="text-xs" style={{color:theme.node.muted}}>
   {selected?("连接来源："+selected.title+" · "+selected.content.length+" 字符"):"原同步来源已断开，当前故事内容保持不变"}
  </p>}
  {changed&&!compare&&<p className="text-xs" style={{color:theme.node.muted}}>
   发现尚未导入的上游内容。可以先比较差异，或追加到草案。确认版本仍独立保留。
  </p>}
  {!!sync&&storyTextDigest(draft)!==sync.baselineDigest&&<p className="text-xs" style={{color:theme.node.muted}}>
   当前草案已在上次同步后被修改；同步操作不会自动合并本地改写。
  </p>}
  {blocked&&selected&&<p role="alert" className="text-xs" style={{color:theme.node.muted}}>
   请先保存当前故事编辑或处理 AI 候选，再刷新上游内容，避免覆盖未保存的修改。
  </p>}
  {compare&&selected&&<div data-story-upstream-compare="" className="space-y-2 border-t pt-2"
   style={{borderColor:theme.node.stroke}}>
   <p className="text-xs" style={{color:theme.node.muted}}>
    当前草案 {compareStats?.currentParagraphs} 段 · 来源 {compareStats?.incomingParagraphs} 段 ·
    同位置差异约 {compareStats?.changedParagraphs} 段
   </p>
   <div className="grid gap-2 md:grid-cols-2">
    <label className="grid min-w-0 gap-1 text-xs">当前故事草案
     <textarea aria-label="当前故事对比正文" readOnly value={draft} rows={6}
      className="min-w-0 resize-y rounded-lg border p-2 text-xs leading-6" style={fieldStyle}/></label>
    <label className="grid min-w-0 gap-1 text-xs">上游文本内容
     <textarea aria-label="上游文本对比正文" readOnly value={selected.content} rows={6}
      className="min-w-0 resize-y rounded-lg border p-2 text-xs leading-6" style={fieldStyle}/></label>
   </div>
   <div className="flex flex-wrap items-center justify-end gap-2">
    <button type="button" className={action} style={fieldStyle} onClick={()=>setCompare(false)}>取消</button>
    <button type="button" className={action} style={fieldStyle} disabled={!allow}
     onClick={()=>void onApply(selected,"replace").then(ok=>{if(ok)setCompare(false);})}>用上游替换当前草案</button>
   </div>
   <p className="text-xs" style={{color:theme.node.muted}}>
    只替换未确认草案，不会删除已确认版本、历史版本或下游已有内容。
   </p>
  </div>}
 </section>;
}
