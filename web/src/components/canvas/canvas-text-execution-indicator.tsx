import type {ReactNode} from "react";
import {useCanvasTextExecution,textExecutionLabel} from "@/features/backend-sync/canvas-text-execution-visual";

/** CSS-only progress indicator. Use inline mode inside the Config node's
 * generate button, never a bottom-anchored overlay above that button.
 * Full text and compact LOD nodes retain the unobtrusive overlay.
 */
export function CanvasTextExecutionIndicator({
 nodeId,compact=false,inline=false,idle=null
}:{nodeId:string;compact?:boolean;inline?:boolean;idle?:ReactNode}){
 const execution=useCanvasTextExecution(nodeId);
 if(!execution)return inline?<>{idle}</>:null;
 const content=<>
  <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
   aria-label="文本模型生成中"/>
  <span className={inline?"min-w-0 truncate":"min-w-0 flex-1 truncate"}>{textExecutionLabel(execution.status)}</span>
  {execution.activeCount>1?<span className="shrink-0 opacity-70">×{execution.activeCount}</span>:null}
 </>;
 if(inline)return <span data-canvas-text-generation-status={execution.status}
  data-canvas-text-generation-count={execution.activeCount}
  role="status" aria-live="polite"
  className="inline-flex max-w-full min-w-0 items-center justify-center gap-2 text-sm font-medium">
  {content}
 </span>;
 return <div data-canvas-text-generation-status={execution.status}
  data-canvas-text-generation-count={execution.activeCount}
  role="status" aria-live="polite"
  className={`pointer-events-none absolute bottom-3 left-3 right-3 z-[35] flex items-center gap-2 rounded-lg bg-black/75 px-2.5 py-2 text-xs font-medium text-white shadow-md ${compact?"":"backdrop-blur-sm"}`}>
  {content}
 </div>;
}
