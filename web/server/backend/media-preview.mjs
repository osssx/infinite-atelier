import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {readFile,mkdir,rename,stat,unlink} from "node:fs/promises";
import {join} from "node:path";

const fail=(code,statusCode=503)=>Object.assign(Error(code),{code,statusCode});
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const supported=new Set(["image/png","image/jpeg","image/webp",
 "video/mp4","video/webm","video/x-matroska"]);
async function ffmpegPreview(source,destination,{executable="ffmpeg",timeoutMs=12000}={}){
 const args=["-hide_banner","-loglevel","error","-nostdin","-threads","1",
  "-i",source,"-vf",
  "scale=w=256:h=256:force_original_aspect_ratio=decrease:flags=fast_bilinear",
  "-frames:v","1","-an","-sn","-y",destination];
 await new Promise((resolve,reject)=>{
  const proc=spawn(executable,args,{windowsHide:true,stdio:["ignore","ignore","pipe"]});
  let settled=false,stderr="",timedOut=false;
  const timeout=setTimeout(()=>{timedOut=true;proc.kill()},timeoutMs);
  function finish(error){
   if(settled)return;
   settled=true;clearTimeout(timeout);
   if(error)reject(error);else resolve();
  }
  proc.stderr.on("data",chunk=>{if(stderr.length<1024)stderr+=String(chunk).slice(0,1024)});
  proc.on("error",()=>finish(fail("preview_transcoder_unavailable")));
  proc.on("close",code=>finish(timedOut?fail("preview_timeout"):code===0?null:fail("preview_render_failed",422)));
 });
}
/** Lazily generated server-owned previews; never persists browser IndexedDB data.
 * Preview files are derived caches and can always be regenerated from BlobStore.
 * The memory gate bounds thumbnail codec jobs during a 200-node pan.
 */
export function createMediaPreviewStore({dataDir,blobStore,render=ffmpegPreview,
 maxConcurrent=2,maxQueued=256}={}){
 if(!dataDir||!blobStore)throw Error("invalid_preview_store");
 const pending=new Map(),queue=[];let active=0;
 const previewRoot=join(dataDir,"previews");
 function enqueue(id,work){
  if(pending.has(id))return pending.get(id);
  if(queue.length+active>=maxQueued)throw fail("preview_busy",503);
  const promise=new Promise((resolve,reject)=>{queue.push({work,resolve,reject});drain()})
   .finally(()=>pending.delete(id));
  pending.set(id,promise);return promise;
 }
 function drain(){
  while(active<maxConcurrent&&queue.length){
   const item=queue.shift();active++;
   void Promise.resolve().then(item.work).then(item.resolve,item.reject).finally(()=>{
    active--;drain();
   });
  }
 }
 async function get(id){
  const blob=await blobStore.stat(id);
  if(!supported.has(blob.mimeType))throw fail("preview_unsupported_mime",415);
  await mkdir(previewRoot,{recursive:true,mode:0o700});
  const pathname=join(previewRoot,id+".png");
  const cached=async()=>{
   try{
    const info=await stat(pathname);
    if(info.size<8||info.size>2*1024*1024)throw Error("preview_invalid_size");
    const bytes=await readFile(pathname);
    if(!bytes.subarray(0,8).equals(pngSignature))throw Error("preview_invalid_signature");
    return bytes;
   }catch(e){if(e.code==="ENOENT")return null;throw e}
  };
  const available=await cached();
  if(available)return available;
  return enqueue(id,async()=>{
   const existing=await cached();
   if(existing)return existing;
   const tmp=join(previewRoot,id+"-"+randomUUID()+".png");
   try{
    await render(blob.path,tmp);
    const bytes=await readFile(tmp);
    if(bytes.length<8||bytes.length>2*1024*1024||
      !bytes.subarray(0,8).equals(pngSignature))throw fail("preview_invalid_output",422);
    await rename(tmp,pathname);
    return bytes;
   }finally{try{await unlink(tmp)}catch{}}
  });
 }
 return {get,root:previewRoot};
}
