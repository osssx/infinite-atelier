import {CanvasNodeType,type CanvasNodeData,type CanvasConnection} from "@/types/canvas";import type {AiConfig,ModelCapability} from "@/stores/use-config-store";
import {resolveComfyWorkflowSelection} from "@/features/comfy-workflow/comfy-workflow-selection";
import {getComfyInstanceScalarFields} from "@/features/comfy-workflow/instance-parameters";
import {createComfyMediaOverridePatch} from "@/features/comfy-workflow/comfy-media-overrides";
import {withComfyMediaAspect} from "@/features/comfy-workflow/comfy-media-aspect";
import type {ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";
import {applyNodeConfigPatch} from "@/lib/canvas/canvas-node-factory";
import {COMFY_WORKFLOW_MOCK_TYPE} from "@/lib/canvas/canvas-ports";
import {setComfyInstanceOverride} from "@/features/comfy-workflow/instance-parameters";

export type AssistantWorkflowScalar=string|number|boolean;
const portIdPattern=/^[a-zA-Z0-9_:\-.]{1,128}$/;
const sensitive=/(?:secret|token|password|api.?key|credential|authorization|密钥|密码|令牌)/i;
export const validAssistantWorkflowScalar=(portId:unknown,value:unknown):value is AssistantWorkflowScalar=>
 typeof portId==="string"&&portIdPattern.test(portId)&&
 (typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)&&Number.isSafeInteger(value)|| // INT or seed
  typeof value==="number"&&Number.isFinite(value)&&Math.abs(value)<=1e15||
  typeof value==="string"&&value.length<=2000);

/** The same effective preset selection used by the media node's real generation path. */
export function assistantWorkflowBinding(node:CanvasNodeData,config:AiConfig){
 const mode:ModelCapability=node.type===CanvasNodeType.Config?node.metadata?.generationMode??"image":
  node.type===CanvasNodeType.Image?"image":node.type===CanvasNodeType.Video?"video":
  node.type===CanvasNodeType.Audio?"audio":"text";
 if(mode==="text")return null;
 const binding=resolveComfyWorkflowSelection(config,node,mode);
 return binding?{mode,binding}:null;
}

