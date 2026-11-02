import {describe,it,expect,vi} from "vitest";
const calls=vi.hoisted(()=>vi.fn());
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:calls}));
vi.mock("@/i18n",()=>({default:{t:(value:string)=>value}}));
import {fetchChannelModels} from "./image";
import type {ModelChannel} from "@/stores/use-config-store";

describe("backend-only OpenAI-compatible model catalog",()=>{
 it("fetches model IDs through local Vault without putting a raw key in request",async()=>{
  calls.mockReset().mockResolvedValue({models:["model-a","model-b"]});
  const channel:ModelChannel={
   id:"my-proxy",name:"proxy",apiFormat:"openai",
   baseUrl:"http://localhost:8188/v1",apiKey:"SHOULD_NOT_APPEAR",
   models:[{name:"model-a",capability:"image"}]
  };
  expect(await fetchChannelModels(channel)).toEqual(["model-a","model-b"]);
  expect(calls).toHaveBeenCalledExactlyOnceWith(
   "/api/v1/channels/my-proxy/models","POST",{baseUrl:"http://localhost:8188/v1"});
  expect(JSON.stringify(calls.mock.calls)).not.toContain("SHOULD_NOT_APPEAR");
 });
 it("loads Gemini models through the Vault-backed endpoint without sending its browser key",async()=>{
  calls.mockReset().mockResolvedValue({models:["gemini-2.5-flash"]});
  const channel:ModelChannel={id:"gemini-channel",name:"Gemini",apiFormat:"gemini",
   baseUrl:"https://generativelanguage.googleapis.com",apiKey:"GEMINI_BROWSER_SECRET",models:[]};
  expect(await fetchChannelModels(channel)).toEqual(["gemini-2.5-flash"]);
  expect(calls).toHaveBeenCalledExactlyOnceWith(
   "/api/v1/channels/gemini-channel/models","POST",{baseUrl:"https://generativelanguage.googleapis.com"});
  expect(JSON.stringify(calls.mock.calls)).not.toContain("GEMINI_BROWSER_SECRET");
 });
 it("does not silently fall back to browser direct model requests on backend failure",async()=>{
  calls.mockReset().mockRejectedValue(Error("vault_not_available"));
  const channel:ModelChannel={id:"my-proxy",name:"proxy",apiFormat:"openai",
   baseUrl:"https://models.example.net/v1",apiKey:"a-secret",models:[]};
  await expect(fetchChannelModels(channel)).rejects.toThrow("vault_not_available");
  expect(calls).toHaveBeenCalledTimes(1);
 });
});
