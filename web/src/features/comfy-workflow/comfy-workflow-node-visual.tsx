import comfyLogoLight from "@/assets/comfyui-logo.svg";
import comfyLogoDark from "@/assets/comfyui-logo-dark.svg";
import type {CanvasNodeData} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import {comfyRunStatusLabel,isComfyRunActive} from "./run-status";
import {useCanvasComfyExecution} from "./canvas-execution-visual";

/** Only the active workflow subscribes to phase updates; CSS owns the animation. */
export function ComfyWorkflowNodeVisual({node,theme}:{node:CanvasNodeData;theme:(typeof canvasThemes)[keyof typeof canvasThemes]}) {
 const execution=useCanvasComfyExecution(node.id);
 const spinning=isComfyRunActive(execution?.status);
 const progress=execution?.progress;
 const nodeId=progress?.currentNode?.startsWith("w_"+node.id+"__")
   ?progress.currentNode.slice(("w_"+node.id+"__").length)
   :progress?.currentNode?.split("__").at(-1);
  const nodeLabel=progress?.nodeName||nodeId;
 return <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center gap-2 p-5 text-center"
   data-comfy-execution-status={execution?.status||"idle"} role={spinning?"status":undefined} aria-live="polite">
   {execution?.preview&&spinning?<img alt="ComfyUI 实时预览" className="max-h-20 max-w-44 rounded object-contain" src={`data:${execution.preview.mime};base64,${execution.preview.data}`}/>:null}
    <div className="relative flex h-12 w-[164px] shrink-0 items-center justify-center">
     <img src={theme===canvasThemes.dark?comfyLogoDark:comfyLogoLight}
      alt="ComfyUI" draggable={false} className="max-h-11 w-[148px] object-contain" />
     {spinning?<div className="absolute -right-1 -top-0.5 size-5 animate-spin rounded-full border-2"
      aria-label="ComfyUI 工作流运行中" style={{borderColor:theme.node.stroke,borderTopColor:theme.node.activeStroke}}/>:null}
    </div>   <span className="text-sm font-semibold">ComfyUI Workflow</span>
   <span className="max-w-48 truncate text-xs opacity-70">
    {execution?.status?comfyRunStatusLabel(execution.status)
     :node.metadata?.comfyWorkflow?.templateId
      ?`已绑定模板 · ${Object.keys(node.metadata.comfyWorkflow.inputOverrides??{}).length} 个实例参数`
      :"点击导入工作流模板"}
   </span>
   {spinning&&nodeLabel?<span className="pointer-events-auto max-w-48 truncate text-[11px] opacity-80" title={progress?.nodeName&&nodeId?progress.nodeName+" · ID: "+nodeId:progress?.currentNode||""}>执行节点 {nodeLabel}</span>:null}
   {spinning&&progress?.step!=null&&progress.steps?
    <span className="text-[11px] opacity-80">采样 {progress.step}/{progress.steps} · {Math.round((progress.value??0)*100)}%</span>:null}
   {execution?.error?<span title={execution.error} className="max-w-48 truncate text-[11px] text-red-500">{execution.error}</span>:null}
  </div>;
}
