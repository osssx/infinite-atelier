import {describe,expect,it} from "vitest";
import {isCanvasAssistantTextOnlyRequest,isCanvasAssistantSkillOptOutRequest} from "./canvas-assistant-output-intent";

const request="请帮我规划一个包含 3 个镜头的短视频分镜，只输出文字方案。不要修改画布、调用 Skill 或提交任何图片和视频生成任务。后续我会继续完善这个方案。";

describe("AI canvas assistant explicit output intent",()=>{
 it("routes the original text-only Task smoke prompt away from canvas actions and Skill scripts",()=>{
  expect(isCanvasAssistantTextOnlyRequest(request)).toBe(true);
  expect(isCanvasAssistantSkillOptOutRequest(request)).toBe(true);
 });
 it.each([
  "只输出文字方案，不要修改画布",
  "不要修改画布",
  "不要在画布创建节点",
  "仅提供分镜文字建议，不要生成媒体"
 ])("recognizes user-specified no-action constraints: %s",text=>{
  expect(isCanvasAssistantTextOnlyRequest(text)).toBe(true);
 });
 it.each([
  "创建三个分镜文本节点",
  "修改图片节点参数，不要生成图片",
  "将整个画布按连线关系布局，不要修改节点内容",
  "先输出思路，然后创建三个节点",
  "请用 scene-guide Skill 创建分镜节点"
 ])("keeps explicit canvas edits actionable: %s",text=>{
  expect(isCanvasAssistantTextOnlyRequest(text)).toBe(false);
 });
 it("does not suppress Skill unless the user opts out",()=>{
  expect(isCanvasAssistantSkillOptOutRequest("不要调用 Skill")).toBe(true);
  expect(isCanvasAssistantSkillOptOutRequest("请使用 Skill 整理分镜")).toBe(false);
  expect(isCanvasAssistantSkillOptOutRequest("请创建三个文本节点")).toBe(false);
 });
});
