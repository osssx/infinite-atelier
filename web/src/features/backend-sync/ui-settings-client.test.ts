import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("./canvas-api",()=>({canvasApi:vi.fn()}));
vi.mock("@/lib/perf-mode",()=>({PERF_MODE:false}));
import {canvasApi} from "./canvas-api";
import {publicModelConfig,redactedExportConfig} from "./ui-settings-client";
import {createModelConfigStorage,awaitModelConfigPersistence} from "./model-config-persistence";
import {createThemeStorage,awaitThemePersistence} from "./ui-theme-persistence";
import type {AiConfig} from "@/stores/use-config-store";

const config={
 channelMode:"local",baseUrl:"https://api.example.test",apiKey:"top secret",
 apiFormat:"openai",model:"chan::txt",imageModel:"",videoModel:"",textModel:"chan::txt",
 audioModel:"",audioVoice:"alloy",audioFormat:"mp3",audioSpeed:"1",
 audioInstructions:"",videoSeconds:"6",videoMode:"text_to_video",videoRatio:"adaptive",
 videoReturnLastFrame:"false",vquality:"720",videoGenerateAudio:"true",
 videoWatermark:"false",systemPrompt:"prompt",reasoningEffort:"auto",models:["chan::txt"],
 quality:"auto",size:"1:1",background:"",count:"1",canvasImageCount:"3",
 comfyInstanceId:"comfy-local",comfyAutoDetect:true,
 channels:[{id:"chan",name:"provider",baseUrl:"https://api.example.test",apiKey:"SENSITIVE_KEY",
  apiFormat:"openai",models:[{name:"txt",capability:"text",script:"SECRET SCRIPT"}]}]
} satisfies AiConfig;
const publicConfig=publicModelConfig(config);
let local:Map<string,string>;
beforeEach(()=>{
 vi.mocked(canvasApi).mockReset();
 local=new Map();
 vi.stubGlobal("window",{localStorage:{
  getItem:(k:string)=>local.get(k)??null,
  setItem:(k:string,v:string)=>{local.set(k,v)},
  removeItem:(k:string)=>{local.delete(k)}
 }});
});
describe("P5.4b non-secret settings client",()=>{
 it("allowlist serialization removes all credentials and scripts even if imported objects have extra fields",()=>{
  const projected=publicModelConfig({...config,oauthSecret:"SENSITIVE" } as AiConfig);
  const text=JSON.stringify(projected);
  expect(text).not.toContain("SENSITIVE");
  expect(text).not.toContain("top secret");
  expect(text).not.toContain("SECRET SCRIPT");
  expect(text).not.toContain("apiKey");
  expect(text).not.toContain("oauthSecret");
  expect((projected.channels as Array<{models:Array<Record<string,unknown>>}>)[0].models[0].script).toBeUndefined();
 });
 it("explicit portable JSON/ZIP redaction excludes API keys and custom scripts",()=>{
  const content=JSON.stringify(redactedExportConfig(config));
  expect(content).not.toContain("SENSITIVE_KEY");
  expect(content).not.toContain("top secret");
  expect(content).not.toContain("SECRET SCRIPT");
  expect(JSON.parse(content).channels[0].apiKey).toBe("");
 });
 it("never auto-applies a legacy API key to default settings when backend has no profile",async()=>{
  local.set("infinite-canvas:ai_config_store",JSON.stringify({state:{config}}));
  vi.mocked(canvasApi).mockResolvedValue({revision:1,value:{}});
  const defaults={...config,apiKey:"",channels:config.channels.map(c=>({...c,apiKey:"",models:c.models.map(({script:_script,...rest})=>rest)}))};
  const storage=createModelConfigStorage(defaults);
  const result=await storage.getItem("config");
  expect(result?.state.config.channels[0].apiKey).toBe("");
  expect(result?.state.config.apiKey).toBe("");
  expect(result?.state.config).toEqual(defaults);
 });
 it("local credentials follow exact channel ID, base URL and format only",async()=>{
  local.set("infinite-canvas:ai_config_store",JSON.stringify({state:{config}}));
  vi.mocked(canvasApi).mockResolvedValue({revision:2,value:publicConfig});
  const storage=createModelConfigStorage({...config,apiKey:"",channels:config.channels.map(c=>({...c,apiKey:""}))});
  const result=await storage.getItem("config");
  expect(result?.state.config.channels[0].apiKey).toBe("SENSITIVE_KEY");
  expect(result?.state.config.channels[0].models[0].script).toBe("SECRET SCRIPT");
  const bad={...publicConfig,channels:[{...(publicConfig.channels as object[])[0],baseUrl:"https://wrong.example.test"}]};
  vi.mocked(canvasApi).mockResolvedValue({revision:3,value:bad});
  const other=await storage.getItem("config");
  expect(other?.state.config.channels[0].apiKey).toBe("");
  expect(other?.state.config.channels[0].models[0].script).toBeUndefined();
 });
 it("PUT never includes raw credentials, stores local-only keys, and blocks blind retries after conflict",async()=>{
  vi.mocked(canvasApi).mockResolvedValueOnce({revision:2,value:publicConfig})
   .mockRejectedValueOnce(Error("ui_setting_revision_conflict"));
  const storage=createModelConfigStorage(config);
  await storage.getItem("config");
  await expect(storage.setItem("config",{state:{config:{...config,videoSeconds:"10"}},version:0}))
   .rejects.toThrow("ui_setting_revision_conflict");
  const sent=vi.mocked(canvasApi).mock.calls[1];
  expect(sent[0]).toBe("/api/v1/ui-settings/model_config");
  expect(JSON.stringify(sent)).not.toContain("SENSITIVE_KEY");
  expect(JSON.stringify(sent)).not.toContain("top secret");
  expect(JSON.stringify(sent)).not.toContain("SECRET SCRIPT");
  expect(local.get("atelier:local-credentials")).toContain("SENSITIVE_KEY");
  await expect(storage.setItem("config",{state:{config},version:0}))
   .rejects.toThrow("model_config_reload_required");
  expect(canvasApi).toHaveBeenCalledTimes(2);
  await expect(awaitModelConfigPersistence()).rejects.toThrow("model_config_reload_required");
 });
 it("user can correct a 400 validation error without unsafe automatic overwrite",async()=>{
  vi.mocked(canvasApi).mockResolvedValueOnce({revision:2,value:publicConfig})
   .mockRejectedValueOnce(Object.assign(Error("ui_setting_invalid"),{status:400,code:"ui_setting_invalid"}))
   .mockResolvedValueOnce({revision:3,value:publicConfig});
  const storage=createModelConfigStorage(config);
  await storage.getItem("config");
  await expect(storage.setItem("config",{state:{config:{...config,baseUrl:"bad://address"}},version:0}))
   .rejects.toThrow("ui_setting_invalid");
  await storage.setItem("config",{state:{config:{...config,videoSeconds:"12"}},version:0});
  await awaitModelConfigPersistence();
  expect(vi.mocked(canvasApi).mock.calls[2][2]).toEqual({expectedRevision:2,value:{
   ...publicConfig,videoSeconds:"12"
  }});
 });
 it("backend hydration failure is observable by the config save barrier",async()=>{
  vi.mocked(canvasApi).mockRejectedValueOnce(Error("backend_unavailable"));
  const storage=createModelConfigStorage(config);
  await expect(storage.getItem("config")).rejects.toThrow("backend_unavailable");
  await expect(awaitModelConfigPersistence()).rejects.toThrow("backend_unavailable");
  await expect(storage.setItem("config",{state:{config},version:0}))
   .rejects.toThrow("model_config_reload_required");
 });
 it("honors preexisting vault markers without re-enabling removed migration",async()=>{
  const channel=config.channels[0];
  local.set("atelier:vaulted-model-channels",JSON.stringify({
   [channel.id]:{id:channel.id,baseUrl:channel.baseUrl,apiFormat:channel.apiFormat}
  }));
  local.set("infinite-canvas:ai_config_store",JSON.stringify({state:{config}}));
  vi.mocked(canvasApi).mockResolvedValue({revision:2,value:publicConfig});
  const storage=createModelConfigStorage({...config,apiKey:"",
   channels:config.channels.map(c=>({...c,apiKey:""}))});
  const hydrated=await storage.getItem("config");
  expect(hydrated?.state.config.channels[0].apiKey).toBe("");
  await storage.setItem("config",{state:{config},version:0});
  const stored=JSON.parse(local.get("atelier:local-credentials")!);
  expect(stored.channels[channel.id].apiKey).toBe("");
  expect(local.get("infinite-canvas:ai_config_store")).toContain("SENSITIVE_KEY");
 });
 it("theme is backend-authoritative and ignores stale browser theme without migration",async()=>{
  local.set("infinite-canvas:theme_store",JSON.stringify({state:{theme:"light"}}));
  vi.mocked(canvasApi).mockResolvedValueOnce({revision:1,value:"dark"})
   .mockResolvedValueOnce({revision:2,value:"light"});
  const storage=createThemeStorage<{theme:"light"|"dark"}>();
  const current=await storage.getItem("theme");
  expect(current?.state.theme).toBe("dark");
  await storage.setItem("theme",{state:{theme:"light"},version:0});
  await awaitThemePersistence();
  expect(canvasApi).toHaveBeenNthCalledWith(2,
   "/api/v1/ui-settings/theme","PUT",{expectedRevision:1,value:"light"});
 });
});
