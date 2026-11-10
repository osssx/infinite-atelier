// @vitest-environment happy-dom
import {describe,it,expect} from "vitest";
import {CanvasNodeType,type CanvasConnection,type CanvasNodeData} from "@/types/canvas";
import {layoutCanvasDependencyGraph} from "./canvas-assistant-graph-layout";
import {applyAssistantCanvasActions,parseAssistantCanvasActions} from "./canvas-assistant-actions";

const N=(id:string,x=0,y=0,w=250,h=140):CanvasNodeData=>({
 id,type:CanvasNodeType.Text,title:id,position:{x,y},width:w,height:h,
 metadata:{content:"preserve "+id,status:"success"}
});
const E=(a:string,b:string):CanvasConnection=>({id:"edge-"+a+"-"+b,fromNodeId:a,toNodeId:b});
const options=(nodeIds:string[]=[],direction:"horizontal"|"vertical"="horizontal")=>({
 nodeIds,direction,gap:48,layerGap:140,center:{x:600,y:450}
});
function overlaps(a:CanvasNodeData,b:CanvasNodeData){
 return a.position.x<b.position.x+b.width&&a.position.x+a.width>b.position.x&&
  a.position.y<b.position.y+b.height&&a.position.y+a.height>b.position.y;
}
function pos(nodes:readonly CanvasNodeData[],id:string){
 const p=nodes.find(n=>n.id===id);
 if(!p)throw Error("missing "+id);
 return p;
}
describe("P2.4 dependency-aware layout",()=>{
 it("places a diamond DAG in distinct dependency layers without overlaps or changing the graph",()=>{
  const nodes=[N("a",30,25),N("b",70,30),N("c",0,0),N("d",20,0)];
  const edges=[E("a","b"),E("a","c"),E("b","d"),E("c","d")];
  const next=layoutCanvasDependencyGraph(nodes,edges,options());
  expect(pos(next,"a").position.x+250+140).toBeLessThanOrEqual(pos(next,"b").position.x);
  expect(pos(next,"a").position.x+250+140).toBeLessThanOrEqual(pos(next,"c").position.x);
  expect(pos(next,"b").position.x+250+140).toBeLessThanOrEqual(pos(next,"d").position.x);
  expect(pos(next,"c").position.x+250+140).toBeLessThanOrEqual(pos(next,"d").position.x);
  for(let i=0;i<next.length;i++)for(let j=i+1;j<next.length;j++)
   expect(overlaps(next[i],next[j])).toBe(false);
  expect(next.map(n=>n.metadata)).toEqual(nodes.map(n=>n.metadata));
  expect(nodes[0].position).toEqual({x:30,y:25});
  const again=layoutCanvasDependencyGraph(nodes,edges,options());
  expect(next.map(n=>n.position)).toEqual(again.map(n=>n.position));
 });
 it("reorders crossing branches by predecessors rather than preserving a crossed second layer",()=>{
  const nodes=[N("top",0,0),N("bottom",0,500),N("wrong-bottom",500,900),N("wrong-top",500,-500)];
  const edges=[E("top","wrong-bottom"),E("bottom","wrong-top")];
  const next=layoutCanvasDependencyGraph(nodes,edges,options());
  expect(pos(next,"top").position.y).toBeLessThan(pos(next,"bottom").position.y);
  expect(pos(next,"wrong-bottom").position.y).toBeLessThan(pos(next,"wrong-top").position.y);
  expect(pos(next,"wrong-bottom").position.x).toBeGreaterThan(pos(next,"top").position.x);
  expect(edges).toEqual([E("top","wrong-bottom"),E("bottom","wrong-top")]);
 });
 it("supports top-to-bottom direction, isolating parallel nodes and keeping links unchanged",()=>{
  const nodes=[N("start",10,30),N("left",500,20),N("right",-200,0),N("end",20,20)];
  const edges=[E("start","left"),E("start","right"),E("left","end"),E("right","end")];
  const next=layoutCanvasDependencyGraph(nodes,edges,options([],"vertical"));
  expect(pos(next,"start").position.y+140+140).toBeLessThanOrEqual(pos(next,"left").position.y);
  expect(pos(next,"start").position.y+140+140).toBeLessThanOrEqual(pos(next,"right").position.y);
  expect(pos(next,"left").position.y+140+140).toBeLessThanOrEqual(pos(next,"end").position.y);
  expect(pos(next,"right").position.y+140+140).toBeLessThanOrEqual(pos(next,"end").position.y);
  expect(overlaps(pos(next,"left"),pos(next,"right"))).toBe(false);
 });
 it("uses a compact non-overlapping grid for a graph without edges",()=>{
  const nodes=[N("1"),N("2"),N("3"),N("4"),N("5")];
  const next=layoutCanvasDependencyGraph(nodes,[],options());
  for(let i=0;i<next.length;i++)for(let j=i+1;j<next.length;j++)
   expect(overlaps(next[i],next[j])).toBe(false);
  expect(new Set(next.map(n=>n.position.x)).size).toBeGreaterThan(1);
  expect(new Set(next.map(n=>n.position.y)).size).toBeGreaterThan(1);
 });
 it("contracts groups into atomic graph nodes and moves members by the exact group displacement",()=>{
  const base=applyAssistantCanvasActions({
   nodes:[N("innerA",0,0),N("innerB",400,0),N("external",1000,200)],
   connections:[E("innerA","innerB"),E("innerB","external")]
  },[{type:"create_group",ref:"grp",title:"第一幕",members:["innerA","innerB"]}],
  "safe",{x:200,y:200});
  const groupId=base.refs.get("grp")!;
  const grouped=pos(base.nodes,groupId);
  const next=layoutCanvasDependencyGraph(base.nodes,base.connections,options());
  const delta={
   x:pos(next,groupId).position.x-grouped.position.x,
   y:pos(next,groupId).position.y-grouped.position.y
  };
  for(const id of ["innerA","innerB"]){
   expect(pos(next,id).position.x-pos(base.nodes,id).position.x).toBeCloseTo(delta.x);
   expect(pos(next,id).position.y-pos(base.nodes,id).position.y).toBeCloseTo(delta.y);
   expect(pos(next,id).metadata?.groupId).toBe(groupId);
   expect(pos(next,id).metadata?.content).toBe("preserve "+id);
  }
  expect(pos(next,groupId).position.x+grouped.width+140)
   .toBeLessThanOrEqual(pos(next,"external").position.x);
  expect(base.connections).toEqual([E("innerA","innerB"),E("innerB","external")]);
  expect(base.nodes.find(n=>n.id==="external")?.position).toEqual({x:1000,y:200});
 });
 it("operates on a subset and leaves untouched nodes unmodified",()=>{
  const nodes=[N("a",0,0),N("b",500,20),N("untouched",8000,7000)];
  const result=layoutCanvasDependencyGraph(nodes,[E("a","b"),E("b","untouched")],
   options(["a","b"]));
  expect(pos(result,"untouched")).toBe(pos(nodes,"untouched"));
  expect(pos(result,"a").position.x).toBeLessThan(pos(result,"b").position.x);
  expect(result.length).toBe(nodes.length);
 });
 it("rejects direct selection of grouped child, corrupt group links and cycles before mutation",()=>{
  const base=applyAssistantCanvasActions({nodes:[N("a"),N("b",400,0),N("c",800,0)],
   connections:[E("a","b"),E("b","c")]},[
   {type:"create_group",ref:"group",title:"一幕",members:["a","b"]}
  ],"safe",{x:0,y:0});
  expect(()=>layoutCanvasDependencyGraph(base.nodes,base.connections,options(["a"])))
   .toThrow(/整个分组/);
  const corrupt=base.nodes.map(n=>n.id==="c"?{...n,metadata:{...n.metadata,groupId:"nonexistent"}}:n);
  expect(()=>layoutCanvasDependencyGraph(corrupt,base.connections,options()))
   .toThrow(/分组关系无效/);
  const graph={nodes:[N("a"),N("b"),N("c")],
   connections:[E("a","b"),E("b","c"),E("c","a")]};
  expect(()=>applyAssistantCanvasActions(graph,[
   {type:"create_node",ref:"new",nodeType:"text",title:"New"},
   {type:"layout_graph",nodeIds:[]}
  ],"safe",{x:0,y:0})).toThrow(/循环依赖/);
  expect(graph.nodes).toHaveLength(3);
  expect(graph.nodes.find(n=>n.title==="New")).toBeUndefined();
  expect(graph.connections).toHaveLength(3);
 });
 it("rejects out-of-range coordinates, inconsistent inputs and malformed model action schema",()=>{
  expect(()=>layoutCanvasDependencyGraph([N("x")],[],{
   ...options(),center:{x:999990,y:999990}
  })).toThrow(/坐标范围/);
  expect(()=>layoutCanvasDependencyGraph([N("x")],[],options(["missing"])))
   .toThrow(/不存在/);
  expect(()=>layoutCanvasDependencyGraph([N("x")],[],options(["x","x"])))
   .toThrow(/重复/);
  expect(()=>layoutCanvasDependencyGraph([],[],options())).toThrow(/请选择/);
  for(const action of [
   {type:"layout_graph",nodeIds:[],direction:"grid"},
   {type:"layout_graph",nodeIds:[],gap:5},
   {type:"layout_graph",nodeIds:[],layerGap:10},
   {type:"layout_graph",nodeIds:[],layerGap:361},
   {type:"layout_graph",nodeIds:["x","x"]},
   {type:"layout_graph",nodeIds:[],rewriteEdges:true},
   {type:"layout_graph",nodeIds:Array.from({length:201},(_,i)=>"id"+i)},
  ])expect(()=>parseAssistantCanvasActions([action])).toThrow();
 });
 it("supports 200-node chains with bounded runtime and consistent layer positions",()=>{
  const nodes=Array.from({length:200},(_,i)=>N("n"+i));
  const connections=nodes.slice(1).map((node,i)=>E(nodes[i].id,node.id));
  const next=layoutCanvasDependencyGraph(nodes,connections,options());
  expect(next).toHaveLength(200);
  expect(pos(next,"n0").position.x).toBeLessThan(pos(next,"n199").position.x);
  expect(nodes[0].position).toEqual({x:0,y:0});
 });
});
