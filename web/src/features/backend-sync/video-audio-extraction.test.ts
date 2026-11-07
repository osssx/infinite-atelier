import {describe,expect,it,vi} from "vitest";
import {createVideoAudioExtractionController,extractedAudioMetadata,videoAudioSourceId,audioExtractionErrorMessage,type ExtractedAudio} from "./video-audio-extraction";
import type {CanvasNodeData} from "@/types/canvas";

const hash="a".repeat(64),other="b".repeat(64);
const video:CanvasNodeData={id:"video",type:"video",title:"Clip",position:{x:0,y:0},width:320,height:180,
 metadata:{content:"/api/v1/blobs/"+hash,storageKey:"cas:"+hash}};
const output:ExtractedAudio={blobId:other,mimeType:"audio/mp4",byteSize:200,durationMs:1000};
const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};
function fixture(){
 let source:CanvasNodeData|undefined=video;
 const done=deferred<ExtractedAudio>(),onResult=vi.fn(),onError=vi.fn(),onChange=vi.fn();
 const request=vi.fn((_source:CanvasNodeData,_signal:AbortSignal)=>done.promise),saveSource=vi.fn(async()=>{});
 const controller=createVideoAudioExtractionController({projectId:"p",getSource:()=>source,saveSource,request,onResult,onError,onChange});
 return {controller,done,onResult,onError,onChange,request,saveSource,setSource:(next:typeof source)=>{source=next}};
}
describe("video audio extraction page lifecycle",()=>{
 it("deduplicates synchronously, saves before submitting and commits once",async()=>{
  const f=fixture();const first=f.controller.start(video);await f.controller.start(video);
  expect(f.saveSource).toHaveBeenCalledOnce();expect(f.request).toHaveBeenCalledOnce();
  expect(f.onChange).toHaveBeenLastCalledWith(new Set([video.id]));
  f.done.resolve(output);await first;
  expect(f.onResult).toHaveBeenCalledExactlyOnceWith(video,output);
  expect(f.onChange).toHaveBeenLastCalledWith(new Set());
 });
 it("waits for persistence and never submits after save failure",async()=>{
  const f=fixture();f.saveSource.mockRejectedValueOnce(Error("save_failed"));
  await f.controller.start(video);expect(f.request).not.toHaveBeenCalled();expect(f.onError).toHaveBeenCalledOnce();
 });
 it("cancel aborts transport and silently discards even a late successful result",async()=>{
  const f=fixture(),first=f.controller.start(video);await Promise.resolve();
  const signal=f.request.mock.calls[0][1];f.controller.cancel(video.id);
  expect(signal.aborted).toBe(true);f.done.resolve(output);await first;
  expect(f.onResult).not.toHaveBeenCalled();expect(f.onError).not.toHaveBeenCalled();
 });
 it.each(["delete","replace","navigate"])("discards obsolete results after %s",async kind=>{
  const f=fixture(),first=f.controller.start(video);await Promise.resolve();
  if(kind==="replace")f.setSource({...video,metadata:{storageKey:"cas:"+other,content:"/api/v1/blobs/"+other}});
  else f.setSource(undefined);
  if(kind==="navigate")f.controller.dispose();else f.controller.reconcile();
  expect(f.request.mock.calls[0][1].aborted).toBe(true);
  f.done.resolve(output);await first;expect(f.onResult).not.toHaveBeenCalled();
 });
 it("checks identity again after response even before reconcile runs",async()=>{
  const f=fixture(),first=f.controller.start(video);await Promise.resolve();f.setSource(undefined);
  f.done.resolve(output);await first;expect(f.onResult).not.toHaveBeenCalled();
 });
 it("old operation cleanup does not clear a newer operation on the same video",async()=>{
  const f=fixture(),old=f.controller.start(video);await Promise.resolve();f.controller.cancel(video.id);
  const next=deferred<ExtractedAudio>();f.request.mockImplementationOnce(()=>next.promise);
  const current=f.controller.start(video);await Promise.resolve();f.done.resolve(output);await old;
  expect(f.onChange).toHaveBeenLastCalledWith(new Set([video.id]));
  expect(f.onResult).not.toHaveBeenCalled();next.resolve(output);await current;
  expect(f.onResult).toHaveBeenCalledOnce();
 });
 it("creates durable audio identity and source metadata without inheriting video fields",()=>{
  expect(extractedAudioMetadata(output,video)).toEqual({content:"/api/v1/blobs/"+other,storageKey:"cas:"+other,
   status:"success",mimeType:"audio/mp4",bytes:200,durationMs:1000,audioExtraction:{sourceNodeId:"video",sourceBlobId:hash}});
  expect(videoAudioSourceId({...video,metadata:{...video.metadata,content:"https://external.test/video.mp4"}})).toBeNull();
  expect(audioExtractionErrorMessage(Error("audio_extraction_no_audio"))).toContain("没有可提取的音轨");
  expect(audioExtractionErrorMessage(Error("audio_extraction_tool_unavailable"))).toContain("ATELIER_FFMPEG_PATH");
 });
});
