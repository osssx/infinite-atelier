import {Puzzle} from "lucide-react";
import type {CanvasNodeData} from "@/types/canvas";
import type {canvasThemes} from "@/lib/canvas-theme";
import {comfyRunStatusLabel,isComfyRunActive} from "./run-status";
import {useCanvasComfyExecution} from "./canvas-execution-visual";

/** Only the active workflow subscribes to phase updates; CSS owns the animation. */
export function ComfyWorkflowNodeVisual({node,theme}:{node:CanvasNodeData;theme:(typeof canvasThemes)[keyof typeof canvasThemes]}) {
 const execution=useCanvasComfyExecution(node.id);
 const spinning=isComfyRunActive(execution?.status);
 return <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center gap-2 p-5 text-center"
   data-comfy-execution-status={execution?.status||"idle"} role={spinning?"status":undefined} aria-live="polite">
   {spinning
    ? <div className="size-9 animate-spin rounded-full border-[3px]" aria-label="ComfyUI 工作流运行中"
       style={{borderColor:theme.node.stroke,borderTopColor:theme.node.activeStroke}}/>
    : <Puzzle className="size-9 opacity-60" />}
   <span className="text-sm font-semibold">ComfyUI Workflow</span>
   <span className="max-w-48 truncate text-xs opacity-70">
    {execution?.status?comfyRunStatusLabel(execution.status)
     :node.metadata?.comfyWorkflow?.templateId
      ?`已绑定模板 · ${Object.keys(node.metadata.comfyWorkflow.inputOverrides??{}).length} 个实例参数`
      :"点击导入工作流模板"}
   </span>
   {execution?.error?<span title={execution.error} className="max-w-48 truncate text-[11px] text-red-500">{execution.error}</span>:null}
  </div>;
}
