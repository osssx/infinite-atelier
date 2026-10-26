import {describe,it,expect,vi,afterEach} from "vitest";
vi.mock("@/services/image-storage",()=>({getImageBlob:vi.fn()}));
vi.mock("@/services/file-storage",()=>({getMediaBlob:vi.fn()}));
import {freezeSeedanceReferences} from "./seedance-frozen-references";
import type {VideoGenerationRequest} from "@/services/api/video/types";
import type {createSqliteComfyBridge} from "./sqlite-comfy-bridge";
const hash="a".repeat(64);
const cas="cas:"+hash;
const asBridge=()=>({uploadFrozenBlob:vi.fn(async(blob:Blob,mimeType:string)=>({
 blobId:hash,sha256:hash,byteSize:blob.size,mimeType,existing:false
 }))}) as unknown as Pick<ReturnType<typeof createSqliteComfyBridge>,"uploadFrozenBlob">;
const request=(mode:VideoGenerationRequest["mode"],references:VideoGenerationRequest["references"]):VideoGenerationRequest=>({
 mode,modelOption:"doubao-seedance-2-0-260128",prompt:"snow",
 references,resolution:"720p",ratio:"16:9",durationSeconds:6,generateAudio:true,watermark:false
});
afterEach(()=>vi.unstubAllGlobals());
describe("P4.4 frozen Seedance media references",()=>{
 it("pins first/last frames to immutable CAS hashes without reading image bytes into browser",async()=>{
  const fetcher=vi.fn(async(_url:string,_options?:RequestInit)=>new Response(null,{status:200,
   headers:{"content-type":"image/png","content-length":"2500"}}));
  const bridge=asBridge();
  const refs=await freezeSeedanceReferences(request("first_last_frame",[
   {id:"first",kind:"image",role:"first_frame",storageKey:cas},
   {id:"last",kind:"image",role:"last_frame",storageKey:cas}
  ]),bridge,{fetcher:fetcher as unknown as typeof fetch});
  expect(refs).toEqual([
   {kind:"image",role:"first_frame",blobId:hash,sha256:hash,mimeType:"image/png"},
   {kind:"image",role:"last_frame",blobId:hash,sha256:hash,mimeType:"image/png"}
  ]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/blobs/"+hash);
  expect(bridge.uploadFrozenBlob).not.toHaveBeenCalled();
 });
 it("uploads previously unpinned image/audio as CAS and sends only immutable digests",async()=>{
  const bridge=asBridge();
  const refs=await freezeSeedanceReferences(request("omni_reference",[
   {id:"pic",kind:"image",role:"reference_image",storageKey:"image:old"},
   {id:"sound",kind:"audio",role:"reference_audio",storageKey:"audio:old",durationMs:3200}
  ]),bridge,{
   readImage:async()=>new Blob(["png-content"],{type:"image/png"}),
   readMedia:async()=>new Blob(["wav-content"],{type:"audio/wav"})
  });
  expect(refs.map(r=>r.kind)).toEqual(["image","audio"]);
  expect(bridge.uploadFrozenBlob).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(refs)).not.toContain("wav-content");
  expect(refs[1].durationMs).toBe(3200);
 });
 it("accepts Ark asset identity for reference video; refuses private loopback video",async()=>{
  const bridge=asBridge();
  const frozen=await freezeSeedanceReferences(request("omni_reference",[
   {id:"v",kind:"video",role:"reference_video",url:"asset://ark-media-1",durationMs:4000}
  ]),bridge);
  expect(frozen).toEqual([{kind:"video",role:"reference_video",
   assetUrl:"asset://ark-media-1",durationMs:4000}]);
  await expect(freezeSeedanceReferences(request("omni_reference",[
   {id:"v",kind:"video",role:"reference_video",url:"/api/v1/blobs/"+hash,storageKey:cas}
  ]),bridge)).rejects.toThrow("请先上传至方舟素材库");
 });
 it("fails before GPU generation on missing CAS or MIME/role mismatch",async()=>{
  const bridge=asBridge();
  const fetcher=vi.fn(async()=>new Response(null,{status:200,
   headers:{"content-type":"audio/wav","content-length":"100"}}));
  await expect(freezeSeedanceReferences(request("first_frame",[
   {id:"first",kind:"image",role:"first_frame",storageKey:cas}
  ]),bridge,{fetcher:fetcher as unknown as typeof fetch})).rejects.toThrow("格式不受支持");
  await expect(freezeSeedanceReferences(request("omni_reference",[
   {id:"sound",kind:"audio",role:"reference_video",storageKey:cas}
  ]),bridge)).rejects.toThrow("角色与类型不匹配");
 });
});
