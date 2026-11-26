import {useState} from "react";
import {ArrowDownToLine,GitCompareArrows,RefreshCw} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import type {StoryTextSource,StoryTextSync,StorySourceComparison,StorySyncMode} from "./drama-story-upstream";
import {createStorySourceComparison,readableStoryLabels,storySourceComparisonIssue,storySourceParagraphChanges,
 storySourceSummary,storyTextDigest,storyTextSyncPatch} from "./drama-story-upstream";

/** Only the history page mounts a writable source controller. The preview owns a frozen
 * draft and source so that external changes never silently change what the user approves. */
export function DramaStoryUpstreamPanel({sources,sync,draft,blocked,onApply,theme}:{
 sources:readonly StoryTextSource[];sync?:StoryTextSync;draft:string;blocked:boolean;
 onApply:(compare:StorySourceComparison,mode:StorySyncMode)=>Promise<boolean>;
 theme:CanvasTheme;
}){
 const [chosen,setChosen]=useState("");
 const [review,setReview]=useState<{compare:StorySourceComparison;mode:StorySyncMode;label:string}|null>(null);
 const primary=sources.find(item=>item.nodeId===sync?.nodeId&&item.edgeId===sync?.edgeId);
 const selected=sources.length===1?sources[0]:chosen?sources.find(item=>item.edgeId===chosen):primary;
 const labels=readableStoryLabels(sources);
 const issue=review?storySourceComparisonIssue(review.compare,draft,sources,sync):"";
 const edited=!!sync&&storyTextDigest(draft)!==sync.baselineDigest;
 const allow=!!selected?.content.trim()&&!blocked;
 const open=(mode:StorySyncMode)=>{if(selected?.content.trim())setReview({compare:createStorySourceComparison(draft,selected,sync),mode,label:labels[sources.indexOf(selected)]});};
 const control={background:theme.node.fill,color:theme.node.text,borderColor:theme.node.stroke};
 const action="inline-flex min-h-7 items-center justify-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-opacity hover:opacity-80 disabled:opacity-40";
 const summary=storySourceSummary(sources,sync);
 const compare=review?.compare;
 const stats=compare?storySourceParagraphChanges(compare.draft,compare.source.content):null;
 return <section data-story-upstream-panel="" className="min-w-0 space-y-2 rounded-lg border p-2.5"
  style={{borderColor:theme.node.stroke,background:theme.node.panel,color:theme.node.text}}>
  <div className="flex items-center justify-between gap-1.5">
   <strong className="text-xs">文本来源与同步</strong>
   <span className="shrink-0 text-[11px]" style={{color:theme.node.muted}}>{sources.length} 条</span>
  </div>
  <div data-story-upstream-compact="" role="status" className="break-words text-[11px] leading-relaxed" style={{color:theme.node.muted}}>{summary}{edited?" · 草案已编辑":""}</div>
  {!sources.length?<p className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>
   {sync?"原来源已断开，故事草案和已确认版本均已保留。":"暂无关联上游文本，可在画布连接文本节点。"}
  </p>:<>
   {sources.length>1?<label className="grid min-w-0 gap-1 text-xs">
    选择来源文本
    <select aria-label="选择故事上游文本" className="min-w-0 w-full rounded-md border px-2 py-1.5"
     style={control} value={selected?.edgeId??""} disabled={blocked}
     onChange={event=>{setChosen(event.target.value);setReview(null);}}>
     <option value="" disabled>请选择来源</option>
     {sources.map((item,index)=><option key={item.edgeId} value={item.edgeId}>{labels[index]}{item.edgeId===primary?.edgeId?" · 上次同步":""}</option>)}
    </select>
   </label>:null}
   {selected?<p className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>
    {labels[sources.indexOf(selected)]} · {selected.content.length} 字符{!selected.content.trim()?" · 暂无内容":""}
   </p>:<p className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>请明确选择要比较的文本，不自动合并多个来源。</p>}
   <div className="grid grid-cols-2 gap-1.5">
    <button type="button" className={action+" col-span-2"} style={control} disabled={!selected?.content.trim()||blocked}
     onClick={()=>open("replace")}><GitCompareArrows size={12} aria-hidden="true"/>比较差异</button>
    <button type="button" className={action} style={control} disabled={!allow} onClick={()=>open("append")}>
     <ArrowDownToLine size={12} aria-hidden="true"/>追加预览</button>
    <button type="button" className={action} style={control} disabled={!allow} onClick={()=>open("replace")}>
     <RefreshCw size={12} aria-hidden="true"/>替换预览</button>
   </div>
  </>}
  {blocked&&<p role="status" className="text-[11px]" style={{color:theme.node.muted}}>当前操作尚未完成，暂不能修改草案。</p>}
  {review&&compare&&<div data-story-upstream-compare="" className="min-w-0 space-y-2 border-t pt-2" style={{borderColor:theme.node.stroke}}>
   <div data-story-upstream-details="" className="space-y-1">
    <strong className="text-xs">{review.mode==="append"?"追加到草案":"替换草案"} · {review.label}</strong>
    <p className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>当前 {stats?.currentParagraphs} 段 · 来源 {stats?.incomingParagraphs} 段 · 同位置差异约 {stats?.changedParagraphs} 段</p>
   </div>
   <label className="grid min-w-0 gap-1 text-xs">比较时的故事草案
    <textarea aria-label="当前故事对比正文" readOnly value={compare.draft} rows={4}
     className="thin-scrollbar min-w-0 w-full max-h-48 resize-y rounded-md border p-2 text-xs leading-5" style={control}/></label>
   <label className="grid min-w-0 gap-1 text-xs">比较时的上游文本
    <textarea aria-label="上游文本对比正文" readOnly value={compare.source.content} rows={4}
     className="thin-scrollbar min-w-0 w-full max-h-48 resize-y rounded-md border p-2 text-xs leading-5" style={control}/></label>
   {review.mode==="append"&&<label className="grid min-w-0 gap-1 text-xs">追加后的草案预览
    <textarea aria-label="追加草案预览" readOnly value={storyTextSyncPatch(compare.source,"append",compare.draft).dramaDraft} rows={4}
     className="thin-scrollbar min-w-0 w-full max-h-48 resize-y rounded-md border p-2 text-xs leading-5" style={control}/></label>}
   {issue&&<p role="alert" className="break-words rounded border p-1.5 text-[11px]" style={control}>{issue}。当前比较内容仍保留。</p>}
   <p className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>
    {review.mode==="replace"?"替换非空且不同的草案前先保存恢复备份。":"追加保留原有正文，并把所选文本放到文末。"} 已确认故事和下游内容不变。
   </p>
   <div className="flex flex-wrap items-center justify-end gap-1.5">
    <button type="button" className={action} style={control} disabled={blocked} onClick={()=>setReview(null)}>取消</button>
    {issue?<button type="button" className={action} style={control} disabled={!allow} onClick={()=>open(review.mode)}>重新比较</button>:
     <button type="button" className={action+" font-semibold"} style={{...control,background:theme.node.text,color:theme.node.panel}}
      disabled={blocked||!compare.source.content.trim()} onClick={()=>void onApply(compare,review.mode).then(ok=>{if(ok)setReview(null);})}>
      {review.mode==="append"?"追加到当前草案":"用上游替换当前草案"}</button>}
   </div>
  </div>}
 </section>;
}
