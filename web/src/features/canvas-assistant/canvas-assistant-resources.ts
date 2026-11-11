import {buildCanvasResourceReferences,type CanvasResourceReference} from "@/lib/canvas/canvas-resource-references";
import {canvasCasUrl} from "@/features/backend-sync/canvas-cas";
import {imageReferenceLabel} from "@/lib/image-reference-prompt";
import type {CanvasNodeData} from "@/types/canvas";

/** Reuses normal canvas @ resources while exposing every output of a batch
 * image node as a separately addressable candidate (no guessed first image).
 */
export function buildAssistantResourceReferences(nodes:CanvasNodeData[]):CanvasResourceReference[]{
 const index=new Map(nodes.map(node=>[node.id,node]));
 let imageIndex=0;
 return buildCanvasResourceReferences(nodes).flatMap(ref=>{
  if(ref.kind!=="image")return [ref];
  const node=index.get(ref.nodeId);
  const images=node?.metadata?.images?.filter(image=>image.status==="success"&&image.storageKey);
  if(node?.metadata?.images?.length&&!images?.length)return [];
  if(!images?.length)return [{...ref,label:imageReferenceLabel(imageIndex++)}];
  const primary=images.find(image=>image.id===node?.metadata?.primaryImageId);
  const ordered=primary?[primary,...images.filter(image=>image.id!==primary.id)]:images;
  return ordered.map(image=>({
   ...ref,id:ref.nodeId+":"+image.id,imageId:image.id,
   label:imageReferenceLabel(imageIndex++),
   title:ref.title+" · 第 "+(images.findIndex(item=>item.id===image.id)+1)+" 张",
   previewUrl:canvasCasUrl(image.storageKey)??image.content,
   active:true
  }));
 });
}
