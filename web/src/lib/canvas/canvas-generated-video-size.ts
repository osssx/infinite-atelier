import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";

type SizeSource="poster"|"video";
const valid=(w:number,h:number)=>Number.isSafeInteger(w)&&Number.isSafeInteger(h)&&
 w>0&&h>0&&w<=32768&&h<=32768&&w*h<=268435456;

/** Only the original fixed-size 420x236 generated nodes can be reflowed.
 * A cached poster can give an accurate ratio without decoding 200 videos;
 * its scaled dimensions are NOT incorrectly recorded as native resolution.
 */
export function recoverLegacyGeneratedVideoSize(
 node:CanvasNodeData,width:number,height:number,source:SizeSource
):CanvasNodeData{
 const meta=node.metadata;
 if(node.type!==CanvasNodeType.Video||!meta?.content||
    !(meta.comfyArtifact||meta.modelArtifact)||meta.freeResize||
    !valid(width,height))return node;
 if(meta.legacyVideoAspectRecovered){
  if(source==="video"&&!meta.naturalWidth&&!meta.naturalHeight)
   return {...node,metadata:{...meta,naturalWidth:width,naturalHeight:height}};
  return node;
 }
 if(meta.naturalWidth||meta.naturalHeight||node.width!==420||node.height!==236)return node;
 const scale=Math.max(420/Math.max(width,height),220/Math.min(width,height));
 const w=Math.round(width*scale),h=Math.round(height*scale);
 return {
  ...node,width:w,height:h,
  position:{x:node.position.x+(node.width-w)/2,y:node.position.y+(node.height-h)/2},
  metadata:{...meta,legacyVideoAspectRecovered:true,
   ...(source==="video"?{naturalWidth:width,naturalHeight:height}:{})}
 };
}
