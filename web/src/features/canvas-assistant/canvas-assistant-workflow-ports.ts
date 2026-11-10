import {nanoid} from "nanoid";
import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import {COMFY_WORKFLOW_MOCK_TYPE,getCanvasResourceOutputPorts} from "@/lib/canvas/canvas-ports";
import {prepareCanvasPortConnection} from "@/lib/canvas/canvas-port-connections";
import type {ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";

export type AssistantWorkflowPortAction=
 |{type:"connect_workflow_port";fromNodeId:string;fromPortId:string;toNodeId:string;toPortId:string}
 |{type:"replace_workflow_port";fromNodeId:string;fromPortId:string;toNodeId:string;toPortId:string}
 |{type:"disconnect_workflow_port";nodeId:string;portId:string};

const secretLike=/(?:password|api.?key|secret|token|credential|authorization|密钥|密码|令牌)/i;
const short=(value:string,max=96)=>value.replace(/[\n\r]/g," ").slice(0,max);

/** Pin real template version + input mapping before modifying workflow canvas edges. */
export function assertAssistantWorkflowInput(
 nodes:readonly CanvasNodeData[],id:string,portId:string,
 templates?:ReadonlyMap<string,ComfyWorkflowTemplate>,
){
 const node=nodes.find(n=>n.id===id);
 if(!node||node.type!==COMFY_WORKFLOW_MOCK_TYPE)throw Error("目标不是独立的 ComfyUI 工作流节点。");
 const binding=node.metadata?.comfyWorkflow;
 const template=templates?.get(id);
 if(!binding?.templateId||!binding.templateRevision||!template||
  binding.templateId!==template.id||binding.templateRevision!==template.revision)
  throw Error("工作流预设尚未加载或版本已变化，不能修改端口绑定。");
 const port=template.ports.find(p=>p.id===portId&&p.direction==="target");
 const descriptor=node.metadata?.comfyPorts?.find(p=>p.id===portId&&p.direction==="target");
 if(!port||!descriptor||port.valueKind!==descriptor.valueKind||
   !port.inputBinding?.targets?.length)
  throw Error("目标端口未在当前工作流预设中暴露或绑定无效："+portId);
 return {node,template,port};
}

export function applyAssistantWorkflowPortAction(
 nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[],
 action:AssistantWorkflowPortAction,templates?:ReadonlyMap<string,ComfyWorkflowTemplate>,
):CanvasConnection[]{
 if(action.type==="disconnect_workflow_port"){
  assertAssistantWorkflowInput(nodes,action.nodeId,action.portId,templates);
  const occupied=connections.filter(c=>c.toNodeId===action.nodeId&&c.toPortId===action.portId);
  if(occupied.length!==1)throw Error("目标工作流端口没有唯一的已有连线，未解除绑定。");
  return connections.filter(c=>c.id!==occupied[0].id);
 }
 assertAssistantWorkflowInput(nodes,action.toNodeId,action.toPortId,templates);
 if(action.fromNodeId===action.toNodeId)throw Error("不能将节点连接至自身。");
 const source=nodes.find(n=>n.id===action.fromNodeId);
 if(!source||!["text","image","video","audio"].includes(source.type))
  throw Error("当前 ComfyUI 后端仅支持文本、图像、视频或音频节点作为外部输入来源。"); const occupied=connections.filter(c=>c.toNodeId===action.toNodeId&&c.toPortId===action.toPortId);
 if(action.type==="connect_workflow_port"&&occupied.length)
  throw Error("工作流输入端口已有连线，需要使用 replace_workflow_port 并确认后才能替换。");
 if(action.type==="replace_workflow_port"&&occupied.length!==1)
  throw Error("替换要求目标端口已有一条连线；新增连接应使用 connect_workflow_port。");
 const result=prepareCanvasPortConnection(
  {nodeId:action.fromNodeId,handleType:"source",portId:action.fromPortId},
  {nodeId:action.toNodeId,handleType:"target",portId:action.toPortId},
  nodes,connections,{replaceOccupiedWorkflowInput:action.type==="replace_workflow_port"});
 if(!result.connection)throw Error("工作流端口无法连接："+(result.error??"unknown"));
 if(action.type==="connect_workflow_port"&&result.replacedConnectionIds?.length)
  throw Error("新增连线不能替换已有连线。");
 if(action.type==="replace_workflow_port"&&(result.replacedConnectionIds?.length??0)!==1)
  throw Error("工作流端口替换结果无效，未修改连线。");
 const replaced=new Set(result.replacedConnectionIds??[]);
 return [...connections.filter(c=>!replaced.has(c.id)),{...result.connection,id:nanoid()}];
}

/** Minimal source metadata + exact pinned input port IDs, no media bytes or secret values. */
export function assistantWorkflowPortContext(
 node:CanvasNodeData,template:ComfyWorkflowTemplate,
 nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[],
):string{
 if(node.type!==COMFY_WORKFLOW_MOCK_TYPE||
   node.metadata?.comfyWorkflow?.templateId!==template.id||
   node.metadata?.comfyWorkflow?.templateRevision!==template.revision)return "";
 const incoming=connections.filter(c=>c.toNodeId===node.id);
 const lines=["独立 ComfyUI 工作流节点 id="+node.id+"；预设="+short(template.name,72)+"；版本="+short(template.revision,80),
 "工作流动态输入端口（portId 用于 connect_workflow_port / replace_workflow_port / disconnect_workflow_port）："];
 const ports=template.ports.filter(p=>p.direction==="target"&&
  node.metadata?.comfyPorts?.some(actual=>actual.id===p.id&&actual.direction==="target"&&actual.valueKind===p.valueKind)&&
  p.inputBinding?.targets?.length&&!secretLike.test(p.id+" "+p.label));
 for(const port of ports.slice(0,36)){
  const links=incoming.filter(c=>c.toPortId===port.id);
  lines.push("输入 portId="+port.id+"，名称="+short(port.label,64)+
   "，类型="+port.valueKind+"，已连接="+(links.length?links.map(c=>c.fromNodeId+"."+c.fromPortId).join("、"):"无")+
   "，必填="+Boolean(port.required));
 }
 const kinds=new Set(ports.map(p=>p.valueKind));
 const sources=nodes.filter(n=>n.id!==node.id&&["text","image","video","audio"].includes(n.type))
  .flatMap(n=>getCanvasResourceOutputPorts(n).filter(p=>kinds.has(p.valueKind))
   .map(port=>({node:n,port}))).slice(0,35); if(sources.length){
  lines.push("候选输出端口（按实际类型匹配后方可连接）：");
  for(const {node:source,port} of sources)lines.push(
   "sourceNodeId="+source.id+"，名称="+short(source.title,62)+
   "，sourcePortId="+port.id+"，类型="+port.valueKind);
 }
 lines.push("空端口用 connect_workflow_port 自动新增；已连接的端口用 replace_workflow_port 修改来源（需要确认）或 disconnect_workflow_port 断开（需要确认）。不要猜测端口 ID。");
 return lines.join("\n").slice(0,6100);
}
