import type {UploadedImage} from "@/services/image-storage";
import type {UploadedFile} from "@/services/file-storage";
import {readImageMeta} from "@/lib/image-utils";
import {canvasSession} from "@/features/backend-sync/canvas-api";
import {proxyApiUrl} from "@/lib/api-proxy";
import {readVideoMeta,readAudioMeta} from "@/services/file-storage";
import {canvasCasKey,canvasCasUrl} from "./canvas-cas";
export {canvasCasKey,canvasCasUrl,getCanvasBlob,isCanvasCasKey} from "./canvas-cas";

/** Stable content-addressed references owned by SQLite + server BlobStore.
 * Never uses origin-local IndexedDB. This service is Canvas-specific so that
 * the unrelated Asset library's legacy storage is not silently migrated.
 */
const TYPES=new Set(["image/png","image/jpeg","image/webp","video/mp4","video/webm",
 "video/x-matroska","audio/wav","audio/flac","audio/ogg","audio/mpeg","text/plain"]);
type Uploaded={blobId:string;sha256:string;byteSize:number;mimeType:string;existing:boolean};
async function inputBlob(input:string|Blob):Promise<Blob>{
 if(input instanceof Blob)return input;
 let source=input;
 try{
  const url=new URL(input);
  if(url.protocol==="http:"||url.protocol==="https:")source=proxyApiUrl(input);
 }catch{ /* data:, blob: and root-relative CAS URLs must not hit the proxy */ }
 const response=await fetch(source,{credentials:"same-origin"});
 if(!response.ok)throw Error("canvas_media_download_failed");
 return response.blob();
}
async function upload(blob:Blob,kind:"image"|"video"|"audio"):Promise<{key:string;url:string;size:number;mime:string}>{
 const mime=blob.type.toLowerCase().split(";")[0];
 if(!TYPES.has(mime)||!mime.startsWith(kind+"/"))throw Error("unsupported_canvas_media_mime");
 const send=async(force=false)=>fetch("/api/v1/blobs",{
  method:"POST",credentials:"same-origin",cache:"no-store",
  headers:{"Content-Type":"application/octet-stream","X-Atelier-Mime":mime,
   "X-Atelier-CSRF":await canvasSession(force)},
  body:blob
 });
 let response=await send();
 if(response.status===401)response=await send(true); // known rejection; CAS upload is idempotent
 const value:unknown=await response.json().catch(()=>null);
 if(!response.ok){
  const reason=value&&typeof value==="object"&&"code" in value?String(value.code):"canvas_blob_upload_failed";
  throw Error(reason);
 }
 const entry=value as Uploaded;
 if(!entry||typeof entry.blobId!=="string"||entry.sha256!==entry.blobId||
  entry.byteSize!==blob.size||entry.mimeType!==mime)
  throw Error("canvas_blob_response_invalid");
 const key=canvasCasKey(entry.blobId);
 return {key,url:canvasCasUrl(key)!,size:blob.size,mime};
}
export async function uploadCanvasImage(input:string|Blob):Promise<UploadedImage>{
 const blob=await inputBlob(input);
 const saved=await upload(blob,"image");
 const meta=await readImageMeta(saved.url);
 return {url:saved.url,storageKey:saved.key,width:meta.width,height:meta.height,
  bytes:saved.size,mimeType:saved.mime};
}
export async function uploadCanvasMedia(input:string|Blob,kind:"video"|"audio"):Promise<UploadedFile>{
 const blob=await inputBlob(input),saved=await upload(blob,kind);
 const meta=kind==="video"?await readVideoMeta(saved.url):await readAudioMeta(saved.url);
 return {url:saved.url,storageKey:saved.key,bytes:saved.size,mimeType:saved.mime,...meta};
}
export async function storeCanvasGeneratedVideo(result:{blob?:Blob;url?:string;mimeType?:string}):Promise<UploadedFile>{
 const source=result.blob??(result.url?await inputBlob(result.url):null);
 if(!source)throw Error("canvas_video_missing");
 // Some model gateways stream valid MP4 as application/octet-stream.
 // Only repair generic/empty MIME; BlobStore still validates binary signatures.
 const mime=source.type.startsWith("video/")?source.type:result.mimeType?.startsWith("video/")?
  result.mimeType:"video/mp4";
 return uploadCanvasMedia(source.type===mime?source:new Blob([source],{type:mime}),"video");
}
export async function storeCanvasGeneratedAudio(blob:Blob,format="mp3"):Promise<UploadedFile>{
 const fallback=format==="wav"?"audio/wav":format==="flac"?"audio/flac":
  format==="ogg"?"audio/ogg":"audio/mpeg";
 return uploadCanvasMedia(blob.type.startsWith("audio/")?blob:new Blob([blob],{type:fallback}),"audio");
}
