import {describe,expect,it} from "vitest";
import type {CanvasAssistantMessage} from "@/types/canvas";
import {buildCanvasAssistantTurns} from "./canvas-assistant-history";
let serial=0;
const m=(role:CanvasAssistantMessage["role"],text:string):CanvasAssistantMessage=>({id:String(++serial),role,text});

describe("AI canvas assistant conversation continuity",()=>{
 it("keeps failed requests and uses the last incomplete task when the user says continue",()=>{
  const previous=[
   m("user","创建三个节点"),m("error","模型未返回可执行的画布指令"),
   m("user","连接这三个节点"),m("error","接口异常")
  ];
  const turns=buildCanvasAssistantTurns(previous,"继续","节点 2，连线 1");
  expect(turns).toHaveLength(5);
  expect(turns[0].content).toBe("创建三个节点");
  expect(turns[1].content).toContain("模型未返回可执行");
  expect(turns[2].content).toBe("连接这三个节点");
  expect(turns[3].content).toContain("接口异常");
  expect(turns[4].content).toContain("原始要求：连接这三个节点");
  expect(turns[4].content).toContain("只执行尚未完成的部分");
  expect(turns[4].content).toContain("用户问题：");
  expect(turns[4].content).toContain("节点 2，连线 1");
 });
 it("retains canvas execution outcomes as conversation context",()=>{
  const history=[
   m("user","解释节点有什么作用"),m("assistant","节点是画布上的工作单位。"),
   m("user","创建节点"),m("assistant","已自动执行 1 项画布操作。"),
   m("user","删除节点"),m("assistant","画布操作未完成：节点不存在"),
   m("user","运行图片生成"),m("assistant","已提交生成任务（任务 ID：job1）。")
  ];
  const turns=buildCanvasAssistantTurns(history,"分析当前画布");
  expect(turns).toHaveLength(9);
  expect(turns[3].content).toContain("已自动执行");
  expect(turns[5].content).toContain("节点不存在");
  expect(turns[7].content).toContain("job1");
 });
 it("only retains the last eight exchanges with fresh canvas state",()=>{
  const history=Array.from({length:20},(_,i)=>[
   m("user","问答"+i),m("assistant","回复"+i)
  ]).flat();
  const result=buildCanvasAssistantTurns(history,"移动节点","节点 5，连线 2");
  expect(result).toHaveLength(17);
  expect(result[0].content).toBe("问答12");
  expect(result[15].content).toBe("回复19");
  expect(result[16].content).toContain("用户问题：\n移动节点");
  expect(result[16].content).toContain("节点 5，连线 2");
 });
 it("groups Skill script logs, errors and run IDs in the same exchange",()=>{
  const history=[
   m("user","执行 Skill 导出文本"),
   m("assistant","Skill 脚本执行失败（运行 ID：run-123；状态：failed）。\n退出码：9009"),
   m("assistant","修正解释器后又尝试运行。"),
   m("error","助手已停止生成")
  ];
  const turns=buildCanvasAssistantTurns(history,"刚才为什么失败？");
  expect(turns).toHaveLength(3);
  expect(turns[1].content).toContain("run-123");
  expect(turns[1].content).toContain("9009");
  expect(turns[1].content).toContain("修正解释器");
  expect(turns[1].content).toContain("助手已停止生成");
  expect(turns[2].content).toBe("刚才为什么失败？");
 });
 it("does not treat a successful canvas action as unfinished",()=>{
  const history=[m("user","创建节点"),m("assistant","已自动执行 1 项画布操作。")];
  expect(buildCanvasAssistantTurns(history,"继续").at(-1)?.content).toBe("继续");
 });
 it("marks a saved orphaned user prompt as interrupted rather than discarding it",()=>{
  const turns=buildCanvasAssistantTurns([m("user","创建三个节点")],"重试");
  expect(turns[1].content).toContain("可能被中断");
  expect(turns.at(-1)?.content).toContain("原始要求：创建三个节点");
 });
 it("does not turn a failed explanatory question into a canvas mutation",()=>{
  const turns=buildCanvasAssistantTurns([
   m("user","解释为什么创建节点会失败"),m("error","服务超时")
  ],"继续");
  expect(turns.at(-1)?.content).toBe("继续");
 });
 it("uses the last execution outcome when a failed Skill attempt later succeeds",()=>{
  const turns=buildCanvasAssistantTurns([
   m("user","执行 Skill 生成文本"),
   m("assistant","Skill 脚本执行失败：9009"),
   m("assistant","已自动执行 1 项画布操作。")
  ],"继续");
  expect(turns.at(-1)?.content).toBe("继续");
 });
 it("bounds old history before sending it to the API",()=>{
  const history=Array.from({length:8},(_,i)=>[
   m("user","长问题"+i+"文".repeat(2500)),
   m("assistant","长回复"+i+"字".repeat(9000))
  ]).flat();
  const turns=buildCanvasAssistantTurns(history,"继续说明");
  expect(turns.at(-1)?.content).toBe("继续说明");
  expect(turns.reduce((sum,turn)=>sum+new TextEncoder().encode(turn.content).length,0)).toBeLessThanOrEqual(64*1024);
 });
});