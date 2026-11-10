import {describe,expect,it} from "vitest";
import type {CanvasAssistantMessage} from "@/types/canvas";
import {buildCanvasAssistantTurns} from "./canvas-assistant-history";
let serial=0;
const m=(role:CanvasAssistantMessage["role"],text:string):CanvasAssistantMessage=>({id:String(++serial),role,text});

describe("AI canvas assistant history isolation",()=>{
 it("excludes every orphaned request whose model action attempt failed",()=>{
  const history=[
   m("user","创建三个节点"),
   m("error","模型未返回可执行的画布指令，已尝试重新生成操作计划"),
   m("user","创建三个节点"),
   m("error","assistant_actions_missing"),
   m("user","创建三个节点")
  ];
  const result=buildCanvasAssistantTurns(history,"创建三个节点","节点 2，连线 1");
  expect(result).toHaveLength(1);
  expect(result[0].role).toBe("user");
  expect(result[0].content).toContain("用户问题：\n创建三个节点");
  expect(result[0].content).toContain("节点 2，连线 1");
  expect(JSON.stringify(result)).not.toContain("模型未返回可执行");
 });
 it("keeps coherent Q&A, drops unpaired user messages and completed operations",()=>{
  const history=[
   m("user","解释节点有什么作用"),m("assistant","节点是画布上的工作单位。"),
   m("user","创建三个节点"),m("error","assistant_actions_missing"),
   m("user","改为创建一个节点"),
   m("assistant","已创建一个节点。\n\n已自动执行 1 项画布操作。"),
   m("user","删除节点"),m("assistant","准备删除。\n\n画布操作未完成：节点不存在"),
   m("user","运行图片生成"),m("assistant","准备生成。\n\n已通过原有节点执行链路提交 1 项生成任务（任务 ID：job1）。"),
   m("user","再试试删除节点"),m("error","接口异常"),
   m("user","无回复的旧问题")
  ];
  const result=buildCanvasAssistantTurns(history,"什么是端口？");
  expect(result).toEqual([
   {role:"user",content:"解释节点有什么作用"},
   {role:"assistant",content:"节点是画布上的工作单位。"},
   {role:"user",content:"什么是端口？"}
  ]);
 });
 it("retains only the latest eight complete Q&A exchanges and current full canvas context",()=>{
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
 it("drops an old user turn after an error even when an assistant turn arrives later",()=>{
  const history=[
   m("user","修改节点"),m("error","失败"),m("assistant","旧消息"),
   m("user","正常问题"),m("assistant","正常回复")
  ];
  expect(buildCanvasAssistantTurns(history,"新指令")).toEqual([
   {role:"user",content:"正常问题"},
   {role:"assistant",content:"正常回复"},
   {role:"user",content:"新指令"}
  ]);
 });
});
