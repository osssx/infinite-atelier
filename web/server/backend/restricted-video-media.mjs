import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {validateFrozenVideoImages,materializeFrozenVideoImages} from "./restricted-video-images.mjs";

const invalid=code=>Object.assign(Error(code),{code,statusCode:422,confirmedNotAccepted:true});
const HASH=/^[a-f0-9]{64}$/;
const mediaTypes={
 video:new Set(["video/mp4","video/quicktime","video/webm"]),
 audio:new Set(["audio/wav","audio/mpeg","audio/flac","audio/ogg"])
};
const limits={video:12*1024*1024,audio:6*1024*1024};
const MAX_ALL=32*1024*1024;
const MAX_ITEMS={video:3,audio:3};

/** Keep only immutable CAS identity and media metadata in persisted jobs.
 * Binary bytes and URLs must never be present in a snapshot.
 */
export function validateFrozenVideoMedia(references){
 if(references===undefined)return [];
 if(!Array.isArray(references)||references.length>12)
  throw invalid("video_script_media_references_invalid");
 const images=references.filter(ref=>ref?.kind==="image");
 validateFrozenVideoImages(images);
 const count={video:0,audio:0};
 return references.map(ref=>{
  if(ref?.kind==="image")return validateFrozenVideoImages([ref])[0];
  if(!ref||typeof ref!=="object"||Array.isArray(ref)||
    !Object.hasOwn(mediaTypes,ref.kind)||
    ref.role!==(ref.kind==="video"?"reference_video":"reference_audio")||
    !mediaTypes[ref.kind].has(ref.mimeType)||
    typeof ref.blobId!=="string"||!HASH.test(ref.blobId)||
    ref.sha256!==ref.blobId||
    Object.keys(ref).some(k=>!["kind","role","blobId","sha256","mimeType",
      "width","height","durationMs"].includes(k))||
    ref.durationMs!==undefined&&(!Number.isSafeInteger(ref.durationMs)||ref.durationMs<1||ref.durationMs>3600000)||
    (ref.width!==undefined||ref.height!==undefined)&&
      (ref.kind!=="video"||
       (ref.width!==undefined&&(!Number.isSafeInteger(ref.width)||ref.width<1||ref.width>16384))||
       (ref.height!==undefined&&(!Number.isSafeInteger(ref.height)||ref.height<1||ref.height>16384))))
   throw invalid("video_script_media_references_invalid");
  if(++count[ref.kind]>MAX_ITEMS[ref.kind])
   throw invalid("video_script_media_count_invalid");
  return {kind:ref.kind,role:ref.role,blobId:ref.blobId,
   sha256:ref.blobId,mimeType:ref.mimeType,
   ...(ref.durationMs?{durationMs:ref.durationMs}:{}),
   ...(ref.width?{width:ref.width}:{}),
   ...(ref.height?{height:ref.height}:{})};
 });
}

/** Media is materialized in memory for the one trusted, billable POST.
 * For large / proprietary asset-upload APIs, use a separate durable provider
 * adapter. Replaying uncertain remote uploads is not safe.
 */
export async function materializeFrozenVideoMedia(blobStore,references){
 const verified=validateFrozenVideoMedia(references);
 const frames=await materializeFrozenVideoImages(blobStore,verified.filter(x=>x.kind==="image"));
 const result={...frames,referenceVideos:[],referenceAudios:[]};
 // Count all CAS bytes, including frames, before allocating video buffers.
 let total=0;
 const checked=[];
 for(const ref of verified){
  const info=await blobStore.stat(ref.blobId);
  if(info.mimeType!==ref.mimeType||info.sha256!==ref.sha256||info.byteSize<1||
    (ref.kind!=="image"&&info.byteSize>limits[ref.kind]))
   throw invalid("video_script_media_size_or_mime_invalid");
  total+=info.byteSize;
  if(total>MAX_ALL)throw invalid("video_script_media_total_too_large");
  checked.push({ref,info});
 }
 for(const {ref,info} of checked){
  if(ref.kind==="image")continue;
  const bytes=await readFile(info.path);
  if(bytes.length!==info.byteSize||
   createHash("sha256").update(bytes).digest("hex")!==ref.sha256)
   throw invalid("video_script_media_integrity_invalid");
  const dataUrl="data:"+ref.mimeType+";base64,"+bytes.toString("base64");
  if(ref.kind==="video")result.referenceVideos.push(dataUrl);
  else result.referenceAudios.push(dataUrl);
 }
 return result;
}
