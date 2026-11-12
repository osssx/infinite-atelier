import {buildCanvasResourceReferences,type CanvasResourceReference} from "@/lib/canvas/canvas-resource-references";
import {canvasCasUrl} from "@/features/backend-sync/canvas-cas";
import {imageReferenceLabel} from "@/lib/image-reference-prompt";
import type {CanvasNodeData} from "@/types/canvas";

/** Place selected nodes at the front of @ suggestions without changing identity
 * tokens, reference labels, or the relative order of each node's outputs. */
export function prioritizeAssistantResourceReferences(
 references:readonly CanvasResourceReference[],selectedNodeIds:readonly string[]
):CanvasResourceReference[]{
 if(!selectedNodeIds.length)return [...references];
 const priorities=new Map(selectedNodeIds.map((id,index)=>[id,index]));
 const selected=selectedNodeIds.map(()=>[] as CanvasResourceReference[]);
 const rest:CanvasResourceReference[]=[];
 for(const reference of references){
  const priority=priorities.get(reference.nodeId);
  if(priority===undefined)rest.push(reference);
  else selected[priority].push(reference);
 }
 return [...selected.flat(),...rest];
}

/** Reuses normal canvas @ resources while exposing every output of a batch
 * image node as a separately addressable candidate (no guessed first image).
 */
export function buildAssistantResourceReferences(nodes:CanvasNodeData[]):CanvasResourceReference[]{
 let imageIndex=0;
 const resources=buildCanvasResourceReferences(nodes);
 const byNode=new Map(resources.map(ref=>[ref.nodeId,ref]));
 let nodeIndex=0;
 return nodes.flatMap(node=>{
  // Workflows, groups and unmaterialized media nodes remain addressable by @.
  const ref=byNode.get(node.id)??{
   id:node.id,nodeId:node.id,kind:"node" as const,
   label:"节点 "+(++nodeIndex),title:node.title||"未命名节点",active:true
  };
  if(ref.kind!=="image")return [ref];
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
