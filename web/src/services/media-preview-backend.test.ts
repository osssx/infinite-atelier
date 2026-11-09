import {afterEach,describe,expect,it,vi} from "vitest";
const local=vi.hoisted(()=>({reads:vi.fn(),writes:vi.fn()}));
vi.mock("localforage",()=>({default:{createInstance:()=>({
 getItem:local.reads,setItem:local.writes,removeItem:vi.fn()
})}}));
vi.mock("@/lib/perf-mode",()=>({PERF_MODE:false}));
import {acquireMediaPreview,getExistingMediaPreview,resolveMediaPreview,setPreviewGenerationSuspended} from "./media-preview-storage";

describe("SQLite CAS server preview lookup",()=>{
 afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();local.reads.mockClear();local.writes.mockClear()});
 it("fetches image & video poster from server without reading or writing browser preview storage",async()=>{
  const fetched:string[]=[];
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>{
   fetched.push(url);
   return new Response(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:"image/png"}),{status:200});
  }));
  vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:preview");
  const videoKey="cas:"+"a".repeat(64);
  const imageKey="cas:"+"b".repeat(64);
  expect(await getExistingMediaPreview("video",videoKey)).toBe("blob:preview");
  expect(await resolveMediaPreview("video",videoKey)).toBe("blob:preview");
  expect(await resolveMediaPreview("image",imageKey)).toBe("blob:preview");
  expect(fetched).toEqual([
   "/api/v1/blobs/"+"a".repeat(64)+"/preview",
   "/api/v1/blobs/"+"b".repeat(64)+"/preview"
  ]);
  expect(local.reads).not.toHaveBeenCalled();
  expect(local.writes).not.toHaveBeenCalled();
 });
 it("does not attempt raw video fallback if preview service rejects input",async()=>{
  vi.stubGlobal("fetch",vi.fn(async()=>new Response("unavailable",{status:503})));
  const videoKey="cas:"+"c".repeat(64);
  expect(await resolveMediaPreview("video",videoKey)).toBeNull();
  expect(local.reads).not.toHaveBeenCalled();
 });
 it("does not read IndexedDB, fetch legacy keys, or call an original-blob loader",async()=>{
  const fetchMock=vi.fn();
  const loadBlob=vi.fn(async()=>new Blob(["original"]));
  vi.stubGlobal("fetch",fetchMock);
  expect(await getExistingMediaPreview("image","image:legacy")).toBeNull();
  // @ts-expect-error The preview API has no original-media loader parameter.
  expect(await resolveMediaPreview("image","image:legacy",loadBlob)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(loadBlob).not.toHaveBeenCalled();
  expect(local.reads).not.toHaveBeenCalled();
  expect(local.writes).not.toHaveBeenCalled();
 });
 it("runs up to four independent preview requests concurrently",async()=>{
  let active=0,peak=0;
  vi.stubGlobal("requestIdleCallback",(callback:()=>void)=>setTimeout(callback,0));
  vi.stubGlobal("fetch",vi.fn(async()=>{
   active+=1;peak=Math.max(peak,active);
   await new Promise(resolve=>setTimeout(resolve,10));
   active-=1;
   return new Response(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:"image/png"}),{status:200});
  }));
  vi.spyOn(URL,"createObjectURL").mockImplementation((()=>`blob:preview-${Math.random()}`) as typeof URL.createObjectURL);
  const keys=Array.from({length:7},(_,index)=>"cas:"+String(index+1).repeat(64));
  await Promise.all(keys.map(key=>resolveMediaPreview("image",key)));
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
 });
 it("cancels a queued preview when its last component lease is released",async()=>{
  const fetchMock=vi.fn(async()=>new Response(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:"image/png"}),{status:200}));
  vi.stubGlobal("fetch",fetchMock);
  vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:resubscribed-preview");
  setPreviewGenerationSuspended(true,"pan");
  const key="cas:"+"d".repeat(64);
  const cancelled=acquireMediaPreview("image",key);
  cancelled.release();
  const replacement=acquireMediaPreview("image",key);
  setPreviewGenerationSuspended(false,"pan");
  expect(await cancelled.promise).toBeNull();
  expect(await replacement.promise).toBe("blob:resubscribed-preview");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  replacement.release();
 });
 it("keeps an in-use object URL out of LRU eviction",async()=>{
  let serial=0;
  const revoked:string[]=[];
  vi.stubGlobal("requestIdleCallback",(callback:()=>void)=>setTimeout(callback,0));
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:"image/png"}),{status:200})));
  vi.spyOn(URL,"createObjectURL").mockImplementation(()=>`blob:lru-${serial++}`);
  vi.spyOn(URL,"revokeObjectURL").mockImplementation((url)=>{revoked.push(url)});
  const pinned=acquireMediaPreview("image","cas:"+"e".repeat(64));
  const pinnedUrl=await pinned.promise;
  const rest=Array.from({length:256},(_,index)=>"cas:"+index.toString(16).padStart(64,"0"));
  await Promise.all(rest.map((key)=>resolveMediaPreview("image",key)));
  expect(revoked).not.toContain(pinnedUrl);
  pinned.release();
 });
});
