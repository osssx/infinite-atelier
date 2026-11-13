// @vitest-environment happy-dom
import {describe,expect,it} from "vitest";
import {CanvasNodeType,type CanvasConnection,type CanvasNodeData} from "@/types/canvas";
import {applyAssistantCanvasActions,assistantCreatedSelection,dangerousAssistantActionSummary,parseAssistantCanvasActions} from "./canvas-assistant-actions";

const node=(id:string,content="old"):CanvasNodeData=>({
 id,type:CanvasNodeType.Text,title:"Existing",position:{x:0,y:0},width:320,height:220,metadata:{content}
});
const connection=(from:string,to:string,id="edge-1"):CanvasConnection=>
 ({id,fromNodeId:from,toNodeId:to});
const center={x:320,y:220};

describe("P3c2 prior generated asset action validation",()=>{
 it("requires a later action and forbids caller-supplied media identity",()=>{
  const valid=[{type:"run_node",nodeId:"source",mode:"image"},
   {type:"run_workflow",nodeId:"wf",inputFromPrevious:{sourceKind:"image",toPortId:"image_in"}}];
  expect(parseAssistantCanvasActions(valid)).toEqual(valid);
  expect(()=>parseAssistantCanvasActions([valid[1]])).toThrow(/第一项生成/);
  expect(()=>parseAssistantCanvasActions([valid[0],
   {type:"run_workflow",nodeId:"wf",inputFromPrevious:{sourceKind:"image",
    toPortId:"image_in",artifactId:"forged"}}])).toThrow();
 });
});
describe("P2 canvas action executor",()=>{
 it("creates nodes and connects new refs to existing nodes atomically",()=>{
  const original={nodes:[node("text-existing")],connections:[] as CanvasConnection[]};
  const actions=[
   {type:"connect",from:"draft-1",to:"draft-2"},
   {type:"create_text",ref:"draft-1",title:"新场景 A",content:"第一幕"},
   {type:"create_text",ref:"draft-2",title:"新场景 B",content:"第二幕"},
   {type:"connect",from:"text-existing",to:"draft-1"}
  ];
  const result=applyAssistantCanvasActions(original,actions,"safe",center);
  expect(result.applied).toBe(4);
  expect(result.nodes).toHaveLength(3);
  expect(result.connections).toHaveLength(2);
  expect(result.nodes[1].title).toBe("新场景 A");
  expect(result.nodes[1].metadata?.content).toBe("第一幕");
  expect(result.connections[0].fromNodeId).toBe(result.refs.get("draft-1"));
  expect(result.connections[0].toNodeId).toBe(result.refs.get("draft-2"));
  expect(original.nodes).toHaveLength(1);
  expect(original.connections).toHaveLength(0);
 });
 it("stages destructive changes separately and only applies them when asked",()=>{
  const original={nodes:[node("text-one"),node("text-two")],
   connections:[connection("text-one","text-two")]};
  const actions=[
   {type:"create_text",ref:"new",title:"Draft",content:"new"},
   {type:"set_text",nodeId:"text-one",content:"confirmed"},
   {type:"set_title",nodeId:"text-one",title:"New name"},
   {type:"delete_connection",connectionId:"edge-1"},
   {type:"delete_node",nodeId:"text-two"}
  ];
  const safe=applyAssistantCanvasActions(original,actions,"safe",center);
  expect(safe.applied).toBe(1);
  expect(safe.nodes[0].metadata?.content).toBe("old");
  expect(safe.connections).toHaveLength(1);
  const confirmed=applyAssistantCanvasActions(safe,actions,"dangerous",center,safe.refs);
  expect(confirmed.applied).toBe(4);
  expect(confirmed.nodes[0].metadata?.content).toBe("confirmed");
  expect(confirmed.nodes[0].title).toBe("New name");
  expect(confirmed.nodes.some(n=>n.id==="text-two")).toBe(false);
  expect(confirmed.connections).toHaveLength(0);
  expect(dangerousAssistantActionSummary(parseAssistantCanvasActions(actions))).toContain("删除 1 个节点");
 });
 it("fails closed on missing ids, invalid operations and conflicting ports",()=>{
  const original={nodes:[node("one"),node("two")],
   connections:[connection("one","two")]};
  expect(()=>applyAssistantCanvasActions(original,[{type:"connect",from:"one",to:"two"}],"safe",center)).toThrow(/连线无效/);
  expect(()=>applyAssistantCanvasActions(original,[{type:"connect",from:"two",to:"one"}],"safe",center)).toThrow(/循环/);
  expect(()=>applyAssistantCanvasActions(original,[{type:"connect",from:"one",to:"missing"}],"safe",center)).toThrow(/连线无效/);
  expect(()=>applyAssistantCanvasActions(original,[{type:"create_text",ref:"one",title:"x",content:"x"}],"safe",center)).toThrow(/冲突/);
  expect(()=>applyAssistantCanvasActions(original,[{type:"delete_node",nodeId:"missing"}],"dangerous",center)).toThrow();
  expect(original.nodes[0].metadata?.content).toBe("old");
  expect(original.connections).toHaveLength(1);
 });
 it("rejects destructive unsupported media deletion and malformed payloads",()=>{
  const media={...node("media"),type:CanvasNodeType.Image};
  expect(()=>applyAssistantCanvasActions({nodes:[media],connections:[]},
   [{type:"delete_node",nodeId:"media"}],"dangerous",center)).toThrow(/仅支持删除文本节点/);
  expect(()=>applyAssistantCanvasActions({nodes:[media],connections:[]},
   [{type:"set_text",nodeId:"media",content:"no"}],"dangerous",center)).toThrow(/文本节点/);
  expect(()=>parseAssistantCanvasActions([{type:"create_text",ref:"n",title:"x",content:"x",unsafe:true}])).toThrow();
  expect(()=>parseAssistantCanvasActions([{type:"delete_node",nodeId:"media",confirm:false}])).toThrow();
  expect(()=>parseAssistantCanvasActions([{type:"create_text",ref:"n",title:"x",content:"x"},{type:"create_text",ref:"n",title:"y",content:"y"}])).toThrow(/重复/);
 });
});

