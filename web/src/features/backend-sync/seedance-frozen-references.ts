import type {VideoGenerationRequest,VideoInputMedia} from "@/services/api/video/types";
import {isCanvasCasKey,canvasCasUrl} from "./canvas-cas";
import {getImageBlob} from "@/services/image-storage";
import {getMediaBlob} from "@/services/file-storage";
import type {createSqliteComfyBridge} from "./sqlite-comfy-bridge";

export type FrozenArkReference={
 kind:"image"|"video"|"audio";
 role:"first_frame"|"last_frame"|"reference_image"|"reference_video"|"reference_audio";
 mimeType?:string;blobId?:string;sha256?:string;
 assetUrl?:string;durationMs?:number;width?:number;height?:number;
};
const allowed:Record<"image"|"video"|"audio",readonly string[]>={
 image:["image/png","image/jpeg","image/webp"],
 video:["video/mp4","video/quicktime"],
 audio:["audio/wav","audio/mpeg"]
};
const expectedRole:Record<FrozenArkReference["kind"],readonly string[]>={
 image:["first_frame","last_frame","reference_image"],
 video:["reference_video"],
 audio:["reference_audio"]
};
export async function freezeSeedanceReferences(
 request:VideoGenerationRequest,
 bridge:Pick<ReturnType<typeof createSqliteComfyBridge>,"uploadFrozenBlob">,
 deps:{
  readImage?:(key:string)=>Promise<Blob|null>;
  readMedia?:(key:string)=>Promise<Blob|null>;
  fetcher?:typeof fetch;
 }={}
):Promise<FrozenArkReference[]>{
 const result:FrozenArkReference[]=[];
 const fetcher=deps.fetcher??fetch;
 for(const ref of request.references){
  if(!ref.role||!expectedRole[ref.kind].includes(ref.role))
   throw Error("Seedance 参考素材角色与类型不匹配");
  const stored=ref.storageKey;
  const assetUrl=ref.kind==="video"&&ref.url?.startsWith("asset://")?ref.url:undefined;
  // Existing Ark video assets can be passed through. Otherwise freeze local
  // video bytes into immutable CAS; the backend publishes them to TOS and
  // creates an Ark Asset before submitting the billable Seedance task.
  if(ref.kind==="video"&&!assetUrl&&!stored&&!ref.url)
   throw Error("本地参考视频文件不存在");
  if(assetUrl&&!/^asset:\/\/[A-Za-z0-9_-]{1,160}$/.test(assetUrl))
   throw Error("方舟视频素材 ID 无效");
  let blobId:string|undefined,mimeType:string|undefined,bytes:number|undefined;
  if(!assetUrl&&stored&&isCanvasCasKey(stored)){
   const response=await fetcher(canvasCasUrl(stored)!,{
    method:"HEAD",credentials:"same-origin",cache:"no-store"
   });
   if(!response.ok)throw Error("参考媒体 CAS 文件不存在："+response.status);
   mimeType=(response.headers.get("content-type")??"").split(";")[0].trim();
   bytes=Number(response.headers.get("content-length"));
   if(!Number.isSafeInteger(bytes)||bytes<=0)throw Error("参考媒体大小无效");
   blobId=stored.slice(4);
  }else if(!assetUrl&&(stored||ref.dataUrl||ref.url)){
   let blob=stored?await(ref.kind==="image"?(deps.readImage??getImageBlob)(stored):
     (deps.readMedia??getMediaBlob)(stored)):null;
   const url=ref.kind==="image"?ref.dataUrl??ref.url:ref.url;
   if(!blob&&url){
    if(!url.startsWith("data:")&&!url.startsWith("blob:")&&!url.startsWith("/api/v1/blobs/"))
     throw Error("不能冻结外部非可信媒体 URL");
    const response=await fetcher(url,{credentials:"same-origin"});
    if(!response.ok)throw Error("参考媒体文件读取失败");
    blob=await response.blob();
   }
   if(!blob)throw Error("参考媒体文件不存在");
   mimeType=blob.type;bytes=blob.size;
   if(!allowed[ref.kind].includes(mimeType))throw Error("参考媒体格式不受支持："+mimeType);
   const uploaded=await bridge.uploadFrozenBlob(blob,mimeType);
   if(uploaded.blobId!==uploaded.sha256)throw Error("参考媒体 CAS 校验失败");
   blobId=uploaded.blobId;
  }else if(!assetUrl)throw Error("参考媒体缺少文件");
  if(ref.kind==="video"&&!assetUrl&&!blobId)throw Error("参考视频冻结到 CAS 失败");
  if(mimeType&&!allowed[ref.kind].includes(mimeType))
   throw Error("参考媒体格式不受支持："+mimeType);
  if(bytes&&(ref.kind==="image"&&bytes>=30*1024*1024||
     ref.kind==="audio"&&bytes>=15*1024*1024||
     ref.kind==="video"&&bytes>200*1024*1024))
   throw Error("参考媒体超过 Seedance 文件大小限制");
  const frozen:FrozenArkReference={kind:ref.kind,role:ref.role,
   ...(blobId?{blobId,sha256:blobId,mimeType}:{}),
   ...(assetUrl?{assetUrl}:{}),
   ...(ref.durationMs?{durationMs:ref.durationMs}:{}),
   ...(ref.width?{width:ref.width}:{}),
   ...(ref.height?{height:ref.height}:{})};
  result.push(frozen);
 }
 return result;
}
