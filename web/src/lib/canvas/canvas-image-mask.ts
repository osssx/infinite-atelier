import {CanvasNodeType,type CanvasImageMask,type CanvasNodeData} from "@/types/canvas";

export type ResolvedCanvasImage={id?:string;storageKey?:string;content?:string;mimeType?:string;width?:number;height?:number;mask?:CanvasImageMask};
/** Resolves one image deterministically. An explicit id wins; ambiguous batches never guess. */
export function resolveCanvasImage(node:CanvasNodeData,imageId?:string):ResolvedCanvasImage|undefined{
 if(node.type!==CanvasNodeType.Image)return undefined;
 const images=node.metadata?.images;
 if(images?.length){
  const selected=imageId?images.find(image=>image.id===imageId):node.metadata?.primaryImageId?
   images.find(image=>image.id===node.metadata?.primaryImageId):images.length===1?images[0]:undefined;
  return selected?{id:selected.id,storageKey:selected.storageKey,content:selected.content,mimeType:selected.mimeType,width:selected.naturalWidth,height:selected.naturalHeight,mask:selected.mask}:undefined;
 }
 if(imageId)return undefined;
 return {storageKey:node.metadata?.storageKey,content:node.metadata?.content,mimeType:node.metadata?.mimeType,width:node.metadata?.naturalWidth,height:node.metadata?.naturalHeight,mask:node.metadata?.mask};
}
export function isCanvasImageMaskValid(image:ResolvedCanvasImage|undefined):image is ResolvedCanvasImage&{mask:CanvasImageMask}{
 return Boolean(image?.mask?.storageKey&&image.storageKey&&image.mask.sourceStorageKey===image.storageKey&&
  (!image.mask.sourceImageId||image.mask.sourceImageId===image.id)&&
  Number.isSafeInteger(image.mask.width)&&image.mask.width>0&&Number.isSafeInteger(image.mask.height)&&image.mask.height>0&&
  (!image.width||image.mask.width===image.width)&&(!image.height||image.mask.height===image.height));
}
export function resolveCanvasImageMask(node:CanvasNodeData,imageId?:string){const image=resolveCanvasImage(node,imageId);return isCanvasImageMaskValid(image)?{image,mask:image.mask}:undefined}
