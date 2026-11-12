import {canvasResourceReferenceToken,type CanvasResourceReference} from "@/lib/canvas/canvas-resource-references";

export type AssistantVisualReference={nodeId:string;imageId?:string};
/** Identity @ chips address nodes. Only an explicit image chip consents to
 * sending image pixels; other nodes provide read-only context, not media. */
export function collectAssistantImageMentions(text:string,references:readonly CanvasResourceReference[]){
 const candidates=new Map(references.filter(item=>item.active)
  .map(item=>[canvasResourceReferenceToken(item),item] as const));
 const images:AssistantVisualReference[]=[],foundImages=new Set<string>();
 const nodeIds:string[]=[],foundNodes=new Set<string>();
 let unresolved=false;
 const remaining=text.replace(/@\[node:[^\]]+\]/g,token=>{
  const candidate=candidates.get(token);
  if(!candidate){unresolved=true;return token;}
  if(!foundNodes.has(candidate.nodeId)){
   nodeIds.push(candidate.nodeId);
   foundNodes.add(candidate.nodeId);
  }
  const title=candidate.title.replace(/[\r\n]/g," ").slice(0,80);
  if(candidate.kind!=="image")return "【引用节点："+title+"（"+candidate.kind+"，id="+candidate.nodeId+"）】";
  const key=candidate.nodeId+":"+(candidate.imageId??"");
  if(!foundImages.has(key)){
   images.push({nodeId:candidate.nodeId,...(candidate.imageId?{imageId:candidate.imageId}:{})});
   foundImages.add(key);
  }
  return "【参考图片："+title+"】";
 });
 return {text:remaining,images,nodeIds,unresolved};
}
