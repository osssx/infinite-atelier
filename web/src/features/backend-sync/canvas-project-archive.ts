import {saveAs} from "file-saver";
import {awaitCanvasStorePersistence} from "@/stores/canvas/use-canvas-store";
import {canvasSession,CanvasApiError} from "./canvas-api";

const MAX_FILE_BYTES=2*1024*1024*1024;
const MEMORY_FALLBACK_BYTES=128*1024*1024;
type DiskWriter={write(data:Uint8Array):Promise<void>;close():Promise<void>;abort():Promise<void>};
type DiskHandle={createWritable():Promise<DiskWriter>};
function errorCode(response:Response,body:unknown){
 const code=body&&typeof body==="object"&&"code" in body&&typeof body.code==="string"?
  body.code:"archive_request_failed";
 return new CanvasApiError(code,response.status);
}
export async function exportSqliteCanvasProject(id:string,title?:string){
 const safe=(title||id).replace(/[\\/:*?"<>|\x00-\x1f]/g,"_").slice(0,96)||id;
 const filename=safe+".atelier.zip";
 // Ask while the click still holds user activation; async API calls follow.
 const host=typeof window==="undefined"?undefined:
  window as Window & {showSaveFilePicker?:(options:unknown)=>Promise<DiskHandle>};
 const destination=host?.showSaveFilePicker?await host.showSaveFilePicker({
  suggestedName:filename,
  types:[{description:"Infinite Atelier project",accept:{"application/zip":[".zip"]}}]
 }):undefined;
 await awaitCanvasStorePersistence();
 const path="/api/v1/projects/"+encodeURIComponent(id)+"/archive";
 const res=await fetch(path,{credentials:"same-origin",cache:"no-store"});
 if(!res.ok)throw errorCode(res,await res.json().catch(()=>null));
 const expected=res.headers.get("content-length");
 if(expected&&Number(expected)>MAX_FILE_BYTES)throw new CanvasApiError("archive_size_exceeded",413);
 if(!res.body)throw new CanvasApiError("archive_response_invalid",502);
 const reader=res.body.getReader(),parts:Uint8Array[]=[];
 let writer:DiskWriter|undefined,total=0;
 try{
  if(destination)writer=await destination.createWritable();
  while(true){
   const {done,value}=await reader.read();
   if(done)break;
   total+=value.byteLength;
   if(total>MAX_FILE_BYTES||(!writer&&total>MEMORY_FALLBACK_BYTES)){
    await reader.cancel();
    throw new CanvasApiError(writer?"archive_size_exceeded":
      "archive_large_export_requires_file_system_access",413);
   }
   if(writer)await writer.write(value);
   else parts.push(new Uint8Array(value));
  }
  if(!total)throw new CanvasApiError("archive_response_invalid",502);
  if(writer)await writer.close();
  else saveAs(new Blob(parts as BlobPart[],{type:"application/zip"}),filename);
 }catch(e){if(writer)try{await writer.abort()}catch{}throw e}
 finally{reader.releaseLock()}
}
export async function importSqliteCanvasProject(file:File):Promise<{id:string;title:string;mediaCount:number}>{
 if(!/\.zip$/i.test(file.name)||!file.size||file.size>MAX_FILE_BYTES)
  throw new CanvasApiError("archive_invalid_file_or_size",413);
 // The same user may have an unsaved in-memory editor. Do not overwrite it.
 await awaitCanvasStorePersistence();
 let res:Response|undefined;
 for(let attempt=0;attempt<2;attempt++){
  const csrf=await canvasSession(attempt===1);
  res=await fetch("/api/v1/projects/import-archive",{
   method:"POST",credentials:"same-origin",cache:"no-store",
   headers:{"content-type":"application/zip","x-atelier-csrf":csrf},
   body:file
  });
  if(res.status!==401||attempt===1)break;
 }
 if(!res)throw new CanvasApiError("archive_upload_failed",0);
 const json=await res.json().catch(()=>null) as {id?:string;title?:string;mediaCount?:number;code?:string}|null;
 if(!res.ok)throw errorCode(res,json);
 if(!json?.id||typeof json.id!=="string")throw new CanvasApiError("archive_response_invalid",502);
 return {id:json.id,title:json.title??file.name,mediaCount:json.mediaCount??0};
}
