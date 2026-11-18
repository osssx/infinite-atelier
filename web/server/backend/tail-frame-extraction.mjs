import {createReadStream} from "node:fs";
import {mkdir,mkdtemp,rm,stat} from "node:fs/promises";
import {join} from "node:path";
import {runMediaProcess} from "./audio-extraction.mjs";
import {captureLimits} from "../comfy-workflow/capture-adapters.mjs";

const failure=(code,statusCode=422)=>Object.assign(Error(code),{code,statusCode});

export function createTailFrameExtractionService({dataDir,blobStore,
 ffmpeg=process.env.ATELIER_FFMPEG_PATH||"ffmpeg",run=runMediaProcess,timeoutMs=600000}={}){
 const pending=new Map();
 async function available(){
  try{await run(ffmpeg,["-version"],{signal:AbortSignal.timeout(5000)});return true}
  catch{return false}
 }
 async function decode(sourceBlobId,{signal}={}){
  const source=await blobStore.stat(sourceBlobId);
  if(!source.mimeType.startsWith("video/"))throw failure("tail_frame_source_invalid");
  const root=join(dataDir,"tmp");
  await mkdir(root,{recursive:true});
  const temp=await mkdtemp(join(root,"tail-frame-"));
  try{
   const output=join(temp,"last.png"),deadline=AbortSignal.timeout(timeoutMs);
   const abort=signal?AbortSignal.any([signal,deadline]):deadline;
   let lineBuffer="",timeMs=null;
   const onStderr=chunk=>{
    const lines=(lineBuffer+chunk.toString()).split("\n");
    lineBuffer=lines.pop().slice(-2048);
    for(const line of lines){
     const pts=/Parsed_showinfo.*\bn:\s*\d+.*\bpts_time:\s*([-+\d.eE]+)/.exec(line);
     if(pts&&Number.isFinite(Number(pts[1])))timeMs=Math.round(Number(pts[1])*1000);
    }
   };
   // Decode in presentation order and overwrite the one output file on each
   // frame. image2's atomic writing leaves only a complete PNG on disk.
   await run(ffmpeg,["-hide_banner","-loglevel","info","-nostats","-nostdin","-threads","1",
    "-protocol_whitelist","file","-i",source.path,"-map","0:V:0","-an","-sn","-dn",
    "-filter_threads","1","-vf","showinfo","-fps_mode","passthrough","-threads","1",
    "-c:v","png","-f","image2","-update","1","-atomic_writing","1","-y",output],{signal:abort,onStderr});
   abort.throwIfAborted();
   if(timeMs===null)throw failure("tail_frame_timestamp_missing");
   const {size}=await stat(output);
   if(!size||size>Math.min(blobStore.maxBlobBytes,captureLimits.image))throw failure("tail_frame_size_invalid",413);
   const stored=await blobStore.put(createReadStream(output),{mime:"image/png"});
   return {blobId:stored.blobId,sha256:stored.sha256,sourceBlobId,timeMs};
  }finally{await rm(temp,{recursive:true,force:true})}
 }
 function extract(sourceBlobId,options){
  if(options?.signal)return decode(sourceBlobId,options);
  if(!pending.has(sourceBlobId))pending.set(sourceBlobId,decode(sourceBlobId).finally(()=>pending.delete(sourceBlobId)));
  return pending.get(sourceBlobId);
 }
 return {available,extract};
}
