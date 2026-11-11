// @vitest-environment happy-dom
import {describe,expect,it} from "vitest";
import type {CanvasResourceReference} from "@/lib/canvas/canvas-resource-references";
import {collectAssistantImageMentions} from "./canvas-assistant-visual-mentions";
import {canvasResourceReferenceToken} from "@/lib/canvas/canvas-resource-references";

const image=(id:string,label:string):CanvasResourceReference=>({
 id,nodeId:id,title:"画面 "+id,label,kind:"image",active:true
});
describe("assistant visual @-mention extraction",()=>{
 it("resolves only explicitly mentioned active images and never unrelated text resources",()=>{
  const candidates=[image("a","参考图1"),image("b","参考图2"),{
   id:"text",nodeId:"text",kind:"text",label:"资料1",title:"文案",active:true
  } satisfies CanvasResourceReference];
  const result=collectAssistantImageMentions("分析 "+canvasResourceReferenceToken(candidates[1])+"，与 资料1 对比",candidates);
  expect(result.images).toEqual([{nodeId:"b"}]);
  expect(result.text).toContain("【参考图片：画面 b】");
  expect(result.text).toContain("资料1");
 });
 it("deduplicates repeated identity mentions and preserves the user's order",()=>{
  const a=image("a","参考图1"),b=image("b","参考图10");
  const result=collectAssistantImageMentions([
   canvasResourceReferenceToken(b),canvasResourceReferenceToken(a),canvasResourceReferenceToken(a)
  ].join(" "),[a,b]);
  expect(result.images).toEqual([{nodeId:"b"},{nodeId:"a"}]);
  expect(result.text).not.toContain("@[node:");
 });
 it("uses stable node/image identity tokens even when display labels change",()=>{
  const ref={...image("node:img","参考图1"),imageId:"second"};
  const token=canvasResourceReferenceToken(ref);
  const renamed={...ref,label:"参考图7",title:"新版标题"};
  const picked=collectAssistantImageMentions("分析 "+token,[renamed]);
  expect(picked.images).toEqual([{nodeId:"node:img",imageId:"second"}]);
  expect(picked.unresolved).toBe(false);
  expect(picked.text).toContain("新版标题");
  const gone=collectAssistantImageMentions("分析 "+token,[]);
  expect(gone.images).toEqual([]);
  expect(gone.unresolved).toBe(true);
 });
 it("never interprets ordinary text matching a reference label as permission to send an image",()=>{
  const refs=[image("a","参考图1"),image("b","参考图2")];
  const result=collectAssistantImageMentions("我想讨论参考图1和参考图2这两个名字",refs);
  expect(result.images).toEqual([]);
  expect(result.unresolved).toBe(false);
  expect(result.text).toContain("参考图1");
 });
 it("never infers images from unselected, hidden references",()=>{
  expect(collectAssistantImageMentions("参考图1",[{...image("a","参考图1"),active:false}]).images).toEqual([]);
  expect(collectAssistantImageMentions("讲讲图片",[]).images).toEqual([]);
 });
});
