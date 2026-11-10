// @vitest-environment happy-dom
import {describe,expect,it} from "vitest";
import {CanvasNodeType,type CanvasConnection,type CanvasNodeData} from "@/types/canvas";
import {applyAssistantCanvasActions,dangerousAssistantActionSummary,parseAssistantCanvasActions} from "./canvas-assistant-actions";

const node=(id:string,content="old"):CanvasNodeData=>({
 id,type:CanvasNodeType.Text,title:"Existing",position:{x:0,y:0},width:320,height:220,metadata:{content}
});
const connection=(from:string,to:string,id="edge-1"):CanvasConnection=>
 ({id,fromNodeId:from,toNodeId:to});
const center={x:320,y:220};

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
