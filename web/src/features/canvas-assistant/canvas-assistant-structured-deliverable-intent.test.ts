import {describe,it,expect} from "vitest";
import {detectAssistantStructuredTextDelivery as detect} from "./canvas-assistant-structured-deliverable-intent";
import {isCanvasAssistantCanvasActionRequest} from "./canvas-assistant-output-intent";
describe("P4.3 显式文本交付意图",()=>{
 it("识别故事、场景与分镜的单一交付规格",()=>{
  expect(detect("请生成一份兔子儿童动画故事大纲","task",false)).toMatchObject({
   deliverableType:"story",title:"故事大纲",minimumMeaningfulChars:60});
  expect(detect("设计兔子动画的场景设定","task",false)).toMatchObject({
   deliverableType:"scene",title:"场景设定",minimumMeaningfulChars:35});
  expect(detect("为兔子动画编写分镜提示词","task",false)).toMatchObject({
   deliverableType:"storyboard",title:"分镜提示词",minimumMeaningfulChars:40});
 });
 it("用户明确要求空白模板才允许空正文",()=>{
  expect(detect("创建空白场景设定模板","task",false)?.allowEmptyTemplate).toBe(true);
  expect(detect("创建场景设定","task",false)?.allowEmptyTemplate).toBe(false);
  expect(detect("请创建场景设定文本节点，不要空白模板，要写出具体内容","task",false)?.allowEmptyTemplate).toBe(false);
 });
 it("纯讨论、非 Task 与文本问答不自动冻结规格",()=>{
  expect(detect("如何编写故事大纲？","task",false)).toBeNull();
  expect(detect("请查看当前场景设定","task",false)).toBeNull();
  expect(detect("请创建场景设定",null,false)).toBeNull();
  expect(detect("请创建场景设定","task",true)).toBeNull();
 });
 it("与画布显式编辑入口保持一致：纯撰写问答不自动创建节点",()=>{
  for(const text of ["生成故事大纲文本节点","创建场景设定文本节点","生成分镜提示词文本节点"]){
   expect(isCanvasAssistantCanvasActionRequest(text)).toBe(true);
   expect(detect(text,"task",!isCanvasAssistantCanvasActionRequest(text))).not.toBeNull();
  }
  for(const text of ["请编写分镜提示词","请设计场景设定"]){
   expect(isCanvasAssistantCanvasActionRequest(text)).toBe(false);
   expect(detect(text,"task",!isCanvasAssistantCanvasActionRequest(text))).toBeNull();
  }
 });
 it("同时请求多种文本交付不默选一种",()=>{
  expect(detect("请生成故事大纲和分镜提示词","task",false)).toBeNull();
  expect(detect("请生成场景设定和故事大纲","task",false)).toBeNull();
 });
 it("明确要求多个故事或场景节点时不默默收缩为单一规格",()=>{
  expect(detect("请生成三个场景设定文本节点","task",false)).toBeNull();
  expect(detect("请创建多个场景设定卡片","task",false)).toBeNull();
  expect(detect("请生成两篇故事大纲","task",false)).toBeNull();
  expect(detect("请生成两个故事大纲文本节点","task",false)).toBeNull();
  expect(detect("你创建三个分镜文本节点并依次连线","task",false)).toBeNull();
  expect(detect("请创建分镜提示词节点并连接到已有故事节点","task",false)).toBeNull();
 });
 it("故事大纲作为来源时允许明确的分镜目标",()=>{
  expect(detect("根据故事大纲生成分镜提示词","task",false)?.deliverableType).toBe("storyboard");
  expect(detect("根据故事大纲生成场景设定","task",false)?.deliverableType).toBe("scene");
  expect(detect("请根据故事大纲生成视频","task",false)).toBeNull();
  expect(detect("请基于场景卡生成背景图片","task",false)).toBeNull();
  expect(detect("请创建一个分镜提示词文本节点，标题为《雨夜归家》","task",false)?.title).toBe("雨夜归家");
 });
});
