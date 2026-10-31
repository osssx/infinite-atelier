import {beforeAll,describe,expect,it,vi} from "vitest";
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
import {registerBuiltinNodes} from "@/components/canvas/nodes/builtin-nodes";
import {COMFY_WORKFLOW_MOCK_TYPE,MOCK_COMFY_PORTS} from "@/lib/canvas/canvas-ports";
import {CanvasNodeType} from "@/types/canvas";
import {applyNodeConfigPatch,createCanvasNode,titleAfterComfyWorkflowBind} from "./canvas-node-factory";
beforeAll(()=>registerBuiltinNodes());
const patch={comfyPorts:MOCK_COMFY_PORTS,comfyWorkflow:{
    templateId:"h3",templateRevision:"a".repeat(64),
    bindingState:"needs-instance-binding" as const,inputOverrides:{}
}};
describe("Comfy workflow auto title on bind",()=>{
 it("renames only the default-title node during a valid template binding",()=>{
  const node=createCanvasNode(COMFY_WORKFLOW_MOCK_TYPE,{x:200,y:200});
  expect(node.title).toBe("工作流");
  const bound=applyNodeConfigPatch(node,patch,"MiniMax H3 I2V Turbo · 图生视频");
  expect(bound.title).toBe("MiniMax H3 I2V Turbo · 图生视频");
  expect(bound.metadata?.comfyWorkflow?.templateId).toBe("h3");
  expect(bound.metadata?.comfyPorts).toEqual(MOCK_COMFY_PORTS);
 });
 it("keeps manually renamed nodes and does not rename on later rebinding",()=>{
  const node={...createCanvasNode(COMFY_WORKFLOW_MOCK_TYPE,{x:0,y:0}),title:"H3 I2V — 自定义节点"};
  expect(applyNodeConfigPatch(node,patch,"另一个工作流").title).toBe(node.title);
  const renamed=applyNodeConfigPatch(createCanvasNode(COMFY_WORKFLOW_MOCK_TYPE,{x:0,y:0}),patch,"原预设");
  expect(applyNodeConfigPatch(renamed,patch,"另一个预设").title).toBe("原预设");
 });
 it("does not rename for unrelated config, empty names, or other node types",()=>{
  const node=createCanvasNode(COMFY_WORKFLOW_MOCK_TYPE,{x:0,y:0});
  expect(applyNodeConfigPatch(node,{comfyPorts:MOCK_COMFY_PORTS},"Foo").title).toBe("工作流");
  expect(applyNodeConfigPatch(node,patch,"   ").title).toBe("工作流");
  expect(titleAfterComfyWorkflowBind({...node,title:"ComfyUI Workflow"},"旧版默认")).toBe("旧版默认");
  const image=createCanvasNode(CanvasNodeType.Image,{x:0,y:0});
  expect(titleAfterComfyWorkflowBind(image,"新工作流")).toBe(image.title);
 });
});
