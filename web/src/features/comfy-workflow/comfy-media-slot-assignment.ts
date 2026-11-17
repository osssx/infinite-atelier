import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import {getGenerationResourceNodes} from "@/lib/canvas/canvas-resource-references";
import {resolveCanvasImage,resolveCanvasImageMask} from "@/lib/canvas/canvas-image-mask";
import type {MediaModeId} from "@/services/media-capabilities";
import type {ComfyWorkflowTemplate} from "./template-schema";

type Ref={nodeId:string;imageId?:string};
function mediaResources(template:ComfyWorkflowTemplate,nodeId:string,nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[]){
 const resources=getGenerationResourceNodes(nodeId,[...nodes],[...connections],true).filter(source=>source.id!==nodeId);
 const useCase=template.mediaUseCase;
 const textOnlyImage=useCase?.channel==="image"&&(useCase.mediaCapabilities
  ?useCase.mediaCapabilities.modes.some(mode=>mode.enabled&&mode.id==="text_to_image")&&!useCase.mediaCapabilities.modes.some(mode=>mode.enabled&&mode.inputs.some(input=>input.maxItems>0))
  :!useCase.slots.some(slot=>["IMAGE","MASK","VIDEO","AUDIO"].includes(slot.valueKind)));
 if(textOnlyImage)return resources.filter(source=>!["image","video","audio"].includes(source.type));
 // Editing a populated image node uses its frozen original when there are no
 // external media references, matching the image prompt panel reference bar.
 if(template.mediaUseCase?.channel==="image"&&template.mediaUseCase.slots.some(slot=>slot.valueKind==="IMAGE")&&!resources.some(source=>["image","video","audio"].includes(source.type))){
  const own=nodes.find(source=>source.id===nodeId&&source.type==="image");
  const image=own?resolveCanvasImage(own):undefined;
  if(own&&(image?.content||image?.storageKey))resources.push(own);
 }
 return resources;
}
/** Explicit workflow mode wins; otherwise choose a mode that accepts the live references. */
export function resolveComfyMediaMode(template:ComfyWorkflowTemplate,nodeId:string,nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[],explicit?:MediaModeId,fallback?:MediaModeId):MediaModeId|undefined{
 if(explicit)return explicit;
 const useCase=template.mediaUseCase,capabilities=useCase?.mediaCapabilities;
 if(!capabilities)return fallback;
 const resources=[...new Map(mediaResources(template,nodeId,nodes,connections).filter(n=>["image","video","audio"].includes(n.type)).map(n=>[n.id,n])).values()];
 const counts:Record<string,number>={image:0,video:0,audio:0,mask:0};
 for(const source of resources){counts[source.type]++;if(resolveCanvasImageMask(source))counts.mask++;}
 const compatible=capabilities.modes.filter(mode=>mode.enabled&&useCase?.modeBindings?.[mode.id]&&
  ["image","video","audio"].every(kind=>counts[kind]<=mode.inputs.filter(rule=>rule.kind===kind).reduce((sum,rule)=>sum+rule.maxItems,0))&&
  mode.inputs.every(rule=>counts[rule.kind]>=rule.minItems));
 return compatible.find(mode=>mode.id===capabilities.defaultMode)?.id??compatible[0]?.id??capabilities.defaultMode??fallback;
}
/** Resolve from the live reference graph, never from cached manual slot selections. */
export function assignComfyMediaSlots(template:ComfyWorkflowTemplate,nodeId:string,nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[],mode?:MediaModeId){
 const slots:Record<string,Ref>={},errors:string[]=[];
 const useCase=template.mediaUseCase;
 if(!useCase)return {slots,errors};
 const activeMode=mode??useCase.mediaCapabilities?.defaultMode;
 const contract=useCase.mediaCapabilities?.modes.find(item=>item.id===activeMode&&item.enabled);
 const mapping=activeMode?useCase.modeBindings?.[activeMode]:undefined;
 const activeIds=new Set(Object.values(mapping?.rolePorts??{}).flat());
 const activeSlots=useCase.slots.filter(slot=>!useCase.mediaCapabilities||activeIds.has(slot.id));
 const resources=mediaResources(template,nodeId,nodes,connections);
 const used=new Set<string>(),usedMasks=new Set<string>();
 const refFor=(source:CanvasNodeData):Ref=>{const image=resolveCanvasImage(source);return {nodeId:source.id,...(image?.id?{imageId:image.id}:{})}};
 const available=(source:CanvasNodeData,kind:string)=>{
  if(kind==="MASK")return !!resolveCanvasImageMask(source);
  if(source.type!==kind.toLowerCase())return false;
  const media=kind==="IMAGE"?resolveCanvasImage(source):source.metadata;
  return !!(media?.storageKey||('content' in (media??{})&&media?.content));
 };
 // Reserve explicit ports before consuming references for implicit slots.
 for(const edge of connections.filter(edge=>edge.toNodeId===nodeId&&useCase.slots.some(slot=>slot.id===edge.toPortId))){
  const slot=activeSlots.find(slot=>slot.id===edge.toPortId);
  if(!slot){errors.push("当前模式不接受已连接的媒体槽位："+edge.toPortId);continue;}
  const source=nodes.find(source=>source.id===edge.fromNodeId);
  const consumed=slot.valueKind==="MASK"?usedMasks:used;
  if(!source||source.id===nodeId||!available(source,slot.valueKind)){errors.push("媒体素材不可用："+slot.label);continue;}
  if(slots[slot.id]||consumed.has(source.id)){errors.push("媒体素材重复分配："+slot.label);continue;}
  slots[slot.id]=refFor(source);consumed.add(source.id);
 }
 for(const slot of activeSlots){
  if(slots[slot.id])continue;
  const consumed=slot.valueKind==="MASK"?usedMasks:used;
  const source=resources.find(source=>!consumed.has(source.id)&&available(source,slot.valueKind));
  if(source){slots[slot.id]=refFor(source);consumed.add(source.id);}
 }
 for(const source of new Map(resources.map(source=>[source.id,source])).values()){
  if(!["image","video","audio"].includes(source.type))continue;
  if(!available(source,source.type.toUpperCase())){errors.push("参考素材不可用或未选择单张图片："+source.title);continue;}
  if(!used.has(source.id)&&!usedMasks.has(source.id))errors.push("参考素材超过当前模式槽位容量："+source.title);
 }
 if(useCase.mediaCapabilities){
  if(!contract||!mapping)errors.push("当前工作流未启用或绑定该生成模式");
  for(const rule of contract?.inputs??[]){
   const ids=mapping?.rolePorts?.[rule.role]??[];
   const count=ids.filter(id=>slots[id]).length;
   if(count<rule.minItems)errors.push("缺少必填媒体素材："+rule.role+(rule.kind==="mask"?"（需要有效蒙版）":""));
   if(count>rule.maxItems)errors.push("媒体素材超过模式容量："+rule.role);
  }
 }else for(const slot of activeSlots)if(slot.required&&!slots[slot.id])errors.push("缺少必填媒体素材："+slot.label);
 return {slots,errors};
}
