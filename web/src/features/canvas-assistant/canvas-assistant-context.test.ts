import {describe,it,expect} from "vitest";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";
import {buildCanvasAssistantContext} from "./canvas-assistant-context";
const nodes:CanvasNodeData[]=[
 {id:"t1",type:CanvasNodeType.Text,title:"梗概",position:{x:0,y:0},width:200,height:80,
  metadata:{content:"雨夜来信",prompt:"写成短剧"}},
 {id:"i1",type:CanvasNodeType.Image,title:"人物图",position:{x:5,y:5},width:200,height:90,
  metadata:{content:"data:image/png;base64,AAAA",prompt:"红发主角"}},
 {id:"t2",type:CanvasNodeType.Text,title:"秘密",position:{x:0,y:0},width:180,height:80,metadata:{content:"保密内容"}},
];
describe("assistant context snapshot",()=>{
 it("uses only referenced nodes and adjacent topology",()=>{
  const result=buildCanvasAssistantContext({projectTitle:"测试",nodes,connections:[
   {id:"e1",fromNodeId:"t1",toNodeId:"i1"}],nodeIds:["t1","i1"]});
  expect(result.text).toContain("雨夜来信");
  expect(result.text).toContain("梗概 → 人物图");
  expect(result.text).not.toContain("保密内容");
  expect(result.text).not.toContain("base64");
  expect(result.references).toHaveLength(2);
 });
 it("limits large selections and output; overview excludes contents",()=>{
  const result=buildCanvasAssistantContext({projectTitle:"画布",nodes:[...nodes,{...nodes[0],
   id:"long",metadata:{content:"字".repeat(30000)}}],connections:[],nodeIds:["long"],maxChars:800});
  expect(result.truncated).toBe(true);
  expect(result.text.length).toBeLessThan(850);
  const overview=buildCanvasAssistantContext({projectTitle:"画布",nodes,connections:[],nodeIds:[],scope:"overview"});
  expect(overview.text).not.toContain("雨夜来信");
 });
 it("gives selected group member IDs and overview group memberships without leaking text",()=>{
  const graph=[...nodes,{id:"group-1",type:CanvasNodeType.Group,title:"第一幕",position:{x:0,y:0},width:760,height:480,metadata:{status:"idle" as const}},
   {...nodes[2],metadata:{...nodes[2].metadata,groupId:"group-1"}}];
  const selected=buildCanvasAssistantContext({projectTitle:"剧情",nodes:graph,connections:[],nodeIds:["group-1","t2"]});
  expect(selected.text).toContain("分组成员：秘密 (id=t2)");
  expect(selected.text).toContain("所属分组：id=group-1");
  const overview=buildCanvasAssistantContext({projectTitle:"剧情",nodes:graph,connections:[],nodeIds:[],scope:"overview"});
  expect(overview.text).toContain("groupId=group-1");
  expect(overview.text).not.toContain("保密内容");
 });
});