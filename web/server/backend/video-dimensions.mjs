import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {imageNodeSize} from "./image-dimensions.mjs";

const execFileAsync=promisify(execFile);
const videoMimes=new Set(["video/mp4","video/quicktime","video/webm","video/x-matroska"]);
const valid=(w,h)=>Number.isSafeInteger(w)&&Number.isSafeInteger(h)&&w>0&&h>0&&
 w<=32768&&h<=32768&&w*h<=268435456;

/** FFprobe reports encoded dimensions; rotate them into presentation
 * orientation, matching HTMLVideoElement.videoWidth / videoHeight.
 * Invalid metadata must never block an already completed GPU job.
 */
export function parseVideoDimensions(result){
 const streams=result?.streams;
 if(!Array.isArray(streams)||streams.length===0)return null;
 const video=streams[0];
 const width=video?.width,height=video?.height;
 if(!valid(width,height))return null;
 const side=Array.isArray(video.side_data_list)?video.side_data_list:[];
 const rawRotation=side.find(item=>Number.isFinite(item?.rotation))?.rotation ??
  Number(video.tags?.rotate ?? 0);
 const rotation=Number(rawRotation);
 const quarterTurn=Number.isFinite(rotation)&&
  Math.abs(Math.round(rotation/90)%2)===1&&Math.abs(rotation-Math.round(rotation/90)*90)<0.01;
 return quarterTurn?{width:height,height:width}:{width,height};
}

/** Probe only a previously verified local CAS blob path. No network inputs,
 * no shell, no unbounded output or background decoder for canvas nodes.
 * ffprobe is optional: when absent, materialization retains its fallback.
 */
export async function readVideoDimensions(path,mime,{
 executable="ffprobe",probe=execFileAsync,timeoutMs=8000
}={}){
 if(!videoMimes.has(mime)||typeof path!=="string"||!path)return null;
 try{
  const {stdout}=await probe(executable,[
   "-v","error","-select_streams","v:0",
   "-show_entries","stream=width,height:stream_tags=rotate:stream_side_data=rotation",
   "-of","json","-i",path
  ],{windowsHide:true,timeout:timeoutMs,maxBuffer:65536,encoding:"utf8"});
  return parseVideoDimensions(JSON.parse(stdout));
 }catch{return null}
}

/** Same image/video aspect policy, including existing minimum handle size. */
export function videoNodeSize(dimensions){
 return dimensions?imageNodeSize(dimensions):{width:420,height:236};
}
