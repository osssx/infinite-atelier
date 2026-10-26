import {describe,it,expect} from "vitest";
import {CanvasNodeType,type CanvasNodeData,type CanvasConnection} from "@/types/canvas";
import {findSqliteModelRetrySource} from "./sqlite-model-retry-source";
const node=(id:string,type:CanvasNodeData["type"],content?:string):CanvasNodeData=>({
 id,type,title:id,position:{x:0,y:0},width:320,height:200,
 metadata:{...(content?{content}:{})}
});
const edge=(fromNodeId:string,toNodeId:string):CanvasConnection=>({id:fromNodeId+"-"+toNodeId,fromNodeId,toNodeId});
describe("P4.6 official retry source resolution",()=>{
 it("retries an image from its sole upstream Text producer, never from a completed image",()=>{
  const text=node("prompt",CanvasNodeType.Text,"A fox"),out=node("result",CanvasNodeType.Image,"/api/v1/blobs/hash");
  expect(findSqliteModelRetrySource(out,[text,out],[edge("prompt","result")])).toBe(text);
 });
 it("prefers Config ancestor through intermediates",()=>{
  const config=node("cfg",CanvasNodeType.Config),text=node("text",CanvasNodeType.Text),out=node("out",CanvasNodeType.Video);
  expect(findSqliteModelRetrySource(out,[config,text,out],[edge("cfg","text"),edge("text","out")])).toBe(config);
 });
 it("ambiguous producers fail closed, no automatic selection",()=>{
  const a=node("a",CanvasNodeType.Text),b=node("b",CanvasNodeType.Text),out=node("out",CanvasNodeType.Audio);
  expect(findSqliteModelRetrySource(out,[a,b,out],[edge("a","out"),edge("b","out")])).toBe(out);
 });
 it("standalone failed empty output is its own source",()=>{
  const out=node("out",CanvasNodeType.Image);
  expect(findSqliteModelRetrySource(out,[out],[])).toBe(out);
 });
});
