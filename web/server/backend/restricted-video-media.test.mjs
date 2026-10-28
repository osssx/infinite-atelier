import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {validateFrozenVideoMedia,materializeFrozenVideoMedia} from "./restricted-video-media.mjs";

const mp4=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const wav=Buffer.from("524946460800000057415645666d7420","hex");
const dataUrl=(mime,bytes)=>"data:"+mime+";base64,"+bytes.toString("base64");

test("frozen video and audio use only CAS identity; read on demand as submit-only Data URLs",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-reference-media-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const blobStore=createBlobStore({db,dataDir:dir});
 const video=await blobStore.put([mp4],{mime:"video/mp4"});
 const audio=await blobStore.put([wav],{mime:"audio/wav"});
 const refs=[
  {kind:"video",role:"reference_video",blobId:video.blobId,sha256:video.sha256,
   mimeType:"video/mp4",durationMs:1234,width:640,height:360},
  {kind:"audio",role:"reference_audio",blobId:audio.blobId,sha256:audio.sha256,
   mimeType:"audio/wav",durationMs:2500}
 ];
 assert.deepEqual(validateFrozenVideoMedia(refs),refs);
 assert.ok(!JSON.stringify(refs).includes("data:"));
 const memory=await materializeFrozenVideoMedia(blobStore,refs);
 assert.deepEqual(memory.referenceVideos,[dataUrl("video/mp4",mp4)]);
 assert.deepEqual(memory.referenceAudios,[dataUrl("audio/wav",wav)]);
 assert.deepEqual(memory.referenceImages,[]);
 assert.equal(memory.firstFrame,undefined);
});
test("rejects external media URLs, non-CAS refs, oversized or unknown media before HTTP submit",async()=>{
 const id="a".repeat(64),base={kind:"video",role:"reference_video",
  blobId:id,sha256:id,mimeType:"video/mp4"};
 for(const modified of [
  {...base,assetUrl:"asset://some-provider"},
  {...base,url:"https://untrusted.example/video.mp4"},
  {...base,dataUrl:"data:video/mp4;base64,raw"},
  {...base,sha256:"b".repeat(64)},
  {...base,mimeType:"video/avi"},
  {...base,role:"first_frame"},
  {...base,blobId:"../secrets"},
  {...base,kind:"audio",role:"reference_audio",mimeType:"video/mp4"}
 ]){
  assert.throws(()=>validateFrozenVideoMedia([modified]),/video_script_media_references_invalid/);
 }
 assert.throws(()=>validateFrozenVideoMedia(Array(4).fill(base)),
  /video_script_media_count_invalid/);
 const audio={...base,kind:"audio",role:"reference_audio",mimeType:"audio/wav"};
 assert.throws(()=>validateFrozenVideoMedia(Array(4).fill(audio)),
  /video_script_media_count_invalid/);
 const large={stat:async()=>({blobId:id,sha256:id,mimeType:"video/mp4",
  byteSize:12*1024*1024+1,path:"unreachable"})};
 await assert.rejects(materializeFrozenVideoMedia(large,[base]),
  /video_script_media_size_or_mime_invalid/);
});
