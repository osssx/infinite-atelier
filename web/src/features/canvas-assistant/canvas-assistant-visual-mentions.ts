import {canvasResourceReferenceToken,type CanvasResourceReference} from "@/lib/canvas/canvas-resource-references";

export type AssistantVisualReference={nodeId:string;imageId?:string};
/** The assistant uses the shared editor in identity mode. Only a deliberate
 * @ chip counts as consent to send image pixels. Plain-text labels never do. */
export function collectAssistantImageMentions(text:string,references:readonly CanvasResourceReference[]){
 const candidates=new Map(references.filter(item=>item.active&&item.kind==="image")
  .map(item=>[canvasResourceReferenceToken(item),item] as const));
 const images:AssistantVisualReference[]=[],found=new Set<string>();
 let unresolved=false;
 const remaining=text.replace(/@\[node:[^\]]+\]/g,token=>{
  const candidate=candidates.get(token);
  if(!candidate){unresolved=true;return token;}
  const key=candidate.nodeId+":"+(candidate.imageId??"");
  if(!found.has(key)){
   images.push({nodeId:candidate.nodeId,...(candidate.imageId?{imageId:candidate.imageId}:{})});
   found.add(key);
  }
  return "【参考图片："+candidate.title.slice(0,80)+"】";
 });
 return {text:remaining,images,unresolved};
}
