import {describe,expect,it,vi} from "vitest";
import {createComfyPreviewMediaController,type ComfyPreviewMedia} from "./comfy-preview-media";

const preview=(version:number,mime:ComfyPreviewMedia["mime"]="image/png"):ComfyPreviewMedia=>({kind:"preview",version,mime});
const response=(version:number,mime="image/png")=>new Response(new Blob(["media"],{type:mime}),{headers:{"X-Preview-Version":String(version)}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve}}

describe("Comfy preview media URLs",()=>{
 it("aborts stale fetches, keeps a good URL after failure, and releases it on run change/clear",async()=>{
  const first=deferred<Response>(),second=deferred<Response>();
  const fetcher=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValueOnce(new Response(null,{status:404}));
  const revoke=vi.fn(),controller=createComfyPreviewMediaController({fetcher,createUrl:vi.fn().mockReturnValue("blob:good"),revokeUrl:revoke});
  const stale=controller.load("job-1",preview(1));
  const current=controller.load("job-1",preview(2));
  expect((fetcher.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  second.resolve(response(2));
  await expect(current).resolves.toEqual({runId:"job-1",url:"blob:good",mime:"image/png"});
  first.resolve(response(1));
  await expect(stale).resolves.toBeNull();
  await expect(controller.load("job-1",preview(3))).resolves.toBeNull();
  expect(revoke).not.toHaveBeenCalled();
  void controller.load("job-2",preview(1));
  expect(revoke).toHaveBeenCalledWith("blob:good");
  controller.clear();
 });
 it("keeps animated WebP intact unless reduced motion requests a static frame",async()=>{
  const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(response(1,"image/webp"))),decode=vi.fn().mockResolvedValue(new Blob(["frame"],{type:"image/png"}));
  const controller=createComfyPreviewMediaController({fetcher,createUrl:blob=>blob.type+":"+String(blob.size),decodeWebpFrame:decode});
  await expect(controller.load("job",preview(1,"image/webp"),false)).resolves.toMatchObject({mime:"image/webp",url:"image/webp:5"});
  expect(decode).not.toHaveBeenCalled();
  await expect(controller.load("job",preview(1,"image/webp"),true)).resolves.toMatchObject({mime:"image/png",url:"image/png:5"});
  expect(decode).toHaveBeenCalledOnce();
  controller.dispose();
 });
});