function assertScalarValue(port:ComfyWorkflowTemplate["ports"][number],value:AssistantWorkflowScalar){
 const kind=port.valueKind;
 if(kind==="BOOLEAN"?typeof value!=="boolean":
  kind==="STRING"?typeof value!=="string":
  kind==="INT"?!Number.isSafeInteger(value):
  kind==="FLOAT"?(typeof value!=="number"||!Number.isFinite(value)):true)
  throw Error("工作流端口 "+port.id+" 的数值类型不匹配，未修改。");
 if(port.choices?.length&&!port.choices.some(choice=>Object.is(choice.value,value)))
  throw Error("工作流端口 "+port.id+" 的值不在预设候选项中。");
}
export function setAssistantWorkflowParameter(node:CanvasNodeData,portId:string,value:AssistantWorkflowScalar,
 config:AiConfig,template:ComfyWorkflowTemplate,connections:readonly CanvasConnection[]=[]):CanvasNodeData{
 if(!validAssistantWorkflowScalar(portId,value))throw Error("工作流参数类型或长度不合法。");
 if(node.type===COMFY_WORKFLOW_MOCK_TYPE){
  const binding=node.metadata?.comfyWorkflow;
  if(!binding?.templateId||!binding.templateRevision||
   binding.templateId!==template.id||binding.templateRevision!==template.revision)
   throw Error("工作流模板未绑定或版本已变化，未修改参数。");
  const field=getComfyInstanceScalarFields(template,node,connections).find(f=>f.port.id===portId);
  if(!field)throw Error("工作流预设不存在该可编辑的标量输入端口："+portId);
  if(field.connectedFrom||field.connectionCount)
   throw Error("该工作流输入已由上游节点连线控制，需先解除端口连接才能修改本地参数。");
  assertScalarValue(field.port,value);
  return {...node,metadata:{...node.metadata,comfyWorkflow:{
   ...binding,inputOverrides:setComfyInstanceOverride(binding.inputOverrides??{},portId,value)
  }}};
 }
 const active=assistantWorkflowBinding(node,config);
 if(!active)throw Error("目标节点没有绑定工作流预设，无法修改工作流参数。"); if(template.id!==active.binding.templateId||template.revision!==active.binding.templateRevision||
  !template.mediaUseCase||template.mediaUseCase.channel!==active.mode)
  throw Error("工作流预设版本或媒体类型已改变，未修改参数。");
 const excluded=new Set([template.mediaUseCase.promptPortId,...template.mediaUseCase.slots.map(slot=>slot.id)]);
 if(excluded.has(portId))throw Error("提示词或媒体输入端口须使用专门操作，不支持直接修改覆盖值。");
 const fields=getComfyInstanceScalarFields(template,node,[],active.binding.overrides); const field=fields.find(item=>item.port.id===portId);
 if(!field)throw Error("工作流预设不存在该可编辑的标量输入端口："+portId);
 assertScalarValue(field.port,value); const patch=createComfyMediaOverridePatch(active.binding,portId,value);
 if(node.type===CanvasNodeType.Config)
  return {...node,metadata:{...node.metadata,
   comfyWorkflowSelections:{...node.metadata?.comfyWorkflowSelections,[active.mode]:patch.comfyMediaPreset!}}};
 const visualPatch=withComfyMediaAspect(template,patch);
 return applyNodeConfigPatch(node,visualPatch);
}
function safeCurrent(value:unknown,label:string){
 if(sensitive.test(label))return "[已隐藏]";
 if(typeof value==="number"||typeof value==="boolean")return String(value);
 if(typeof value==="string"&&value.length<=60)return JSON.stringify(value);
 return value===undefined?"模板默认":"[文本省略]";
}
/** P2.6 independent workflow node: actual node-local scalar overrides and connected precedence. */
export function assistantComfyWorkflowScalarContext(
 node:CanvasNodeData,template:ComfyWorkflowTemplate,connections:readonly CanvasConnection[]
):string{
 const binding=node.metadata?.comfyWorkflow;
 if(node.type!==COMFY_WORKFLOW_MOCK_TYPE||!binding||
  binding.templateId!==template.id||binding.templateRevision!==template.revision)return "";
 const fields=getComfyInstanceScalarFields(template,node,connections)
  .filter(field=>!sensitive.test(field.port.id+" "+field.port.label));
 const lines=["独立 ComfyUI 工作流可编辑标量参数 id="+node.id+
  "，使用 set_workflow_param 修改未连接的端口；参数覆盖写入 comfyWorkflow.inputOverrides。"];
 for(const field of fields.slice(0,30)){
  const current=field.localValue.source==="disconnect"?undefined:field.localValue.value;
  const choices=field.port.choices?.slice(0,10).map(c=>JSON.stringify(c.value)).join(", ");
  lines.push("portId="+field.port.id+"，名称="+field.port.label.slice(0,56)+
   "，类型="+field.port.valueKind+
   "，当前值="+safeCurrent(current,field.port.label)+
   (field.connectedFrom?"，由上游 "+field.connectedFrom.nodeId+" 连线控制（先断开才能改本地值）":"，可修改")+
   (choices?"，候选值=["+choices.slice(0,220)+"]":""));
 }
 return lines.join("\n").slice(0,3600);
}

/** Only expose literal editable port names, types and safe scalar values; never expose API graph or assets. */
export function assistantWorkflowTemplateContext(node:CanvasNodeData,config:AiConfig,template:ComfyWorkflowTemplate):string{
 const active=assistantWorkflowBinding(node,config);
 if(!active||!template.mediaUseCase||template.id!==active.binding.templateId||
  template.revision!==active.binding.templateRevision)return "";
 const excluded=new Set([template.mediaUseCase.promptPortId,...template.mediaUseCase.slots.map(slot=>slot.id)]);
 const fields=getComfyInstanceScalarFields(template,node,[],active.binding.overrides)  .filter(field=>!excluded.has(field.port.id)&&!sensitive.test(field.port.id+" "+field.port.label));
 const lines=["工作流预设节点 id="+node.id+"；预设="+template.name+"；version="+template.revision,
  "当前渠道使用 ComfyUI 工作流预设；普通 set_node_param 参数不会作用于该预设。请用 set_workflow_param 指定准确端口 ID。"];
 for(const field of fields.slice(0,30)){
  const choices=field.port.choices?.slice(0,12).map(c=>JSON.stringify(c.value)).join(", ");
  const decision=field.localValue;
  const current=decision.source==="disconnect"?undefined:decision.value;
  lines.push("端口 id="+field.port.id+"，名称="+field.port.label.slice(0,56)+
   "，类型="+field.port.valueKind+"，当前值="+safeCurrent(current,field.port.label)+
   (choices?"，候选值=["+choices.slice(0,250)+"]":""));
 }
 if(fields.length>30)lines.push("其余 "+(fields.length-30)+" 个端口未列出");
 return lines.join("\n").slice(0,3500);
}
