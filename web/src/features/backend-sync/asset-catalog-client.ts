import {canvasApi} from "@/features/backend-sync/canvas-api";
import {canvasCasUrl,isCanvasCasKey} from "@/features/backend-sync/canvas-cas";
import {uploadCanvasImage,uploadCanvasMedia} from "@/features/backend-sync/canvas-media";
import {getImageBlob} from "@/services/image-storage";
import {getMediaBlob} from "@/services/file-storage";
import type {Asset} from "@/stores/use-asset-store";

export type BackendAssetCatalog={revision:number;assets:Asset[]};
const endpoint="/api/v1/assets";
const CAS_URL=/^\/api\/v1\/blobs\/([a-f0-9]{64})$/;
export const readBackendAssetCatalog=()=>canvasApi<BackendAssetCatalog>(endpoint);
export const saveBackendAssetCatalog=(revision:number,assets:Asset[])=>
 canvasApi<BackendAssetCatalog>(endpoint,"PUT",{expectedRevision:revision,assets});

const casMetaCache=new Map<string,{url:string;bytes:number;mimeType:string}>();
async function metaFor(key:string){
 const url=canvasCasUrl(key);
 if(!url)throw Error("asset_invalid_cas_key");
 const cached=casMetaCache.get(key);
 if(cached)return cached;
 const res=await fetch(url,{method:"HEAD",credentials:"same-origin",cache:"no-store"});
 if(!res.ok)throw Error("asset_media_missing:"+res.status);
 const size=Number(res.headers.get("content-length"));
 const mime=res.headers.get("content-type")?.split(";")[0]?.toLowerCase();
 if(!Number.isSafeInteger(size)||size<0||!mime)throw Error("asset_media_invalid_headers");
 const result={url,bytes:size,mimeType:mime};
 casMetaCache.set(key,result);return result;
}
async function normalizeCover(url:string){
 if(!url.startsWith("blob:")&&!url.startsWith("data:"))return url;
 const saved=await uploadCanvasImage(url);
 return saved.url;
}
/** Convert every browser-only media key to durable CAS BEFORE PUT.
 * Original LocalForage entries remain untouched for manual recovery.
 */
export async function normalizeAssetCatalogItem(asset:Asset):Promise<Asset>{
 if(asset.kind==="text")return {...asset,coverUrl:await normalizeCover(asset.coverUrl)};
 const data=asset.data;
 const direct=asset.kind==="image"?asset.data.dataUrl:asset.data.url;
 const embeddedId=CAS_URL.exec(direct)?.[1];
 const key=data.storageKey??(embeddedId?`cas:${embeddedId}`:undefined);
 let media:{url:string;bytes:number;mimeType:string;width?:number;height?:number};
 if(key&&isCanvasCasKey(key)){
  const stat=await metaFor(key);
  if(!stat.mimeType.startsWith(asset.kind+"/"))throw Error("asset_media_kind_mismatch");
  media={...stat,width:data.width,height:data.height};
 }else{
  let blob:Blob|null=null;
  if(key)blob=asset.kind==="image"?await getImageBlob(key):await getMediaBlob(key);
  if(!blob&&asset.kind==="image"&&asset.data.dataUrl.startsWith("data:image/"))
   blob=await (await fetch(asset.data.dataUrl)).blob();
  if(!blob)throw Error("asset_legacy_media_missing");
  if(blob.type!==data.mimeType)blob=new Blob([blob],{type:data.mimeType});
  const saved=asset.kind==="image"?await uploadCanvasImage(blob):await uploadCanvasMedia(blob,"video");
  media={url:saved.url,bytes:saved.bytes,mimeType:saved.mimeType,
   width:data.width||saved.width||0,height:data.height||saved.height||0};
 }
 const storedKey="cas:"+CAS_URL.exec(media.url)?.[1];
 if(!isCanvasCasKey(storedKey))throw Error("asset_media_invalid_cas_result");
 const coverUrl=asset.coverUrl.startsWith("blob:")||asset.coverUrl.startsWith("data:")?
  (asset.kind==="image"?media.url:await normalizeCover(asset.coverUrl)):asset.coverUrl;
 const normalized={
  ...asset,coverUrl,
  data:{...data,storageKey:storedKey,
   ...(asset.kind==="image"?{dataUrl:media.url}:{url:media.url}),
   bytes:media.bytes,mimeType:media.mimeType,
   width:Math.max(0,Math.floor(media.width||0)),height:Math.max(0,Math.floor(media.height||0))}
 };
 return normalized as Asset;
}
export async function normalizeAssetCatalog(assets:Asset[]){
 if(!Array.isArray(assets)||assets.length>5000)throw Error("asset_catalog_invalid");
 const result:Asset[]=[];
 for(const item of assets)result.push(await normalizeAssetCatalogItem(item));
 return result;
}
