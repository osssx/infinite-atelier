import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {validCanvasNodeId} from "../canvas-node-id.mjs";

const fail=(code,statusCode=422)=>Object.assign(Error(code),{code,statusCode});
const mimeTypes=new Set(["image/png","image/jpeg","image/webp"]);
const casKey=/^cas:([a-f0-9]{64})$/;
// Ad-hoc multi-round tools clone request JSON: use tighter bounds than durable jobs.
const MAX_IMAGES=4,MAX_PER_IMAGE=8*1024*1024,MAX_TOTAL=24*1024*1024;

/** Resolve immutable images against the CURRENT server-owned project graph.
 * Client IDs alone never authorize a blob or an external URL.
 */
export async function resolveAssistantVisualContext({document,visualContext,blobStore,signal}){
 if(visualContext===undefined)return {images:[],references:[]};
 if(!visualContext||typeof visualContext!=="object"||Array.isArray(visualContext)||
  !Array.isArray(visualContext.images)||!visualContext.images.length||
  visualContext.images.length>MAX_IMAGES||!["high","low","auto",undefined].includes(visualContext.detail)||
  !blobStore)throw fail("assistant_visual_invalid");
 const nodes=document?.nodes;
 if(!Array.isArray(nodes))throw fail("assistant_visual_invalid");
 const index=new Map(nodes.map(node=>[node.id,node])),seen=new Set(),images=[],references=[];
 let total=0;
 for(const item of visualContext.images){
  if(signal?.aborted)throw fail("assistant_cancelled",499);
  if(!item||typeof item!=="object"||Array.isArray(item)||
   Object.keys(item).some(key=>!["nodeId","imageId"].includes(key))||
   !validCanvasNodeId(item.nodeId)||item.imageId!==undefined&&
   (typeof item.imageId!=="string"||!item.imageId.length||item.imageId.length>160))
   throw fail("assistant_visual_invalid");
  const node=index.get(item.nodeId);
  if(node?.type!=="image")throw fail("assistant_visual_node_unavailable");
  const variants=node.metadata?.images;
  let candidate;
  if(Array.isArray(variants)&&variants.length){
   const chosenId=item.imageId??node.metadata?.primaryImageId??(variants.length===1?variants[0]?.id:undefined);
   if(!chosenId)throw fail("assistant_visual_image_ambiguous",409);
   candidate=variants.find(v=>v.id===chosenId);
   if(!candidate)throw fail("assistant_visual_node_unavailable");
  }else{
   if(item.imageId!==undefined)throw fail("assistant_visual_node_unavailable");
   candidate=node.metadata;
  }
  const key=candidate?.storageKey;
  const match=typeof key==="string"?casKey.exec(key):null;
  if(!match)throw fail("assistant_visual_not_materialized",409);
  const referenceKey=node.id+":"+(candidate?.id??"");
  if(seen.has(referenceKey))continue;
  seen.add(referenceKey);
  const info=await blobStore.stat(match[1]);
  if(!mimeTypes.has(info.mimeType)||info.byteSize<1||info.byteSize>MAX_PER_IMAGE||
   (total+=info.byteSize)>MAX_TOTAL)throw fail("assistant_visual_image_invalid",413);
  const bytes=await readFile(info.path);
  if(bytes.length!==info.byteSize||createHash("sha256").update(bytes).digest("hex")!==info.sha256)
   throw fail("assistant_visual_image_integrity",503);
  images.push({bytes,mimeType:info.mimeType});
  references.push({nodeId:node.id,...(candidate?.id?{imageId:candidate.id}:{}),blobId:info.id});
 }
 return {images,references};
}
