import {afterEach,describe,expect,it,vi} from "vitest";
const local=vi.hoisted(()=>({reads:vi.fn(),writes:vi.fn()}));
vi.mock("localforage",()=>({default:{createInstance:()=>({
 getItem:local.reads,setItem:local.writes,removeItem:vi.fn()
})}}));
vi.mock("@/lib/perf-mode",()=>({PERF_MODE:false}));
import {getExistingMediaPreview,resolveMediaPreview} from "./media-preview-storage";

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
  expect(await resolveMediaPreview("video",videoKey,()=>{throw Error("full video should not load")})).toBe("blob:preview");
  expect(await resolveMediaPreview("image",imageKey,()=>{throw Error("full image should not load")})).toBe("blob:preview");
  expect(fetched).toEqual([
   "/api/v1/blobs/"+"a".repeat(64)+"/preview",
   "/api/v1/blobs/"+"b".repeat(64)+"/preview"
  ]);
  expect(local.reads).not.toHaveBeenCalled();
  expect(local.writes).not.toHaveBeenCalled();
 });
 it("does not attempt raw video fallback if preview service rejects input",async()=>{
  vi.stubGlobal("fetch",vi.fn(async()=>new Response("unavailable",{status:503})));
  const videoKey="cas:"+"c".repeat(64),fullLoad=vi.fn();
  expect(await resolveMediaPreview("video",videoKey,fullLoad)).toBeNull();
  expect(fullLoad).not.toHaveBeenCalled();
  expect(local.reads).not.toHaveBeenCalled();
 });
});
