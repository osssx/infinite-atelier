import {describe,expect,it,vi} from "vitest";
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
vi.mock("@/lib/api-proxy",()=>({proxyApiUrl:(url:string)=>url}));
vi.mock("@/lib/image-utils",()=>({dataUrlToFile:vi.fn()}));
vi.mock("@/services/file-storage",()=>({getMediaBlob:vi.fn(),uploadMediaFile:vi.fn()}));
vi.mock("@/services/image-storage",()=>({imageToDataUrl:vi.fn()}));
vi.mock("../model-plugin",()=>({runModelPlugin:vi.fn()}));
vi.mock("axios",()=>({default:{post:vi.fn(),get:vi.fn(),delete:vi.fn(),isCancel:()=>false,isAxiosError:()=>false}}));
import axios from "axios";
import {defaultConfig,createModelChannel,type AiConfig} from "@/stores/use-config-store";
import {createVideoGenerationTask,pollVideoGenerationTask,type VideoGenerationTask} from "../video";
import {SEEDANCE_STANDARD} from "./model-capabilities";

describe("Gateway replacement boundary",()=>{
 it("keeps configured channels but does not replay obsolete browser Ark execution",async()=>{
  const channel=createModelChannel({id:"old-id",name:"Old",apiFormat:"volcengine_ark",
   baseUrl:"http://127.0.0.1:8189/api/v3",apiKey:"local",seedanceAdapter:"router_local"} as never);
  expect(channel.id).toBe("old-id");expect(channel).not.toHaveProperty("seedanceAdapter");
  const config:AiConfig={...defaultConfig,model:"old-id::"+SEEDANCE_STANDARD,
   channels:[{...channel,models:[{name:SEEDANCE_STANDARD,capability:"video"}]}]};
  await expect(createVideoGenerationTask(config,"prompt")).rejects.toThrow(/后端任务/);
  const old={id:"cgt-existing",provider:"router_local",model:config.model} as unknown as VideoGenerationTask;
  await expect(pollVideoGenerationTask(config,old)).rejects.toThrow(/旧 Ark 任务/);
  expect(axios.post).not.toHaveBeenCalled();expect(axios.get).not.toHaveBeenCalled();
 });
});
