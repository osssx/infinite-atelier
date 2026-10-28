import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";

const error=code=>Object.assign(Error(code),{code,statusCode:422,confirmedNotAccepted:true});
const MIME=new Set(["image/png","image/jpeg","image/webp"]);
const ROLE=new Set(["first_frame","last_frame","reference_image"]);
const MAX_IMAGE_BYTES=8*1024*1024;
const MAX_TOTAL_BYTES=24*1024*1024;

/** Strict, immutable CAS-only references. No browser URL, data URI, asset IDs,
 * local paths or inline media is accepted inside the durable JobSnapshot.
 */
export function validateFrozenVideoImages(references){
 if(references===undefined)return [];
 if(!Array.isArray(references)||references.length>6)throw error("video_script_images_invalid");
 let first=0,last=0,regular=0;
 return references.map(ref=>{
  if(!ref||typeof ref!=="object"||Array.isArray(ref)||
   Object.keys(ref).some(k=>!["kind","role","blobId","sha256","mimeType","width","height"].includes(k))||
   ref.kind!=="image"||!ROLE.has(ref.role)||
   !MIME.has(ref.mimeType)||typeof ref.blobId!=="string"||
   !/^[a-f0-9]{64}$/.test(ref.blobId)||ref.sha256!==ref.blobId||
   (ref.width!==undefined&&(!Number.isSafeInteger(ref.width)||ref.width<1||ref.width>16384))||
   (ref.height!==undefined&&(!Number.isSafeInteger(ref.height)||ref.height<1||ref.height>16384)))
   throw error("video_script_images_invalid");
  if(ref.role==="first_frame")first++;
  else if(ref.role==="last_frame")last++;
  else regular++;
  if(first>1||last>1||regular>4)throw error("video_script_images_count_invalid");
  return {kind:"image",role:ref.role,blobId:ref.blobId,sha256:ref.blobId,
   mimeType:ref.mimeType,...(ref.width?{width:ref.width}:{}),
   ...(ref.height?{height:ref.height}:{})};
 });
}

/** Only the trusted submit stage materializes image bytes. The Base64 data
 * exists in process memory for one request, never in SQLite or an artifact URL.
 */
export async function materializeFrozenVideoImages(blobStore,references){
 const verified=validateFrozenVideoImages(references);
 const result={firstFrame:undefined,lastFrame:undefined,referenceImages:[]};
 let total=0;
 for(const ref of verified){
  const stat=await blobStore.stat(ref.blobId);
  total+=stat.byteSize;
  if(stat.mimeType!==ref.mimeType||stat.byteSize<1||
     stat.byteSize>MAX_IMAGE_BYTES||total>MAX_TOTAL_BYTES)
   throw error("video_script_image_size_or_mime_invalid");
  const bytes=await readFile(stat.path);
  if(bytes.length!==stat.byteSize||
     createHash("sha256").update(bytes).digest("hex")!==ref.blobId)
   throw error("video_script_image_integrity_invalid");
  const value="data:"+ref.mimeType+";base64,"+bytes.toString("base64");
  if(ref.role==="first_frame")result.firstFrame=value;
  else if(ref.role==="last_frame")result.lastFrame=value;
  else result.referenceImages.push(value);
 }
 return result;
}
