import {useEffect,useState} from "react";
import {Image as ImageIcon} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";
import {acquireMediaPreview} from "@/services/media-preview-storage";
import {isCanvasCasKey} from "@/features/backend-sync/canvas-cas";
import {dramaReferenceImageKeys,type DramaAsset,type DramaAssetReference} from "./canvas-drama-pipeline";

/** Prefer the base reference, then the first configured outfit/variant in
 * asset order. Ignore obsolete slots and count unique bound image keys. */
export function assetDirectoryImages(asset:DramaAsset,references:readonly DramaAssetReference[]){
 const slots=[undefined,...(asset.variants??[]).map(v=>v.id)];
 const keys=[...new Set(slots.flatMap(variantId=>references.filter(ref=>ref.assetId===asset.id&&ref.variantId===variantId)
  .flatMap(dramaReferenceImageKeys)).filter(isCanvasCasKey))];
 return {cover:keys[0],count:keys.length};
}

export function DramaAssetDirectoryPreview({storageKey,theme}:{storageKey?:string;theme:CanvasTheme}){
 const [preview,setPreview]=useState<{key:string;url:string}|null>(null);
 useEffect(()=>{
  if(!storageKey)return;
  let active=true;
  const lease=acquireMediaPreview("image",storageKey,"visible");
  void lease.promise.then(url=>{if(active&&url)setPreview({key:storageKey,url});});
  return ()=>{active=false;lease.release();};
 },[storageKey]);
 const url=preview?.key===storageKey?preview?.url:undefined;
 return <span className="relative grid aspect-[4/3] w-full place-items-center overflow-hidden rounded-md"
  style={{background:theme.node.fill,color:theme.node.muted}}>
  {url?<img data-asset-directory-preview="" src={url} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-contain"/>:
   <span className="flex flex-col items-center gap-1 text-[11px]"><ImageIcon size={20}/>{storageKey?"参考图":"暂无参考图"}</span>}
 </span>;
}
