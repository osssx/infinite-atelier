import {createHash,randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {Readable} from "node:stream";
import {captureLimits} from "../comfy-workflow/capture-adapters.mjs";
import {open,mkdir,link,unlink,lstat} from "node:fs/promises";
import {join,isAbsolute,resolve,dirname} from "node:path";
import {writeTransaction} from "./repository.mjs";

const recognized=new Set(["image/png","image/jpeg","image/webp","video/mp4","video/quicktime","video/webm","video/x-matroska",
 "audio/wav","audio/flac","audio/ogg","audio/mpeg","text/plain"]);
const failure=(code,statusCode)=>Object.assign(Error(code),{code,statusCode});
const mimeKind=mime=>mime.startsWith("image/")?"image":mime.startsWith("video/")?"video":
 mime.startsWith("audio/")?"audio":"text";
const sig=(b,prefix)=>b.subarray(0,prefix.length).equals(Buffer.from(prefix));
function sniff(data,mime){
 if(mime==="image/png")return data.length>=8&&sig(data,[137,80,78,71,13,10,26,10]);
 if(mime==="image/jpeg")return data.length>=3&&sig(data,[255,216,255]);
 if(mime==="image/webp")return data.length>=12&&data.toString("ascii",0,4)==="RIFF"&&data.toString("ascii",8,12)==="WEBP";
 if(mime==="video/mp4"||mime==="video/quicktime")return data.length>=12&&data.toString("ascii",4,8)==="ftyp";
 if(mime==="video/webm"||mime==="video/x-matroska")return data.length>=4&&sig(data,[26,69,223,163]);
 if(mime==="audio/wav")return data.length>=12&&data.toString("ascii",0,4)==="RIFF"&&data.toString("ascii",8,12)==="WAVE";
 if(mime==="audio/flac")return data.length>=4&&data.toString("ascii",0,4)==="fLaC";
 if(mime==="audio/ogg")return data.length>=4&&data.toString("ascii",0,4)==="OggS";
 if(mime==="audio/mpeg")return data.length>=3&&(data.toString("ascii",0,3)==="ID3"||(data[0]===255&&(data[1]&0xe0)===0xe0));
 if(mime==="text/plain")return true; // full stream validated by TextDecoder below
 return false;
}
/** Content-addressed, atomic publication to disk before main SQLite row.
 * Crash or failed DB write can leave orphan files for a later garbage collection pass.
 */
export function createBlobStore({dataDir,db,maxBlobBytes=64*1024*1024}={}){
 if(typeof dataDir!=="string"||!isAbsolute(dataDir)||!db)throw Error("invalid_blob_store");
 if(!Number.isSafeInteger(maxBlobBytes)||maxBlobBytes<1)throw Error("invalid_blob_quota");
 const root=resolve(dataDir),blobsRoot=join(root,"blobs"),tmpRoot=join(root,"tmp");
 const digestPath=id=>join(blobsRoot,id.slice(0,2),id);
 let activeUploads=0;
 async function verifyExistingFile(path,id,size){
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size!==size)
   throw failure("blob_integrity_error",503);
  const digest=createHash("sha256");let seen=0;
  for await(const bytes of createReadStream(path)){digest.update(bytes);seen+=bytes.length}
  if(seen!==size||digest.digest("hex")!==id)throw failure("blob_integrity_error",503);
 }

 async function put(source,options={}){
  activeUploads++;
  try{return await putInternal(source,options)}finally{activeUploads--}
 }
 async function putInternal(source,{mime,expectedSha256}={}){
  if(!recognized.has(mime))throw failure("unsupported_blob_mime",415);
  if(expectedSha256!==undefined&&!/^[a-f0-9]{64}$/.test(expectedSha256))throw failure("invalid_sha256",400);
  await mkdir(tmpRoot,{recursive:true,mode:0o700});
  const temp=join(tmpRoot,randomUUID()+".part");
  const file=await open(temp,"wx",0o600);
  const sha=createHash("sha256"),decoder=mime==="text/plain"?new TextDecoder("utf-8",{fatal:true}):null;
  let size=0;const fragments=[];let retained=0;
  try{
   for await(const raw of source){
    const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw);
    size+=chunk.length;
    if(size>Math.min(maxBlobBytes,captureLimits[mimeKind(mime)]))throw failure("blob_quota_exceeded",413);
    if(decoder){
     if(chunk.includes(0))throw failure("blob_mime_mismatch",415);
     try{decoder.decode(chunk,{stream:true})}catch{throw failure("blob_mime_mismatch",415)}
    }
    sha.update(chunk);
    if(retained<4096){fragments.push(chunk.subarray(0,4096-retained));retained+=Math.min(chunk.length,4096-retained)}
    await file.writeFile(chunk);
   }
   if(size===0&&mime!=="text/plain")throw failure("empty_blob",400);
   if(decoder){try{decoder.decode()}catch{throw failure("blob_mime_mismatch",415)}}
   if(!sniff(Buffer.concat(fragments),mime))throw failure("blob_mime_mismatch",415);
   const id=sha.digest("hex");
   if(expectedSha256!==undefined&&id!==expectedSha256)throw failure("blob_digest_mismatch",422);
   await file.sync();await file.close();
   const final=digestPath(id);
   await mkdir(dirname(final),{recursive:true,mode:0o700});
   try{await link(temp,final)}
   catch(e){if(e.code!=="EEXIST")throw e;await verifyExistingFile(final,id,size)}
   const entry=db.prepare("SELECT * FROM blobs WHERE id=?").get(id);
   if(entry&&(entry.sha256!==id||entry.byte_size!==size||entry.mime!==mime))
    throw failure("blob_identity_conflict",409);
   if(!entry)writeTransaction(db,()=>{
    db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,?,?,?,?)")
     .run(id,id,size,mime,"blobs/"+id.slice(0,2)+"/"+id,"ready");
   });
   return {blobId:id,sha256:id,byteSize:size,mimeType:mime,existing:!!entry};
  }finally{
   try{await file.close()}catch{}
   try{await unlink(temp)}catch{}
  }
 }
 async function stat(id){
  if(!/^[a-f0-9]{64}$/.test(id))throw failure("blob_not_found",404);
  const record=db.prepare("SELECT * FROM blobs WHERE id=? AND status='ready'").get(id);
  if(!record)throw failure("blob_not_found",404);
  const path=digestPath(id);
  let details;
  try{details=await lstat(path)}catch(e){if(e.code==="ENOENT")throw failure("blob_missing_on_disk",503);throw e}
  if(!details.isFile()||details.isSymbolicLink()||details.size!==record.byte_size)
   throw failure("blob_integrity_error",503);
  return {id,path,byteSize:record.byte_size,mimeType:record.mime,sha256:record.sha256};
 }
 function getStream(record,{start=0,end=record.byteSize-1}={}){
  return record.byteSize===0?Readable.from([]):createReadStream(record.path,{start,end});
 }
 function parseRange(range,total){
  if(range===undefined)return null;
  if(typeof range!=="string"||!/^bytes=\d*-\d*$/.test(range))throw failure("invalid_blob_range",416);
  const [from,to]=range.slice(6).split("-");
  if(!from&&!to)throw failure("invalid_blob_range",416);
  let start,end;
  if(!from){
   const count=Number(to);
   if(!Number.isSafeInteger(count)||count<=0)throw failure("invalid_blob_range",416);
   start=Math.max(0,total-count);end=total-1;
  }else{
   start=Number(from);end=to?Number(to):total-1;
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end))throw failure("invalid_blob_range",416);
   end=Math.min(end,total-1);
  }
  if(start>=total||start<0||end<start)throw failure("invalid_blob_range",416);
  return {start,end};
 }
 return {put,stat,getStream,parseRange,maxBlobBytes,
  hasActiveUploads:()=>activeUploads>0,
  pathFor:id=>/^[a-f0-9]{64}$/.test(id)?digestPath(id):null};
}