describe("P2.2 multi-type creation, layout and grouping",()=>{
 it("creates built-in media, config and director templates with safe metadata",()=>{
  const kinds=["text","image","video","audio","config","director"];
  const actions=kinds.map((nodeType,i)=>({
   type:"create_node",ref:"n"+i,nodeType,title:"类型"+i,
   ...(nodeType==="text"?{content:"原创脚本"}:{prompt:"画面构思 "+i})
  }));
  const result=applyAssistantCanvasActions({nodes:[],connections:[]},actions,"safe",center);
  expect(result.applied).toBe(6);
  expect(result.nodes.map(n=>n.type)).toEqual(kinds);
  expect(result.nodes[0].metadata?.content).toBe("原创脚本");
  for(const n of result.nodes.slice(1)){
   expect(n.metadata?.prompt).toContain("画面构思");
   expect(n.metadata?.content??"").toBe("");
   expect(n.metadata?.storageKey).toBeUndefined();
   expect(n.metadata?.status).toBe("idle");
  }
  expect(result.nodes.every(n=>Number.isFinite(n.position.x)&&Number.isFinite(n.position.y))).toBe(true);
 });
 it("lays out new and existing nodes then wraps them using the same canvas group geometry",()=>{
  const old=node("old");
  const actions=[
   {type:"create_node",ref:"image1",nodeType:"image",title:"角色图"},
   {type:"create_node",ref:"text1",nodeType:"text",title:"角色卡",content:"角色介绍"},
   {type:"layout_nodes",nodeIds:["old","image1","text1"],direction:"horizontal",gap:48},
   {type:"create_group",ref:"cast",title:"人物组",members:["old","image1","text1"]},
  ];
  const result=applyAssistantCanvasActions({nodes:[old],connections:[]},actions,"safe",center);
  expect(result.applied).toBe(4);
  expect(result.createdNodeIds).toHaveLength(3);
  expect(assistantCreatedSelection(result)).toEqual([result.refs.get("cast")]);
  const group=result.nodes.find(n=>n.id===result.refs.get("cast"))!;
  const members=result.nodes.filter(n=>n.metadata?.groupId===group.id);
  expect(group.type).toBe(CanvasNodeType.Group);
  expect(group.title).toBe("人物组");
  expect(members).toHaveLength(3);
  expect(members[0].position.x+members[0].width+48).toBeCloseTo(members[1].position.x,0);
  expect(group.position.x).toBeLessThan(members[0].position.x);
  expect(group.position.y).toBeLessThan(Math.min(...members.map(n=>n.position.y)));
  expect(old.position).toEqual({x:0,y:0});
  expect(old.metadata?.groupId).toBeUndefined();
 });
 it("moves a group together with its children and preserves connections and metadata",()=>{
  const base=applyAssistantCanvasActions({nodes:[node("old")],connections:[]},[
   {type:"create_node",ref:"image1",nodeType:"image",title:"场景图"},
   {type:"create_group",ref:"grp",title:"第一幕",members:["old","image1"]},
   {type:"connect",from:"old",to:"image1"}
  ],"safe",center);
  const group=base.nodes.find(n=>n.type===CanvasNodeType.Group)!;
  const before=new Map(base.nodes.map(n=>[n.id,n]));
  const moved=applyAssistantCanvasActions(base,[
   {type:"layout_nodes",nodeIds:["grp"],direction:"grid",gap:32}
  ],"safe",{x:2000,y:1800},base.refs);
  const delta={x:moved.nodes.find(n=>n.id===group.id)!.position.x-group.position.x,
   y:moved.nodes.find(n=>n.id===group.id)!.position.y-group.position.y};
  for(const current of moved.nodes){
   const previous=before.get(current.id)!;
   expect(current.position.x-previous.position.x).toBeCloseTo(delta.x);
   expect(current.position.y-previous.position.y).toBeCloseTo(delta.y);
  }
  expect(moved.connections).toEqual(base.connections);
  expect(moved.nodes.find(n=>n.id==="old")!.metadata?.content).toBe("old");
 });
 it("supports empty group and layout in grid/vertical, with gap bounds",()=>{
  const actions=[
   {type:"create_node",ref:"a",nodeType:"text",title:"A"},
   {type:"create_node",ref:"b",nodeType:"text",title:"B"},
   {type:"create_node",ref:"c",nodeType:"text",title:"C"},
   {type:"layout_nodes",nodeIds:["a","b","c"],direction:"grid",gap:24},
   {type:"create_group",ref:"blank",title:"空分组",members:[]},
   {type:"layout_nodes",nodeIds:["blank"],direction:"vertical"}
  ];
  const result=applyAssistantCanvasActions({nodes:[],connections:[]},actions,"safe",center);
  expect(result.applied).toBe(6);
  const grid=result.nodes.filter(n=>n.type===CanvasNodeType.Text);
  expect(grid[0].position.y).toBe(grid[1].position.y);
  expect(grid[2].position.y).toBeGreaterThan(grid[0].position.y);
  expect(result.nodes.find(n=>n.id===result.refs.get("blank"))?.title).toBe("空分组");
 });
 it("rejects implicit reparenting, nesting and malformed instructions atomically",()=>{
  const grouped=applyAssistantCanvasActions({nodes:[node("a"),node("b")],connections:[]},[
   {type:"create_group",ref:"existing",title:"现有组",members:["a","b"]}
  ],"safe",center);
  const groupId=grouped.refs.get("existing")!;
  expect(()=>applyAssistantCanvasActions(grouped,[
   {type:"create_node",ref:"new1",nodeType:"text",title:"New"},
   {type:"create_group",ref:"another",title:"错组",members:["a","new1"]}
  ],"safe",center,grouped.refs)).toThrow(/已属于其他分组/);
  expect(grouped.nodes.some(n=>n.title==="New")).toBe(false);
  expect(()=>applyAssistantCanvasActions(grouped,[
   {type:"layout_nodes",nodeIds:["a","b"],direction:"horizontal"}
  ],"safe",center)).toThrow(/整个分组布局/);
  expect(()=>applyAssistantCanvasActions(grouped,[
   {type:"create_group",ref:"nested",title:"嵌套",members:["existing","a"]}
  ],"safe",center,grouped.refs)).toThrow(/分组成员/);
  expect(grouped.nodes.find(n=>n.id==="a")?.metadata?.groupId).toBe(groupId);
  for(const invalid of [
   {type:"create_node",ref:"a1",nodeType:"plugin:unsafe",title:"Unsafe"},
   {type:"create_node",ref:"a1",nodeType:"image",content:"data:image/png;base64,xxx"},
   {type:"create_node",ref:"a1",nodeType:"text",prompt:"overwrite"},
   {type:"create_node",ref:"a1",nodeType:"image",storageKey:"file"},
   {type:"layout_nodes",nodeIds:["a","a"],direction:"grid"},
   {type:"layout_nodes",nodeIds:["a"],direction:"free"},
   {type:"layout_nodes",nodeIds:["a"],direction:"grid",gap:500},
   {type:"create_group",ref:"g1",title:"one",members:["a"]},
   {type:"create_group",ref:"g1",title:"nested",members:["a","a"]},
  ])expect(()=>parseAssistantCanvasActions([invalid])).toThrow();
  expect(()=>parseAssistantCanvasActions(Array.from({length:13},(_,i)=>({
   type:"create_node",ref:"n"+i,nodeType:"text",title:"T"
  })))).toThrow(/最多创建/);
 });
});
