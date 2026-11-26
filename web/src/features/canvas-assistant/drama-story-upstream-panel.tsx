import {useLayoutEffect,useRef,useState} from "react";
import {ArrowDownToLine,ArrowLeft,Copy,FileText,GitCompareArrows,RefreshCw} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import type {StoryTextSource,StoryTextSync,StorySourceComparison,StorySyncMode} from "./drama-story-upstream";
import {createStorySourceComparison,readableStoryLabels,storySourceComparisonIssue,storySourceParagraphChanges,
 storySourceLabels,storySourceState,storyTextDigest,storyTextSyncPatch} from "./drama-story-upstream";

type ReviewMode=StorySyncMode|"compare";
type SourceReview={compare:StorySourceComparison;mode:ReviewMode;label:string};

/** Only the history page mounts a writable source controller. The preview owns a frozen
 * draft and source so that external changes never silently change what the user approves. */
export function DramaStoryUpstreamPanel({sources,sync,draft,blocked,onApply,theme,onReviewChange,wideReview=true,error=""}:{
 sources:readonly StoryTextSource[];sync?:StoryTextSync;draft:string;blocked:boolean;
 onApply:(compare:StorySourceComparison,mode:StorySyncMode)=>Promise<boolean>;
 theme:CanvasTheme;onReviewChange?:(active:boolean)=>void;wideReview?:boolean;error?:string;
}){
 const [chosen,setChosen]=useState("");
 const [review,setReview]=useState<SourceReview|null>(null);
 const [appendSource,setAppendSource]=useState(false);
 const [copyStatus,setCopyStatus]=useState("");
 const panel=useRef<HTMLElement>(null),heading=useRef<HTMLHeadingElement>(null),opener=useRef<ReviewMode|null>(null);
 const reviewOpen=!!review;
 useLayoutEffect(()=>{
  if(reviewOpen)heading.current?.focus();
  else if(opener.current){panel.current?.querySelector<HTMLButtonElement>(`[data-source-review-entry="${opener.current}"]`)?.focus();opener.current=null;}
 },[reviewOpen]);
 const primary=sources.find(item=>item.nodeId===sync?.nodeId&&item.edgeId===sync?.edgeId);
 const selected=sources.length===1?sources[0]:chosen?sources.find(item=>item.edgeId===chosen):primary;
 const labels=readableStoryLabels(sources);
 const selectedLabel=selected?labels[sources.indexOf(selected)]:"";
 const issue=review?storySourceComparisonIssue(review.compare,draft,sources,sync):"";
 const edited=!!sync&&storyTextDigest(draft)!==sync.baselineDigest;
 const allow=!!selected?.content.trim()&&!blocked;
 const refreshedSource=review?sources.find(source=>source.nodeId===review.compare.source.nodeId&&source.edgeId===review.compare.source.edgeId):undefined;
 const refreshReview=()=>{
  if(!review||blocked||!refreshedSource?.content.trim())return;
  setReview({compare:createStorySourceComparison(draft,refreshedSource,sync),mode:review.mode,label:labels[sources.indexOf(refreshedSource)]});
  setAppendSource(false);setCopyStatus("");
 };
 const open=(mode:ReviewMode)=>{
  if(!allow||!selected)return;
  if(!review){opener.current=mode;onReviewChange?.(true);}
  setReview({compare:createStorySourceComparison(draft,selected,sync),mode,label:selectedLabel});
  setAppendSource(false);setCopyStatus("");
 };
 const close=()=>{setReview(null);setCopyStatus("");onReviewChange?.(false);};
 const setMode=(mode:StorySyncMode)=>{
  if(!review||issue||blocked)return;
  setReview({...review,mode});setAppendSource(false);setCopyStatus("");
 };
 const control={background:theme.node.fill,color:theme.node.text,borderColor:theme.node.stroke};
 const action="inline-flex min-h-8 items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-40";
 const state=storySourceState(sources,sync);
 const selectedState=selected&&(sources.length===1?state:primary===selected?(selected.digest===sync?.digest?"current":"updated"):"available");
 const compare=review?.compare;
 const stats=compare?storySourceParagraphChanges(compare.draft,compare.source.content):null;
 const copy=async(text:string)=>{
  try{await navigator.clipboard.writeText(text);setCopyStatus("已复制正文");}
  catch{setCopyStatus("复制失败，可选中正文手动复制。");}
 };
 const textPanel=(name:string,label:string,value:string,hidden=false)=><div className={`flex min-h-0 min-w-0 flex-col gap-1.5 ${wideReview?"flex-1":"shrink-0"}`} style={{display:hidden?"none":undefined}}>
  <div className="flex shrink-0 items-center justify-between gap-2">
   <label className="text-xs font-medium">{name}</label>
   <button type="button" aria-label={"复制"+name} title={"复制"+name} className="rounded p-1 hover:opacity-70" style={{color:theme.node.muted}} onClick={()=>void copy(value)}><Copy size={14}/></button>
  </div>
  <textarea aria-label={label} readOnly value={value} rows={8}
   className={`thin-scrollbar w-full min-w-0 resize-none rounded-lg border p-3 text-sm leading-6 ${wideReview?"min-h-0 flex-1":"h-[220px] shrink-0"}`}
   style={control}/>
 </div>;
 if(review&&compare)return <section ref={panel} data-story-upstream-panel="" data-story-upstream-compare="" data-source-review-mode={review.mode}
  className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 rounded-lg border p-3"
  style={{borderColor:theme.node.stroke,background:theme.node.panel,color:theme.node.text}}>
  <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2" data-story-upstream-details="">
   <button type="button" aria-label="返回来源与影响" className={action} style={control} disabled={blocked} onClick={close}><ArrowLeft size={14}/>返回</button>
   <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold focus:outline-none">{review.mode==="compare"?"比较差异":review.mode==="append"?"追加预览":"替换预览"}</h3>
   <span className="min-w-0 truncate text-xs" title={review.label} style={{color:theme.node.muted}}>{review.label}</span>
   <span className="text-[11px] sm:ml-auto" style={{color:theme.node.muted}}>当前 {stats?.currentParagraphs} 段 · 来源 {stats?.incomingParagraphs} 段 · 同位置差异约 {stats?.changedParagraphs} 段</span>
  </div>
  <div data-story-review-body="" className={`thin-scrollbar min-h-0 min-w-0 flex-1 gap-3 ${wideReview?"grid grid-cols-2 grid-rows-[minmax(0,1fr)] overflow-hidden":"flex flex-col overflow-y-auto overscroll-contain"}`}>
   {textPanel("当前故事草案","当前故事对比正文",compare.draft)}
   <div className={`flex min-h-0 min-w-0 flex-col gap-2 ${wideReview?"":"shrink-0"}`}>
    {review.mode==="append"&&<div role="group" aria-label="追加预览内容" className="flex shrink-0 gap-1">
     <button type="button" className={action} style={appendSource?control:{...control,background:theme.toolbar.activeBg}} aria-pressed={!appendSource} onClick={()=>setAppendSource(false)}>操作后草案</button>
     <button type="button" className={action} style={appendSource?{...control,background:theme.toolbar.activeBg}:control} aria-pressed={appendSource} onClick={()=>setAppendSource(true)}>上游文本</button>
    </div>}
    <div className={`flex min-h-0 min-w-0 flex-col ${wideReview?"flex-1":"shrink-0"}`}>
     {textPanel(review.mode==="replace"?"替换后的草案预览":"上游文本","上游文本对比正文",compare.source.content,review.mode==="append"&&!appendSource)}
     {review.mode==="append"&&textPanel("追加后的草案预览","追加草案预览",storyTextSyncPatch(compare.source,"append",compare.draft).dramaDraft??"",appendSource)}
    </div>
   </div>
  </div>
  <div className="shrink-0 space-y-2 border-t pt-2" style={{borderColor:theme.node.stroke}}>
   {issue&&<p role="alert" className="break-words rounded border p-1.5 text-xs" style={control}>{issue}。当前比较内容仍保留。{!refreshedSource?.content.trim()?" 原来源已断开或为空，请返回重新选择。":""}</p>}
   {error&&<p role="alert" className="break-words rounded border p-1.5 text-xs" style={control}>{error}</p>}
   {copyStatus&&<p role="status" className="text-xs" style={{color:theme.node.muted}}>{copyStatus}</p>}
   <p className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>
    {review.mode==="compare"?"仅查看比较内容；追加或替换需单独预览与确认。":review.mode==="replace"?"替换非空且不同的草案前先保存恢复备份。":"追加保留原有正文，并把所选文本放到文末。"} 已确认故事和下游内容不变。
   </p>
   <div className="flex flex-wrap items-center justify-end gap-1.5">
    <button type="button" className={action} style={control} disabled={blocked} onClick={close}>取消</button>
    {issue?<button type="button" className={action} style={control} disabled={blocked||!refreshedSource?.content.trim()} onClick={refreshReview}>重新比较</button>:
     review.mode==="compare"?<>
      <button type="button" className={action} style={control} disabled={blocked} onClick={()=>setMode("append")}>追加预览</button>
      <button type="button" className={action} style={control} disabled={blocked} onClick={()=>setMode("replace")}>替换预览</button>
     </>:<button type="button" className={action+" font-semibold"} style={{...control,background:theme.node.text,color:theme.node.panel}}
      disabled={blocked||!compare.source.content.trim()} onClick={()=>void onApply(compare,review.mode as StorySyncMode).then(ok=>{if(ok)close();})}>
      {review.mode==="append"?"追加到当前草案":"用上游替换当前草案"}</button>}
   </div>
  </div>
 </section>;
 return <section ref={panel} data-story-upstream-panel="" className="min-w-0 space-y-2.5 rounded-lg border p-3"
  style={{borderColor:theme.node.stroke,background:theme.node.panel,color:theme.node.text}}>
  <div className="flex items-center justify-between gap-1.5">
   <strong className="text-xs">文本来源</strong>
   <span className="shrink-0 text-[11px]" style={{color:theme.node.muted}}>{sources.length} 条</span>
  </div>
  {!sources.length?<div role="status" data-story-upstream-compact="" className="space-y-1 text-[11px] leading-relaxed" style={{color:theme.node.muted}}>
   <p>{storySourceLabels[state]}</p>
   <p>{sync?"原来源已断开，故事草案和已确认版本均已保留。":"暂无关联上游文本，可在画布连接文本节点。"}</p>
  </div>:<>
   {sources.length>1&&<label className="grid min-w-0 gap-1 text-xs">
    <span style={{color:theme.node.muted}}>选择来源文本</span>
    <select aria-label="选择故事上游文本" className="min-w-0 w-full rounded-md border px-2 py-1.5"
     style={control} value={selected?.edgeId??""} disabled={blocked} onChange={event=>setChosen(event.target.value)}>
     <option value="" disabled>请选择来源</option>
     {sources.map((item,index)=><option key={item.edgeId} value={item.edgeId}>{labels[index]}{item.edgeId===primary?.edgeId?" · 上次同步":""}</option>)}
    </select>
   </label>}
   {selected&&selectedState?<div data-story-upstream-compact="" role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1">
    {sources.length===1&&<div className="flex min-w-0 flex-1 items-center gap-1.5"><FileText size={15} className="shrink-0" style={{color:theme.node.muted}}/><span className="truncate text-xs font-medium" title={selectedLabel}>{selectedLabel}</span></div>}
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]" style={{borderColor:theme.node.stroke,color:theme.node.text}}><span aria-hidden="true" className={"size-1.5 shrink-0 rounded-full "+(selectedState==="current"?"bg-emerald-500":selectedState==="updated"||selectedState==="replaced"?"bg-amber-500":"bg-stone-400")}/>{storySourceLabels[selectedState]}</span>
    <span className="text-[11px]" style={{color:theme.node.muted}}>{selected.content.length} 字符{!selected.content.trim()?" · 暂无内容":""}</span>
   </div>:<p data-story-upstream-compact="" role="status" className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>请明确选择要比较的文本，不自动合并多个来源。</p>}
   {edited&&<p className="text-[11px]" style={{color:theme.node.muted}}>草案已编辑</p>}
   <div className="flex flex-wrap gap-1.5">
    <button type="button" data-source-review-entry="compare" className={action+" flex-1"} style={control} disabled={!allow} onClick={()=>open("compare")}><GitCompareArrows size={12} aria-hidden="true"/>比较差异</button>
    <button type="button" data-source-review-entry="append" className={action+" flex-1"} style={control} disabled={!allow} onClick={()=>open("append")}><ArrowDownToLine size={12} aria-hidden="true"/>追加预览</button>
    <button type="button" data-source-review-entry="replace" className={action+" flex-1"} style={control} disabled={!allow} onClick={()=>open("replace")}><RefreshCw size={12} aria-hidden="true"/>替换预览</button>
   </div>
  </>}
  {blocked&&<p role="status" className="text-[11px]" style={{color:theme.node.muted}}>当前操作尚未完成，暂不能修改草案。</p>}
 </section>;
}