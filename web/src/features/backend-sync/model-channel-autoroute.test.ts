import {describe,it,expect,vi} from "vitest";
import {CanvasApiError} from "./canvas-api";
import {ensureSqliteModelChannel,saveSqliteModelChannelFromEditor,modelChannelProvider} from "./model-channel-autoroute";
import type {ModelChannel} from "@/stores/use-config-store";
import type {canvasApi} from "./canvas-api";

const channel=(extra:Partial<ModelChannel>={}):ModelChannel=>({
 id:"channel123",name:"OpenAI",apiFormat:"openai",
 baseUrl:"https://api.openai.com/v1",apiKey:"sk-test-legacy",models:[],...extra
});
describe("default SQLite model routing and automatic DPAPI provisioning",()=>{
 it("routes supported official OpenAI/Ark models automatically, regardless of old saved toggle",()=>{
  expect(modelChannelProvider(channel(),"image")).toBe("openai");
  expect(modelChannelProvider(channel(),"text")).toBe("openai");
  expect(modelChannelProvider(channel(),"video")).toBeNull();
  expect(modelChannelProvider(channel({apiFormat:"volcengine_ark",
   baseUrl:"https://ark.cn-beijing.volces.com/api/v3"}),"video")).toBe("volcengine_ark");
  expect(modelChannelProvider(channel({apiFormat:"volcengine_ark",
   baseUrl:"https://ark.cn-beijing.volces.com/api/v3"}),"image")).toBeNull();
  expect(modelChannelProvider(channel({baseUrl:"http://api.openai.com/v1"}),"image")).toBeNull();
  expect(modelChannelProvider(channel({baseUrl:"https://custom-proxy.example/v1"}),"text")).toBeNull();
 });
 it("creates encrypted local channel on normal save, stripping browser key",async()=>{
  const calls:Array<{method:string;path:string;payload?:unknown}>=[];
  const api=vi.fn(async(path:string,method="GET",payload?:unknown)=>{
   calls.push({method,path,payload});
   if(method==="GET")throw new CanvasApiError("channel_not_found",404,method,path);
   if(method==="POST")return {id:"channel123",provider:"openai",hasKey:true,keyVersion:"ver1"};
   throw Error("unexpected");
  });
  const saved=await ensureSqliteModelChannel(channel(),"openai",api as unknown as typeof canvasApi);
  expect(saved.apiKey).toBe("");
  expect(calls).toEqual([
   {method:"GET",path:"/api/v1/channels/channel123",payload:undefined},
   {method:"POST",path:"/api/v1/channels",payload:{
    id:"channel123",provider:"openai",displayName:"OpenAI",apiKey:"sk-test-legacy"
   }}
  ]);
 });
 it("rotates an explicitly supplied new key using the existing version fence",async()=>{
  const api=vi.fn(async(path:string,method="GET",payload?:unknown)=>{
   if(method==="GET")return {id:"channel123",provider:"openai",hasKey:true,keyVersion:"old"};
   expect(method).toBe("PATCH");
   expect(payload).toEqual({apiKey:"sk-test-legacy",expectedKeyVersion:"old"});
   return {id:"channel123",provider:"openai",hasKey:true,keyVersion:"new"};
  });
  expect((await ensureSqliteModelChannel(channel(),"openai",api as unknown as typeof canvasApi)).apiKey).toBe("");
  expect(api).toHaveBeenCalledTimes(2);
 });
 it("ordinary editor save reuses an already vaulted unchanged key, but rotates a changed key",async()=>{
  const requests:Array<{method:string;path:string}>=[];
  const api=vi.fn(async(path:string,method="GET",payload?:unknown)=>{
   requests.push({method,path});
   if(method==="GET")return {id:"channel123",provider:"openai",hasKey:true,keyVersion:"current"};
   if(method==="PATCH"){
    expect(payload).toEqual({apiKey:"sk-new-key",expectedKeyVersion:"current"});
    return {id:"channel123",provider:"openai",hasKey:true,keyVersion:"next"};
   }
   throw Error("unexpected");
  });
  const original=channel();
  const same={...original,name:"Updated name"};
  const reused=await saveSqliteModelChannelFromEditor(same,original,"openai",api as unknown as typeof canvasApi);
  expect(reused.apiKey).toBe("");
  expect(requests).toEqual([{method:"GET",path:"/api/v1/channels/channel123"}]);
  const changed={...original,apiKey:"sk-new-key"};
  const updated=await saveSqliteModelChannelFromEditor(changed,original,"openai",api as unknown as typeof canvasApi);
  expect(updated.apiKey).toBe("");
  expect(requests.filter(r=>r.method==="PATCH")).toHaveLength(1);
 });
 it("reuses vaulted key without needing to reenter it or call a separate enable button",async()=>{
  const api=vi.fn(async()=>({id:"channel123",provider:"openai",hasKey:true,keyVersion:"current"}));
  const saved=await ensureSqliteModelChannel(channel({apiKey:""}),"openai",api as unknown as typeof canvasApi);
  expect(saved.apiKey).toBe("");
  expect(api).toHaveBeenCalledOnce();
 });
 it("fails closed on mismatched provider, unconfigured key or vault unavailable",async()=>{
  const api=vi.fn(async()=>({id:"channel123",provider:"volcengine_ark",hasKey:true,keyVersion:"v"}));
  await expect(ensureSqliteModelChannel(channel(),"openai",api as unknown as typeof canvasApi))
   .rejects.toThrow("其他模型服务占用");
  const empty=vi.fn(async()=>({id:"channel123",provider:"openai",hasKey:false,keyVersion:null}));
  await expect(ensureSqliteModelChannel(channel({apiKey:""}),"openai",
   empty as unknown as typeof canvasApi)).rejects.toThrow("填写并保存");
  const down=vi.fn(async()=>{throw new CanvasApiError("backend_unavailable",0)});
  await expect(ensureSqliteModelChannel(channel(),"openai",down as unknown as typeof canvasApi))
   .rejects.toThrow("backend_unavailable");
  expect(down).toHaveBeenCalledOnce();
 });
});
