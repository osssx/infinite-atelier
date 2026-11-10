// @vitest-environment happy-dom
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {CanvasNodeType,type CanvasNodeData,type CanvasConnection} from "@/types/canvas";
import {registerCanvasPortResolver,COMFY_WORKFLOW_MOCK_TYPE} from "@/lib/canvas/canvas-ports";
import {defaultConfig} from "@/stores/use-config-store";
import type {ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";
import {applyAssistantCanvasActions,isDangerousAssistantAction,parseAssistantCanvasActions} from "./canvas-assistant-actions";
import {applyAssistantWorkflowPortAction,assistantWorkflowPortContext} from "./canvas-assistant-workflow-ports";
import {assistantComfyWorkflowScalarContext} from "./canvas-assistant-workflow-params";

const template:ComfyWorkflowTemplate={
 id:"wf-preset",revision:"rev-1",name:"Comfy Image",
 apiGraph:{"1":{class_type:"SaveImage",inputs:{ref:null,prompt:"",steps:20}}},
 requirements:{classTypes:["SaveImage"]},
 ports:[
  {id:"ref",label:"参考图",direction:"target",valueKind:"IMAGE",required:true,
   inputBinding:{mode:"socket",replaceInternalLink:true,targets:[{nodeId:"1",inputName:"ref"}]}},
  {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",
   inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"prompt"}]}},
  {id:"steps",label:"Steps",direction:"target",valueKind:"INT",
   inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"steps"}]}},
  {id:"out",label:"Image",direction:"source",valueKind:"IMAGE",
   outputBinding:{nodeId:"1",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}
 ]
};
const workflow=(id="wf"):CanvasNodeData=>({
 id,type:COMFY_WORKFLOW_MOCK_TYPE,title:"Work",position:{x:450,y:0},width:400,height:320,
 metadata:{comfyWorkflow:{templateId:template.id,templateRevision:template.revision,
  bindingState:"needs-instance-binding",inputOverrides:{steps:20}},
  comfyPorts:template.ports.map(({id,label,direction,valueKind,required})=>({id,label,direction,valueKind,required}))}
});
const resource=(id:string,type:CanvasNodeType=CanvasNodeType.Image):CanvasNodeData=>({
 id,type,title:"Asset "+id,position:{x:0,y:0},width:320,height:220,
 metadata:{content:"/api/v1/blobs/already-created",storageKey:"cas:abc"}
});
const conn=(id:string,fromNodeId:string,toNodeId="wf",toPortId="ref"):CanvasConnection=>({
 id,fromNodeId,fromPortId:"image",toNodeId,toPortId
});
const templates=()=>new Map([["wf",template],["wf2",template]]);
const apply=(nodes:CanvasNodeData[],connections:CanvasConnection[],actions:unknown,stage:"safe"|"dangerous")=>
 applyAssistantCanvasActions({nodes,connections},actions,stage,{x:300,y:250},new Map(),defaultConfig,templates());
beforeAll(()=>registerCanvasPortResolver(COMFY_WORKFLOW_MOCK_TYPE,node=>node.metadata?.comfyPorts??[]));
afterAll(()=>registerCanvasPortResolver(COMFY_WORKFLOW_MOCK_TYPE));

