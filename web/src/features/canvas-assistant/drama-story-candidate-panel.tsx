import {useEffect,useRef} from "react";
import {Copy,Pencil} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import {DramaEditActions} from "./drama-edit-actions";
import {storyAssistLabels,storyCandidateComparison,storyTargetLabel,
 type StoryCandidateTarget,type StoryContinuationScope} from "./drama-story-editor-utils";

export type StoryCandidate={target:StoryCandidateTarget;text:string;sourceBaseline:string;sourceContext:string;continuationScope?:StoryContinuationScope};

export function DramaStoryCandidatePanel({candidate,theme,stale,locked,editBuffer,closeIntent,onEdit,onChange,onConfirmEdit,onCancelEdit,onCopy,onAdopt,onDiscard,onContinueViewing}:{
 candidate:StoryCandidate;theme:CanvasTheme;stale:boolean;locked:boolean;editBuffer:string|null;closeIntent:boolean;
 onEdit:()=>void;onChange:(value:string)=>void;onConfirmEdit:()=>void;onCancelEdit:()=>void;
 onCopy:()=>void;onAdopt:()=>void;onDiscard:()=>void;onContinueViewing:()=>void;
}){
 const actionsRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  if(closeIntent){actionsRef.current?.scrollIntoView?.({block:"nearest"});actionsRef.current?.querySelector("button")?.focus({preventScroll:true});}
 },[closeIntent]);
 const comparison=storyCandidateComparison(candidate.target);
 const control={background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text};
 const secondary="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-medium disabled:opacity-40";
 const icon="inline-grid size-7 shrink-0 place-items-center rounded-md hover:opacity-80 disabled:opacity-40";
 const prose="thin-scrollbar min-w-0 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border p-2 text-xs leading-6";
 return <section data-story-ai-candidate="" className="flex shrink-0 min-w-0 flex-col gap-2.5 rounded-lg border p-2.5"
  style={{borderColor:theme.node.stroke,background:theme.toolbar.activeBg}}>
  <div className="flex flex-wrap items-center justify-between gap-1.5">
   <strong className="text-xs">{storyAssistLabels[candidate.target.mode]} · 候选</strong>
   <span className="rounded-full border px-2 py-0.5 text-[11px]" style={control}>{stale?"已过期":"待审核"}</span>
  </div>
  <span data-story-candidate-scope="" className="text-[11px]" style={{color:theme.node.muted}}>{storyTargetLabel(candidate.target,candidate.continuationScope)}</span>
  <div className="grid min-w-0 gap-1.5">
   <strong className="text-xs">{comparison.kind==="insert"?"原文插入位置":"原文 · 待替换范围"}</strong>
   {comparison.kind==="insert"?<div data-story-candidate-original="" className={prose} style={{...control,overflowWrap:"anywhere"}}>
    <span style={{color:theme.node.muted}}>{(comparison.truncatedBefore?"…":"")+comparison.before}</span>
    <span className="my-1 block rounded border border-dashed px-1.5 text-center text-[11px] font-semibold"
     style={{borderColor:theme.node.activeStroke,color:theme.node.text}}>＋ 在此插入续写</span>
    <span style={{color:theme.node.muted}}>{comparison.after+(comparison.truncatedAfter?"…":"")}</span>
   </div>:<pre aria-label="候选对应原文" data-story-candidate-original="" className={prose}
    style={{...control,fontFamily:"inherit",overflowWrap:"anywhere"}}>{comparison.original}</pre>}
  </div>
  <div className="grid min-w-0 gap-1.5">
   <div className="flex items-center justify-between gap-1">
    <strong className="text-xs">候选文字 · {(editBuffer??candidate.text).length} 字符</strong>
    <div className="flex items-center gap-1">
     {editBuffer===null&&<button type="button" className={icon} aria-label="编辑 AI 候选" title="编辑 AI 候选" style={{color:theme.node.muted}} disabled={locked} onClick={onEdit}><Pencil size={13}/></button>}
     <button type="button" className={icon} aria-label="复制 AI 候选" title="复制当前候选文字" style={{color:theme.node.muted}}
      disabled={!(editBuffer??candidate.text)} onClick={onCopy}><Copy size={13}/></button>
    </div>
   </div>
   {editBuffer===null?<pre aria-label="AI 候选内容" data-story-candidate-text="" className={prose}
    style={{...control,fontFamily:"inherit",overflowWrap:"anywhere"}}>{candidate.text}</pre>:
    <><textarea aria-label="编辑 AI 候选内容" data-story-candidate-edit="" className="thin-scrollbar min-h-32 max-h-72 w-full resize-y rounded-md border p-2 text-xs leading-6"
      style={{...control,background:theme.node.fill}} value={editBuffer} onChange={event=>onChange(event.target.value)}/>
     <DramaEditActions theme={theme} label="AI 候选" disabled={locked||!editBuffer.trim()} onConfirm={onConfirmEdit} onCancel={onCancelEdit}/></>}
  </div>
  {stale&&<p role="alert" className="break-words rounded-md border p-2 text-xs leading-relaxed" style={control}>
   正文或关联来源已变化，候选已过期。可复制候选；舍弃后基于最新正文重新生成，不能直接采用。
  </p>}
  {closeIntent&&<p role="status" className="text-xs leading-relaxed" style={{color:theme.node.muted}}>收起或切换面板前，请先采用或舍弃候选，也可以继续查看。</p>}
  <div ref={actionsRef} className="flex flex-wrap justify-end gap-1.5">
   {closeIntent&&<button type="button" className={secondary} style={control} onClick={onContinueViewing}>继续查看</button>}
   <button type="button" className={secondary} style={control} disabled={locked} onClick={onDiscard}>舍弃候选</button>
   <button type="button" className={secondary+" font-semibold"} style={{background:theme.node.text,borderColor:theme.node.text,color:theme.node.panel}}
    disabled={locked||stale||editBuffer!==null||!candidate.text.trim()} onClick={onAdopt}>采用到草案</button>
  </div>
  <p className="text-[11px] leading-relaxed" style={{color:theme.node.muted}}>采用只更新本地编辑稿；随后保存草案，再显式确认故事版本。</p>
 </section>;
}
