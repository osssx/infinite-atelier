import {randomUUID,createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {PassThrough} from "node:stream";
import {Zip,ZipPassThrough} from "fflate";
import {importStreamedArchive} from "./project-archive-import.mjs";
import {createProject,getProject,validateProjectDocument} from "./projects.mjs";
import {getCanvasViewport,getCanvasChats} from "./canvas-state.mjs";
import {assertNoRawCredentials} from "./repository.mjs";
import {createComfyRegistry,validateComfyTemplate} from "./comfy-registry.mjs";

const hashRe=/^[a-f0-9]{64}$/;
const mediaPathRe=/^blobs\/([a-f0-9]{64})$/;
const casRe=/^cas:([a-f0-9]{64})$/;
const blobUrlRe=/^\/api\/v1\/blobs\/([a-f0-9]{64})$/;
const manifestName="manifest.json";
export const ARCHIVE_MAX_BYTES=2*1024*1024*1024;
export const ARCHIVE_MAX_FILES=128;
const error=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const stable=(x)=>JSON.stringify(x);

/** Scan all project content for CAS keys without assuming future node shapes.
 * Fail closed on legacy origin-local keys: this is SQLite-only, not an old
 * browser canvas migration route. */
export function projectArchiveHashes(value){
 const hashes=new Set(),seen=new WeakSet();
 function walk(data,key=""){
  if(typeof data==="string"){
   const a=data.match(casRe)||data.match(blobUrlRe);
   if(a){hashes.add(a[1]);return}
   if(key==="storageKey"&&data!=="")throw error("archive_nonportable_media_reference",422);
   if((key==="content"||key==="url"||key==="poster")&&
     (/^(blob:|data:(?:image|video|audio)\/)/.test(data)))throw error("archive_nonportable_media_reference",422);
   return;
  }
  if(!data||typeof data!=="object"||seen.has(data))return;
  seen.add(data);
  if(Array.isArray(data))for(const child of data)walk(child);
  else for(const [k,v] of Object.entries(data))walk(v,k);
 }
 walk(value);
 return hashes;
}
/** Archive must include every immutable workflow version used by the graph.
 * A bare browser-local templateId would not be a portable project. */
function boundTemplates(document){
 const refs=new Map();
 for(const node of document.nodes??[]){
  const value=node?.metadata?.comfyWorkflow;
  if(!value||value.templateId===undefined&&value.templateRevision===undefined)continue;
  if(typeof value.templateId!=="string"||typeof value.templateRevision!=="string")
   throw error("archive_template_missing",422);
  refs.set(value.templateId+"@"+value.templateRevision,
   {id:value.templateId,revision:value.templateRevision});
 }
 return [...refs.values()].sort((a,b)=>(a.id+"@"+a.revision).localeCompare(b.id+"@"+b.revision));
}
function validatedManifest(manifest,registry){
 if(!manifest||manifest.app!=="infinite-atelier"||manifest.kind!=="sqlite-canvas-project"||
  manifest.version!==1||!manifest.project||!Array.isArray(manifest.media))
  throw error("archive_invalid_manifest");
 const p=manifest.project;
 if(!p.document||!p.viewport||!p.chats||typeof p.title!=="string"||
  p.title.length>500||typeof p.id!=="string")throw error("archive_invalid_manifest");
 validateProjectDocument(p.document);
 assertNoRawCredentials(manifest);
 const templates=manifest.templates??[];
 if(!Array.isArray(templates)||templates.length>64)throw error("archive_invalid_manifest");
 const included=new Set();
 for(const raw of templates){
  let template;
  try{template=validateComfyTemplate(raw)}catch{throw error("archive_invalid_manifest")}
  const key=template.id+"@"+template.revision;
  if(included.has(key))throw error("archive_invalid_manifest");
  included.add(key);
 }
 for(const ref of boundTemplates(p.document))
  if(!included.has(ref.id+"@"+ref.revision)&&!registry.find(ref.id,ref.revision))
   throw error("archive_template_missing",422);
 if(!Array.isArray(p.chats.sessions)||p.chats.activeChatId===undefined)
  throw error("archive_invalid_manifest");
 const found=projectArchiveHashes({document:p.document,chats:p.chats});
 const media=new Map();
 for(const item of manifest.media){
  if(!item||!hashRe.test(item.sha256)||item.path!=="blobs/"+item.sha256||
   !Number.isSafeInteger(item.bytes)||item.bytes<0||
   typeof item.mimeType!=="string"||media.has(item.sha256))
   throw error("archive_invalid_manifest");
  media.set(item.sha256,item);
 }
 if(media.size!==found.size||[...found].some(h=>!media.has(h)))
  throw error("archive_media_manifest_mismatch",422);
 return media;
}
function assertQuota(n){if(n>ARCHIVE_MAX_BYTES)throw error("archive_size_exceeded",413)}
export function createProjectArchive({db,blobStore}={}){
 if(!db||!blobStore)throw Error("archive_backend_required");
 const registry=createComfyRegistry(db);
 async function exportProject(id){
  const project=getProject(db,id),viewport=getCanvasViewport(db,id),chats=getCanvasChats(db,id);
  const hashes=[...projectArchiveHashes({document:project.document,chats})].sort();
  if(hashes.length>ARCHIVE_MAX_FILES-1)throw error("archive_file_limit_exceeded",413);
  const media=[];let total=0;
  for(const hash of hashes){
   const item=await blobStore.stat(hash);
   total+=item.byteSize;assertQuota(total);
   media.push({sha256:hash,path:"blobs/"+hash,bytes:item.byteSize,mimeType:item.mimeType});
  }
  const templates=boundTemplates(project.document).map(ref=>{
   const template=registry.find(ref.id,ref.revision);
   if(!template)throw error("archive_template_missing",422);
   return template;
  });
  if(templates.length>64)throw error("archive_invalid_manifest",413);
  const manifest={app:"infinite-atelier",kind:"sqlite-canvas-project",version:1,
   project:{id:project.id,title:project.document.title||project.id,
    revision:project.revision,document:project.document,
    viewport:viewport.viewport,chats:{sessions:chats.sessions,activeChatId:chats.activeChatId}},
   media,templates};
  const text=Buffer.from(stable(manifest),"utf8");
  if(text.length>5*1024*1024)throw error("archive_invalid_manifest",413);
  assertQuota(total+text.length);
  const stream=new PassThrough({highWaterMark:256*1024});
  const zip=new Zip((e,chunk,final)=>{
   if(stream.destroyed)return;
   if(e){stream.destroy(e);return}
   if(chunk?.length)stream.write(Buffer.from(chunk));
   if(final)stream.end();
  });
  // Consumer abort closes the source instead of reading the rest of every
  // video; normal completion is left intact.
  stream.on("close",()=>{if(!stream.writableFinished)zip.terminate()});
  // Stream archive frames in order. Pause source reads under backpressure.
  async function emit(name,source){
   const entry=new ZipPassThrough(name);
   zip.add(entry);
   for await(const bytes of source){
    if(stream.destroyed)throw error("archive_stream_closed",499);
    entry.push(bytes,false);
    if(stream.writableNeedDrain)await new Promise((resolve,reject)=>{
     const clean=()=>{
      stream.off("drain",resume);stream.off("close",stop);stream.off("error",stop);
     };
     const resume=()=>{clean();resolve()};
     const stop=()=>{clean();reject(error("archive_stream_closed",499))};
     stream.once("drain",resume);stream.once("close",stop);stream.once("error",stop);
    });
   }
   entry.push(new Uint8Array(0),true);
  }
  void (async()=>{
   try{
    await emit(manifestName,[text]);
    for(const item of media){
     const source=await blobStore.stat(item.sha256);
     const digest=createHash("sha256");let bytes=0;
     const tracked=(async function*(){
      for await(const chunk of createReadStream(source.path)){
       digest.update(chunk);bytes+=chunk.length;yield chunk;
      }
     })();
     await emit(item.path,tracked);
     if(bytes!==item.bytes||digest.digest("hex")!==item.sha256)
      throw error("archive_blob_integrity_error",503);
    }
    zip.end();
   }catch(e){zip.terminate();stream.destroy(e)}
  })();
  return {stream,fileName:project.id+".atelier.zip"};
 }
 async function importProject(source){
  return importStreamedArchive(source,{
   limit:ARCHIVE_MAX_BYTES,maxFiles:ARCHIVE_MAX_FILES,
   validateManifest:manifest=>validatedManifest(manifest,registry),blobStore,
   create:(manifest,media)=>{
    const p=manifest.project;
    registry.installMany(manifest.templates??[]);
    const created=createProject(db,{id:randomUUID(),document:{
     ...p.document,title:p.title,
     viewport:p.viewport,chatSessions:p.chats.sessions,activeChatId:p.chats.activeChatId
    }});
    return {id:created.id,revision:created.revision,mediaCount:media.size,title:p.title};
   }
  });
 }
 return {exportProject,importProject};
}
