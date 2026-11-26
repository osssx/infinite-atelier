import {useState} from "react";
import type {CanvasNodeData} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";

/** Preserve confirmed paragraph inspection without loading it in canvas cards. */
export function DramaStoryHistorySummary({node}:{node:CanvasNodeData}){
 const theme=canvasThemes[useThemeStore(state=>state.theme)];
 const [expanded,setExpanded]=useState(false);
 const paragraphs=node.metadata?.dramaSourceParagraphs??[];
 return <section data-story-history-summary="" className="space-y-2 text-xs" style={{color:theme.node.text}}>
  <p className="leading-relaxed" style={{color:theme.node.muted}}>下游使用已确认的故事正文与美术设定；未确认草案不会直接更新下游。</p>
  <div className="rounded-lg border p-2.5" style={{background:theme.node.panel,borderColor:theme.node.stroke}}>
   <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}
    className="flex w-full items-center justify-between gap-2 text-left font-medium">
    <span>已确认原文定位 · {paragraphs.length} 段</span><span style={{color:theme.node.muted}}>{expanded?"收起":"展开"}</span>
   </button>
   {expanded&&(paragraphs.length?<ol className="mt-2 space-y-2">
    {paragraphs.map((paragraph,index)=><li key={paragraph.id} className="min-w-0 rounded-md p-2" style={{background:theme.toolbar.activeBg}}>
     <div className="flex flex-wrap gap-2 text-[11px]" style={{color:theme.node.muted}}>
      <span>第 {index+1} 段</span><span>{paragraph.status==="needs_review"?"待校对":"已定位"}</span>
      {!!paragraph.replaces?.length&&<span>关联旧段落 {paragraph.replaces.length} 个</span>}
     </div><p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{paragraph.text}</p>
    </li>)}
   </ol>:<p className="mt-2" style={{color:theme.node.muted}}>暂无已确认段落。</p>)}
  </div>
 </section>;
}
