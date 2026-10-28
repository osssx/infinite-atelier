import {describe,it,expect,vi} from "vitest";
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
import {defaultConfig,type AiConfig} from "@/stores/use-config-store";
import {runModelPlugin,getPluginTemplates,getScriptTemplatesForFormat,
 getScriptVariablesForFormat} from "./model-plugin";

const openai:AiConfig={
 ...defaultConfig,apiFormat:"openai",model:"model-1",
 baseUrl:"https://api.example.com/v1",apiKey:"SECRET_SHOULD_NOT_BE_EXPOSED"
};
describe("P1 backend-owned scripts never fall back to browser JavaScript",()=>{
 it.each(["text","image","audio","video"] as const)(
  "fails closed before arbitrary browser script execution for %s",async capability=>{
   const dangerous='throw new Error("UNSAFE_BROWSER_EXECUTED")';
   await expect(runModelPlugin({capability,script:dangerous,
    config:openai,prompt:"test"})).rejects.toThrow(/只能通过画布后端任务执行/);
  });
 it("allows unrelated Gemini-format legacy script entry while provider migration is pending",async()=>{
  const result=await runModelPlugin<number>({capability:"text",script:"return 7;",
   config:{...openai,apiFormat:"gemini"}});
  expect(result).toBe(7);
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
