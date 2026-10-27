import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("@/services/image-storage",()=>({getImageBlob:vi.fn()}));
import {freezeModelImages} from "./frozen-model-images";
import {getImageBlob} from "@/services/image-storage";
const hash="b".repeat(64),bytes=new Uint8Array([137,80,78,71,13,10,26,10,1,2]);
const ref=(extra:Record<string,unknown>={})=>({
 id:"i1",name:"reference.png",type:"image/png",dataUrl:"",...extra
});
const uploader=vi.fn(async(blob:Blob,mime:string)=>({
 blobId:hash,sha256:hash,byteSize:blob.size,mimeType:mime,existing:false
}));
const bridge=()=>({uploadFrozenBlob:uploader});
beforeEach(()=>{vi.mocked(getImageBlob).mockReset();uploader.mockClear()});
describe("P5.4d frozen image CAS inputs",()=>{
 it("reuses existing verified backend CAS by HEAD and avoids second uploads",async()=>{
  const fetcher=vi.fn(async(_url:string,options?:RequestInit)=>{
   expect(options?.method).toBe("HEAD");
   return new Response(null,{status:200,headers:{
    "content-type":"image/png","content-length":"10"}});
  });
  const result=await freezeModelImages([ref({storageKey:"cas:"+hash})],
   bridge() as never,{fetcher:fetcher as never});
  expect(result).toEqual([{blobId:hash,mimeType:"image/png"}]);
  expect(fetcher).toHaveBeenCalledWith("/api/v1/blobs/"+hash,
   expect.objectContaining({method:"HEAD",credentials:"same-origin"}));
  expect(uploader).not.toHaveBeenCalled();
 });
 it("freezes local browser image and includes only digest and MIME in task",async()=>{
  vi.mocked(getImageBlob).mockResolvedValueOnce(new Blob([bytes],{type:"image/png"}));
  const result=await freezeModelImages([ref({storageKey:"image:local"})],
   bridge() as never);
  expect(getImageBlob).toHaveBeenCalledWith("image:local");
  expect(uploader).toHaveBeenCalledOnce();
  expect(result).toEqual([{blobId:hash,mimeType:"image/png"}]);
  expect(JSON.stringify(result)).not.toContain("image:local");
 });
 it("rejects arbitrary remote URLs, unsupported media and missing images before upload",async()=>{
  await expect(freezeModelImages([ref({url:"https://evil.example/secret.png"})],
   bridge() as never)).rejects.toThrow("remote_image_forbidden");
  vi.mocked(getImageBlob).mockResolvedValueOnce(new Blob(["<svg/>"],{type:"image/svg+xml"}));
  await expect(freezeModelImages([ref({storageKey:"image:svg"})],
   bridge() as never)).rejects.toThrow("sqlite_model_image_invalid");
  vi.mocked(getImageBlob).mockResolvedValueOnce(null);
  await expect(freezeModelImages([ref({storageKey:"image:missing"})],
   bridge() as never)).rejects.toThrow("remote_image_forbidden");
  expect(uploader).not.toHaveBeenCalled();
 });
 it("fails closed on malformed upload digest and too many references",async()=>{
  const bad={uploadFrozenBlob:vi.fn(async()=>({
   blobId:"not-a-hash",sha256:"not-a-hash",byteSize:10,mimeType:"image/png",existing:false
  }))};
  vi.mocked(getImageBlob).mockResolvedValueOnce(new Blob([bytes],{type:"image/png"}));
  await expect(freezeModelImages([ref({storageKey:"image:local"})],
   bad as never)).rejects.toThrow("upload_invalid");
  await expect(freezeModelImages(Array.from({length:9},(_,i)=>ref({id:String(i)})),
   bridge() as never)).rejects.toThrow("count_invalid");
 });
});
