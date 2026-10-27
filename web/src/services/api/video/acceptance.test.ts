import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
vi.mock("@/lib/api-proxy",()=>({proxyApiUrl:(url:string)=>url}));
vi.mock("@/lib/image-utils",()=>({dataUrlToFile:vi.fn()}));
vi.mock("@/services/file-storage",()=>({getMediaBlob:vi.fn(),uploadMediaFile:vi.fn()}));
vi.mock("@/services/image-storage",()=>({imageToDataUrl:vi.fn()}));
vi.mock("../model-plugin",()=>({runModelPlugin:vi.fn()}));
vi.mock("axios",()=>({default:{post:vi.fn(),get:vi.fn(),delete:vi.fn(),isCancel:()=>false,isAxiosError:()=>false}}));
import axios from "axios";
import {runModelPlugin} from "../model-plugin";
import {uploadMediaFile} from "@/services/file-storage";
import {defaultConfig,type AiConfig} from "@/stores/use-config-store";
import {createVideoGenerationTask,pollVideoGenerationTask,requestVideoGeneration,cancelVideoGenerationTask,retrySeedanceDownload,storeGeneratedVideo,type VideoGenerationTask} from "../video";
import {SEEDANCE_STANDARD} from "./model-capabilities";
import type {VideoGenerationRequest} from "./types";

const ark=(baseUrl="https://ark.cn-beijing.volces.com/api/v3"):AiConfig=>({
 ...defaultConfig,model:"acceptance::"+SEEDANCE_STANDARD,videoModel:"acceptance::"+SEEDANCE_STANDARD,
 channels:[{id:"acceptance",name:"Ark",apiFormat:"volcengine_ark",baseUrl,apiKey:"client-legacy-key",
  models:[{name:SEEDANCE_STANDARD,capability:"video"}]}]
});
const request=(config:AiConfig):VideoGenerationRequest=>({modelOption:config.model,mode:"text_to_video",prompt:"Some scene",references:[],durationSeconds:6,resolution:"720p",ratio:"16:9",generateAudio:true,watermark:false});
const task=(config:AiConfig):VideoGenerationTask=>({id:"previous-task",provider:"volcengine_ark",model:config.model});
beforeEach(()=>vi.clearAllMocks());
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()});

describe("Ark jobs are exclusively server-owned after Gateway removal",()=>{
 it.each(["https://ark.cn-beijing.volces.com/api/v3","http://127.0.0.1:8189/api/v3","https://relay.example.test/api/v3"])(
  "does not submit a browser-paid Ark task for %s",async url=>{
   const cfg=ark(url);
   await expect(createVideoGenerationTask(cfg,"prompt",[],{request:request(cfg)})).rejects.toThrow(/后端任务/);
   await expect(requestVideoGeneration(cfg,"prompt",[],{request:request(cfg)})).rejects.toThrow(/后端任务/);
   expect(axios.post).not.toHaveBeenCalled();expect(axios.get).not.toHaveBeenCalled();
  });
 it("does not upload local references using a browser credential or Gateway API",async()=>{
  const cfg=ark();
  const frozen={...request(cfg),mode:"omni_reference" as const,references:[{
   id:"ref-video",kind:"video" as const,role:"reference_video" as const,storageKey:"local-video",
   mimeType:"video/mp4",bytes:42,width:1280,height:720,durationMs:3000
  }]};
  const fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);
  await expect(createVideoGenerationTask(cfg,"prompt",[],{request:frozen})).rejects.toThrow(/后端任务/);
  expect(fetchMock).not.toHaveBeenCalled();expect(axios.post).not.toHaveBeenCalled();
 });
 it("does not poll, cancel or retry unowned old task IDs or generate replacements",async()=>{
  const cfg=ark();
  await expect(pollVideoGenerationTask(cfg,task(cfg))).rejects.toThrow(/旧 Ark 任务/);
  expect(await cancelVideoGenerationTask(cfg,task(cfg))).toBe(false);
  await expect(retrySeedanceDownload(cfg,task(cfg))).rejects.toThrow(/旧 Ark 任务/);
  expect(axios.post).not.toHaveBeenCalled();expect(axios.get).not.toHaveBeenCalled();
  expect(axios.delete).not.toHaveBeenCalled();
 });
 it("continues to use the independent OpenAI API without Ark Gateway",async()=>{
  const cfg:AiConfig={...ark(),channels:[{...ark().channels[0],apiFormat:"openai"}]};
  vi.mocked(axios.post).mockResolvedValueOnce({data:{id:"openai-task"}});
  expect(await createVideoGenerationTask(cfg,"prompt")).toMatchObject({provider:"openai",id:"openai-task"});
  expect(vi.mocked(axios.post).mock.calls[0][1]).toBeInstanceOf(FormData);
 });
 it("continues to use a configured user plugin without Ark Gateway",async()=>{
  const cfg=ark();cfg.channels[0].models[0].script="return 'https://example.com/video.mp4'";
  vi.mocked(runModelPlugin).mockResolvedValueOnce("https://example.com/video.mp4");
  expect(await createVideoGenerationTask(cfg,"prompt")).toMatchObject({provider:"plugin"});
  expect(axios.post).not.toHaveBeenCalled();
 });
 it("requires local persistence before declaring a downloaded video successful",async()=>{
  vi.mocked(uploadMediaFile).mockRejectedValueOnce(new Error("quota exceeded"));
  await expect(storeGeneratedVideo({blob:new Blob(["video"],{type:"video/mp4"}),requirePersistence:true}))
   .rejects.toThrow(/quota exceeded/);
 });
});
