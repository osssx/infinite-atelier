import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import type {ComfyTemplatePayload,ComfyWorkflowTemplate} from "./template-schema";
import {saveComfyTemplateVersion,removeComfyTemplateVersion} from "./template-registry";
import {saveComfyPreset,type ComfyPreset} from "./preset-registry";

const has=(value:object,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
const scalarKinds=new Set(["STRING","INT","FLOAT","BOOLEAN"]);

/** Snapshot the current node's editable literal overrides into an independent
 * template. Upstream canvas edges are not reproducible preset constants and
 * therefore keep their original template/default values.
 */
export function snapshotComfyInstanceAsPreset(
 template:ComfyWorkflowTemplate,node:CanvasNodeData,connections:readonly CanvasConnection[],name:string
):ComfyTemplatePayload {
 const trimmed=name.trim();
 if(!trimmed || trimmed.length>160)throw Error("预设名称长度必须为 1–160 个字符");
 const binding=node.metadata?.comfyWorkflow;
 if(!binding || binding.templateId!==template.id || binding.templateRevision!==template.revision)
  throw Error("请先加载有效的工作流模板");
 const payload:ComfyTemplatePayload=structuredClone({
  name:trimmed,apiGraph:template.apiGraph,ports:template.ports,requirements:template.requirements
 });
 const connected=new Set(connections.filter(edge=>edge.toNodeId===node.id).map(edge=>edge.toPortId));
 for(const port of payload.ports){
  if(port.direction!=="target"||port.inputBinding?.mode!=="literal"||
     !scalarKinds.has(port.valueKind)||connected.has(port.id)||
     !has(binding.inputOverrides,port.id))continue;
  const value=binding.inputOverrides[port.id];
  if(port.valueKind==="STRING"?typeof value!=="string":
     port.valueKind==="BOOLEAN"?typeof value!=="boolean":
     port.valueKind==="INT"?(typeof value!=="number"||!Number.isSafeInteger(value)):
     typeof value!=="number"||!Number.isFinite(value))
   throw Error("实例参数格式不正确："+port.label);
  port.defaultValue=value;
  for(const target of port.inputBinding.targets) {
   const targetNode=payload.apiGraph[target.nodeId];
   if(!targetNode||!has(targetNode.inputs,target.inputName))
    throw Error("模板参数绑定不存在："+port.label);
   targetNode.inputs[target.inputName]=value;
  }
 }
 return payload;
}

/** Always creates a fresh immutable template and alias; does not change
 * the selected canvas node, its connection graph or the source preset.
 */
export async function saveComfyInstanceAsNewPreset(
 template:ComfyWorkflowTemplate,node:CanvasNodeData,connections:readonly CanvasConnection[],name:string
):Promise<ComfyPreset> {
 const payload=snapshotComfyInstanceAsPreset(template,node,connections,name);
 const id="comfy-custom-"+crypto.randomUUID();
 const created=await saveComfyTemplateVersion(id,payload);
 const preset:ComfyPreset={id,name:payload.name,templateId:created.id,revision:created.revision};
 try{await saveComfyPreset(preset);}
 catch(error){
  try{await removeComfyTemplateVersion(created.id,created.revision);}
  catch{/* Keep the original save error; an unreferenced version may remain. */}
  throw error;
 }
 return preset;
}
