import {afterEach,describe,expect,it,vi} from "vitest";
import {canvasApi,CanvasApiError} from "./canvas-api";

describe("SQLite Canvas API transport",()=>{
 afterEach(()=>vi.unstubAllGlobals());
 it("auto-establishes same-origin session then sends CSRF for writes, omitting JSON header on body-less DELETE",async()=>{
  const requests:Array<{path:string,init:RequestInit}>=[];
  vi.stubGlobal("fetch",vi.fn(async(path:string,init:RequestInit)=>{
   requests.push({path,init});
   const headers={"content-type":"application/json"};
   if(path==="/api/v1/session")return new Response(JSON.stringify({csrfToken:"csrf-local"}),{status:200,headers});
   if(path==="/api/v1/projects"&&init.method==="GET")
    return new Response(JSON.stringify({projects:[]}),{status:200,headers});
   if(path==="/api/v1/projects/id"&&init.method==="DELETE")
    return new Response(JSON.stringify({id:"id",deleted:true}),{status:200,headers});
   throw Error("unexpected "+init.method+" "+path);
  }));
  await canvasApi("/api/v1/projects");
  await canvasApi("/api/v1/projects/id","DELETE");
  expect(requests.map(r=>r.path)).toEqual(["/api/v1/session","/api/v1/projects","/api/v1/projects/id"]);
  const mutation=requests[2].init;
  expect(mutation.credentials).toBe("same-origin");
  expect(mutation.headers).toMatchObject({"x-atelier-csrf":"csrf-local"});
  expect("content-type" in (mutation.headers as Record<string,string>)).toBe(false);
  expect(mutation.body).toBeUndefined();
 });
 it("reports precise save lane while never showing the rejected canvas payload",async()=>{
  vi.stubGlobal("fetch",vi.fn(async(path:string)=>{
   if(path==="/api/v1/session")return new Response(JSON.stringify({csrfToken:"local"}),{
    headers:{"content-type":"application/json"}
   });
   return new Response(JSON.stringify({code:"invalid_request",
    details:{lane:"viewport",field:"/viewport/x",keyword:"type"}}),{
    status:400,headers:{"content-type":"application/json"}
   });
  }));
  const url="/api/v1/projects/example/viewport";
  const error=await canvasApi(url,"PUT",{expectedRevision:1,viewport:{x:null,y:0,k:1}})
   .catch(value=>value) as CanvasApiError;
  expect(error).toBeInstanceOf(CanvasApiError);
  expect(error.code).toBe("invalid_request");
  expect(error.status).toBe(400);
  expect(error.message).toContain("视口保存");
  expect(error.message).toContain("/viewport/x");
  expect(error.message).not.toContain("example");
 });

});
