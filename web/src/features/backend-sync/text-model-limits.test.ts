import {describe,expect,it} from "vitest";
import {assertTextHistorySize,assertTextPromptSize,MAX_TEXT_PROMPT_BYTES} from "./text-model-limits";

describe("text model Skill prompt size limits",()=>{
 it("accepts a multi-Skill Chinese prompt well beyond the old 16KB cap",()=>{
  const prompt = '<selected-skill id="a">\n'+ "中文指令".repeat(14000)
   +'</selected-skill>\n<selected-skill id="b">\n'
   +"镜头说明".repeat(14000)+'</selected-skill>\n<user-request>写分镜</user-request>';
  expect(new TextEncoder().encode(prompt).length).toBeGreaterThan(16000);
  expect(()=>assertTextPromptSize(prompt)).not.toThrow();
  expect(()=>assertTextHistorySize([{role:"system",content:"你是编剧助手"}, {role:"user",content:prompt}])).not.toThrow();
 });
 it("enforces UTF-8 byte limits, including exactly-at-cap and over-cap prompts",()=>{
  expect(()=>assertTextPromptSize("x".repeat(MAX_TEXT_PROMPT_BYTES))).not.toThrow();
  expect(()=>assertTextPromptSize("中".repeat(Math.ceil((MAX_TEXT_PROMPT_BYTES+1)/3)))).toThrow(/512 KiB/);
  expect(()=>assertTextHistorySize([{role:"system",content:"x".repeat(MAX_TEXT_PROMPT_BYTES)}, {role:"user",content:"y".repeat(MAX_TEXT_PROMPT_BYTES)}])).not.toThrow();
  expect(()=>assertTextHistorySize([{role:"system",content:"x".repeat(MAX_TEXT_PROMPT_BYTES)}, {role:"assistant",content:"a"},{role:"user",content:"y".repeat(MAX_TEXT_PROMPT_BYTES)}])).toThrow(/1 MiB/);
  expect(()=>assertTextHistorySize([{role:"assistant",content:"x".repeat(32769)}])).toThrow(/单条/);
 });
});
