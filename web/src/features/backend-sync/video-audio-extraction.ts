import type {CanvasNodeData} from "@/types/canvas";
import {canvasApi} from "./canvas-api";
import {canvasCasKey,canvasCasUrl} from "./canvas-cas";

export type ExtractedAudio={blobId:string;mimeType:"audio/mp4";byteSize:number;durationMs:number};
export function videoAudioSourceId(node:CanvasNodeData):string|null{
 const id=node.metadata?.storageKey?.match(/^cas:([a-f0-9]{64})$/)?.[1];
 return node.type==="video"&&id&&node.metadata?.content===canvasCasUrl("cas:"+id)?id:null;
}
export function extractedAudioMetadata(result:ExtractedAudio,source:CanvasNodeData){
 const key=canvasCasKey(result.blobId);
 return {content:canvasCasUrl(key)!,storageKey:key,status:"success" as const,
  mimeType:result.mimeType,bytes:result.byteSize,durationMs:result.durationMs,
  audioExtraction:{sourceNodeId:source.id,sourceBlobId:videoAudioSourceId(source)!}};
}

/** Transient per-page operations. Identity is checked before submission and
 * before committing so a stale async result can never enter another graph. */
export function createVideoAudioExtractionController({projectId,getSource,saveSource,onResult,onError,onChange,
 request=(source:CanvasNodeData,signal:AbortSignal)=>canvasApi<ExtractedAudio>(
  `/api/v1/projects/${encodeURIComponent(projectId)}/media/extract-audio`,"POST",
  {sourceNodeId:source.id,sourceBlobId:videoAudioSourceId(source)},signal),
}:{projectId:string;getSource:(id:string)=>CanvasNodeData|undefined;
 saveSource:()=>Promise<void>;onResult:(source:CanvasNodeData,result:ExtractedAudio)=>void;
 onError:(error:unknown)=>void;onChange:(ids:ReadonlySet<string>)=>void;
 request?:(source:CanvasNodeData,signal:AbortSignal)=>Promise<ExtractedAudio>}){
 const pending=new Map<string,{source:CanvasNodeData;controller:AbortController}>();
 const changed=()=>onChange(new Set(pending.keys()));
 const current=(source:CanvasNodeData)=>{
  const live=getSource(source.id);
  return live&&videoAudioSourceId(live)===videoAudioSourceId(source)&&videoAudioSourceId(source)!==null;
 };
 function cancel(id:string){
  const task=pending.get(id);if(!task)return;
  pending.delete(id);task.controller.abort();changed();
 }
 async function start(source:CanvasNodeData){
  if(pending.has(source.id))return;
  if(!current(source)){onError(Error("audio_extraction_source_invalid"));return}
  const task={source,controller:new AbortController()};
  pending.set(source.id,task);changed();
  const valid=()=>!task.controller.signal.aborted&&pending.get(source.id)===task&&current(source);
  try{
   await saveSource();if(!valid())return;
   const result=await request(source,task.controller.signal);
   if(valid())onResult(getSource(source.id)!,result);
  }catch(error){if(valid())onError(error)}
  finally{if(pending.get(source.id)===task){pending.delete(source.id);changed()}}
 }
 return {start,cancel,reconcile(){for(const [id,task] of pending)if(!current(task.source))cancel(id)},
  dispose(){for(const id of pending.keys())cancel(id)}};
}

export function audioExtractionErrorMessage(error:unknown):string{
 const code=error instanceof Error?"code" in error?String(error.code):error.message:"";
 const messages:Record<string,string>={
  audio_extraction_no_audio:"该视频没有可提取的音轨",
  audio_extraction_tool_unavailable:"未找到本机 FFmpeg 或 FFprobe，请安装后加入 PATH，或设置 ATELIER_FFMPEG_PATH / ATELIER_FFPROBE_PATH 并重启后端",
  audio_extraction_source_invalid:"源视频已失效或被替换，请重新选择视频",
  project_not_found:"源项目已不存在",
  blob_not_found:"源视频文件已不存在",blob_missing_on_disk:"源视频文件已不存在",
  audio_extraction_busy:"音频提取队列已满，请稍后重试",
  audio_extraction_timeout:"音频提取超时，请重试或使用较短的视频",
  audio_extraction_quota_exceeded:"提取的音频超过存储大小限制",
  blob_quota_exceeded:"提取的音频超过存储大小限制",
 };
 return messages[code]??"音频提取失败，请检查视频文件和本机 FFmpeg 后重试";
}
