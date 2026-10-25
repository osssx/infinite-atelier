import {saveAs} from "file-saver";
import {awaitCanvasStorePersistence} from "@/stores/canvas/use-canvas-store";
import {canvasSession,CanvasApiError} from "./canvas-api";

const MAX_FILE_BYTES=128*1024*1024;
function errorCode(response:Response,body:unknown){
 const code=body&&typeof body==="object"&&"code" in body&&typeof body.code==="string"?
  body.code:"archive_request_failed";
 return new CanvasApiError(code,response.status);
}
export async function exportSqliteCanvasProject(id:string,title?:string){
 await awaitCanvasStorePersistence();
 const path="/api/v1/projects/"+encodeURIComponent(id)+"/archive";
 const res=await fetch(path,{credentials:"same-origin",cache:"no-store"});
 if(!res.ok)throw errorCode(res,await res.json().catch(()=>null));
 const expected=res.headers.get("content-length");
 if(expected&&Number(expected)>MAX_FILE_BYTES)throw new CanvasApiError("archive_size_exceeded",413);
 const content=await res.blob();
 if(!content.size||content.size>MAX_FILE_BYTES)throw new CanvasApiError("archive_size_exceeded",413);
 const safe=(title||id).replace(/[\\/:*?"<>|\x00-\x1f]/g,"_").slice(0,96)||id;
 saveAs(content,safe+".atelier.zip");
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
