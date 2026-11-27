const modeIds={image:["text_to_image","reference_edit","inpaint"],video:["text_to_video","first_frame","last_frame","first_last_frame","omni_reference"],audio:["text_to_speech","voice_clone","text_to_music","text_to_sound"]};
const roleKinds={reference_image:"image",source_image:"image",mask:"mask",first_frame:"image",last_frame:"image",reference_video:"video",reference_audio:"audio",voice_reference:"audio"};
const paramIds={image:new Set(["width","height","seed","count","negative_prompt","transparent_background","output_format"]),video:new Set(["duration_seconds","aspect_ratio","resolution","seed","generate_audio","return_last_frame","watermark"]),audio:new Set(["voice","speed","language","instructions","duration_seconds","sample_rate","channels","output_format"])};
const paramTypes={width:"number",height:"number",seed:"number",count:"number",negative_prompt:"string",transparent_background:"boolean",output_format:"enum",duration_seconds:"number",aspect_ratio:"enum",resolution:"enum",generate_audio:"boolean",return_last_frame:"boolean",watermark:"boolean",voice:"enum",speed:"number",language:"enum",instructions:"string",sample_rate:"enum",channels:"enum"};
const requiredRoles={reference_edit:["reference_image"],inpaint:["source_image","mask"],first_frame:["first_frame"],last_frame:["last_frame"],first_last_frame:["first_frame","last_frame"],voice_clone:["voice_reference"]};
const fields={root:["schemaVersion","kind","modes","defaultMode"],mode:["id","enabled","inputs","allowedReferenceCombinations","maxTotalReferences","parameters","layout"],input:["role","kind","minItems","maxItems","mimeTypes","maxBytes","maxDurationSeconds"],parameter:["id","mode","type","defaultValue","fixedValue","min","max","step","values"],layout:["format","delivery"]};
const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const keys=(x,allow)=>obj(x)&&Object.keys(x).every(k=>allow.includes(k));
const finite=n=>typeof n==="number"&&Number.isFinite(n);
function scalar(v){return typeof v==="string"&&v.length<=256||finite(v)||typeof v==="boolean";}
export function isMediaCapabilities(v){
 if(!keys(v,fields.root)||v.schemaVersion!==1||!Object.hasOwn(modeIds,v.kind)||!Array.isArray(v.modes)||v.modes.length>16)return false;
 const seen=new Set();
 for(const m of v.modes){
  if(!keys(m,fields.mode)||!modeIds[v.kind].includes(m.id)||seen.has(m.id)||typeof m.enabled!=="boolean"||!Array.isArray(m.inputs)||m.inputs.length>16||!Array.isArray(m.parameters)||m.parameters.length>32)return false;
  seen.add(m.id);
  if(m.maxTotalReferences!==undefined&&(!Number.isInteger(m.maxTotalReferences)||m.maxTotalReferences<0||m.maxTotalReferences>32))return false;
  for(const i of m.inputs){
   if(!keys(i,fields.input)||!Object.hasOwn(roleKinds,i.role)||i.kind!==roleKinds[i.role]||!Number.isInteger(i.minItems)||!Number.isInteger(i.maxItems)||i.minItems<0||i.minItems>i.maxItems||i.maxItems>32)return false;
   if(i.mimeTypes!==undefined&&(!Array.isArray(i.mimeTypes)||i.mimeTypes.length>32||i.mimeTypes.some(x=>typeof x!=="string"||x.length>100||!/^[\w.+-]+\/[\w.+*-]+$/.test(x))))return false;
   for(const k of ["maxBytes","maxDurationSeconds"])if(i[k]!==undefined&&(!finite(i[k])||i[k]<=0||i[k]>1e12))return false;
  }
  const roleCounts=new Map();for(const i of m.inputs){if(roleCounts.has(i.role))return false;roleCounts.set(i.role,i);}
  if(m.enabled)for(const role of requiredRoles[m.id]??[])if(!roleCounts.has(role)||roleCounts.get(role).minItems<1)return false;
  if(m.allowedReferenceCombinations!==undefined){if(!Array.isArray(m.allowedReferenceCombinations)||m.allowedReferenceCombinations.length>8)return false;const combos=new Set();for(const c of m.allowedReferenceCombinations){if(!Array.isArray(c)||c.length<1||c.length>3||c.some(x=>!["image","video","audio"].includes(x))||new Set(c).size!==c.length)return false;const id=[...c].sort().join("+");if(combos.has(id))return false;combos.add(id);}}
  const paramSeen=new Set();
  for(const p of m.parameters){
   if(!keys(p,fields.parameter)||typeof p.id!=="string"||!paramIds[v.kind].has(p.id)||paramSeen.has(p.id)||!["fixed","adjustable"].includes(p.mode)||!["number","string","boolean","enum"].includes(p.type)||paramTypes[p.id]!==p.type)return false;
   paramSeen.add(p.id);
   for(const k of ["defaultValue","fixedValue"])if(p[k]!==undefined&&!scalar(p[k]))return false;
   for(const k of ["min","max","step"])if(p[k]!==undefined&&!finite(p[k]))return false;
   if(p.min!==undefined&&p.max!==undefined&&p.min>p.max||p.step!==undefined&&p.step<=0)return false;
   if(p.values!==undefined&&(!Array.isArray(p.values)||p.values.length>128||p.values.some(x=>!scalar(x))))return false;
   if(p.type==="number"&&(p.defaultValue!==undefined&&!finite(p.defaultValue)||p.fixedValue!==undefined&&!finite(p.fixedValue))||p.type==="boolean"&&(p.defaultValue!==undefined&&typeof p.defaultValue!=="boolean"||p.fixedValue!==undefined&&typeof p.fixedValue!=="boolean")||p.type==="string"&&(p.defaultValue!==undefined&&typeof p.defaultValue!=="string"||p.fixedValue!==undefined&&typeof p.fixedValue!=="string"))return false;
   if(p.mode==="fixed"&&p.fixedValue===undefined||p.mode==="adjustable"&&p.fixedValue!==undefined)return false;
   const value=p.mode==="fixed"?p.fixedValue:p.defaultValue;
   if(p.type==="enum"&&(!p.values?.length||value!==undefined&&!p.values.includes(value)))return false;
   if(p.type!=="enum"&&p.values!==undefined)return false;
   if(p.type==="number"&&typeof value==="number"&&(p.min!==undefined&&value<p.min||p.max!==undefined&&value>p.max))return false;
  }
  if(m.layout!==undefined&&(!keys(m.layout,fields.layout)||m.layout.format!=="atelier_bbox_json_v1"||!["prompt_json","dedicated_input"].includes(m.layout.delivery)||v.kind!=="image"||!m.enabled||!["text_to_image","reference_edit"].includes(m.id)))return false;
 }
 return v.defaultMode===undefined||seen.has(v.defaultMode)&&v.modes.find(m=>m.id===v.defaultMode)?.enabled===true;
}
export function resolveMediaCapabilities(target,{kind,supportedModes,supportedParameters}={}){
 const declared=target?.mediaCapabilities;
 if(declared===undefined)return {kind,source:"legacy_compatibility",explicit:false,modes:[],unavailable:[]};
 if(!isMediaCapabilities(declared)||declared.kind!==kind)return {kind,source:"user",explicit:true,modes:[],unavailable:[{code:"media_capability_invalid"}]};
 const supported=supportedModes?new Set(supportedModes):null,params=supportedParameters?new Set(supportedParameters):null,unavailable=[];
 const modes=declared.modes.filter(mode=>mode.enabled).filter(mode=>{
  if(supported&&!supported.has(mode.id)){unavailable.push({code:"executor_mode_unsupported",mode:mode.id});return false;}
  const unsupported=mode.parameters.find(parameter=>params&&!params.has(parameter.id));
  if(unsupported){unavailable.push({code:"executor_parameter_unsupported",mode:mode.id,parameter:unsupported.id});return false;}return true;
 });
 return {kind,source:"user",explicit:true,modes,unavailable,defaultMode:declared.defaultMode};
}
export function validateMediaRequest(request,resolved,{phase="metadata"}={}){
 const errors=[];
 if(!resolved?.explicit)return errors;
 const mode=resolved.modes.find(item=>item.id===request.mode);
 if(!mode){errors.push({code:"media_mode_unavailable",mode:request.mode});return errors;}
 const refs=Array.isArray(request.references)?request.references:[];
 for(const rule of mode.inputs){const selected=refs.filter(ref=>ref.role===rule.role&&ref.kind===rule.kind),count=selected.length;if(count<rule.minItems||count>rule.maxItems)errors.push({code:"media_input_count",mode:mode.id,role:rule.role,actual:count,min:rule.minItems,max:rule.maxItems});
  if(phase!=="structure")for(const ref of selected){if(rule.mimeTypes?.length&&(!ref.mimeType||!rule.mimeTypes.includes(ref.mimeType)))errors.push({code:"media_input_format",mode:mode.id,role:rule.role});if(rule.maxBytes!==undefined&&(!Number.isFinite(ref.bytes)||ref.bytes>rule.maxBytes))errors.push({code:"media_input_size",mode:mode.id,role:rule.role,max:rule.maxBytes});if(rule.maxDurationSeconds!==undefined&&(!Number.isFinite(ref.durationMs)||ref.durationMs<=0||ref.durationMs>rule.maxDurationSeconds*1000))errors.push({code:"media_input_duration",mode:mode.id,role:rule.role,max:rule.maxDurationSeconds});}
 }
 if(mode.maxTotalReferences!==undefined&&refs.length>mode.maxTotalReferences)errors.push({code:"media_total_references",mode:mode.id,actual:refs.length,max:mode.maxTotalReferences});
 for(const ref of refs)if(!mode.inputs.some(rule=>rule.role===ref.role&&rule.kind===ref.kind))errors.push({code:"media_input_unexpected",mode:mode.id,role:ref.role});
 if(mode.allowedReferenceCombinations){const actual=[...new Set(refs.map(ref=>ref.kind))].sort().join("+");if(refs.length&&!mode.allowedReferenceCombinations.some(combo=>[...combo].sort().join("+")===actual))errors.push({code:"media_reference_combination",mode:mode.id,actual});}
 if(mode.id==="omni_reference"&&!refs.length)errors.push({code:"media_reference_required",mode:mode.id});
 for(const spec of mode.parameters){const value=request.parameters?.[spec.id]??spec.defaultValue??(spec.mode==="fixed"?spec.fixedValue:undefined);
  if(value===undefined){errors.push({code:"media_parameter_missing",mode:mode.id,parameter:spec.id});continue;}
  const typeValid=spec.type==="number"?finite(value):spec.type==="string"?typeof value==="string":spec.type==="boolean"?typeof value==="boolean":spec.type==="enum"&&scalar(value);
  const stepInvalid=spec.type==="number"&&spec.step!==undefined&&Math.abs((value-(spec.min??0))/spec.step-Math.round((value-(spec.min??0))/spec.step))>1e-8;
  if(!typeValid||spec.mode==="fixed"&&value!==spec.fixedValue||spec.type==="number"&&(spec.min!==undefined&&value<spec.min||spec.max!==undefined&&value>spec.max||stepInvalid)||spec.type==="enum"&&!spec.values?.includes(value))errors.push({code:"media_parameter_invalid",mode:mode.id,parameter:spec.id,actual:value,min:spec.min,max:spec.max,step:spec.step,values:spec.values});
 }
 return errors;
}
export function supportedMediaModes({provider,kind,customScript=false}={}){
 if(customScript)return kind==="video"?["text_to_video","first_frame","first_last_frame","omni_reference"]:[];
 if(kind==="video")return provider==="volcengine_ark"?["text_to_video","first_frame","first_last_frame","omni_reference"]:provider==="openai"||provider==="openai_compatible"?["text_to_video"]:[];
 if(kind==="image")return provider==="google_gemini"?["text_to_image","reference_edit"]:["openai","openai_compatible"].includes(provider)?["text_to_image","reference_edit","inpaint"]:[];
 if(kind==="audio")return ["openai","openai_compatible"].includes(provider)?["text_to_speech"]:[];
 return [];
}
export function supportedMediaParameters({provider,kind,customScript=false}={}){
 if(customScript)return kind==="video"?["duration_seconds","aspect_ratio","resolution","generate_audio","watermark"]:[];
 if(kind==="video")return provider==="volcengine_ark"?["duration_seconds","aspect_ratio","resolution","generate_audio","watermark"]:provider==="openai"||provider==="openai_compatible"?["duration_seconds","aspect_ratio","resolution"]:[];
 if(kind==="image")return ["openai","openai_compatible"].includes(provider)?["count","size"]:[];
 if(kind==="audio")return ["openai","openai_compatible"].includes(provider)?["voice","speed","output_format","instructions"]:[];
 return [];
}
export function validateComfyMediaContract(useCase,ports){
 const capabilities=useCase?.mediaCapabilities,bindings=useCase?.modeBindings;
 if(capabilities===undefined&&bindings===undefined)return true;
 if(!isMediaCapabilities(capabilities)||capabilities.kind!==useCase.channel||!keys(bindings,capabilities.modes.filter(m=>m.enabled).map(m=>m.id)))throw Error("comfy_media_capability_contract_invalid");
 const byId=new Map(ports.map(port=>[port.id,port]));
 const expectedPortKind={image:"IMAGE",video:"VIDEO",audio:"AUDIO",mask:"MASK"};
 const target=(id,kinds)=>typeof id==="string"&&byId.get(id)?.direction==="target"&&kinds.includes(byId.get(id)?.valueKind);
 const declaredSlots=new Set((useCase.slots??[]).map(slot=>slot.id));
 for(const mode of capabilities.modes.filter(m=>m.enabled)){
  const binding=bindings[mode.id];
  if(!keys(binding,["promptPortId","layoutPortId","parameterPorts","rolePorts","promptTransform"])||!keys(binding.parameterPorts??{},mode.parameters.map(p=>p.id))||!keys(binding.rolePorts??{},mode.inputs.map(i=>i.role)))throw Error("comfy_media_mode_binding_invalid");
  const promptId=binding.promptPortId??useCase.promptPortId;
  if(!target(promptId,["STRING"])||byId.get(promptId)?.inputBinding?.mode!=="literal")throw Error("comfy_media_prompt_binding_invalid");
  // Accept the retired H3 transform only to preserve immutable historical revisions.
  // The compiler never rewrites prompts based on this field.
  if(binding.promptTransform!==undefined){
   if(binding.promptTransform!=="minimax_h3_keyframes"||capabilities.kind!=="video"||
      !["first_frame","last_frame","first_last_frame"].includes(mode.id)||
      byId.get(promptId)?.inputBinding?.targets?.length!==1||
      mode.inputs.length!==(mode.id==="first_last_frame"?2:1)||
      mode.inputs.some(rule=>!["first_frame","last_frame"].includes(rule.role)||rule.minItems!==1||rule.maxItems!==1))
    throw Error("comfy_media_prompt_transform_invalid");
  }
  if(mode.layout?.delivery==="dedicated_input"&&(!binding.layoutPortId||!target(binding.layoutPortId,["STRING","JSON"])||byId.get(binding.layoutPortId)?.inputBinding?.mode!=="literal")||mode.layout===undefined&&binding.layoutPortId!==undefined)throw Error("comfy_media_layout_binding_invalid");
  const claimed=new Set([promptId]);
  if(binding.layoutPortId)claimed.add(binding.layoutPortId);
  for(const spec of mode.parameters){const portId=binding.parameterPorts[spec.id];const kind=spec.type==="number"?["INT","FLOAT"]:spec.type==="boolean"?["BOOLEAN"]:spec.type==="string"?["STRING"]:["STRING"];
   if(!target(portId,kind)||byId.get(portId)?.inputBinding?.mode!=="literal")throw Error("comfy_media_parameter_binding_invalid");}
  for(const id of Object.values(binding.parameterPorts??{})){if(claimed.has(id))throw Error("comfy_media_binding_port_reused");claimed.add(id);}
  const claimedRoles=new Set();
  for(const rule of mode.inputs){const mapped=binding.rolePorts[rule.role];
   if(!Array.isArray(mapped)||mapped.length<rule.minItems||mapped.length!==rule.maxItems||mapped.length>32||new Set(mapped).size!==mapped.length||mapped.some(id=>!declaredSlots.has(id)||!target(id,[expectedPortKind[rule.kind]])||byId.get(id)?.inputBinding?.mode==="literal"||claimed.has(id)||claimedRoles.has(id)))throw Error("comfy_media_role_binding_invalid");
   for(const id of mapped){claimed.add(id);claimedRoles.add(id);}
  }
 }
 return true;
}
