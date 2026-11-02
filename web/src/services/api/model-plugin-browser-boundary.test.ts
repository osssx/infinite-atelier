import {describe,it,expect,vi} from "vitest";
vi.mock("axios",()=>({default:{post:vi.fn(),get:vi.fn(),delete:vi.fn(),request:vi.fn(),isAxiosError:()=>false}}));
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
import {defaultConfig,type AiConfig} from "@/stores/use-config-store";
import {runModelPlugin,getPluginTemplates,getScriptTemplatesForFormat,
 getScriptVariablesForFormat} from "./model-plugin";
import axios from "axios";
import {requestGeneration,requestEdit,requestImageQuestion} from "./image";
import {requestAudioGeneration} from "./audio";
import {requestVideoGeneration,createVideoGenerationTask,pollVideoGenerationTask} from "./video";

const openai:AiConfig={
 ...defaultConfig,apiFormat:"openai",model:"model-1",
 baseUrl:"https://api.example.com/v1",apiKey:"SECRET_SHOULD_NOT_BE_EXPOSED"
};
describe("P1 backend-owned scripts never fall back to browser JavaScript",()=>{
 it.each(["text","image","audio","video"] as const)(
  "fails closed before arbitrary browser script execution for %s",async capability=>{
   const dangerous='throw new Error("UNSAFE_BROWSER_EXECUTED")';
   await expect(runModelPlugin({capability,script:dangerous,
    config:openai,prompt:"test"})).rejects.toThrow(/只能通过画布后端 JobCoordinator/);
  });
 it.each(["openai","gemini","volcengine_ark"] as const)("blocks browser scripts for %s channels",async apiFormat=>{
  await expect(runModelPlugin({capability:"text",script:"return 7;",
   config:{...openai,apiFormat}})).rejects.toThrow(/只能通过画布后端 JobCoordinator/);
 });
 it("closes every legacy browser generation entry before any network request",async()=>{
  const videoTask={id:"old-task",provider:"openai" as const,model:"video-model"};
  const calls=vi.mocked(axios.post);
  await expect(requestGeneration(openai,"image")).rejects.toThrow(/画布后端 JobCoordinator/);
  await expect(requestEdit(openai,"image",[])).rejects.toThrow(/画布后端 JobCoordinator/);
  await expect(requestImageQuestion(openai,[],()=>{})).rejects.toThrow(/画布后端 JobCoordinator/);
  await expect(requestAudioGeneration(openai,"audio")).rejects.toThrow(/画布后端 JobCoordinator/);
  await expect(requestVideoGeneration(openai,"video")).rejects.toThrow(/画布后端 JobCoordinator/);
  await expect(createVideoGenerationTask(openai,"video")).rejects.toThrow(/画布后端 JobCoordinator/);
  await expect(pollVideoGenerationTask(openai,videoTask)).rejects.toThrow(/画布后端 JobCoordinator/);
  expect(calls).not.toHaveBeenCalled();
 });
 it.each(["text","image","audio","video"] as const)(
  "editor offers only backend templates and no key or browser helpers for %s",capability=>{
   const templates=getScriptTemplatesForFormat(capability,"openai");
   expect(templates.length).toBeGreaterThan(0);
   expect(templates.every(x=>x.label.startsWith("安全"))).toBe(true);
   expect(templates).toEqual(getPluginTemplates()[capability].slice(0,templates.length));
   const executable=templates.map(x=>x.script.replace(/^\s*\/\/.*$/gm,"")).join("\n");
   expect(executable).not.toMatch(/\bapiKey\b|new Function\(|\bfetch\(/);
   const vars=getScriptVariablesForFormat(capability,"openai");
   const names=vars.map(x=>x.name);
   expect(names).toContain("model");
   expect(names).toContain("http");
   expect(names).not.toContain("apiKey");
   expect(names).not.toContain("request");
   expect(names).not.toContain("poll");
   expect(names).not.toContain("onDelta");
  });
 it("does not hide existing templates/variables from non-migrated providers",()=>{
  expect(getScriptTemplatesForFormat("text","gemini")).toEqual(getPluginTemplates().text);
  expect(getScriptTemplatesForFormat("video","volcengine_ark")).toEqual(getPluginTemplates().video);
  expect(getScriptVariablesForFormat("text","gemini").map(x=>x.name)).toContain("apiKey");
 });
});
