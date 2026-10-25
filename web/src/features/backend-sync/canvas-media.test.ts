import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("@/lib/image-utils",()=>({readImageMeta:vi.fn(async()=>({width:400,height:200,mimeType:"image/png"}))}));
vi.mock("@/services/file-storage",()=>({
 readVideoMeta:vi.fn(async()=>({width:1920,height:1080,durationMs:8000})),
 readAudioMeta:vi.fn(async()=>({durationMs:2000}))
}));
vi.mock("@/features/backend-sync/canvas-api",()=>({
 canvasSession:vi.fn(async()=>("test-csrf"))
}));
vi.mock("@/lib/api-proxy",()=>({proxyApiUrl:(url:string)=>"/api-proxy?target="+encodeURIComponent(url)}));
import {uploadCanvasImage,uploadCanvasMedia,canvasCasUrl,canvasCasKey,
 getCanvasBlob,storeCanvasGeneratedVideo,storeCanvasGeneratedAudio} from "./canvas-media";

const sha="a".repeat(64);
const png=new Blob([Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0])],{type:"image/png"});
const wav=new Blob([new Uint8Array(44)],{type:"audio/wav"});
describe("Canvas content-addressed media transport",()=>{
 afterEach(()=>vi.unstubAllGlobals());
 it("uploads image, video and audio through authenticated stream and returns persistent same-origin identities",async()=>{
  const sent:Array<{path:string;init:RequestInit}>=[];
  vi.stubGlobal("fetch",vi.fn(async(path:string,init:RequestInit={})=>{
   sent.push({path,init});
   if(path==="/api/v1/blobs"){
    const blob=init.body as Blob;
    return new Response(JSON.stringify({blobId:sha,sha256:sha,byteSize:blob.size,mimeType:blob.type,existing:false}),
     {status:201,headers:{"content-type":"application/json"}});
   }
   if(path==="/api/v1/blobs/"+sha)
    return new Response("blob-content",{status:200,headers:{"content-type":"image/png"}});
   throw Error("unexpected "+path);
  }));
  const image=await uploadCanvasImage(png);
  expect(image).toMatchObject({storageKey:"cas:"+sha,url:"/api/v1/blobs/"+sha,width:400,height:200});
  const video=await uploadCanvasMedia(new Blob(["ftyp+sample"],{type:"video/mp4"}),"video");
  expect(video).toMatchObject({storageKey:"cas:"+sha,width:1920,height:1080,durationMs:8000});
  const audio=await storeCanvasGeneratedAudio(wav,"wav");
  expect(audio).toMatchObject({storageKey:"cas:"+sha,durationMs:2000});
  expect(sent.filter(item=>item.path==="/api/v1/blobs")).toHaveLength(3);
  for(const {init} of sent.filter(item=>item.path==="/api/v1/blobs")){
   expect(init.headers).toMatchObject({
    "Content-Type":"application/octet-stream","X-Atelier-CSRF":"test-csrf"
   });
   expect(init.credentials).toBe("same-origin");
   expect(init.body).toBeInstanceOf(Blob);
  }
  const downloaded=await getCanvasBlob("cas:"+sha);
  expect(await downloaded?.text()).toBe("blob-content");
  expect(canvasCasUrl("image:old")).toBeNull();
  expect(()=>canvasCasKey("invalid")).toThrow("canvas_invalid_blob_id");
 });
 it("rejects unsupported MIME and invalid responses; never falls back to IndexedDB",async()=>{
  const called=vi.fn();
  vi.stubGlobal("fetch",called);
  await expect(uploadCanvasImage(new Blob(["gif"],{type:"image/gif"})))
   .rejects.toThrow("unsupported_canvas_media_mime");
  await expect(uploadCanvasMedia(new Blob(["mp4"],{type:"video/mp4"}),"audio"))
   .rejects.toThrow("unsupported_canvas_media_mime");
  expect(called).not.toHaveBeenCalled();
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({
   blobId:"b".repeat(64),sha256:sha,byteSize:png.size,mimeType:"image/png"
  }),{status:201,headers:{"content-type":"application/json"}})));
  await expect(uploadCanvasImage(png)).rejects.toThrow("canvas_blob_response_invalid");
 });

 it("does not proxy data URL image input when pasting into Canvas",async()=>{
  const paths:string[]=[];
  vi.stubGlobal("fetch",vi.fn(async(path:string,init:RequestInit={})=>{
   paths.push(path);
   if(path.startsWith("data:image/"))return new Response(png,{status:200,headers:{"content-type":"image/png"}});
   return new Response(JSON.stringify({blobId:sha,sha256:sha,byteSize:png.size,mimeType:"image/png"}),
    {status:201,headers:{"content-type":"application/json"}});
  }));
  const image=await uploadCanvasImage("data:image/png;base64,abc");
  expect(image.storageKey).toBe("cas:"+sha);
  expect(paths).toEqual(["data:image/png;base64,abc","/api/v1/blobs"]);
 });
 it("generated videos persist to the backend even with a remote download URL",async()=>{
  const paths:string[]=[];
  vi.stubGlobal("fetch",vi.fn(async(path:string,init:RequestInit={})=>{
   paths.push(path);
   if(path==="/api-proxy?target=https%3A%2F%2Fvideo.example%2Fresult.mp4")
    return new Response(new Blob(["video"],{type:"video/mp4"}),{status:200});
   return new Response(JSON.stringify({blobId:sha,sha256:sha,byteSize:5,mimeType:"video/mp4"}),
    {status:201,headers:{"content-type":"application/json"}});
  }));
  const result=await storeCanvasGeneratedVideo({url:"https://video.example/result.mp4"});
  expect(result.storageKey).toBe("cas:"+sha);
  expect(paths).toEqual(["/api-proxy?target=https%3A%2F%2Fvideo.example%2Fresult.mp4","/api/v1/blobs"]);
 });
});
