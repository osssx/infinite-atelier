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
  customScript?:boolean;
 }={}
):Promise<FrozenArkReference[]>{
 const result:FrozenArkReference[]=[];
 const fetcher=deps.fetcher??fetch;
 const custom=deps.customScript===true;
 if(custom){
  const counts={image:0,video:0,audio:0};
  for(const ref of request.references){
   if(!(ref.kind in counts))throw Error("参考素材类型无效");
   counts[ref.kind]++;
  }
  if(request.references.length>12||counts.image>6||counts.video>3||counts.audio>3)
   throw Error("参考素材数量超限：最多 6 张图片、3 段视频、3 段音频");
 }
 let totalBytes=0,imageBytes=0;
 for(const ref of request.references){
  if(!ref.role||!expectedRole[ref.kind].includes(ref.role))
   throw Error("Seedance 参考素材角色与类型不匹配");
  const stored=ref.storageKey;
  const assetUrl=ref.kind==="video"&&ref.url?.startsWith("asset://")?ref.url:undefined;
  if(custom&&assetUrl)throw Error("自定义视频脚本暂不支持外部 asset:// 素材 ID，请使用本地媒体文件");
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
   if(!allowed[ref.kind].includes(mimeType)&&!(custom&&
      (ref.kind==="video"&&mimeType==="video/webm"||
       ref.kind==="audio"&&["audio/flac","audio/ogg"].includes(mimeType))))
    throw Error("参考媒体格式不受支持："+mimeType);
   if(custom&&(ref.kind==="video"&&bytes>12*1024*1024||
     ref.kind==="audio"&&bytes>6*1024*1024||
     ref.kind==="image"&&bytes>8*1024*1024))
    throw Error("自定义视频脚本参考素材超过单项大小限制");
   const uploaded=await bridge.uploadFrozenBlob(blob,mimeType);
   if(uploaded.blobId!==uploaded.sha256)throw Error("参考媒体 CAS 校验失败");
   blobId=uploaded.blobId;
  }else if(!assetUrl)throw Error("参考媒体缺少文件");
  if(ref.kind==="video"&&!assetUrl&&!blobId)throw Error("参考视频冻结到 CAS 失败");
  if(mimeType&&!allowed[ref.kind].includes(mimeType)&&!(custom&&
      (ref.kind==="video"&&mimeType==="video/webm"||
       ref.kind==="audio"&&["audio/flac","audio/ogg"].includes(mimeType))))
   throw Error("参考媒体格式不受支持："+mimeType);
  if(bytes&&(ref.kind==="image"&&bytes>=30*1024*1024||
     ref.kind==="audio"&&bytes>=15*1024*1024||
     ref.kind==="video"&&bytes>200*1024*1024))
   throw Error("参考媒体超过 Seedance 文件大小限制");
  if(custom){
   if(!Number.isSafeInteger(bytes)||!bytes||
      ref.kind==="video"&&bytes>12*1024*1024||
      ref.kind==="audio"&&bytes>6*1024*1024||
      ref.kind==="image"&&bytes>8*1024*1024||
      (totalBytes+=bytes)>32*1024*1024||
      ref.kind==="image"&&(imageBytes+=bytes)>24*1024*1024)
    throw Error("自定义视频脚本参考素材超过单项或总大小限制");
  }
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
