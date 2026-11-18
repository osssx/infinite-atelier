// @vitest-environment happy-dom
import {describe,expect,it} from "vitest";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";
import {applyAssistantCanvasActions,type AssistantCanvasAction} from "./canvas-assistant-actions";
import {assertCanvasEditCurrent,describeCanvasEdit,freezeCanvasEditContext} from "./canvas-edit-authorization";

const node=(id:string):CanvasNodeData=>({id,title:"同名",type:CanvasNodeType.Text,position:{x:0,y:0},width:100,height:60});
const graph={nodes:[node("selected"),node("adjacent")],connections:[{id:"edge",fromNodeId:"selected",toNodeId:"adjacent"}]};
const frozen=freezeCanvasEditContext(graph,{selectedNodeIds:["selected"],explicitReferences:[],fullGraphGrant:false});

describe("canvas edit authorization",()=>{
 it("permits an explicitly referenced ID but rejects direct edits to read-only neighbors",()=>{
  const actions:AssistantCanvasAction[]=[{type:"set_text",nodeId:"adjacent",content:"new"}];
  const after=applyAssistantCanvasActions(graph,actions,"dangerous",{x:0,y:0});
  expect(()=>describeCanvasEdit(graph,after,actions,frozen)).toThrow("越过");
  expect(describeCanvasEdit(graph,after,actions,{...frozen,explicitReferences:[{nodeId:"adjacent"}]}))
   .toMatchObject({requiresPreview:true,summary:expect.stringContaining("[adjacent]")});
 });
 it("previews the actual edge removed by deleting the selected node",()=>{
  const actions:AssistantCanvasAction[]=[{type:"delete_node",nodeId:"selected"}];
  const after=applyAssistantCanvasActions(graph,actions,"dangerous",{x:0,y:0});
  expect(describeCanvasEdit(graph,after,actions,frozen)).toMatchObject({
   requiresPreview:true,summary:expect.stringContaining("移除连线 [edge]")
  });
  expect(graph.connections).toHaveLength(1);
 });
 it("rejects a stale graph even when the selected IDs and titles still match",()=>{
  const changed={...graph,nodes:[{...graph.nodes[0],position:{x:1,y:0}},graph.nodes[1]]};
  expect(()=>assertCanvasEditCurrent(changed,frozen)).toThrow("发生变化");
 });
 it("requires preview when an authorized group layout also moves an unselected member",()=>{
  const group={...node("group"),type:CanvasNodeType.Group,width:300,height:200};
  const child={...node("child"),metadata:{groupId:"group"}};
  const before={nodes:[group,child],connections:[]};
  const actions:AssistantCanvasAction[]=[{type:"layout_nodes",nodeIds:["group"],direction:"horizontal"}];
  const after=applyAssistantCanvasActions(before,actions,"safe",{x:400,y:400});
  const context=freezeCanvasEditContext(before,{selectedNodeIds:["group"],explicitReferences:[],fullGraphGrant:false});
  expect(describeCanvasEdit(before,after,actions,context)).toMatchObject({
   requiresPreview:true,summary:expect.stringMatching(/级联：.*\[child\] position/)
  });
 });
});
