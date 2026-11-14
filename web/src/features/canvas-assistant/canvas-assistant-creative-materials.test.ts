import {describe,expect,it} from "vitest";
import {detectAssistantCreativeMaterialIntent,selectAssistantCreativeMaterialsForRequest,
 summarizeAssistantCreativeMaterials,type AssistantCreativeMaterial} from "./canvas-assistant-creative-materials";

const item=(kind:AssistantCreativeMaterial["kind"],title:string):AssistantCreativeMaterial=>({
 kind,title,sourceRef:"creative_"+title,sourceDigest:"f".repeat(64),
 sourceLabel:"历史 AI 草稿",provenance:"model_draft",excerpt:"已确认的测试摘要"
});

describe("P4.1b Task 创作资料选择",()=>{
 it("只有关联 Task 且明确引用过去的故事/场景/画风时触发",()=>{
  expect(detectAssistantCreativeMaterialIntent("根据之前的故事和画风继续创作","task")).toEqual({
   kinds:["story","style"],shouldSelect:true});
  expect(detectAssistantCreativeMaterialIntent("根据之前的故事和画风继续创作",null).shouldSelect).toBe(false);
  expect(detectAssistantCreativeMaterialIntent("生成新的故事", "task").shouldSelect).toBe(false);
  expect(detectAssistantCreativeMaterialIntent("保持此前森林场景的美术风格", "task")).toEqual({
   kinds:["scene","style"],shouldSelect:true});
 });
 it("资料按类别选取，明确标题只收窄相应类别",()=>{
  const values=[item("scene","森林场景"),item("scene","室内场景"),item("style","美术风格")];
  expect(selectAssistantCreativeMaterialsForRequest(values,["scene","style"],
   "根据之前森林场景的美术风格继续")).toEqual([values[0],values[2]]);
  expect(selectAssistantCreativeMaterialsForRequest(values,["scene"],"根据之前的场景继续")).toEqual(values.slice(0,2));
 });
 it("超限和无来源不静默截取",()=>{
  const values=Array.from({length:5},(_,i)=>item("scene","场景-"+i));
  expect(()=>selectAssistantCreativeMaterialsForRequest(values,["scene"],"根据之前场景继续")).toThrow(/超过本轮/);
  expect(()=>selectAssistantCreativeMaterialsForRequest([],["scene"],"根据之前场景继续")).toThrow(/没有找到/);
 });
 it("确认提示明确标明草稿未确认，摘要有长度限制",()=>{
  const value=item("story","森林故事");
  value.excerpt="兔子冒险的故事内容".repeat(500);
  const summary=summarizeAssistantCreativeMaterials([value]);
  expect(summary).toContain("（AI 草稿，尚未确认）");
  expect(summary).toContain("取消则不会外发");
  expect(summary.length).toBeLessThan(370);
 });
});
