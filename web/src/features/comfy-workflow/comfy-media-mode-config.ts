import {MEDIA_MODES,type MediaCapabilities,type MediaInputRule,type MediaModeId,type MediaRole} from "@/services/media-capabilities";
import type {ComfyMediaUseCase} from "./template-schema";

type Mode=MediaCapabilities["modes"][number];
type Binding=NonNullable<NonNullable<ComfyMediaUseCase["modeBindings"]>[MediaModeId]>;

export const comfyModeLabels:Record<MediaModeId,string>={text_to_image:"文生图",reference_edit:"参考编辑",inpaint:"局部重绘",text_to_video:"文生视频",first_frame:"首帧生成",last_frame:"尾帧生成",first_last_frame:"首尾帧生成",omni_reference:"全能参考",text_to_speech:"语音合成",voice_clone:"参考音色合成",text_to_music:"音乐生成",text_to_sound:"音效生成"};
export const comfyRoleLabels:Record<MediaRole,string>={reference_image:"参考图片",source_image:"原图",mask:"蒙版",first_frame:"首帧",last_frame:"尾帧",reference_video:"参考视频",reference_audio:"参考音频",voice_reference:"参考音色"};

/** Prompt ports (including per-mode overrides) and media slots are managed by generation, not scalar overrides. */
export function comfyMediaManagedPortIds(useCase:ComfyMediaUseCase):Set<string>{
 return new Set([...(useCase.promptPortId?[useCase.promptPortId]:[]),...Object.values(useCase.modeBindings??{}).flatMap(mode=>mode?.promptPortId?[mode.promptPortId]:[]),...useCase.slots.map(slot=>slot.id)]);
}

/** Mode semantics, independent of any graph class, file name or port ID. */
export function defaultComfyModeInputs(id:MediaModeId):MediaInputRule[]{
 const rule=(role:MediaRole,kind:MediaInputRule["kind"],minItems:number):MediaInputRule=>({role,kind,minItems,maxItems:minItems});
 switch(id){
  case "reference_edit":return [rule("reference_image","image",1)];
  case "inpaint":return [rule("source_image","image",1),rule("mask","mask",1)];
  case "first_frame":return [rule("first_frame","image",1)];
  case "last_frame":return [rule("last_frame","image",1)];
  case "first_last_frame":return [rule("first_frame","image",1),rule("last_frame","image",1)];
  case "voice_clone":return [rule("voice_reference","audio",1)];
  case "omni_reference":return [rule("reference_image","image",0),rule("reference_video","video",0),rule("reference_audio","audio",0)];
  default:return [];
 }
}
export function createComfyMediaCapabilities(useCase:ComfyMediaUseCase):MediaCapabilities{
 return {schemaVersion:1,kind:useCase.channel,modes:MEDIA_MODES[useCase.channel].map(id=>({id,enabled:false,inputs:defaultComfyModeInputs(id),parameters:[]}))};
}

/** The preset import convenience and the editor write the same versioned contract.
 * Incomplete editor drafts are allowed; the shared template validator fences saves.
 */
export function withComfyMediaMode(useCase:ComfyMediaUseCase,mode:Mode,binding:Binding):ComfyMediaUseCase{
 const base=useCase.mediaCapabilities??{schemaVersion:1 as const,kind:useCase.channel,modes:[]};
 if(base.kind!==useCase.channel||!MEDIA_MODES[useCase.channel].includes(mode.id))throw Error("当前媒体类型不支持该生成模式");
 const modes=base.modes.some(item=>item.id===mode.id)?base.modes.map(item=>item.id===mode.id?mode:item):[...base.modes,mode];
 const modeBindings={...useCase.modeBindings};
 if(mode.enabled)modeBindings[mode.id]=binding;else delete modeBindings[mode.id];
 const defaultMode=modes.some(item=>item.enabled&&item.id===base.defaultMode)?base.defaultMode:modes.find(item=>item.enabled)?.id;
 const {defaultMode:_old,...rest}=base;
 return {...useCase,mediaCapabilities:{...rest,modes,...(defaultMode?{defaultMode}:{})},modeBindings};
}

export function setComfyMediaModeEnabled(useCase:ComfyMediaUseCase,id:MediaModeId,enabled:boolean):ComfyMediaUseCase{
 const mode=useCase.mediaCapabilities?.modes.find(item=>item.id===id)??{id,enabled:false,inputs:defaultComfyModeInputs(id),parameters:[]};
 const current=useCase.modeBindings?.[id];
 if(current)return withComfyMediaMode(useCase,{...mode,enabled},current);
 // Empty optional roles are valid declarations and need no manual mapping.
 const inputs=mode.inputs.map(rule=>({...rule,maxItems:rule.minItems}));
 const rolePorts=Object.fromEntries(inputs.map(rule=>[rule.role,[]]));
 return withComfyMediaMode(useCase,{...mode,enabled,inputs},{rolePorts,parameterPorts:{}});
}

export function mapComfyMediaRole(useCase:ComfyMediaUseCase,id:MediaModeId,role:MediaRole,requested:string[]):ComfyMediaUseCase{
 const mode=useCase.mediaCapabilities?.modes.find(item=>item.id===id),binding=useCase.modeBindings?.[id];
 if(!mode||!binding)return useCase;
 const rule=mode.inputs.find(item=>item.role===role);
 if(!rule)return useCase;
 const occupied=new Set(Object.entries(binding.rolePorts??{}).filter(([key])=>key!==role).flatMap(([,ports])=>ports??[]));
 const kind=rule.kind.toUpperCase();
 const ports=[...new Set(requested)].filter(port=>!occupied.has(port)&&useCase.slots.some(slot=>slot.id===port&&slot.valueKind===kind));
 if(role==="first_frame"||role==="last_frame")ports.splice(1);
 const floor=defaultComfyModeInputs(id).find(item=>item.role===role)?.minItems??0;
 const minItems=Math.max(floor,Math.min(rule.minItems,ports.length));
 const inputs=mode.inputs.map(item=>item.role===role?{...item,minItems,maxItems:Math.max(minItems,ports.length)}:item);
 return withComfyMediaMode(useCase,{...mode,inputs},{...binding,rolePorts:{...binding.rolePorts,[role]:ports}});
}
