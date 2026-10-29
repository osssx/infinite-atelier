import {useCanvasTextExecution,textExecutionLabel} from "@/features/backend-sync/canvas-text-execution-visual";

/** Lightweight pointer-transparent badge shared by full and compact LOD.
 * The spinning CSS border needs no React updates or animation-frame work.
 */
export function CanvasTextExecutionIndicator({nodeId,compact=false}:{nodeId:string;compact?:boolean}){
 const execution=useCanvasTextExecution(nodeId);
 if(!execution)return null;
 return <div data-canvas-text-generation-status={execution.status}
  data-canvas-text-generation-count={execution.activeCount}
  role="status" aria-live="polite"
  className={`pointer-events-none absolute bottom-3 left-3 right-3 z-[35] flex items-center gap-2 rounded-lg bg-black/75 px-2.5 py-2 text-xs font-medium text-white shadow-md ${compact?"":"backdrop-blur-sm"}`}>
  <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white"
   aria-label="文本模型生成中"/>
  <span className="min-w-0 flex-1 truncate">{textExecutionLabel(execution.status)}</span>
  {execution.activeCount>1?<span className="shrink-0 opacity-70">×{execution.activeCount}</span>:null}
 </div>;
}
