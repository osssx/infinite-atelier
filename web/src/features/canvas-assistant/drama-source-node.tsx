import {memo} from "react";
import {Maximize2} from "lucide-react";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import type {CanvasNodeData} from "@/types/canvas";
import type {StorySourceState} from "./drama-story-upstream";
import {dramaNodeControl,DramaNodeStatus} from "./drama-node-style";
import {resolveStorySummary,storyVersionConfirmed,storyDraftStatusLabel} from "./drama-story-state";

const sourceHints:Record<StorySourceState,string>={updated:"上游文本有更新",replaced:"原上游来源已替换",
 disconnected:"上游来源已断开",available:"检测到新上游文本",multiple:"连接多个文本来源",
 current:"上游文本已同步",none:""};

/** Summary only: no editing controls, full-text history or network requests. */
export const DramaSourceNode=memo(function DramaSourceNode({node,onOpenEditor,sourceState="none"}:{
 node:CanvasNodeData;onOpenEditor:(nodeId:string)=>void;sourceState?:StorySourceState;
}){
 const theme=canvasThemes[useThemeStore(state=>state.theme)];
 const summary=resolveStorySummary(node),control=dramaNodeControl(theme);
 const preview=summary?.preview.trim();
 return <section className="flex h-full min-h-0 w-full flex-col gap-2 overflow-hidden px-3 pb-3 pt-2.5 text-xs"
  style={{color:theme.node.text}}>
  <div className="flex items-center justify-between gap-2">
   <strong className="text-sm font-semibold">小说或剧本</strong>
   <DramaNodeStatus theme={theme} confirmed={storyVersionConfirmed(node)} draftLabel={storyDraftStatusLabel(node)}/>
  </div>
  <button type="button" data-story-inline-summary="" onPointerDown={e=>e.stopPropagation()}
   className="min-h-0 w-full flex-1 overflow-hidden rounded-lg border p-3 text-left text-xs leading-relaxed"
   style={{...control,background:theme.toolbar.activeBg}} onClick={()=>onOpenEditor(node.id)}>
   <span className="mb-1 block font-medium" style={{color:theme.node.muted}}>{summary?`${summary.length} 字符 · `:""}点击打开完整编辑器</span>
   <span className="line-clamp-4 whitespace-pre-wrap break-words">{!summary?"摘要暂不可用，点击打开完整编辑器":summary.hasText?(preview||"正文开头为空白")+(summary.length>360?"…":""):"尚无故事正文，点击开始创作"}</span>
  </button>
  <div className="flex min-w-0 items-center gap-2 text-[11px]" style={{color:theme.node.muted}}>
   <span className="min-w-0 flex-1 truncate" title={node.metadata?.dramaFilmStyle}>影片风格：{node.metadata?.dramaFilmStyle||"未设置"}</span>
   <span className="shrink-0">{node.metadata?.videoRatio||"随模型"}</span>
  </div>
  {sourceHints[sourceState]&&<span className="truncate text-[11px]" style={{color:theme.node.muted}}>{sourceHints[sourceState]}</span>}
  <div className="flex shrink-0 justify-end">
   <button type="button" onPointerDown={e=>e.stopPropagation()} onClick={()=>onOpenEditor(node.id)}
    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium"
    style={control}><Maximize2 size={13}/>完整编辑</button>
  </div>
 </section>;
},(prev,next)=>prev.node.id===next.node.id&&prev.node.metadata===next.node.metadata&&
 prev.sourceState===next.sourceState&&prev.onOpenEditor===next.onOpenEditor);