// @vitest-environment happy-dom
import {describe,it,expect} from "vitest";
import {CanvasNodeType,type CanvasNodeData,type CanvasConnection} from "@/types/canvas";
import {applyAssistantCanvasActions,dangerousAssistantActionSummary,isDangerousAssistantAction,parseAssistantCanvasActions} from "./canvas-assistant-actions";

const basic=(id:string,x:number,y:number):CanvasNodeData=>({
 id,type:CanvasNodeType.Text,title:id,position:{x,y},width:340,height:240,metadata:{content:"原始:"+id,status:"success"}
});
const center={x:300,y:240};
const start=()=>{
 const nodes=[basic("a",10,10),basic("b",410,10),basic("c",1600,960)];
 const connections:CanvasConnection[]=[{id:"edge-a-b",fromNodeId:"a",toNodeId:"b"}];
 const grouped=applyAssistantCanvasActions({nodes,connections},[
  {type:"create_group",ref:"group1",title:"原有分组",members:["a","b"]}
 ],"safe",center);
 return {nodes,connections,grouped,groupId:grouped.refs.get("group1")!};
};
describe("P2.3 existing-group membership operations",()=>{
 it("adds existing and newly created nodes, enlarging group without relocating nodes or disconnecting edges",()=>{
  const {grouped,groupId}=start();
  const before=new Map(grouped.nodes.map(n=>[n.id,n]));
  const actions=[
   {type:"create_node",nodeType:"text",ref:"new_node",title:"新场景",content:"新增"},
   {type:"add_to_group",groupId:"group1",members:["c","new_node"]}
  ];
  const result=applyAssistantCanvasActions(grouped,actions,"safe",center,grouped.refs);
  expect(result.applied).toBe(2);
  expect(result.refs.get("group1")).toBe(groupId);
  expect(result.nodes.find(n=>n.id==="c")?.metadata?.groupId).toBe(groupId);
  expect(result.nodes.find(n=>n.id==="c")?.position).toEqual(before.get("c")?.position);
  expect(result.nodes.find(n=>n.id==="c")?.metadata?.content).toBe("原始:c");
  expect(result.nodes.find(n=>n.id===result.refs.get("new_node"))?.metadata?.groupId).toBe(groupId);
  const group=result.nodes.find(n=>n.id===groupId)!;
  expect(group.position.x).toBeLessThanOrEqual(before.get(groupId)!.position.x);
  expect(group.width).toBeGreaterThan(before.get(groupId)!.width);
  expect(group.position.y+group.height).toBeGreaterThan(1200);
  expect(result.connections).toEqual(grouped.connections);
  expect(grouped.nodes.find(n=>n.id==="c")?.metadata?.groupId).toBeUndefined();
 });
 it("removes members from existing group while preserving their exact position, media metadata and edges",()=>{
  const {grouped,groupId}=start();
  const before=grouped.nodes.find(n=>n.id==="a")!;
  const result=applyAssistantCanvasActions(grouped,[
   {type:"remove_from_group",groupId,members:["a"]}
  ],"safe",center,grouped.refs);
  expect(result.applied).toBe(1);
  const detached=result.nodes.find(n=>n.id==="a")!;
  expect(detached.position).toEqual(before.position);
  expect(detached.metadata).toEqual({...before.metadata,groupId:undefined});
  expect(result.nodes.find(n=>n.id==="b")?.metadata?.groupId).toBe(groupId);
  expect(result.nodes.find(n=>n.id===groupId)).toEqual(grouped.nodes.find(n=>n.id===groupId));
  expect(result.connections).toEqual(grouped.connections);
 });
 it("treats dissolution as high risk; only after confirmation remove shell, preserving nodes and edges",()=>{
  const {grouped,groupId}=start();
  const actions=parseAssistantCanvasActions([{type:"ungroup",groupId:"group1"}]);
  expect(isDangerousAssistantAction(actions[0])).toBe(true);
  expect(dangerousAssistantActionSummary(actions)).toContain("解散 1 个分组");
  const safe=applyAssistantCanvasActions(grouped,actions,"safe",center,grouped.refs);
  expect(safe.applied).toBe(0);
  expect(safe.nodes).toEqual(grouped.nodes);
  const changed=applyAssistantCanvasActions(safe,actions,"dangerous",center,grouped.refs);
  expect(changed.applied).toBe(1);
  expect(changed.nodes).toHaveLength(grouped.nodes.length-1);
  expect(changed.nodes.some(n=>n.id===groupId)).toBe(false);
  for(const id of ["a","b","c"]){
   expect(changed.nodes.find(n=>n.id===id)?.position).toEqual(grouped.nodes.find(n=>n.id===id)?.position);
   expect(changed.nodes.find(n=>n.id===id)?.metadata?.groupId).toBeUndefined();
  }
  expect(changed.connections).toEqual(grouped.connections);
 });
 it("fails closed for invalid membership, nesting, duplicate refs and moving nodes already grouped",()=>{
  const {grouped,groupId}=start();
  const cases=[
   [{type:"add_to_group",groupId,members:["a"]}], // already member
   [{type:"add_to_group",groupId,members:["missing"]}],
   [{type:"add_to_group",groupId,members:["group1"]}], // nested
   [{type:"add_to_group",groupId:"missing",members:["c"]}],
   [{type:"remove_from_group",groupId,members:["c"]}], // not a member
   [{type:"remove_from_group",groupId,members:["a","missing"]}],
   [{type:"create_node",ref:"new1",nodeType:"text",title:"New"},
    {type:"add_to_group",groupId:"missing",members:["new1"]}]
  ];
  for(const actions of cases){
   expect(()=>applyAssistantCanvasActions(grouped,actions,"safe",center,grouped.refs)).toThrow();
   expect(grouped.nodes.find(n=>n.id==="c")?.metadata?.groupId).toBeUndefined();
   expect(grouped.nodes.some(n=>n.title==="New")).toBe(false);
  }
  for(const action of [
   {type:"add_to_group",groupId,members:[]},
   {type:"remove_from_group",groupId,members:["a","a"]},
   {type:"add_to_group",groupId,members:["c"],force:true},
   {type:"ungroup",groupId,deleteMembers:true},
   {type:"ungroup",groupId:1}
  ])expect(()=>parseAssistantCanvasActions([action])).toThrow();
 });
 it("blocks ungroup when group shell itself has edges; avoids loss of existing connections",()=>{
  const {grouped,groupId}=start();
  const withEdge={...grouped,connections:[...grouped.connections,
   {id:"edge-to-group",fromNodeId:"c",toNodeId:groupId}]};
  expect(()=>applyAssistantCanvasActions(withEdge,[
   {type:"ungroup",groupId}
  ],"dangerous",center,grouped.refs)).toThrow(/分组自身仍有连线/);
  expect(withEdge.connections).toHaveLength(2);
 });
 it("rejects extreme group expansion atomically rather than silently moving the graph",()=>{
  const {grouped,groupId}=start();
  const remote=basic("remote",999900,999900);
  const input={nodes:[...grouped.nodes,remote],connections:grouped.connections};
  expect(()=>applyAssistantCanvasActions(input,[
   {type:"add_to_group",groupId,members:["remote"]}
  ],"safe",center)).toThrow(/安全范围/);
  expect(input.nodes.find(n=>n.id==="remote")?.metadata?.groupId).toBeUndefined();
 });
});
