import {describe,it,expect,vi,afterEach} from "vitest";
vi.mock("./sqlite-comfy-bridge",()=>({createSqliteComfyBridge:vi.fn()}));
vi.mock("./frozen-model-images",()=>({freezeModelImages:vi.fn(async()=>[
 {blobId:"a".repeat(64),mimeType:"image/png"}])}));
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
 it("freezes arbitrary user-configured compatible endpoint without a server whitelist",async()=>{
  const calls:string[]=[];
  const api=vi.fn(async(path:string,method="GET",payload?:unknown)=>{
   calls.push(method+" "+path);
   if(path==="/api/v1/execution/capabilities")return {autoDispatch:true,modelKinds:["text"]};
   if(path==="/api/v1/channels/proxy-1")return {id:"proxy-1",provider:"openai_compatible",
    hasKey:true,keyVersion:"sealed-key-version"};
   if(path==="/api/v1/jobs"){
    expect(payload).toMatchObject({snapshot:{provider:"openai_compatible",channelId:"proxy-1",
     endpointBaseUrl:"http://127.0.0.1:8188/v1",secretVersionRef:"sealed-key-version",
     task:{kind:"text",prompt:"hello"}}});
    expect(JSON.stringify(payload)).not.toContain("apiKey");
    return fakeJob;
   }
   throw Error("unexpected "+path);
  });
  const b=bridge();
  await startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   channelId:"proxy-1",channelBaseUrl:"http://127.0.0.1:8188/v1",provider:"openai_compatible",
   task:{kind:"text",model:"proxy-text-model",prompt:"hello"},bridge:b,api:api as unknown as typeof canvasApi});
  expect(calls).toEqual(["GET /api/v1/execution/capabilities","GET /api/v1/channels/proxy-1","POST /api/v1/jobs"]);
  expect(b.assertNoActiveJob).not.toHaveBeenCalled();
  const blocked=vi.fn();
  const neverSaved=bridge();
  await expect(startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   channelId:"proxy-1",channelBaseUrl:"http://169.254.169.254/v1",provider:"openai_compatible",
   task:{kind:"text",model:"proxy-text-model",prompt:"hello"},bridge:neverSaved,
   api:vi.fn(async()=>({autoDispatch:true,modelKinds:["text"]})) as unknown as typeof canvasApi
  })).rejects.toThrow("不安全");
  expect(neverSaved.saveProjectNow).not.toHaveBeenCalled();
 });
 it("text bypasses prior active-job lookup, while retaining save fence and a fresh submission ID",async()=>{
  const b=bridge();
  b.assertNoActiveJob.mockRejectedValue(Error("backend_prior_job_not_terminal:old-unknown"));
  const keys:string[]=[];
  const api=vi.fn(async(path:string,_method="GET",payload?:any)=>{
   if(path==="/api/v1/execution/capabilities")return {autoDispatch:true,modelKinds:["text"]};
   if(path==="/api/v1/channels/openai-channel")
    return {id:"openai-channel",provider:"openai",hasKey:true,keyVersion:"v1"};
   if(path==="/api/v1/jobs"){
    keys.push(payload.idempotencyKey);
    expect(payload.snapshot.task.kind).toBe("text");
    expect(payload.expectedProjectRevision).toBe(3);
    return fakeJob;
   }
   throw Error("unexpected "+path);
  });
  const args={projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   channelId:"openai-channel",task:{kind:"text" as const,model:"deepseek/deepseek-v4.1-flash-1017",prompt:"hello"},
   bridge:b,api:api as unknown as typeof canvasApi};
  await startSqliteModelGeneration(args);
  await startSqliteModelGeneration(args);
  expect(b.assertNoActiveJob).not.toHaveBeenCalled();
  expect(b.saveProjectNow).toHaveBeenCalledTimes(2);
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
 });
 it("freezes trusted text script into SQLite snapshot without browser key",async()=>{
  const script='const data = await http.post("/chat/completions", {model, messages}); return data.choices?.[0]?.message?.content || "";';
  const api=vi.fn(async(path:string,method="GET",payload?:any)=>{
   if(path==="/api/v1/execution/capabilities")return {autoDispatch:true,modelKinds:["text"]};
   if(path==="/api/v1/channels/proxy-1")return {id:"proxy-1",provider:"openai_compatible",hasKey:true,keyVersion:"v2"};
   if(path==="/api/v1/jobs"){
    expect(payload.snapshot).toMatchObject({
     adapterKind:"model",provider:"openai_compatible",channelId:"proxy-1",
     endpointBaseUrl:"http://127.0.0.1:8188/v1",secretVersionRef:"v2",
     task:{kind:"text",model:"my-model",prompt:"hello",script}
    });
    expect(JSON.stringify(payload)).not.toContain("apiKey");
    return fakeJob;
   }
   throw Error("unexpected "+path);
  });
  await startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   provider:"openai_compatible",channelId:"proxy-1",channelBaseUrl:"http://127.0.0.1:8188/v1",
   task:{kind:"text",model:"my-model",prompt:"hello",script},
   bridge:bridge(),api:api as unknown as typeof canvasApi});
  expect(api).toHaveBeenCalledTimes(3);
  const forbidden=vi.fn();
  await expect(startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   provider:"openai",channelId:"proxy-1",
   task:{kind:"video",model:"my-model",prompt:"hello"},
   bridge:bridge(),api:forbidden as unknown as typeof canvasApi})).rejects.toThrow("model_provider_kind_unsupported");
 });
 it("fails closed without worker, missing DPAPI key, or unsuccessful save fence",async()=>{
  const unsupported=vi.fn(async()=>({autoDispatch:false,modelKinds:[]}));
   const args={projectId:"p1",sourceNodeId:"text-1",nodes,connections,   channelId:"openai-channel",task:{kind:"text" as const,model:"gpt-4o-mini",prompt:"Hi"}};
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
 it("submits frozen restricted async video script as durable poll job without browser API key",async()=>{
  const script=JSON.stringify({version:1,
   submit:'const data=await http.post("/videos",{model,prompt});return data.id;',
   poll:'const data=await http.get("/videos/"+remoteTaskId);return {id:data.id,status:data.status,videoUrl:data.url};'
  });
  const requests:Array<{path:string;payload:any}>=[];
  const api=vi.fn(async(path:string,method="GET",payload?:unknown)=>{
   requests.push({path,payload});
   if(path==="/api/v1/execution/capabilities")
    return {autoDispatch:true,modelKinds:["image","text","audio","video"]};
   if(path==="/api/v1/channels/proxy-1")
    return {id:"proxy-1",provider:"openai_compatible",hasKey:true,keyVersion:"vault-v1"};
   if(path==="/api/v1/jobs")return fakeJob;
   throw Error("unexpected "+path);
  });
  const b=bridge();
  await startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   channelId:"proxy-1",channelBaseUrl:"http://127.0.0.1:8188/v1",provider:"openai_compatible",
   task:{kind:"video",model:"my-video",prompt:"fox",duration:6,ratio:"16:9",
    resolution:"720p",generateAudio:true,watermark:false,script},
   bridge:b,api:api as unknown as typeof canvasApi});
  const post=requests.find(x=>x.path==="/api/v1/jobs")?.payload;
  expect(post).toMatchObject({executionMode:"poll",snapshot:{provider:"openai_compatible",
   secretVersionRef:"vault-v1",endpointBaseUrl:"http://127.0.0.1:8188/v1",
   task:{kind:"video",model:"my-video",prompt:"fox",script}}});
  expect(JSON.stringify(post)).not.toContain("apiKey");
  expect(b.saveProjectNow).toHaveBeenCalledTimes(1);
 });
 it("keeps async video first/last/reference CAS hashes in the frozen task without inline image bytes",async()=>{
  const hash="a".repeat(64);
  const refs=(["first_frame","last_frame","reference_image"] as const).map(role=>({
   kind:"image" as const,role,blobId:hash,sha256:hash,mimeType:"image/png"
  }));
  const script=JSON.stringify({version:1,
   submit:'const data=await http.post("/videos",{model,prompt,first_frame:params.firstFrame,last_frame:params.lastFrame,reference_images:params.referenceImages});return data.id;',
   poll:'const data=await http.get("/videos/"+remoteTaskId);return {id:data.id,status:data.status,videoUrl:data.url};'
  });
  const received:unknown[]=[];
  const api=vi.fn(async(path:string,method="GET",payload?:unknown)=>{
   if(path==="/api/v1/execution/capabilities")return {autoDispatch:true,modelKinds:["video"]};
   if(path==="/api/v1/channels/proxy-1")
    return {id:"proxy-1",provider:"openai_compatible",hasKey:true,keyVersion:"version-1"};
   if(path==="/api/v1/jobs"){received.push(payload);return fakeJob}
   throw Error("unexpected "+path);
  });
  const b=bridge();
  await startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   channelId:"proxy-1",channelBaseUrl:"http://127.0.0.1:8188/v1",provider:"openai_compatible",
   task:{kind:"video",model:"my-video",prompt:"fox",duration:6,script,references:refs},
   api:api as unknown as typeof canvasApi,bridge:b});
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({executionMode:"poll",snapshot:{task:{
   references:refs,script
  }}});
  expect(JSON.stringify(received[0])).not.toMatch(/data:image|blob:|apiKey/);
  expect(b.saveProjectNow).toHaveBeenCalledTimes(1);
  const refused=vi.fn();
  await expect(startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   channelId:"proxy-1",provider:"openai_compatible",
   task:{kind:"video",model:"my-video",prompt:"fox",script,
    references:[{kind:"video",role:"reference_video",blobId:hash,sha256:"b".repeat(64)}]},
   api:refused as unknown as typeof canvasApi,bridge:bridge()})).rejects.toThrow("必须是已冻结的");
  expect(refused).not.toHaveBeenCalled();
 });
 it("accepts immutable video/audio CAS refs in custom video job, never raw media",async()=>{
  const hash="a".repeat(64);
  const references=[{kind:"video" as const,role:"reference_video" as const,blobId:hash,sha256:hash,mimeType:"video/mp4"},
   {kind:"audio" as const,role:"reference_audio" as const,blobId:hash,sha256:hash,mimeType:"audio/wav"}];
  const script=JSON.stringify({version:1,
   submit:'const d=await http.post("/videos",{model,reference_videos:params.referenceVideos,reference_audios:params.referenceAudios});return d.id;',
   poll:'const d=await http.get("/videos/"+remoteTaskId);return {id:d.id,status:d.status,videoUrl:d.url};'});
  const submitted:any[]=[];
  const api=vi.fn(async(path:string,method="GET",payload?:any)=>{
   if(path==="/api/v1/execution/capabilities")return {autoDispatch:true,modelKinds:["video"]};
   if(path==="/api/v1/channels/proxy-1")return {id:"proxy-1",provider:"openai_compatible",hasKey:true,keyVersion:"v1"};
   if(path==="/api/v1/jobs"){submitted.push(payload);return fakeJob}
   throw Error("unexpected "+path);
  });
  await startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   provider:"openai_compatible",channelId:"proxy-1",channelBaseUrl:"http://127.0.0.1:8188/v1",
   task:{kind:"video",model:"video",prompt:"fox",script,references},
   api:api as unknown as typeof canvasApi,bridge:bridge()});
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({executionMode:"poll",snapshot:{task:{script,references}}});
  expect(JSON.stringify(submitted[0])).not.toMatch(/data:video|data:audio|apiKey/);
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
 it("P5.4d freezes reference images for image edits before save fence, never sends inline image bytes",async()=>{
  const events:string[]=[];
  const reference={id:"image-1",name:"reference",type:"image/png",dataUrl:"data:image/png;base64,UNSAFE"};
  const uploaded=bridge();
  uploaded.saveProjectNow.mockImplementationOnce(async()=>{
   events.push("save");
   return {projectId:"p1",revision:5,sourceNodeFingerprint:"ref"};
  });
  const api=vi.fn(async(path:string,method="GET",payload?:unknown)=>{
   if(path==="/api/v1/execution/capabilities")
    return {autoDispatch:true,modelKinds:["image","text"]};
   if(path==="/api/v1/channels/openai-channel")
    return {id:"openai-channel",provider:"openai",hasKey:true,keyVersion:"v1"};
   if(path==="/api/v1/jobs"){
    events.push("submit");
    expect(payload).toMatchObject({snapshot:{task:{
     kind:"image",operation:"edit",images:[{blobId:"a".repeat(64),mimeType:"image/png"}]
    }}});
    expect(JSON.stringify(payload)).not.toContain("UNSAFE");
    expect(JSON.stringify(payload)).not.toContain("data:image");
    return fakeJob;
   }
   throw Error("unexpected");
  });
  await startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",
   nodes,connections,channelId:"openai-channel",referenceImages:[reference],
   task:{kind:"image",model:"gpt-image-2",prompt:"add stars"},
   bridge:uploaded,api:api as unknown as typeof canvasApi});
  expect(events).toEqual(["save","submit"]);
 });
 it("P5.4d image questions freeze multimodal references while leaving generation kind text",async()=>{
  const api=vi.fn(async(path:string,_method="GET",payload?:unknown)=>{
   if(path.includes("capabilities"))return {autoDispatch:true,modelKinds:["text"]};
   if(path.includes("/channels/"))return {id:"openai-channel",provider:"openai",hasKey:true,keyVersion:"v1"};
   if(path==="/api/v1/jobs"){
    expect(payload).toMatchObject({snapshot:{task:{
     kind:"text",images:[{blobId:"a".repeat(64),mimeType:"image/png"}]
    }}});
    expect((payload as {snapshot:{task:{operation?:string}}}).snapshot.task.operation).toBeUndefined();
    return fakeJob;
   }
   throw Error("unexpected");
  });
  await startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",
   nodes,connections,channelId:"openai-channel",referenceImages:[{
    id:"image-1",name:"image",type:"image/png",dataUrl:"data:image/png;base64,x"}],
   task:{kind:"text",model:"gpt-4o-mini",prompt:"What is in this image?"},
   bridge:bridge(),api:api as unknown as typeof canvasApi});
 });
 it("P5.4d rejects forged frozen refs and illegal mask capability before saving",async()=>{
  const b=bridge();
  const api=vi.fn(async(path:string)=>path.includes("capabilities")?
   {autoDispatch:true,modelKinds:["image","text"]}:
   {id:"openai-channel",provider:"openai",hasKey:true,keyVersion:"v1"});
  const common={projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   channelId:"openai-channel",bridge:b,api:api as unknown as typeof canvasApi};
  await expect(startSqliteModelGeneration({...common,task:{
   kind:"image",model:"gpt-image-2",prompt:"edit",images:[{blobId:"a".repeat(64),mimeType:"image/png"}]
  }})).rejects.toThrow("references_must_be_frozen");
  await expect(startSqliteModelGeneration({...common,
   referenceImages:[{id:"x",type:"image/png",name:"a",dataUrl:"x"}],
   maskImage:{id:"mask",type:"image/png",name:"mask",dataUrl:"x"},
   task:{kind:"text",model:"gpt-4o-mini",prompt:"ask"},
  })).rejects.toThrow("mask_inputs_invalid");
  expect(b.saveProjectNow).not.toHaveBeenCalled();
 });
 it("P5.4e freezes multi-turn transcript and stream flag without browser key",async()=>{
  const messages=[
   {role:"system" as const,content:"Brief answers"},
   {role:"user" as const,content:"First question"},
   {role:"assistant" as const,content:"First answer"},
   {role:"user" as const,content:"Follow-up"}
  ];
  const api=vi.fn(async(path:string,method="GET",payload?:unknown)=>{
   if(path.includes("capabilities"))return {autoDispatch:true,modelKinds:["text"]};
   if(path.includes("/channels/"))return {id:"openai-channel",provider:"openai",hasKey:true,keyVersion:"v2"};
   if(path==="/api/v1/jobs"){
    expect(payload).toMatchObject({snapshot:{adapterKind:"model",
      secretVersionRef:"v2",task:{kind:"text",stream:true,messages}}});
    expect(JSON.stringify(payload)).not.toContain("apiKey");
    return fakeJob;
   }
   throw Error("unexpected");
  });
  await startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",
   nodes,connections,channelId:"openai-channel",
   task:{kind:"text",model:"gpt-4o-mini",prompt:"Follow-up",stream:true,messages},
   bridge:bridge(),api:api as unknown as typeof canvasApi});
 });
 it("P5.4e blocks inline media inside serialized chat messages",async()=>{
  const api=vi.fn(async(path:string)=>path.includes("capabilities")?
   {autoDispatch:true,modelKinds:["text"]}:
   {id:"openai-channel",provider:"openai",hasKey:true,keyVersion:"v2"});
  const b=bridge();
  await expect(startSqliteModelGeneration({projectId:"p1",sourceNodeId:"text-1",
   nodes,connections,channelId:"openai-channel",
   task:{kind:"text",model:"gpt-4o-mini",prompt:"Ask",
    messages:[{role:"user",content:"data:image/png;base64,EXFIL"}]},
   bridge:b,api:api as unknown as typeof canvasApi})
  ).rejects.toThrow("model_text_history_invalid");
  expect(b.saveProjectNow).not.toHaveBeenCalled();
 });
 it("P5.4k carries the server grant only outside immutable text JobSnapshot",async()=>{
  const id="11111111-1111-4111-a111-111111111111";
  const cas="a".repeat(64);
  const b=bridge();
  const api=vi.fn(async(path:string,method="GET",payload?:unknown)=>{
   if(path.includes("capabilities"))return {autoDispatch:true,modelKinds:["text"]};
   if(path.includes("/channels/"))return {
    id:"openai-channel",provider:"openai",hasKey:true,keyVersion:"v1"
   };
   if(path==="/api/v1/jobs"){
    expect(payload).toMatchObject({
     skillAuthorizationId:id,
     snapshot:{adapterKind:"model",task:{
      kind:"text",skills:{blobId:cas},prompt:"Show camera moves"
     }}
    });
    expect(JSON.stringify((payload as {snapshot:unknown}).snapshot)).not.toContain(id);
    return fakeJob;
   }
   throw Error("unexpected API");
  });
  await startSqliteModelGeneration({
   projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   channelId:"openai-channel",skillAuthorizationId:id,
   task:{kind:"text",model:"gpt-4o-mini",prompt:"Show camera moves",
    stream:true,messages:[{role:"user",content:"Show camera moves"}],
    skills:{blobId:cas}},
   bridge:b,api:api as unknown as typeof canvasApi
  });
  expect(api.mock.calls.some(call=>call[0]==="/api/v1/jobs")).toBe(true);
  await expect(startSqliteModelGeneration({
   projectId:"p1",sourceNodeId:"text-1",nodes,connections,
   channelId:"openai-channel",
   task:{kind:"text",model:"gpt-4o-mini",prompt:"Show camera moves",
    skills:{blobId:cas}},bridge:b,api:api as unknown as typeof canvasApi
  })).rejects.toThrow("skill_grant_required");
 });
 it("normalizes Canvas ratio shortcuts to supported OpenAI image size",()=>{
  expect(openAiImageSize("1:1")).toBe("1024x1024");
  expect(openAiImageSize("16:9")).toBe("1536x1024");
  expect(openAiImageSize("9:16")).toBe("1024x1536");
  expect(openAiImageSize("random")).toBe("auto");
 });
});
