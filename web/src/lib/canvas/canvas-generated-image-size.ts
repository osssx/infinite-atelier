import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";

/** Previously materialized images were created as 420x420 independently of
 * their pixel aspect ratio. Recover geometry only for those unmodified nodes.
 * Never override a user's manual resize or free-resize setting.
 */
export function recoverLegacyGeneratedImageSize(node:CanvasNodeData,width:number,height:number):CanvasNodeData{
 const meta=node.metadata;
 if(node.type!==CanvasNodeType.Image||!meta?.content||
    !(meta.comfyArtifact||meta.modelArtifact)||meta.images?.length||
    meta.freeResize||meta.naturalWidth||meta.naturalHeight||
    node.width!==420||node.height!==420||
    !Number.isSafeInteger(width)||!Number.isSafeInteger(height)||
    width<1||height<1||width>32768||height>32768||width*height>268435456)
  return node;
 const scale=Math.max(420/Math.max(width,height),220/Math.min(width,height));
 const w=Math.round(width*scale),h=Math.round(height*scale);
 return {
  ...node,width:w,height:h,
  position:{x:node.position.x+(node.width-w)/2,y:node.position.y+(node.height-h)/2},
  metadata:{...meta,naturalWidth:width,naturalHeight:height}
 };
}
