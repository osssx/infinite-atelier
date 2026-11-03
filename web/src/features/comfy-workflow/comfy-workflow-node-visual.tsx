import {useEffect,useRef,useState} from "react";
import comfyLogoLight from "@/assets/comfyui-logo.svg";
import comfyLogoDark from "@/assets/comfyui-logo-dark.svg";
import type {CanvasNodeData} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import {comfyRunStatusLabel,isComfyRunActive} from "./run-status";
import {useCanvasComfyExecution} from "./canvas-execution-visual";
import {createComfyPreviewMediaController} from "./comfy-preview-media";

/** Only the active workflow subscribes to phase updates; CSS owns the animation. */
export function ComfyWorkflowNodeVisual({node,theme}:{node:CanvasNodeData;theme:(typeof canvasThemes)[keyof typeof canvasThemes]}) {
 const execution=useCanvasComfyExecution(node.id);
 const spinning=isComfyRunActive(execution?.status);
 const progress=execution?.progress;
 const preview=execution?.preview;
 const previewEnabled=Boolean(node.metadata?.comfyWorkflow?.previewBinding||execution?.previewEnabled||preview);
 const [previewSource,setPreviewSource]=useState<{runId:string;url:string;mime:string}|null>(null);
 const previewUrl=previewSource&&previewSource.runId===execution?.runId?previewSource.url:null;
 const previewMediaRef=useRef<ReturnType<typeof createComfyPreviewMediaController>|null>(null);
 if(!previewMediaRef.current)previewMediaRef.current=createComfyPreviewMediaController();
 const videoRef=useRef<HTMLVideoElement|null>(null);
 const [reducedMotion,setReducedMotion]=useState(false);
 useEffect(()=>{
  const query=window.matchMedia?.("(prefers-reduced-motion: reduce)");
  if(!query)return;
  const update=()=>setReducedMotion(query.matches);update();query.addEventListener?.("change",update);
  return()=>query.removeEventListener?.("change",update);
 },[]);
 useEffect(()=>{
  if(!previewEnabled||!spinning||!preview){
   previewMediaRef.current!.clear();setPreviewSource(null);return;
  }
  const runId=execution?.runId;
  if(!runId)return;
  if(previewSource?.runId!==runId){
   previewMediaRef.current!.clear();setPreviewSource(null);
  }
  void previewMediaRef.current!.load(runId,preview,reducedMotion).then(media=>{if(media)setPreviewSource(media)});
  return()=>previewMediaRef.current?.abortPending();
 },[previewEnabled,spinning,preview?.version,preview?.mime,execution?.runId,reducedMotion]);
 useEffect(()=>{
  const video=videoRef.current;if(!video)return;
  if(reducedMotion)video.pause();else if(previewUrl)void video.play().catch(()=>{});
 },[reducedMotion,previewUrl]);
 useEffect(()=>()=>previewMediaRef.current?.dispose(),[]);
 const nodeId=progress?.currentNode?.startsWith("w_"+node.id+"__")
   ?progress.currentNode.slice(("w_"+node.id+"__").length)
   :progress?.currentNode?.split("__").at(-1);
  const nodeLabel=progress?.nodeName||nodeId;
 return <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center gap-2 p-5 text-center"
   data-comfy-execution-status={execution?.status||"idle"} role={spinning?"status":undefined} aria-live="polite">
   {previewUrl&&spinning&&previewSource?.mime==="video/mp4"?
    <video ref={videoRef} key={previewUrl} src={previewUrl} className="min-h-0 min-w-0 max-h-full max-w-full flex-1 object-contain" autoPlay muted loop playsInline controls={false} aria-label="ComfyUI 实时预览" onLoadedMetadata={event=>{if(reducedMotion)event.currentTarget.pause()}}/>:
    previewUrl&&spinning?<img alt="ComfyUI 实时预览" className="min-h-0 min-w-0 max-h-full max-w-full flex-1 rounded object-contain" src={previewUrl}/>:null}
   {(!previewUrl||!spinning)?<div className="flex h-12 w-[164px] shrink-0 items-center justify-center">
    <img src={theme===canvasThemes.dark?comfyLogoDark:comfyLogoLight} alt="ComfyUI" draggable={false} className="max-h-11 w-[148px] object-contain" />
   </div>:null}
   <span className="text-sm font-semibold">ComfyUI Workflow</span>
   <span className="inline-flex max-w-48 min-w-0 items-center justify-center gap-2 text-xs opacity-70" data-comfy-status-line>
    {spinning?<span className="size-4 shrink-0 animate-spin rounded-full border-2"
     aria-label="ComfyUI 工作流运行中" style={{borderColor:theme.node.stroke,borderTopColor:theme.node.activeStroke}}/>:null}
    <span className="min-w-0 truncate">
     {execution?.status?comfyRunStatusLabel(execution.status)
      :node.metadata?.comfyWorkflow?.templateId
       ?`已绑定模板 · ${Object.keys(node.metadata.comfyWorkflow.inputOverrides??{}).length} 个实例参数`
       :"点击导入工作流模板"}
    </span>
   </span>
   {spinning&&nodeLabel?<span className="pointer-events-auto max-w-48 truncate text-[11px] opacity-80" title={progress?.nodeName&&nodeId?progress.nodeName+" · ID: "+nodeId:progress?.currentNode||""}>执行节点 {nodeLabel}</span>:null}
   {spinning&&progress?.step!=null&&progress.steps?
    <span className="text-[11px] opacity-80">采样 {progress.step}/{progress.steps} · {Math.round((progress.value??0)*100)}%</span>:null}
   {execution?.error?<span title={execution.error} className="max-w-48 truncate text-[11px] text-red-500">{execution.error}</span>:null}
  </div>;
}
