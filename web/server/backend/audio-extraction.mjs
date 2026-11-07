import {spawn} from "node:child_process";
import {createReadStream} from "node:fs";
import {mkdir,mkdtemp,rm,stat} from "node:fs/promises";
import {join} from "node:path";
import {captureLimits} from "../comfy-workflow/capture-adapters.mjs";

export const extractionError=(code,statusCode=422)=>Object.assign(Error(code),{code,statusCode});
const cancelled=()=>extractionError("audio_extraction_cancelled",499);
const check=signal=>{if(signal.aborted)throw signal.reason??cancelled()};

/** No shell, remote protocols or user-supplied command arguments. Wait for close
 * after killing so the caller can safely remove temporary files on Windows. */
export function runMediaProcess(executable,args,{signal}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(signal.reason??cancelled());return}
  const child=spawn(executable,args,{windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let output="",failure,killTimer;
  const abort=()=>{
   failure=signal.reason??cancelled();child.kill();
   killTimer=setTimeout(()=>child.kill("SIGKILL"),1000);
  };
  signal?.addEventListener("abort",abort,{once:true});
  child.stdout.on("data",chunk=>{
   if(output.length+chunk.length>65536){failure=extractionError("audio_extraction_failed");child.kill()}
   else output+=String(chunk);
  });
  child.stderr.on("data",()=>{});
  child.on("error",()=>{failure=extractionError("audio_extraction_tool_unavailable",503)});
  child.on("close",code=>{
   clearTimeout(killTimer);signal?.removeEventListener("abort",abort);
   if(failure)reject(failure);
   else if(code!==0)reject(extractionError("audio_extraction_failed"));
   else resolve(output);
  });
 });
}

export function createAudioExtractionService({dataDir,blobStore,
 ffmpeg=process.env.ATELIER_FFMPEG_PATH||"ffmpeg",
 ffprobe=process.env.ATELIER_FFPROBE_PATH||"ffprobe",
 run=runMediaProcess,maxConcurrent=2,maxQueued=8,timeoutMs=600000}={}){
 const queue=[],running=new Set();let closed=false;
 const maxBytes=Math.min(blobStore.maxBlobBytes,captureLimits.audio);
 async function probe(path,signal){
  const text=await run(ffprobe,["-v","error","-protocol_whitelist","file","-show_streams","-show_format","-of","json",path],{signal});
  try{return JSON.parse(text)}catch{throw extractionError("audio_extraction_failed")}
 }
 async function work(task){
  const {signal}=task.controller;
  const timer=setTimeout(()=>task.controller.abort(extractionError("audio_extraction_timeout",504)),timeoutMs);
  let temp;
  try{
   check(signal);await task.validate?.();
   const source=await blobStore.stat(task.blobId);
   if(!source.mimeType.startsWith("video/"))throw extractionError("audio_extraction_source_invalid",409);
   const info=await probe(source.path,signal);
   if(!info.streams?.some(stream=>stream.codec_type==="audio"))throw extractionError("audio_extraction_no_audio");
   check(signal);
   const root=join(dataDir,"tmp");await mkdir(root,{recursive:true});
   temp=await mkdtemp(join(root,"extract-audio-"));
   const output=join(temp,"audio.m4a");
   await run(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-threads","1",
    "-protocol_whitelist","file","-i",source.path,"-map","0:a:0","-vn","-sn","-dn",
    "-map_metadata","-1","-c:a","aac","-b:a","192k","-ar","48000","-ac","2",
    "-fs",String(maxBytes),"-movflags","+faststart","-y",output],{signal});
   check(signal);
   const size=(await stat(output)).size;
   if(size>=maxBytes)throw extractionError("audio_extraction_quota_exceeded",413);
   const result=await probe(output,signal);
   const durationMs=Math.round(Number(result.format?.duration)*1000);
   if(!Number.isSafeInteger(durationMs)||durationMs<=0||result.streams?.length!==1||
    result.streams[0].codec_name!=="aac"||result.streams[0].codec_type!=="audio")
    throw extractionError("audio_extraction_failed");
   check(signal);await task.validate?.();
   const stored=await blobStore.put(createReadStream(output),{mime:"audio/mp4"});
   check(signal);
   return {blobId:stored.blobId,mimeType:"audio/mp4",byteSize:stored.byteSize,durationMs};
  }finally{clearTimeout(timer);if(temp)await rm(temp,{recursive:true,force:true})}
 }
 function drain(){
  while(!closed&&running.size<maxConcurrent&&queue.length){
   const task=queue.shift();task.started=true;running.add(task);
   void work(task).then(task.resolve,task.reject).finally(()=>{
    task.cleanup();running.delete(task);drain();
   });
  }
 }
 function extract(blobId,{signal,validate}={}){
  if(closed||running.size>=maxConcurrent&&queue.length>=maxQueued)
   return Promise.reject(extractionError("audio_extraction_busy",503));
  if(signal?.aborted)return Promise.reject(cancelled());
  return new Promise((resolve,reject)=>{
   const task={blobId,validate,resolve,reject,controller:new AbortController(),started:false};
   const abort=()=>{
    task.controller.abort(cancelled());
    if(!task.started){const index=queue.indexOf(task);if(index>=0)queue.splice(index,1);task.cleanup();reject(cancelled())}
   };
   task.cleanup=()=>signal?.removeEventListener("abort",abort);
   signal?.addEventListener("abort",abort,{once:true});
   queue.push(task);drain();
  });
 }
 async function close(){
  closed=true;
  for(const task of queue.splice(0)){task.cleanup();task.reject(cancelled())}
  await Promise.all([...running].map(task=>new Promise(resolve=>{
   const cleanup=task.cleanup;task.cleanup=()=>{cleanup();resolve()};task.controller.abort(cancelled());
  })));
 }
 return {extract,close};
}
