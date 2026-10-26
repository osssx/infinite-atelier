import {describe,it,expect,vi,afterEach} from "vitest";
vi.mock("./sqlite-comfy-bridge",()=>({createSqliteComfyBridge:vi.fn()}));
import {startSqliteModelGeneration,openAiImageSize} from "./sqlite-model-generation";
import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import type {BackendJobView} from "@/types/backend-contracts";
import type {canvasApi} from "./canvas-api";
const source:CanvasNodeData={id:"text-1",type:"text",title:"Text",
 position:{x:0,y:0},width:300,height:200,metadata:{content:"A fox"}};
const nodes=[source],connections:CanvasConnection[]=[];
const fakeJob:BackendJobView={id:"job-1",status:"queued",projectId:"p1",
 executionMode:"immediate",createdAt:1,updatedAt:1,upstreamTaskId:null,
 attemptId:null,submitMarker:null,submissionStartedAt:null};
const bridge=()=>({
 state:{status:"connected" as const},
 assertNoActiveJob:vi.fn(async()=>{}),
 assertComfyReady:vi.fn(async()=>{}),
 saveProjectNow:vi.fn(async()=>({projectId:"p1",revision:3,sourceNodeFingerprint:"fingerprint"})),
 uploadFrozenBlob:vi.fn(async()=>({blobId:"blob",sha256:"blob",byteSize:5,mimeType:"image/png",existing:false})),
 submitFrozenJob:vi.fn(async()=>fakeJob)
});
afterEach(()=>vi.unstubAllGlobals());
describe("P4.4 ordinary SQLite model submit",()=>{
 it("reads backend capabilities and DPAPI credential reference, freezes graph before POST",async()=>{
  const calls:string[]=[];
  const api=vi.fn(async(path:string,method="GET",payload?:unknown)=>{
   calls.push(method+" "+path);
   if(path==="/api/v1/execution/capabilities")
    return {autoDispatch:true,modelKinds:["image","audio","text"]};
   if(path==="/api/v1/channels/openai-channel")
    return {id:"openai-channel",provider:"openai",hasKey:true,keyVersion:"v1"};
   if(path==="/api/v1/jobs"){
    expect(payload).toMatchObject({projectId:"p1",targetNodeId:"text-1",
     expectedProjectRevision:3,sourceNodeFingerprint:"fingerprint",executionMode:"immediate",
     snapshot:{adapterKind:"model",provider:"openai",channelId:"openai-channel",
      secretVersionRef:"v1",task:{kind:"image",model:"gpt-image-2",prompt:"A fox"}}});
    expect(JSON.stringify(payload)).not.toContain("apiKey");
    return fakeJob;
   }
   throw Error("unexpected "+path);
  });
  const b=bridge();
  const result=await startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",
   nodes,connections,channelId:"openai-channel",
   task:{kind:"image",model:"gpt-image-2",prompt:"A fox"},bridge:b,api:api as unknown as typeof canvasApi});
  expect(result).toEqual(fakeJob);
  expect(calls).toEqual(["GET /api/v1/execution/capabilities",
   "GET /api/v1/channels/openai-channel","POST /api/v1/jobs"]);
  expect(b.assertNoActiveJob).toHaveBeenCalledWith("text-1");
  expect(b.saveProjectNow).toHaveBeenCalledOnce();
 });
 it("fails closed without worker, missing DPAPI key, or unsuccessful save fence",async()=>{
  const unsupported=vi.fn(async()=>({autoDispatch:false,modelKinds:[]}));
  const args={projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   channelId:"openai-channel",task:{kind:"text" as const,model:"gpt-4o-mini",prompt:"Hi"}};
  await expect(startSqliteModelGeneration({...args,bridge:bridge(),api:unsupported as unknown as typeof canvasApi}))
   .rejects.toThrow("不可用");
  const missing=vi.fn(async(path:string)=>path.includes("capabilities")?
   {autoDispatch:true,modelKinds:["text"]}:
   {id:"openai-channel",provider:"openai",hasKey:false,keyVersion:null});
  await expect(startSqliteModelGeneration({...args,bridge:bridge(),api:missing as unknown as typeof canvasApi}))
   .rejects.toThrow("加密密钥");
  const b=bridge();b.saveProjectNow.mockRejectedValueOnce(Error("generation_save_barrier_required"));
  const valid=vi.fn(async(path:string)=>path.includes("capabilities")?
   {autoDispatch:true,modelKinds:["text"]}:
   {id:"openai-channel",provider:"openai",hasKey:true,keyVersion:"v1"});
  await expect(startSqliteModelGeneration({...args,bridge:b,api:valid as unknown as typeof canvasApi}))
   .rejects.toThrow("generation_save_barrier_required");
  expect(valid.mock.calls.some(args=>args[0]==="/api/v1/jobs")).toBe(false);
 });
 it("submits Ark async video with frozen remote credential version and poll mode",async()=>{
  const requests:Array<{path:string;method:string;payload?:unknown}>=[];
  const api=vi.fn(async(path:string,method="GET",payload?:unknown)=>{
   requests.push({path,method,payload});
   if(path==="/api/v1/execution/capabilities")return {autoDispatch:true,modelKinds:["video"]};
   if(path==="/api/v1/channels/ark-test")
    return {id:"ark-test",provider:"volcengine_ark",hasKey:true,keyVersion:"v2"};
   if(path==="/api/v1/jobs")return fakeJob;
   throw Error("Unexpected API");
  });
  const video={kind:"video" as const,model:"doubao-seedance-2-0-260128",prompt:"snow",
   duration:6,ratio:"16:9",resolution:"720p",generateAudio:true,watermark:false};
  await startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",
   nodes,connections,channelId:"ark-test",provider:"volcengine_ark",
   task:video,bridge:bridge(),api:api as unknown as typeof canvasApi});
  const payload=requests.find(r=>r.path==="/api/v1/jobs")?.payload;
  expect(payload).toMatchObject({executionMode:"poll",snapshot:{
   adapterKind:"model",provider:"volcengine_ark",channelId:"ark-test",
   secretVersionRef:"v2",task:video
  }});
  expect(JSON.stringify(payload)).not.toContain("apiKey");
 });
 it("normalizes Canvas ratio shortcuts to supported OpenAI image size",()=>{
  expect(openAiImageSize("1:1")).toBe("1024x1024");
  expect(openAiImageSize("16:9")).toBe("1536x1024");
  expect(openAiImageSize("9:16")).toBe("1024x1536");
  expect(openAiImageSize("random")).toBe("auto");
 });
});
