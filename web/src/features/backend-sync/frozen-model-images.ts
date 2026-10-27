/** Immutable, trusted local reference images for SQLite model jobs.
 * Only backend CAS or local browser image bytes are accepted, never arbitrary
 * remote URLs or data URLs embedded inside a durable JobSnapshot.
 */
import type {ReferenceImage} from "@/types/image";
import type {createSqliteComfyBridge} from "./sqlite-comfy-bridge";
import {isCanvasCasKey,canvasCasUrl} from "./canvas-cas";
import {getImageBlob} from "@/services/image-storage";

export type FrozenModelImage={blobId:string;mimeType:"image/png"|"image/jpeg"|"image/webp"};
const mimes=new Set(["image/png","image/jpeg","image/webp"]);
const MAX_IMAGE=20*1024*1024,MAX_TOTAL=64*1024*1024;
type Bridge=Pick<ReturnType<typeof createSqliteComfyBridge>,"uploadFrozenBlob">;
export async function freezeModelImages(images:readonly ReferenceImage[],bridge:Bridge,deps:{
 read?:(key:string)=>Promise<Blob|null>;fetcher?:typeof fetch
}={}):Promise<FrozenModelImage[]>{
 if(!images.length||images.length>8)throw Error("sqlite_model_image_count_invalid");
 const result:FrozenModelImage[]=[];let total=0;
 for(const image of images){
  let blobId:string,mimeType:string,size:number;
  if(image.storageKey&&isCanvasCasKey(image.storageKey)){
   const url=canvasCasUrl(image.storageKey);
   if(!url)throw Error("sqlite_model_image_url_invalid");
   const response=await(deps.fetcher??fetch)(url,{method:"HEAD",
    credentials:"same-origin",cache:"no-store"});
   if(!response.ok)throw Error("sqlite_model_image_missing");
   blobId=image.storageKey.slice(4);
   mimeType=(response.headers.get("content-type")??"").split(";")[0].trim();
   size=Number(response.headers.get("content-length"));
  }else{
   let blob:Blob|null=null;
   if(image.storageKey)blob=await(deps.read??getImageBlob)(image.storageKey);
   if(!blob){
    const url=image.dataUrl||image.url||"";
    if(!url.startsWith("data:image/")&&!url.startsWith("blob:"))
     throw Error("sqlite_model_remote_image_forbidden");
    const response=await(deps.fetcher??fetch)(url);
    if(!response.ok)throw Error("sqlite_model_image_missing");
    blob=await response.blob();
   }
   mimeType=blob.type;size=blob.size;
   if(!mimes.has(mimeType)||size<1||size>MAX_IMAGE||total+size>MAX_TOTAL)
    throw Error("sqlite_model_image_invalid");
   const uploaded=await bridge.uploadFrozenBlob(blob,mimeType);
   if(uploaded.blobId!==uploaded.sha256||
    !/^[a-f0-9]{64}$/.test(uploaded.blobId)||
    uploaded.mimeType!==mimeType||uploaded.byteSize!==size)
    throw Error("sqlite_model_image_upload_invalid");
   blobId=uploaded.blobId;
  }
  if(!mimes.has(mimeType)||!Number.isSafeInteger(size)||size<1||
   size>MAX_IMAGE||(total+=size)>MAX_TOTAL||
   !/^[a-f0-9]{64}$/.test(blobId))throw Error("sqlite_model_image_invalid");
  result.push({blobId,mimeType:mimeType as FrozenModelImage["mimeType"]});
 }
 return result;
}
