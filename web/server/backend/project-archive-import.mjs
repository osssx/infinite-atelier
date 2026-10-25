import {createHash,randomUUID} from "node:crypto";
import {createWriteStream,createReadStream} from "node:fs";
import {mkdtemp,rm} from "node:fs/promises";
import {finished} from "node:stream/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Unzip} from "fflate";

/** Stage stored ZIP members to a private temporary directory. Only manifest
 * (max 5 MiB) stays in RAM; media are SHA-256 hashed while being written.
 * ZIP32 STORE only, preventing zip bombs and out-of-scope decompression. */
const error=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const NAME=/^blobs\/([a-f0-9]{64})$/;
const MANIFEST="manifest.json";
const META_LIMIT=5*1024*1024;
function completeZip(tail,total,count){
 return tail.length===22&&tail.readUInt32LE(0)===0x06054b50&&
  tail.readUInt16LE(4)===0&&tail.readUInt16LE(6)===0&&
  tail.readUInt16LE(8)===count&&tail.readUInt16LE(10)===count&&
  tail.readUInt16LE(20)===0&&
  tail.readUInt32LE(16)+tail.readUInt32LE(12)===total-22;
}
export async function importStreamedArchive(source,{limit,maxFiles,validateManifest,blobStore,create}){
 const root=await mkdtemp(join(tmpdir(),"atelier-archive-stage-"));
 const entries=new Map(),opened=new Set(),finishing=[];
 const backpressure=[],writers=[];
 let received=0,expanded=0,tail=Buffer.alloc(0),failure=null,manifestChunks=[];
 const abort=(e)=>{if(!failure)failure=e?.code?e:error("archive_invalid_zip")};
 const unzip=new Unzip(entry=>{
  if(failure)return;
  const name=entry.name;
  if((name!==MANIFEST&&!NAME.test(name))||entry.compression!==0||
     opened.has(name)||opened.size>=maxFiles){abort(error("archive_invalid_entry"));return}
  opened.add(name);
  const hasher=createHash("sha256");
  let bytes=0,output=null;
  if(name!==MANIFEST){
   output=createWriteStream(join(root,name.slice(6)),{flags:"wx",mode:0o600,highWaterMark:256*1024});
   output.on("error",abort);
   writers.push(output);
   finishing.push(finished(output).catch(abort));
  }
  entry.ondata=(err,chunk,final)=>{
   if(failure)return;
   if(err){abort(error("archive_invalid_zip"));return}
   bytes+=chunk.length;expanded+=chunk.length;
   if(expanded>limit||(name===MANIFEST&&bytes>META_LIMIT)){
    abort(error("archive_size_exceeded",413));return
   }
   hasher.update(chunk);
   if(name===MANIFEST)manifestChunks.push(Buffer.from(chunk));
   else if(chunk.length&&!output.write(Buffer.from(chunk))){
    // Feed at most one input frame ahead of an OS file write. Large media
    // are never buffered as an array of decompressed chunks.
    backpressure.push(new Promise((resolve,reject)=>{
     const done=()=>{output.off("drain",drain);output.off("close",close);output.off("error",close)};
     const drain=()=>{done();resolve()};
     const close=()=>{done();reject(error("archive_stage_write_failed",503))};
     output.once("drain",drain);output.once("close",close);output.once("error",close);
    }));
   }
   if(final){
    if(output)output.end();
    entries.set(name,{bytes,digest:hasher.digest("hex"),path:name===MANIFEST?null:join(root,name.slice(6))});
   }
  };
  entry.start();
 });
 try{
  for await(const incoming of source){
   const buffer=Buffer.from(incoming);
   received+=buffer.length;
   if(received>limit)throw error("archive_size_exceeded",413);
   tail=Buffer.concat([tail,buffer]).subarray(-22);
   unzip.push(buffer,false);
   if(failure)throw failure;
   if(backpressure.length){
    await Promise.all(backpressure.splice(0));
    if(failure)throw failure;
   }
  }
  if(!completeZip(tail,received,opened.size))throw error("archive_invalid_zip");
  unzip.push(new Uint8Array(),true);
  await Promise.all(finishing);
  if(failure)throw failure;
  if(entries.size!==opened.size)throw error("archive_invalid_zip");
  const meta=entries.get(MANIFEST);
  if(!meta||meta.bytes>META_LIMIT)throw error("archive_invalid_manifest");
  let manifest;
  try{manifest=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(
   Buffer.concat(manifestChunks,meta.bytes)))}
  catch{throw error("archive_invalid_manifest")}
  manifestChunks=[];
  const media=validateManifest(manifest);
  if(entries.size!==media.size+1)throw error("archive_unexpected_files");
  for(const item of media.values()){
   const staged=entries.get(item.path);
   if(!staged||staged.bytes!==item.bytes||staged.digest!==item.sha256)
    throw error("archive_media_integrity_error",422);
  }
  // No project exists before full validation and CAS writes complete.
  for(const item of media.values()){
   const saved=await blobStore.put(createReadStream(entries.get(item.path).path),{
    mime:item.mimeType,expectedSha256:item.sha256
   });
   if(saved.blobId!==item.sha256)throw error("archive_media_integrity_error",422);
  }
  return create(manifest,media);
 }finally{
  // Reject malformed or oversized uploads without leaving open files.
  // Destroy only writers that were not completed (Windows cannot unlink
  // active staging handles), then wait for their completion/error handlers.
  for(const writer of writers)if(!writer.closed)writer.destroy();
  await Promise.allSettled(finishing);
  await rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:80});
 }
}
