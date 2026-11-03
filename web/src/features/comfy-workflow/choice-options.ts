import type {ComfyScalarChoice} from "./template-schema";
import {parseComfyScalarOverride, type ComfyScalarKind} from "./instance-parameters";
import {inspectComfyInputSpec,MAX_COMFY_CHOICES} from "./comfy-input-spec";
import type {ComfyApiGraph,ComfyObjectInfo,ComfyTemplatePort} from "./template-schema";

export type ComfyChoiceKind=Extract<ComfyScalarKind,"STRING"|"INT"|"FLOAT">;
export const formatComfyChoiceLines=(options:readonly ComfyScalarChoice[]) =>
    options.map(o=>o.label===String(o.value) ? o.label : o.label+" | "+String(o.value)).join("\n");

/** One line per option: either `value` or `display label | actual value`.
 * Without a separator the same text is used as its label and parsed value.
 * Numeric kinds are parsed once, not coerced at execution.
 */
export function parseComfyChoiceLines(kind:ComfyChoiceKind,text:string):
    {ok:true;choices:ComfyScalarChoice[]} | {ok:false;error:string} {
    const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    if(!lines.length||lines.length>MAX_COMFY_CHOICES)return {ok:false,error:`请设置 1–${MAX_COMFY_CHOICES} 个候选项`};
    const choices:ComfyScalarChoice[]=[];
    const seen=new Set<string>();
    for(const [i,line] of lines.entries()){
        const sep=line.indexOf("|");
        const label=sep<0?line:line.slice(0,sep).trim();
        const raw=sep<0?line:line.slice(sep+1).trim();
        if(!label||label.length>90||label.includes("|"))return {ok:false,error:"第 "+(i+1)+" 行的显示名称必须为 1–90 字符，不能包含 |"};
        const parsed=parseComfyScalarOverride(kind,raw);
        if(!parsed.ok)return {ok:false,error:"第 "+(i+1)+" 行："+parsed.error};
        const value=parsed.value as string|number;
        const key=typeof value+":"+String(value);
        if(seen.has(key))return {ok:false,error:"候选项的实际值不能重复："+String(value)};
        seen.add(key);
        choices.push({label,value});
    }
    return {ok:true,choices};
}

export type InferredComfyChoices=
 | {kind:"choices";choices:ComfyScalarChoice[]}
 | {kind:"default-outside";choices:ComfyScalarChoice[]}
 | {kind:"none"|"too-many"|"incompatible"|"empty-intersection";count?:number};

/** Intersect declared enum targets by actual scalar value. Unconstrained scalar
 * targets do not restrict the enum; incompatible declarations prevent inference.
 */
export function inferComfyChoicesForPort(port:ComfyTemplatePort,graph:ComfyApiGraph,info?:ComfyObjectInfo):InferredComfyChoices{
 const binding=port.inputBinding;
 if(port.direction!=="target"||binding?.mode!=="literal"||!info||! ["STRING","INT","FLOAT"].includes(port.valueKind))return {kind:"none"};
 const enumTargets:Array<{choices:ComfyScalarChoice[];targetValue:unknown}>=[];
 const boundValues:unknown[]=[];
 for(const target of binding.targets){
  const node=graph[target.nodeId];if(!node)return {kind:"incompatible"};
  boundValues.push(node.inputs[target.inputName]);
  const schema=info[node.class_type]?.input;
  const spec=schema?.required?.[target.inputName]??schema?.optional?.[target.inputName];
  if(!spec)return {kind:"incompatible"};
  const descriptor=inspectComfyInputSpec(spec);
  if(descriptor.options){
   if(descriptor.valueKind!==port.valueKind)return {kind:"incompatible"};
   if(descriptor.options.length>MAX_COMFY_CHOICES)return {kind:"too-many",count:descriptor.options.length};
   if(!descriptor.choices)return {kind:"incompatible"};
   enumTargets.push({choices:[...descriptor.choices],targetValue:node.inputs[target.inputName]});
  }else if(descriptor.valueKind&&descriptor.valueKind!==port.valueKind){
   return {kind:"incompatible"};
  }
 }
 if(!enumTargets.length)return {kind:"none"};
 const first=enumTargets[0].choices;
 const common=first.filter(choice=>enumTargets.every(target=>target.choices.some(candidate=>
  typeof candidate.value===typeof choice.value&&Object.is(candidate.value,choice.value))));
 if(!common.length)return {kind:"empty-intersection"};
 // Keep declared enum selections and explicit defaults visible; never silently
 // change the user's saved value when a fresh /object_info list has drifted.
 if(boundValues.some(value=>!common.some(choice=>Object.is(choice.value,value)))||
   Object.prototype.hasOwnProperty.call(port,"defaultValue")&&!common.some(choice=>Object.is(choice.value,port.defaultValue)))
  return {kind:"default-outside",choices:common};
 return {kind:"choices",choices:common};
}

export function autoFillComfyPortChoices(ports:readonly ComfyTemplatePort[],graph:ComfyApiGraph,info:ComfyObjectInfo,
 suppressed:ReadonlySet<string>=new Set(),replaceable:ReadonlySet<string>=new Set()):{ports:readonly ComfyTemplatePort[];blocked:Map<string,InferredComfyChoices>}{
 let changed=false;const blocked=new Map<string,InferredComfyChoices>();
 const sameChoices=(left:readonly ComfyScalarChoice[]|undefined,right:readonly ComfyScalarChoice[])=>
  Boolean(left&&left.length===right.length&&left.every((choice,index)=>
   choice.label===right[index].label&&typeof choice.value===typeof right[index].value&&Object.is(choice.value,right[index].value)));
 const next=ports.map(port=>{
  if(port.direction!=="target"||(port.choices&&!replaceable.has(port.id))||suppressed.has(port.id))return port;
  const inferred=inferComfyChoicesForPort(port,graph,info);
  if(inferred.kind==="default-outside")blocked.set(port.id,inferred);
  if(inferred.kind==="choices"||inferred.kind==="default-outside"){
   if(sameChoices(port.choices,inferred.choices))return port;
   changed=true;return {...port,choices:inferred.choices}
  }
  if(inferred.kind!=="none")blocked.set(port.id,inferred);
  return port;
 });
 return {ports:changed?next:ports,blocked};
}
