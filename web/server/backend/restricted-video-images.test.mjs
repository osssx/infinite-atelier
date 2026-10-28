import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {validateFrozenVideoImages,materializeFrozenVideoImages} from "./restricted-video-images.mjs";

const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082","hex");

test("freeze reference payload contains only immutable CAS hashes; materialization supplies data URLs in memory",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"video-frames-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const blobStore=createBlobStore({db,dataDir:dir});
 const saved=await blobStore.put([png],{mime:"image/png"});
 const refs=[
  {kind:"image",role:"first_frame",blobId:saved.blobId,sha256:saved.sha256,mimeType:"image/png"},
  {kind:"image",role:"last_frame",blobId:saved.blobId,sha256:saved.sha256,mimeType:"image/png"},
  {kind:"image",role:"reference_image",blobId:saved.blobId,sha256:saved.sha256,mimeType:"image/png"}
 ];
 assert.deepEqual(validateFrozenVideoImages(refs),refs);
 assert.ok(!JSON.stringify(refs).includes("data:image/"));
 const data=await materializeFrozenVideoImages(blobStore,refs);
 assert.equal(data.firstFrame,"data:image/png;base64,"+png.toString("base64"));
 assert.equal(data.lastFrame,data.firstFrame);
 assert.deepEqual(data.referenceImages,[data.firstFrame]);
 assert.deepEqual(await materializeFrozenVideoImages(blobStore,[]),{
  firstFrame:undefined,lastFrame:undefined,referenceImages:[]});
 const invalid=[
  {...refs[0],assetUrl:"asset://external"},
  {...refs[0],url:"http://169.254.169.254"},
  {...refs[0],dataUrl:"data:image/png;base64,123"},
  {...refs[0],sha256:"a".repeat(64)},
  {...refs[0],mimeType:"video/mp4"},
  {...refs[0],role:"reference_video"},
  {...refs[0],blobId:"/etc/passwd"}
 ];
 for(const ref of invalid)assert.throws(
  ()=>validateFrozenVideoImages([ref]),/video_script_images_invalid/);
 assert.throws(()=>validateFrozenVideoImages([refs[0],refs[0]]),
  /video_script_images_count_invalid/);
 assert.throws(()=>validateFrozenVideoImages(Array(7).fill(refs[2])),
  /video_script_images_invalid/);
 await assert.rejects(materializeFrozenVideoImages(blobStore,[{
  ...refs[0],blobId:"a".repeat(64),sha256:"a".repeat(64)
 }]),/blob_not_found/);
});
