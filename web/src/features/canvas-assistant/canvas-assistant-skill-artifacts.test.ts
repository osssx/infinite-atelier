import {describe,expect,it} from "vitest";
import {createSkillTextArtifactActions} from "./canvas-assistant-skill-artifacts";

describe("generic completed Skill text-artifact recovery",()=>{
 const content='{"summary":"夜市","visibleText":"你好","items":[]}';
 const valid={status:"completed",exit_code:0,artifacts:[{
  path:"outputs/prompt.txt",mime:"text/plain",content,
  byte_length:new TextEncoder().encode(content).length
 }]};
 it("creates a safe text node with the exact verified script output, no MOSS schema assumptions",()=>{
  const actions=createSkillTextArtifactActions(valid);
  expect(actions).toHaveLength(1);
  expect(actions[0].type).toBe("create_node");
  expect(actions[0].nodeType).toBe("text");
  expect(actions[0].title).toContain("prompt.txt");
  expect(actions[0].content).toBe(content);
 });
 it("rejects failed executions, binary or partial artifacts, and mismatched byte sizes",()=>{
  expect(createSkillTextArtifactActions({...valid,status:"failed"})).toEqual([]);
  expect(createSkillTextArtifactActions({...valid,exit_code:9009})).toEqual([]);
  expect(createSkillTextArtifactActions({...valid,artifacts:[{...valid.artifacts[0],mime:"image/png"}]})).toEqual([]);
  expect(createSkillTextArtifactActions({...valid,artifacts:[{...valid.artifacts[0],byte_length:8000}]})).toEqual([]);
  expect(createSkillTextArtifactActions({...valid,artifacts:[{...valid.artifacts[0],content:undefined}]})).toEqual([]);
 });
 it("bounds fallback to four distinct, fully inlined outputs",()=>{
  const artifacts=Array.from({length:8},(_,i)=>({
   path:"out/file-"+i+".txt",mime:"text/plain",content:"ok",
   byte_length:2
  }));
  expect(createSkillTextArtifactActions({status:"completed",artifacts}).length).toBe(4);
  expect(createSkillTextArtifactActions({status:"completed",artifacts:[artifacts[0],artifacts[0]]}).length).toBe(1);
 });
});