describe("P2.6 AI Comfy workflow typed input binding",()=>{
 it("adds a new valid type-matched port connection without asking for confirmation",()=>{
  const actions=parseAssistantCanvasActions([{
   type:"connect_workflow_port",fromNodeId:"image-a",fromPortId:"image",toNodeId:"wf",toPortId:"ref"
  }]);
  expect(isDangerousAssistantAction(actions[0])).toBe(false);
  const original=[resource("image-a"),workflow()];
  const result=apply(original,[],actions,"safe");
  expect(result.applied).toBe(1);
  expect(result.connections).toMatchObject([{fromNodeId:"image-a",fromPortId:"image",toNodeId:"wf",toPortId:"ref"}]);
  expect(result.connections[0].id).toBeTruthy();
  expect(original[1].metadata?.comfyWorkflow?.inputOverrides).toEqual({steps:20});
  expect(apply(original,[],actions,"dangerous").applied).toBe(0);
 });
 it("replaces only occupied workflow port after confirmation; preserves original on cancel",()=>{
  const old=conn("old-edge","image-a");
  const nodes=[resource("image-a"),resource("image-b"),workflow()];
  const actions=parseAssistantCanvasActions([{
   type:"replace_workflow_port",fromNodeId:"image-b",fromPortId:"image",toNodeId:"wf",toPortId:"ref"
  }]);
  expect(isDangerousAssistantAction(actions[0])).toBe(true);
  expect(apply(nodes,[old],actions,"safe").connections).toEqual([old]);
  const result=apply(nodes,[old],actions,"dangerous");
  expect(result.applied).toBe(1);
  expect(result.connections).toHaveLength(1);
  expect(result.connections[0]).toMatchObject({fromNodeId:"image-b",toNodeId:"wf",toPortId:"ref"});
  expect(result.connections[0].id).not.toBe(old.id);
  expect(result.nodes[2].metadata).toEqual(nodes[2].metadata);
 });
 it("cannot smuggle a replacement through safe connect or replace an empty input",()=>{
  const nodes=[resource("image-a"),resource("image-b"),workflow()];
  const newAction={type:"connect_workflow_port",fromNodeId:"image-b",fromPortId:"image",toNodeId:"wf",toPortId:"ref"};
  expect(()=>apply(nodes,[conn("prior","image-a")],[newAction],"safe")).toThrow(/已有连线/);
  expect(()=>apply(nodes,[],[{...newAction,type:"replace_workflow_port"}],"dangerous")).toThrow(/已有一条连线/);
  expect(apply(nodes,[conn("prior","image-a")],[{...newAction,type:"replace_workflow_port"}],"safe").applied).toBe(0); });
 it("disconnects an occupied port after confirmation without touching other links",()=>{
  const nodes=[resource("image-a"),resource("text-a",CanvasNodeType.Text),workflow()];
  const links=[conn("img-edge","image-a"),{id:"txt-edge",fromNodeId:"text-a",fromPortId:"text",toNodeId:"wf",toPortId:"prompt"}];
  const action={type:"disconnect_workflow_port",nodeId:"wf",portId:"ref"};
  expect(isDangerousAssistantAction(parseAssistantCanvasActions([action])[0])).toBe(true);
  expect(apply(nodes,links,[action],"safe").connections).toEqual(links);
  expect(apply(nodes,links,[action],"dangerous").connections).toEqual([links[1]]);
  expect(()=>apply(nodes,[],[action],"dangerous")).toThrow(/没有唯一/);
 });
 it("checks exact template version, actual input mapping and source port type before mutating",()=>{
  const nodes=[resource("image-a"),resource("text-a",CanvasNodeType.Text),workflow()];
  const action={type:"connect_workflow_port",fromNodeId:"text-a",fromPortId:"text",toNodeId:"wf",toPortId:"ref"};
  expect(()=>apply(nodes,[],[action],"safe")).toThrow(/incompatible_port_type/);
  expect(()=>apply(nodes,[],[{...action,fromNodeId:"image-a",fromPortId:"not-image"}],"safe")).toThrow(/missing_port/);
  expect(()=>apply(nodes,[],[{...action,fromNodeId:"image-a",toPortId:"out"}],"safe")).toThrow(/目标端口/);
  const stale=workflow();stale.metadata!.comfyWorkflow!.templateRevision="r0";
  expect(()=>apply([nodes[0],stale],[],[{...action,fromNodeId:"image-a"}],"safe")).toThrow(/版本/);
  expect(()=>apply(nodes,[],[{...action,fromNodeId:"wf",toNodeId:"wf"}],"safe")).toThrow();
  expect(()=>parseAssistantCanvasActions([{...action,script:"console.log(1)"}])).toThrow();
 });
 it("rejects workflow-node upstream sources not supported by frozen Comfy submission",()=>{
  const a=workflow(),b=workflow("wf2");
  const action={type:"connect_workflow_port",fromNodeId:"wf2",fromPortId:"out",toNodeId:"wf",toPortId:"ref"};
  expect(()=>apply([a,b],[],[action],"safe")).toThrow(/仅支持文本、图像、视频或音频/);
 });
 it("rejects cycles when connecting an existing workflow output artifact back into its producer",()=>{
  const graph=[workflow(),resource("derived")];
  const prior=[{id:"artifact-link",fromNodeId:"wf",fromPortId:"out",toNodeId:"derived",toPortId:"comfy-artifact"}];
  const action={type:"connect_workflow_port",fromNodeId:"derived",fromPortId:"image",toNodeId:"wf",toPortId:"ref"};
  expect(()=>apply(graph,prior,[action],"safe")).toThrow(/cycle/);
 }); it("exposes exact input and candidate source port IDs and connected precedence, without media payloads",()=>{
  const nodes=[resource("image-a"),workflow()];
  const edges=[conn("connected","image-a")];
  const text=assistantWorkflowPortContext(nodes[1],template,nodes,edges);
  const scalars=assistantComfyWorkflowScalarContext(nodes[1],template,edges);
  expect(text).toContain("输入 portId=ref");
  expect(text).toContain("sourceNodeId=image-a");
  expect(text).toContain("sourcePortId=image");
  expect(text).toContain("已连接=image-a.image");
  expect(scalars).toContain("portId=steps");
  expect(scalars).toContain("20");
  expect(text).not.toContain("/api/v1/blobs/already-created");
 });
 it("allows disconnect then scalar override in one confirmed batch, rejecting override while connected",()=>{
  const nodes=[resource("text-a",CanvasNodeType.Text),workflow()];
  const original={id:"txt-edge",fromNodeId:"text-a",fromPortId:"text",toNodeId:"wf",toPortId:"prompt"};
  expect(()=>apply(nodes,[original],[{type:"set_workflow_param",nodeId:"wf",portId:"prompt",value:"new"}],"dangerous"))
   .toThrow(/上游节点连线/);
  const result=apply(nodes,[original],[
   {type:"disconnect_workflow_port",nodeId:"wf",portId:"prompt"},
   {type:"set_workflow_param",nodeId:"wf",portId:"prompt",value:"new"}
  ],"dangerous");
  expect(result.applied).toBe(2);
  expect(result.connections).toEqual([]);
  expect(result.nodes[1].metadata?.comfyWorkflow?.inputOverrides).toEqual({steps:20,prompt:"new"});
  expect(nodes[1].metadata?.comfyWorkflow?.inputOverrides).toEqual({steps:20});
 });
});
