import {afterEach,describe,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({
 saveAs:vi.fn(),
 flush:vi.fn(async()=>{}),
 session:vi.fn(async()=>"csrf-local")
}));
vi.mock("file-saver",()=>({saveAs:state.saveAs}));
vi.mock("@/stores/canvas/use-canvas-store",()=>({
 awaitCanvasStorePersistence:state.flush
}));
vi.mock("./canvas-api",()=>({
 CanvasApiError:class CanvasApiError extends Error{
  constructor(public code:string,public status:number){super(code)}
 },
 canvasSession:state.session
}));
import {exportSqliteCanvasProject,importSqliteCanvasProject} from "./canvas-project-archive";

describe("SQLite Canvas ZIP UI transport",()=>{
 afterEach(()=>{
  vi.unstubAllGlobals();
  vi.clearAllMocks();
 });
 it("exports through authenticated same-origin API without browser IndexedDB",async()=>{
  const requests:Array<{url:string;init:RequestInit}>=[];
  vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
   requests.push({url,init});
   return new Response(new Blob(["PK ZIP data"],{type:"application/zip"}),{
    status:200,headers:{"content-type":"application/zip"}
   });
  }));
  await exportSqliteCanvasProject("project_one","Some:Thing?");
  expect(state.flush).toHaveBeenCalledOnce();
  expect(requests).toMatchObject([{url:"/api/v1/projects/project_one/archive",
   init:{credentials:"same-origin",cache:"no-store"}}]);
  expect(state.saveAs).toHaveBeenCalledOnce();
  expect(state.saveAs.mock.calls[0][1]).toBe("Some_Thing_.atelier.zip");
 });

 it("streams ZIP response directly to the browser disk writer when supported",async()=>{
  const chunks:Uint8Array[]=[];
  const close=vi.fn(async()=>{}),abort=vi.fn(async()=>{});
  const picker=vi.fn(async()=>({createWritable:async()=>({
   write:async(bytes:Uint8Array)=>{chunks.push(bytes)},close,abort
  })}));
  vi.stubGlobal("window",{showSaveFilePicker:picker});
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(new ReadableStream({
   start(controller){controller.enqueue(new Uint8Array([80,75,3,4]));controller.enqueue(new Uint8Array([6,7,8]));controller.close()}
  }),{status:200,headers:{"content-type":"application/zip"}})));
  await exportSqliteCanvasProject("project_large","Very Large");
  expect(picker).toHaveBeenCalledOnce();
  expect(chunks.map(chunk=>[...chunk])).toEqual([[80,75,3,4],[6,7,8]]);
  expect(close).toHaveBeenCalledOnce();
  expect(abort).not.toHaveBeenCalled();
  expect(state.saveAs).not.toHaveBeenCalled();
 });
 it("uploads the exact archive with CSRF and returns a new backend ID",async()=>{
  const file=new File(["ZIP"],"project.atelier.zip",{type:"application/zip"});
  vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
   expect(url).toBe("/api/v1/projects/import-archive");
   expect(init.method).toBe("POST");
   expect(init.body).toBe(file);
   expect(init.credentials).toBe("same-origin");
   expect(init.headers).toMatchObject({"x-atelier-csrf":"csrf-local",
    "content-type":"application/zip"});
   return new Response(JSON.stringify({id:"new-sqlite-project",title:"Restored",mediaCount:2}),{
    status:201,headers:{"content-type":"application/json"}
   });
  }));
  expect(await importSqliteCanvasProject(file)).toEqual({
   id:"new-sqlite-project",title:"Restored",mediaCount:2
  });
  expect(state.flush).toHaveBeenCalledOnce();
 });
 it("fails locally on oversized input, preserving existing project list",async()=>{
  const fake={name:"large.zip",size:2*1024*1024*1024+1} as File;
  const fetcher=vi.fn();
  vi.stubGlobal("fetch",fetcher);
  await expect(importSqliteCanvasProject(fake)).rejects.toThrow("archive_invalid_file_or_size");
  expect(state.flush).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
 });
 it("reports archive checksum error without claiming import success",async()=>{
  const file=new File(["bad"],"broken.zip",{type:"application/zip"});
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(
   JSON.stringify({code:"archive_media_integrity_error"}),
   {status:422,headers:{"content-type":"application/json"}}
  )));
  await expect(importSqliteCanvasProject(file)).rejects.toThrow("archive_media_integrity_error");
 });
});
