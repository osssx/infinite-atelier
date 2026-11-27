import videoWorkflow from "../../../../workflows/video_minimax_h3_ref2v_turbo.json";
import {templatePayloadFromGraph,validateComfyApiGraph,type ComfyApiGraph,type ComfyTemplatePayload,type ComfyTemplatePort} from "./template-schema";
import type {MediaInputRule,MediaParameterSpec} from "@/services/media-capabilities";
import {defaultComfyModeInputs,withComfyMediaMode} from "./comfy-media-mode-config";
export const MINIMAX_H3_REF2V_TEMPLATE_ID="video-minimax-h3-ref2v-turbo";
type RefKind="IMAGE"|"VIDEO"|"AUDIO";
const refGroups=[
 {prefix:"ref_images.ref_image_",kind:"IMAGE",classType:"LoadImage",field:"image",id:"reference_image",label:"参考图片",max:9},
 {prefix:"ref_videos.ref_video_",kind:"VIDEO",classType:"VHS_LoadVideo",field:"video",id:"reference_video",label:"参考视频",max:3},
 {prefix:"ref_audios.ref_audio_",kind:"AUDIO",classType:"LoadAudio",field:"audio",id:"reference_audio",label:"参考音频",max:3},
] as const;
function referenceMappings(graph:ComfyApiGraph){
 const model=graph["129"],mappings:Array<{id:string;label:string;nodeId:string;field:string;kind:RefKind;group:typeof refGroups[number]["id"]}>=[];
 if(model?.class_type!=="MiniMaxH3ReferenceToVideo")return null;
 const claims=new Set<string>();
 for(const [key,link] of Object.entries(model.inputs)){
  if(!key.startsWith("ref_images.")&&!key.startsWith("ref_videos.")&&!key.startsWith("ref_audios.")&&!key.startsWith("ref_video_audios."))continue;
  const group=refGroups.find(g=>key.startsWith(g.prefix));
  if(!group)return null; // paired audio is not part of this exact import preset
  const suffix=key.slice(group.prefix.length);
  if(!/^\d+$/.test(suffix)||String(Number(suffix))!==suffix||Number(suffix)>=group.max||
     !Array.isArray(link)||link.length!==2||typeof link[0]!=="string"||link[1]!==0)return null;
  const loader=graph[link[0]],claim=link[0]+"."+group.field;
  if(loader?.class_type!==group.classType||typeof loader.inputs[group.field]!=="string"||claims.has(claim))return null;
  claims.add(claim);
  mappings.push({id:group.id+"_"+suffix,label:group.label+" "+(Number(suffix)+1),nodeId:link[0],field:group.field,kind:group.kind,group:group.id});
 }
 return mappings.sort((a,b)=>refGroups.findIndex(g=>g.id===a.group)-refGroups.findIndex(g=>g.id===b.group)||a.id.localeCompare(b.id));
}
const scalarFields=[
 ["prompt","视频提示词","STRING","129","prompt"],
 ["duration","视频时长（秒）","FLOAT","128","value"],
 ["aspect_ratio","画面比例","STRING","115","aspect_ratio"],
 ["megapixels","画面大小（MP）","FLOAT","115","megapixels"],
 ["ref_image_size","参考图像尺寸","STRING","129","ref_image_size"],
 ["seed","随机种子","INT","105_15","noise_seed"],
 ["lightning","启用 Lightning LoRA","BOOLEAN","105_126","value"],
 ["steps","常规步数","INT","105_124","value"],
 ["lightning_steps","Lightning 步数","INT","105_125","value"],
 ["lora_strength","LoRA 强度","FLOAT","105_121","strength_model"],
] as const;
export function isMiniMaxH3Ref2VWorkflow(graph:ComfyApiGraph):boolean{
 const refs=referenceMappings(graph);
 return !!refs&&refs.some(ref=>ref.kind==="VIDEO")&&
    graph["115"]?.class_type==="ResolutionSelector"&&graph["128"]?.class_type==="PrimitiveFloat"&&
    graph["105_91"]?.class_type==="CreateVideo"&&graph["92"]?.class_type==="SaveVideo"&&
    JSON.stringify(graph["92"].inputs.video)===JSON.stringify(["105_91",0])&&
    scalarFields.every(([, , ,id,key])=>Object.hasOwn(graph[id]?.inputs??{},key))&&
    refs.filter(ref=>ref.kind==="VIDEO").every(ref=>["force_rate","custom_width","custom_height","frame_load_cap","skip_first_frames","select_every_nth","format"].every(key=>Object.hasOwn(graph[ref.nodeId].inputs,key)));
}
export function buildMiniMaxH3Ref2VPreset(raw:unknown):ComfyTemplatePayload{
 const original=validateComfyApiGraph(raw);
 if(!isMiniMaxH3Ref2VWorkflow(original))throw Error("This file is not the supported MiniMax H3 Ref2V Turbo API workflow");
 const graph=structuredClone(original),refs=referenceMappings(graph)!;
 const payload=templatePayloadFromGraph("MiniMax H3 Ref2V Turbo · 全能参考",graph);
 const ports:ComfyTemplatePort[]=refs.map(ref=>({id:ref.id,label:ref.label,direction:"target",valueKind:ref.kind,required:false,
  inputBinding:{mode:"media-file",mediaKind:ref.kind,targets:[{nodeId:ref.nodeId,inputName:ref.field}]},absentPolicy:{mode:"auto-prune"}}));
 for(const ref of refs.filter(item=>item.kind==="VIDEO")){
  // Decode in ComfyUI, with deterministic time scale; no frame files in CAS.
  Object.assign(graph[ref.nodeId].inputs,{force_rate:24,format:"None",frame_load_cap:360,select_every_nth:1,skip_first_frames:0});
  for(const [key,label] of [["custom_width","参考视频宽度（0=原比例）"],["custom_height","参考视频高度（0=原比例）"]] as const)
   ports.push({id:ref.id+"_"+key,label:ref.label+" · "+label,direction:"target",valueKind:"INT",
    inputBinding:{mode:"literal",targets:[{nodeId:ref.nodeId,inputName:key}]},absentPolicy:{mode:"keep-template"}});
 }
 graph["105_91"].inputs.fps=24;
 for(const [id,label,valueKind,nodeId,inputName] of scalarFields)
  ports.push({id,label,valueKind,direction:"target",required:id==="prompt",inputBinding:{mode:"literal",targets:[{nodeId,inputName}]},
   absentPolicy:{mode:"keep-template"},...(id==="ref_image_size"?{choices:[{label:"匹配生成尺寸",value:"match"},{label:"最大保真",value:"max"}]}:{})});
 ports.push({id:"video",label:"生成视频",direction:"source",valueKind:"VIDEO",outputBinding:{nodeId:"105_91",outputIndex:0},capture:{kind:"video",adapterId:"SaveVideo"}});
 payload.ports=ports;
 const rolePorts:Record<string,string[]>={},inputs:MediaInputRule[]=[];
 for(const group of refGroups){
  const ids=refs.filter(ref=>ref.group===group.id).map(ref=>ref.id);
  if(!ids.length)continue;
  rolePorts[group.id]=ids;
  inputs.push({role:group.id,kind:group.kind.toLowerCase() as MediaInputRule["kind"],minItems:0,maxItems:ids.length,
   ...(group.kind==="VIDEO"?{maxDurationSeconds:15}: {})});
 }
 const duration=graph["128"].inputs.value;
 const parameters:MediaParameterSpec[]=[{id:"duration_seconds",type:"number",mode:"adjustable",defaultValue:typeof duration==="number"&&duration>=1&&duration<=15?duration:5,min:1,max:15}];
 // Align the graph default with the capability default only if the imported value is invalid.
 if(duration!==parameters[0].defaultValue)graph["128"].inputs.value=parameters[0].defaultValue;
 const parameterPorts={duration_seconds:"duration"};
 // The importer supplies only the known preset's declarative port mapping.
 // The same configuration function is used by the generic media editor.
 let useCase:NonNullable<ComfyTemplatePayload["mediaUseCase"]>={channel:"video",primaryOutputKind:"video",promptPortId:"prompt",primaryOutputPortId:"video",
  aspectSync:{mode:"ratio",portId:"aspect_ratio"},slots:refs.map(ref=>({id:ref.id,label:ref.label,valueKind:ref.kind,required:false}))};
 useCase=withComfyMediaMode(useCase,{id:"text_to_video",enabled:true,inputs:[],parameters},{promptPortId:"prompt",rolePorts:{},parameterPorts});
 useCase=withComfyMediaMode(useCase,{id:"omni_reference",enabled:true,inputs,parameters},{promptPortId:"prompt",rolePorts,parameterPorts});
 const hasFirst=rolePorts.reference_image?.includes("reference_image_0");
 const hasLast=hasFirst&&rolePorts.reference_image?.includes("reference_image_1");
 if(hasFirst){
  useCase=withComfyMediaMode(useCase,{id:"first_frame",enabled:true,inputs:defaultComfyModeInputs("first_frame"),parameters},{promptPortId:"prompt",rolePorts:{first_frame:["reference_image_0"]},parameterPorts});
  useCase=withComfyMediaMode(useCase,{id:"last_frame",enabled:true,inputs:defaultComfyModeInputs("last_frame"),parameters},{promptPortId:"prompt",rolePorts:{last_frame:["reference_image_0"]},parameterPorts});
 }
 if(hasLast)useCase=withComfyMediaMode(useCase,{id:"first_last_frame",enabled:true,inputs:defaultComfyModeInputs("first_last_frame"),parameters},{promptPortId:"prompt",rolePorts:{first_frame:["reference_image_0"],last_frame:["reference_image_1"]},parameterPorts});
 payload.mediaUseCase=useCase;
 payload.requirements.modelAssets=[...new Set(Object.values(graph).flatMap(node=>Object.entries(node.inputs)
  .filter(([key])=>["unet_name","clip_name","vae_name","lora_name"].includes(key))
  .map(([,value])=>value).filter((value):value is string=>typeof value==="string")))].sort();
 return payload;
}
export function minimaxH3Ref2VBundledTemplate():ComfyTemplatePayload{
 return buildMiniMaxH3Ref2VPreset(videoWorkflow);
}
