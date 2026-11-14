import {describe,it,expect} from "vitest";
import {wantsAssistantTaskReadTools} from "./canvas-assistant-read-tool-intent";

describe("P4.2a 显式 Task 只读工具模式",()=>{
 it("仅在关联 Task 且明确请求查询画布或历史时启用",()=>{
  expect(wantsAssistantTaskReadTools("查看选中的画布节点内容","task1")).toBe(true);
  expect(wantsAssistantTaskReadTools("搜索角色设定节点","task1")).toBe(true);
  expect(wantsAssistantTaskReadTools("检查画布节点连线","task1")).toBe(true);
  expect(wantsAssistantTaskReadTools("读取任务历史记录","task1")).toBe(true);
  expect(wantsAssistantTaskReadTools("检索创作资料","task1")).toBe(true);
 });
 it("不将普通创作或无 Task 的请求误选为工具执行",()=>{
  expect(wantsAssistantTaskReadTools("查看选中的画布节点内容",null)).toBe(false);
  expect(wantsAssistantTaskReadTools("创作兔子儿童动画故事","task1")).toBe(false);
  expect(wantsAssistantTaskReadTools("生成角色卡提示词文本节点","task1")).toBe(false);
  expect(wantsAssistantTaskReadTools("继续下一阶段","task1")).toBe(false);
 });
});
