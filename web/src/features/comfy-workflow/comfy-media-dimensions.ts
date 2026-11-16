import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {getComfyInstanceScalarFields} from "./instance-parameters";
import type {ComfyWorkflowTemplate} from "./template-schema";

export type ComfyMediaDimensions={width:number;height:number;megapixels?:number;multiple?:number;aspectRatio?:string};
type Binding=NonNullable<CanvasNodeMetadata["comfyMediaPreset"]>;
const valid=(width:unknown,height:unknown):ComfyMediaDimensions|undefined=>
 typeof width==="number"&&typeof height==="number"&&Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&
 width>0&&height>0&&width<=32768&&height<=32768?{width,height}:undefined;
// Python round uses ties to even; match ResolutionSelector rather than JS Math.round.
const roundEven=(value:number)=>value%1===0.5?2*Math.round(value/2):Math.round(value);
export function resolutionFromMegapixels(width:number,height:number,megapixels:number,multiple=16):ComfyMediaDimensions{
 const scale=Math.sqrt(megapixels*1024*1024/(width*height));
 return {width:Math.max(multiple,roundEven(width*scale/multiple)*multiple),height:Math.max(multiple,roundEven(height*scale/multiple)*multiple)};
}

/** Static evaluation only. Never execute arbitrary workflow nodes or infer from disconnected nodes. */
export function resolveComfyMediaDimensions(template:ComfyWorkflowTemplate,binding:Binding,includeSettings=false):ComfyMediaDimensions|undefined{
 const graph=template.apiGraph;
 let resolutionSettings:{megapixels:number;multiple:number;aspectRatio:string}|undefined;
 const fields=getComfyInstanceScalarFields(template,{id:"dimensions",metadata:{}} as CanvasNodeData,[],binding.overrides);
 const fieldValue=(id:string)=>{const local=fields.find(field=>field.port.id===id)?.localValue;return local&&"value" in local?local.value:undefined;};
 const sync=template.mediaUseCase?.aspectSync;
 if(sync?.mode==="dimensions")return valid(fieldValue(sync.widthPortId),fieldValue(sync.heightPortId));
 const input=(nodeId:string,key:string,seen=new Set<string>()):unknown=>{
  const identity=nodeId+"."+key;
  if(seen.has(identity))return undefined;
  seen=new Set(seen).add(identity);
  const owners=fields.filter(field=>field.port.inputBinding?.targets.some(target=>target.nodeId===nodeId&&target.inputName===key));
  if(owners.length>1)return undefined;
  const raw=owners.length?fieldValue(owners[0].port.id):graph[nodeId]?.inputs[key];
  if(!Array.isArray(raw))return raw;
  const [source,index]=raw;
  if(typeof source!=="string"||!Number.isInteger(index))return undefined;
  const upstream=graph[source];
  if(upstream?.class_type==="ResolutionSelector"&&(index===0||index===1)){
   const aspect=input(source,"aspect_ratio",seen),mp=input(source,"megapixels",seen),multiple=input(source,"multiple",seen);
   const match=typeof aspect==="string"?aspect.match(/^(\d+)\s*:\s*(\d+)(?:\s*\([^)]*\))?$/):null;
   if(!match||typeof mp!=="number"||!Number.isFinite(mp)||mp<=0||mp>16||typeof multiple!=="number"||!Number.isSafeInteger(multiple)||multiple<8||multiple>128)return undefined;
   const w=Number(match[1]),h=Number(match[2]);
   if(w<=0||h<=0)return undefined;
   // ComfyUI core nodes_resolution.py: MP is measured in 1024² pixels.
   resolutionSettings={megapixels:mp,multiple,aspectRatio:w+":"+h};
   const size=resolutionFromMegapixels(w,h,mp,multiple);
   return index===0?size.width:size.height;
  }
  if(index===0&&["PrimitiveInt","PrimitiveFloat"].includes(upstream?.class_type))return input(source,"value",seen);
  return undefined;
 };
 const output=template.ports.find(port=>port.id===template.mediaUseCase?.primaryOutputPortId)?.outputBinding?.nodeId;
 if(!output)return undefined;
 let level=[output];const visited=new Set<string>();
 while(level.length){
  const next:string[]=[];const candidates:ComfyMediaDimensions[]=[];
  for(const id of level){
   if(visited.has(id))continue;visited.add(id);
   const node=graph[id];if(!node)continue;
   if(Object.hasOwn(node.inputs,"width")&&Object.hasOwn(node.inputs,"height")){
    const size=valid(input(id,"width"),input(id,"height"));
    if(!size)return undefined;
    candidates.push(size);
   }else{
    // Unknown geometric transformations cannot be evaluated as a pass-through.
    if(/scale|resize|crop/i.test(node.class_type))return undefined;
    for(const value of Object.values(node.inputs))if(Array.isArray(value)&&typeof value[0]==="string"&&graph[value[0]])next.push(value[0]);
   }
  }
  if(candidates.length){
   const first=candidates[0];
   return candidates.every(size=>size.width===first.width&&size.height===first.height)?{...first,...(includeSettings?resolutionSettings:{})}:undefined;
  }
  level=next;
 }
 return undefined;
}
