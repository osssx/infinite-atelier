import {describe,expect,it,vi} from "vitest";
// The recovery helper is pure; keep tests independent of browser language storage.
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
import {CanvasNodeType,type CanvasNodeData,type CanvasVideoTask} from "@/types/canvas";
import {resetInterruptedGeneration} from "./canvas-generation-helpers";

const videoTask=(provider:CanvasVideoTask["provider"],status:CanvasVideoTask["status"]="running"):CanvasVideoTask=>({
 provider,model:"legacy-model",taskId:"legacy-task-123",startedAt:123456789,status
});
const video=(provider:CanvasVideoTask["provider"],status:CanvasVideoTask["status"]="running",
 patch:Partial<CanvasNodeData["metadata"]>={}):CanvasNodeData=>({
 id:"legacy-1",type:CanvasNodeType.Video,title:"Historical video",
 position:{x:40,y:60},width:420,height:236,
 metadata:{status:"loading",videoTask:videoTask(provider,status),prompt:"keep my prompt",
  videoRequest:{prompt:"keep",modelOption:"legacy-model",mode:"text_to_video",references:[],
   durationSeconds:6,resolution:"720p",ratio:"9:16",generateAudio:true,watermark:false},
  ...patch},
} as CanvasNodeData);

describe("restore of historical browser Ark video tasks",()=>{
 it.each(["volcengine_ark","router_local"] as const)(
  "never requeues unavailable %s task; preserves remote metadata and refs",(provider)=>{
   for(const status of ["queued","running","succeeded"] as const){
    const input=video(provider,status,{videoDownloadError:"old remote file failed",lastFrameUrl:"/historical/last-frame"});
    const [result]=resetInterruptedGeneration([input]);
    expect(result.metadata).toMatchObject({
      status:"error",
      videoTask:{provider,status,taskId:"legacy-task-123",startedAt:123456789},
      videoDownloadError:"old remote file failed",lastFrameUrl:"/historical/last-frame",
      prompt:"keep my prompt"
    });
    expect(result.metadata?.errorDetails).toContain("不会自动重新生成");
    expect(result.width).toBe(input.width);
    expect(result.height).toBe(input.height);
    expect(resetInterruptedGeneration([result])[0]).toBe(result);
   }
  }
 );
 it("preserves an already downloaded video and does not clear original provider task",()=>{
  const videoWithContent=video("volcengine_ark","succeeded",{
   content:"/api/v1/blobs/"+"f".repeat(64),storageKey:"cas:"+"f".repeat(64)
  });
  const [out]=resetInterruptedGeneration([videoWithContent]);
  expect(out.metadata?.status).toBe("success");
  expect(out.metadata?.content).toBe(videoWithContent.metadata?.content);
  expect(out.metadata?.videoTask).toEqual(videoWithContent.metadata?.videoTask);
  const alreadySuccessful={...videoWithContent,metadata:{...videoWithContent.metadata,status:"success" as const}};
  expect(resetInterruptedGeneration([alreadySuccessful])[0]).toBe(alreadySuccessful);
 });
 it("keeps historical terminal failure and never overwrites an existing error",()=>{
  const original=video("router_local","failed",{status:"error",errorDetails:"Remote rejected"});
  expect(resetInterruptedGeneration([original])[0]).toBe(original);
  const withKnownFailure=video("router_local","succeeded",{status:"error",errorDetails:"Already diagnosed"});
  expect(resetInterruptedGeneration([withKnownFailure])[0]).toBe(withKnownFailure);
 });
 it("does not change the existing interruption handling for non-Ark jobs",()=>{
  for(const provider of ["openai","plugin"] as const){
   const input=video(provider,"queued");
   const [out]=resetInterruptedGeneration([input]);
   expect(out.metadata?.status).toBe("error");
   expect(out.metadata?.errorDetails).toBeTruthy();
   expect(out.metadata?.videoTask).toEqual(input.metadata?.videoTask);
  }
 });
});
