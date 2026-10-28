import {beforeEach,describe,expect,it,vi} from "vitest";
import {canvasApi,CanvasApiError} from "@/features/backend-sync/canvas-api";
import {invalidateComfyObjectInfo,loadComfyObjectInfo} from "./comfy-object-info-client";

vi.mock("@/features/backend-sync/canvas-api",()=>({
 canvasApi:vi.fn(),
 CanvasApiError:class extends Error{
  constructor(public code:string,public status:number){super(code)}
 }
}));
const api=vi.mocked(canvasApi);
const info={KSampler:{input:{required:{seed:["INT",{}]}},output:["LATENT"]}};
const path=(id:string)=>"/api/v1/comfy/instances/"+id+"/object-info";
describe("ComfyUI object-info backend sync cache",()=>{
 beforeEach(()=>{invalidateComfyObjectInfo();api.mockReset();vi.useRealTimers()});
 it("uses authenticated same-origin instance route, dedupes requests, and caches by instance",async()=>{
  let release!:(value:unknown)=>void;
  api.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}) as never);
  const one=loadComfyObjectInfo("local");
  const two=loadComfyObjectInfo("local");
  expect(api).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith(path("local"));
  release({instanceId:"local",objectInfo:info});
  expect(await one).toEqual(info);
  expect(await two).toEqual(info);
  expect(await loadComfyObjectInfo("local")).toEqual(info);
  expect(api).toHaveBeenCalledTimes(1);
  api.mockResolvedValueOnce({instanceId:"second",objectInfo:{Other:{output:["IMAGE"]}}} as never);
  expect(await loadComfyObjectInfo("second")).toHaveProperty("Other");
  expect(api).toHaveBeenCalledWith(path("second"));
 });
 it("manual refresh bypasses cache, and instance edit invalidation removes stale definitions",async()=>{
  api.mockResolvedValue({instanceId:"local",objectInfo:info} as never);
  await loadComfyObjectInfo("local");
  await loadComfyObjectInfo("local",true);
  expect(api).toHaveBeenCalledTimes(2);
  invalidateComfyObjectInfo("local");
  await loadComfyObjectInfo("local");
  expect(api).toHaveBeenCalledTimes(3);
 });
 it("expires cached definitions after five minutes",async()=>{
  vi.useFakeTimers();
  api.mockResolvedValue({instanceId:"local",objectInfo:info} as never);
  await loadComfyObjectInfo("local");
  await vi.advanceTimersByTimeAsync(4*60*1000);
  await loadComfyObjectInfo("local");
  expect(api).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60*1000+1);
  await loadComfyObjectInfo("local");
  expect(api).toHaveBeenCalledTimes(2);
 });
 it("ignores superseded in-flight results after force refresh",async()=>{
  let finish!:(value:unknown)=>void;
  api.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}) as never);
  const old=loadComfyObjectInfo("local");
  api.mockResolvedValueOnce({instanceId:"local",objectInfo:{New:{output:["VIDEO"]}}} as never);
  const latest=await loadComfyObjectInfo("local",true);
  finish({instanceId:"local",objectInfo:info});
  await old;
  expect(await loadComfyObjectInfo("local")).toEqual(latest);
  expect(api).toHaveBeenCalledTimes(2);
 });
 it("rejects invalid instance IDs and malformed or mismatched responses, without caching errors",async()=>{
  await expect(loadComfyObjectInfo("http://example.com")).rejects.toThrow(/有效实例/);
  expect(api).not.toHaveBeenCalled();
  api.mockResolvedValueOnce({instanceId:"another",objectInfo:info} as never);
  await expect(loadComfyObjectInfo("local")).rejects.toThrow(/响应无效/);
  api.mockResolvedValueOnce({instanceId:"local",objectInfo:info} as never);
  await expect(loadComfyObjectInfo("local")).resolves.toEqual(info);
  expect(api).toHaveBeenCalledTimes(2);
 });
 it("maps missing instance errors to an actionable message",async()=>{
  api.mockRejectedValueOnce(new CanvasApiError("comfy_instance_not_found",404));
  await expect(loadComfyObjectInfo("gone")).rejects.toThrow(/实例不存在/);
 });
});
