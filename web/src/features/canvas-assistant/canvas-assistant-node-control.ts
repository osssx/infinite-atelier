import {CanvasNodeType,type CanvasGenerationMode,type CanvasNodeData,type CanvasNodeMetadata} from "@/types/canvas";
import {COMFY_WORKFLOW_MOCK_TYPE} from "@/lib/canvas/canvas-ports";
import {selectableModelsByCapability,type AiConfig} from "@/stores/use-config-store";
import {updateCanvasNodePrompt} from "@/lib/canvas/canvas-prompt-metadata";
import {assistantWorkflowBinding} from "./canvas-assistant-workflow-params";

export const assistantParameterKeys=[
 "model","generationMode","quality","size","count","reasoningEffort",
 "seconds","videoRatio","vquality","generateAudio","audioVoice","audioFormat",
 "audioSpeed","audioInstructions","textCount"
] as const;
export type AssistantParameterKey=typeof assistantParameterKeys[number];
export type AssistantParameterValue=string|number|boolean;
export type AssistantExecutionAction=
 |{type:"run_node";nodeId:string;mode?:CanvasGenerationMode}
 |{type:"run_workflow";nodeId:string};
export type AssistantNodeRun={
 kind:"node"|"workflow";nodeId:string;mode?:CanvasGenerationMode;prompt?:string;
};
const allowedKeys=new Set<string>(assistantParameterKeys);
const modes=new Set<string>(["text","image","video","audio"]);
export const assistantValueHasSupportedShape=(key:unknown,value:unknown):key is AssistantParameterKey=>{
 if(typeof key!=="string"||!allowedKeys.has(key))return false;
 if(typeof value!=="string"&&typeof value!=="number"&&typeof value!=="boolean")return false;
 if(typeof value==="string"&&value.length>2000)return false;
 if(typeof value==="number"&&!Number.isFinite(value))return false;
 switch(key){
  case "model":return typeof value==="string"&&value.length>0&&value.length<=128;
  case "generationMode":return typeof value==="string"&&modes.has(value);
  case "quality":return typeof value==="string"&&["auto","low","medium","high"].includes(value);
  case "size":return typeof value==="string"&&["auto","1024x1024","1536x1024","1024x1536","512x512","256x256","1792x1024","1024x1792"].includes(value);
  case "count":return Number.isInteger(value)&&Number(value)>=1&&Number(value)<=10;
  case "textCount":return Number.isInteger(value)&&Number(value)>=1&&Number(value)<=8;
  case "reasoningEffort":return typeof value==="string"&&["auto","low","medium","high","xhigh"].includes(value);
  case "seconds":return Number.isInteger(value)&&Number(value)>=4&&Number(value)<=20;
  case "videoRatio":return typeof value==="string"&&["adaptive","16:9","9:16","1:1","4:3","3:4","21:9"].includes(value);
  case "vquality":return typeof value==="string"&&["480p","720p","1080p"].includes(value);
  case "generateAudio":return typeof value==="boolean";
  case "audioVoice":return typeof value==="string"&&/^[\w-]{1,64}$/.test(value);
  case "audioFormat":return typeof value==="string"&&["mp3","wav","flac"].includes(value);
  case "audioSpeed":return typeof value==="number"&&value>=0.25&&value<=4;
  case "audioInstructions":return typeof value==="string"&&value.length<=2000;
  default:return false;
 }
};
export function assistantNodeMode(node:CanvasNodeData,chosen?:CanvasGenerationMode):CanvasGenerationMode{
 const natural=node.type===CanvasNodeType.Text?"text":node.type===CanvasNodeType.Image?"image":
  node.type===CanvasNodeType.Audio?"audio":node.type===CanvasNodeType.Video?"video":
  node.type===CanvasNodeType.Config?node.metadata?.generationMode??"image":null;
 if(!natural)throw Error("该节点不支持直接执行模型生成。");
 if(chosen&&chosen!==natural)throw Error("执行模式与节点类型或配置节点当前模式不一致。");
 return natural;
}
export function setAssistantNodePrompt(node:CanvasNodeData,prompt:string):CanvasNodeData{
 if(![CanvasNodeType.Text,CanvasNodeType.Image,CanvasNodeType.Video,CanvasNodeType.Audio,CanvasNodeType.Config].includes(node.type as CanvasNodeType))
  throw Error("该节点类型不允许 AI 修改生成提示词。");
 if(typeof prompt!=="string"||prompt.length>12000)throw Error("提示词长度无效。");
 const previous=node.metadata;
 return {...node,metadata:{
  ...updateCanvasNodePrompt(previous,prompt),
  ...(node.type===CanvasNodeType.Config||Boolean(previous?.content?.trim())?{composerContent:prompt}:{})
 }};
}
export function setAssistantNodeParameter(
 node:CanvasNodeData,key:AssistantParameterKey,value:AssistantParameterValue,config?:AiConfig
):CanvasNodeData{
 if(!assistantValueHasSupportedShape(key,value))throw Error("节点参数不支持此数值，未执行。");
 if(key==="generationMode"){
  if(node.type!==CanvasNodeType.Config)throw Error("只有配置节点可调整生成模式。");
  return {...node,metadata:{...node.metadata,generationMode:value as CanvasGenerationMode}};
 }
  const mode=assistantNodeMode(node);
  if(node.metadata?.comfyMediaPreset||node.metadata?.comfyWorkflowSelections?.[mode==="text"?"image":mode]||
   config&&assistantWorkflowBinding(node,config))
   throw Error("该节点使用 ComfyUI 工作流预设，请使用 set_workflow_param 按实际工作流端口 ID 修改参数；普通渠道参数不会生效。"); const allowed=mode==="text"?["model","reasoningEffort","textCount"]:
  mode==="image"?["model","quality","size","count"]:
  mode==="video"?["model","seconds","videoRatio","vquality","generateAudio"]:
  ["model","audioVoice","audioFormat","audioSpeed","audioInstructions"];
 if(!allowed.includes(key))throw Error("该参数不适用于当前节点生成模式。");
 if(key==="model"){
  if(!config)throw Error("缺少可用模型配置，未修改节点。");
  if(node.metadata?.comfyMediaPreset||node.metadata?.comfyWorkflowSelections?.[mode==="text"?"image":mode])
   throw Error("节点已绑定 ComfyUI 预设，请先在参数面板解除绑定后切换渠道模型。");
  if(!selectableModelsByCapability(config,mode).includes(value as string))
   throw Error("模型未在当前渠道配置中找到，或不支持节点生成类型。");
 }
 const metadata:CanvasNodeMetadata={...node.metadata};
 if(key==="seconds"||key==="audioSpeed")Object.assign(metadata,{[key]:String(value)});
 else if(key==="generateAudio")metadata.generateAudio=String(value);
 else Object.assign(metadata,{[key]:value});
 return {...node,metadata};
}
export function planAssistantNodeRuns(
 nodes:readonly CanvasNodeData[],actions:readonly AssistantExecutionAction[],
 refs:ReadonlyMap<string,string>=new Map()
):AssistantNodeRun[]{
 const result:AssistantNodeRun[]=[];
 const seen=new Set<string>();
 for(const action of actions){
  const nodeId=refs.get(action.nodeId)??action.nodeId;
  const node=nodes.find(n=>n.id===nodeId);
  if(!node)throw Error("生成目标节点不存在，未执行。");
  if(seen.has(nodeId))throw Error("本轮重复执行同一节点，已拒绝。");
  seen.add(nodeId);
  if(result.length>=3)throw Error("每次 AI 请求最多触发 3 个生成任务。");
  if(action.type==="run_workflow"){
   if(node.type!==COMFY_WORKFLOW_MOCK_TYPE)throw Error("执行目标不是 ComfyUI 工作流节点。");
    // Match executeComfyWorkflow: a template revision must exist, but execution
    // uses the configured global default ComfyUI instance. Template binding
    // normally leaves bindingState as "needs-instance-binding"; that UI state
    // alone does not make a globally runnable workflow invalid.
    if(!node.metadata?.comfyWorkflow?.templateId||
     !node.metadata.comfyWorkflow?.templateRevision)
     throw Error("工作流节点尚未绑定可执行的预设模板。");   result.push({kind:"workflow",nodeId});
   continue;
  }
  if(node.type===COMFY_WORKFLOW_MOCK_TYPE)throw Error("ComfyUI 工作流必须使用 run_workflow 操作。");
   const mode=assistantNodeMode(node,action.mode);
   // A populated media node is still a valid generation source. The materializer
   // appends separate artifacts when source media content is already present.
   const prompt=node.metadata?.composerContent??node.metadata?.prompt??"";  if(!prompt.trim())throw Error("节点生成提示词为空，请先设置提示词并确认。");
  result.push({kind:"node",nodeId,mode,prompt});
 }
 return result;
}
