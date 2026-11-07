import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {getComfyInstanceScalarFields} from "./instance-parameters";
import type {ComfyTemplatePort,ComfyWorkflowTemplate} from "./template-schema";

type Binding=NonNullable<CanvasNodeMetadata["comfyMediaPreset"]>;
export function parseComfyAspect(value:unknown):string|undefined{
 if(typeof value!=="string")return;
 const match=value.trim().match(/^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)(?:\s*\([^)]*\))?$/i);
 if(!match)return;
 return dimensionsAspect(Number(match[1]),Number(match[2]));
}
function dimensionsAspect(width:unknown,height:unknown):string|undefined{
 if(typeof width!=="number"||typeof height!=="number"||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return;
 const ratio=width/height;
 if(ratio<0.25||ratio>4)return;
 // Integer representation works with the existing channel size parser.
 return `${Math.round(ratio*1000000)}:1000000`;
}
const name=(value:string)=>value.toLowerCase().replace(/[\s_-]/g,"");
const named=(port:ComfyTemplatePort,names:string[])=>[port.id,port.label].some(value=>names.includes(name(value)));
export function resolveComfyMediaAspect(template:ComfyWorkflowTemplate,binding:Binding):{ratio?:string;warning?:string}{
 const sync=template.mediaUseCase?.aspectSync;
 if(!template.mediaUseCase||template.mediaUseCase.primaryOutputKind==="audio"||sync?.mode==="off")return {};
 const fields=getComfyInstanceScalarFields(template,{id:"aspect",metadata:{}} as CanvasNodeData,[],binding.overrides);
 const value=(id:string)=>{const local=fields.find(field=>field.port.id===id)?.localValue;return local&&"value" in local?local.value:undefined;};
 if(sync?.mode==="ratio")return {ratio:parseComfyAspect(value(sync.portId))};
 if(sync?.mode==="dimensions")return {ratio:dimensionsAspect(value(sync.widthPortId),value(sync.heightPortId))};
 const strings=fields.filter(field=>field.port.valueKind==="STRING");
 const mapped=strings.filter(field=>field.port.inputBinding?.targets.some(target=>name(target.inputName)==="aspectratio"));
 const ratios=mapped.length?mapped:strings.filter(field=>named(field.port,["aspectratio","ratio","aspect","画面比例","宽高比","比例"]));
 const ambiguous={warning:"无法唯一识别节点比例参数，请在预设的媒体用途配置中手动指定。"};
 if(ratios.length>1)return ambiguous;
 if(ratios.length===1)return {ratio:parseComfyAspect(value(ratios[0].port.id))};
 const numeric=fields.filter(field=>["INT","FLOAT"].includes(field.port.valueKind));
 const pairs=new Map<string,[string,string]>();
 for(const width of numeric)for(const height of numeric){
  if(width===height)continue;
  if(width.port.inputBinding?.targets.some(w=>name(w.inputName)==="width"&&height.port.inputBinding?.targets.some(h=>h.nodeId===w.nodeId&&name(h.inputName)==="height")))
   pairs.set(JSON.stringify([width.port.id,height.port.id]),[width.port.id,height.port.id]);
 }
 if(!pairs.size){
  const widths=numeric.filter(field=>named(field.port,["width","宽度","宽"]));
  const heights=numeric.filter(field=>named(field.port,["height","高度","高"]));
  if(widths.length&&heights.length){
   if(widths.length!==1||heights.length!==1)return ambiguous;
   if(widths[0]===heights[0])return ambiguous;
   if(!widths[0].port.inputBinding?.targets.some(w=>heights[0].port.inputBinding?.targets.some(h=>h.nodeId===w.nodeId)))return {};
   pairs.set("named",[widths[0].port.id,heights[0].port.id]);
  }
 }
 if(pairs.size>1)return ambiguous;
 const pair=[...pairs.values()][0];
 return pair?{ratio:dimensionsAspect(value(pair[0]),value(pair[1]))}:{};
}

export function withComfyMediaAspect(template:ComfyWorkflowTemplate,patch:Partial<CanvasNodeMetadata>):Partial<CanvasNodeMetadata>{
 const binding=patch.comfyMediaPreset;
 return binding?{...patch,comfyMediaPreviewRatio:resolveComfyMediaAspect(template,binding).ratio}:patch;
}
