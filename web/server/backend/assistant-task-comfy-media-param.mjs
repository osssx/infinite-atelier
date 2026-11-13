/** P3b controlled media preset scalar overrides. No browser config claims.
 * Template revision and media-use-case mapping are read from server storage.
 */
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const secret=/(?:secret|token|password|api.?key|credential|authorization|密钥|密码|令牌)/i;
const own=(a,k)=>Object.prototype.hasOwnProperty.call(a,k);
const simple=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const normalized=value=>{
 if(typeof value!=="string")return null;
 const m=value.trim().match(/^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)(?:\s*\([^)]*\))?$/i);
 if(!m)return null;
 return aspect(Number(m[1]),Number(m[2]));
};
const aspect=(w,h)=>{
 if(!Number.isFinite(w)||!Number.isFinite(h)||w<=0||h<=0)return null;
 const r=w/h;
 return r<0.25||r>4?null:Math.round(r*1_000_000)+":1000000";
};
function adjustNodeSize(node,ratio){
 if(!ratio||!["image","video"].includes(node.type))return node;
 const metadata=node.metadata??{};
 if(metadata.content||metadata.storageKey||metadata.images?.length||metadata.freeResize)return node;
 const match=ratio.match(/^(\d+):(\d+)$/);
 if(!match)return node;
 const r=Number(match[1])/Number(match[2]);
 const base=node.type==="video"?{width:420,height:236}:{width:340,height:240};
 const dims=r>=base.width/base.height?{width:base.width,height:base.width/r}:
  {width:base.height*r,height:base.height};
 return {...node,width:dims.width,height:dims.height,
  position:{x:node.position.x+node.width/2-dims.width/2,
   y:node.position.y+node.height/2-dims.height/2}};
}
function effectiveBinding(node,config){
 const mode=node.type==="config"?node.metadata?.generationMode??"image":node.type;
 if(!["image","video","audio"].includes(mode))throw fail("assistant_comfy_target_invalid");
 const meta=node.metadata??{};
 if(meta.comfyMediaPreset)return {mode,binding:meta.comfyMediaPreset,where:"media"};
 if(meta.comfyWorkflowSelections?.[mode])return {mode,binding:meta.comfyWorkflowSelections[mode],where:"selection"};
 if(meta.model)throw fail("assistant_comfy_target_invalid");
 const fallback=config?.comfyWorkflowDefaults?.[mode];
 if(!fallback)throw fail("assistant_comfy_target_invalid");
 return {mode,binding:{...fallback,overrides:{},slots:{}},
  where:node.type==="config"?"selection":"media"};
}
function valueFor(template,binding,portId){
 if(own(binding.overrides??{},portId))return binding.overrides[portId];
 return template.ports.find(p=>p.id===portId)?.defaultValue;
}
function computedRatio(template,binding,changedPortId){
 const sync=template.mediaUseCase?.aspectSync;
 if(!sync||sync.mode==="off")return {changed:false};
 if(sync.mode==="ratio"){
  if(sync.portId!==changedPortId)return {changed:false};
  return {changed:true,ratio:normalized(valueFor(template,binding,sync.portId))};
 }
 if(sync.mode==="dimensions"){
  if(![sync.widthPortId,sync.heightPortId].includes(changedPortId))return {changed:false};
  const width=valueFor(template,binding,sync.widthPortId);
  const height=valueFor(template,binding,sync.heightPortId);
  if(typeof width!=="number"||typeof height!=="number")
   throw fail("assistant_comfy_aspect_sync_unavailable");
  return {changed:true,ratio:aspect(width,height)};
 }
 // Auto inference may have multiple candidate ports; don't silently desync preview.
 if(/aspect|ratio|width|height|宽高比|比例|宽度|高度/i.test(changedPortId))
  throw fail("assistant_comfy_aspect_sync_unavailable");
 return {changed:false};
}
export function applyFrozenComfyMediaParameter({document,action,resolve,loadTemplate,config}){
 const index=document.nodes.findIndex(n=>n.id===resolve(action.nodeId));
 if(index<0)throw fail("assistant_comfy_target_invalid");
 const node=document.nodes[index],meta=node.metadata??{};
 const {mode,binding,where}=effectiveBinding(node,config);
 if(!simple(binding)||typeof binding.templateId!=="string"||typeof binding.templateRevision!=="string"||
  !simple(binding.overrides??{}))throw fail("assistant_comfy_template_unavailable");
 const template=loadTemplate?.(binding.templateId,binding.templateRevision);
 if(!template||template.id!==binding.templateId||template.revision!==binding.templateRevision||
  template.mediaUseCase?.channel!==mode)
  throw fail("assistant_comfy_template_unavailable");
 const port=template.ports?.find(p=>p.id===action.portId&&p.direction==="target");
 const excluded=new Set([template.mediaUseCase.promptPortId,
  ...(template.mediaUseCase.slots??[]).map(s=>s.id)]);
 if(!port||excluded.has(action.portId)||secret.test(port.id+" "+port.label)||
  port.inputBinding?.mode!=="literal"||!port.inputBinding.targets?.length||
  !["STRING","INT","FLOAT","BOOLEAN"].includes(port.valueKind))
  throw fail("assistant_comfy_port_invalid");
 const v=action.value;
 const valid=port.valueKind==="STRING"?typeof v==="string":
  port.valueKind==="BOOLEAN"?typeof v==="boolean":
  port.valueKind==="INT"?Number.isSafeInteger(v):
  typeof v==="number"&&Number.isFinite(v);
 if(!valid||Array.isArray(port.choices)&&port.choices.length&&
  !port.choices.some(option=>Object.is(option.value,v)))
  throw fail("assistant_comfy_param_value_invalid");
 const updated={...binding,overrides:{...binding.overrides,[port.id]:v}};
 const ratio=computedRatio(template,updated,port.id);
 let nextMeta={...meta};
 if(where==="selection")nextMeta.comfyWorkflowSelections={
  ...meta.comfyWorkflowSelections,[mode]:updated};
 else nextMeta.comfyMediaPreset=updated;
 if(ratio.changed)nextMeta.comfyMediaPreviewRatio=ratio.ratio??undefined;
 let next={...node,metadata:nextMeta};
 if(ratio.changed&&ratio.ratio)next=adjustNodeSize(next,ratio.ratio);
 document.nodes[index]=next;
}
