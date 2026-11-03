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
 const showingPreview=Boolean(previewUrl&&spinning);
 const statusText=execution?.status?comfyRunStatusLabel(execution.status)
  :node.metadata?.comfyWorkflow?.templateId
   ?`已绑定模板 · ${Object.keys(node.metadata.comfyWorkflow.inputOverrides??{}).length} 个实例参数`
   :"点击导入工作流模板";
 return <div className={showingPreview
    ?"pointer-events-none relative h-full w-full overflow-hidden rounded-3xl text-center"
    :"pointer-events-none flex h-full w-full flex-col items-center justify-center gap-2 p-5 text-center"}
   data-comfy-execution-status={execution?.status||"idle"} role={spinning?"status":undefined} aria-live="polite">
   {showingPreview?<>
    {previewSource?.mime==="video/mp4"?
     <video ref={videoRef} key={previewUrl} src={previewUrl!} className="absolute inset-0 h-full w-full rounded-3xl object-cover object-center" autoPlay muted loop playsInline controls={false} aria-label="ComfyUI 实时预览" onLoadedMetadata={event=>{if(reducedMotion)event.currentTarget.pause()}}/>:
     <img alt="ComfyUI 实时预览" className="absolute inset-0 h-full w-full rounded-3xl object-cover object-center" src={previewUrl!}/>}
    <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col items-start gap-1 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-4 pb-4 pt-12 text-left text-white">
     <span className="inline-flex max-w-full min-w-0 items-center gap-2 text-xs" data-comfy-status-line>
      <span className="size-4 shrink-0 animate-spin rounded-full border-2" aria-label="ComfyUI 工作流运行中"
       style={{borderColor:"rgba(255,255,255,.4)",borderTopColor:"white"}}/>
      <span className="min-w-0 truncate">{statusText}</span>
     </span>
     {spinning&&nodeLabel?<span className="max-w-full truncate text-[11px] text-white/90" title={progress?.nodeName&&nodeId?progress.nodeName+" · ID: "+nodeId:progress?.currentNode||""}>执行节点 {nodeLabel}</span>:null}
     {spinning&&progress?.step!=null&&progress.steps?
      <span className="text-[11px] text-white/90">采样 {progress.step}/{progress.steps} · {Math.round((progress.value??0)*100)}%</span>:null}
     {execution?.error?<span title={execution.error} className="max-w-full truncate text-[11px] text-red-200">{execution.error}</span>:null}
    </div>
   </>:<>
    <div className="flex h-12 w-[164px] shrink-0 items-center justify-center">
     <img src={theme===canvasThemes.dark?comfyLogoDark:comfyLogoLight} alt="ComfyUI" draggable={false} className="max-h-11 w-[148px] object-contain" />
    </div>
    <span className="inline-flex max-w-48 min-w-0 items-center justify-center gap-2 text-xs opacity-70" data-comfy-status-line>
     {spinning?<span className="size-4 shrink-0 animate-spin rounded-full border-2"
      aria-label="ComfyUI 工作流运行中" style={{borderColor:theme.node.stroke,borderTopColor:theme.node.activeStroke}}/>:null}
     <span className="min-w-0 truncate">{statusText}</span>
    </span>
    {spinning&&nodeLabel?<span className="pointer-events-auto max-w-48 truncate text-[11px] opacity-80" title={progress?.nodeName&&nodeId?progress.nodeName+" · ID: "+nodeId:progress?.currentNode||""}>执行节点 {nodeLabel}</span>:null}
    {spinning&&progress?.step!=null&&progress.steps?
     <span className="text-[11px] opacity-80">采样 {progress.step}/{progress.steps} · {Math.round((progress.value??0)*100)}%</span>:null}
    {execution?.error?<span title={execution.error} className="max-w-48 truncate text-[11px] text-red-500">{execution.error}</span>:null}
   </>}
  </div>;
}
