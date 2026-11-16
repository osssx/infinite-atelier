import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {isAbsolute} from "node:path";

const exec=promisify(execFile);
const supported=new Set(["video/mp4","video/quicktime","video/webm","video/x-matroska","audio/mpeg","audio/wav","audio/x-wav","audio/flac","audio/ogg"]);
export function parseMediaDurationMs(value){
 const durations=[Number(value?.format?.duration),...(Array.isArray(value?.streams)?value.streams.map(stream=>Number(stream?.duration)):[])].filter(n=>Number.isFinite(n)&&n>0);
 if(!durations.length)return null;
 const ms=Math.round(Math.max(...durations)*1000);
 return Number.isSafeInteger(ms)&&ms>0?ms:null;
}
/** Obtain duration only from a local, hash-pinned CAS path; browser metadata and URLs are never accepted. */
export async function readMediaDurationMs(path,mime,{executable=process.env.ATELIER_FFPROBE_PATH||"ffprobe",probe=exec,timeoutMs=8000}={}){
 if(typeof path!=="string"||!isAbsolute(path)||!supported.has(mime))return null;
 try{
  const {stdout}=await probe(executable,["-v","error","-protocol_whitelist","file","-show_streams","-show_format","-of","json",path],
   {windowsHide:true,timeout:timeoutMs,maxBuffer:65536,encoding:"utf8"});
  return parseMediaDurationMs(JSON.parse(stdout));
 }catch{return null}
}
