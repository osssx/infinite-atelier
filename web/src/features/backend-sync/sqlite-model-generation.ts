import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import type {BackendJobView} from "@/types/backend-contracts";
import {canvasApi} from "./canvas-api";
import {createSqliteComfyBridge} from "./sqlite-comfy-bridge";
import type {FrozenArkReference} from "./seedance-frozen-references";
import type {ReferenceImage} from "@/types/image";
import {freezeModelImages,type FrozenModelImage} from "./frozen-model-images";

export type FrozenTextTurn=
 | {role:"system"|"user"|"assistant";content:string}
 | {role:"assistant";content:string;toolCalls:{id:string;name:string;argumentsJson:string}[]}
 | {role:"tool";content:string;callId:string;name:string};

/** Ordinary OpenAI calls use the same SQLite revision/source-fingerprint fence
 * as Comfy, with encrypted backend channel references (never raw API keys).
 * P5.4d allows frozen CAS images for official OpenAI image edits or text
 * questions, retaining a single output and no browser credential references.
 */
export async function startSqliteModelGeneration({
 projectId,sourceNodeId,nodes,connections,channelId,provider="openai",task,
 referenceImages=[],maskImage,
 api=canvasApi,bridge=createSqliteComfyBridge({projectId,
  getLocalGraph:()=>({nodes:[...nodes],connections:[...connections]})})
}:{
 projectId:string;sourceNodeId:string;
 nodes:readonly CanvasNodeData[];connections:readonly CanvasConnection[];
 channelId:string;provider?:"openai"|"volcengine_ark";
 task:{kind:"image"|"audio"|"text"|"video";model:string;prompt:string;
  size?:string;quality?:string;voice?:string;format?:string;speed?:number;
  duration?:number;ratio?:string;resolution?:string;generateAudio?:boolean;watermark?:boolean;
  mode?:"text_to_video"|"first_frame"|"first_last_frame"|"omni_reference";
  references?:FrozenArkReference[];
  operation?:"edit";images?:FrozenModelImage[];mask?:FrozenModelImage;
  messages?:FrozenTextTurn[];stream?:boolean;skills?:{blobId:string}};
 referenceImages?:readonly ReferenceImage[];maskImage?:ReferenceImage;
 api?:typeof canvasApi;bridge?:ReturnType<typeof createSqliteComfyBridge>;
}):Promise<BackendJobView>{
 if(!nodes.some(node=>node.id===sourceNodeId))throw Error("model_source_node_missing");
 if((provider==="openai"&&task.kind==="video")||
    (provider==="volcengine_ark"&&task.kind!=="video"))
  throw Error("model_provider_kind_unsupported");
 const capability=await api<{autoDispatch:boolean;modelKinds?:string[]}>(
  "/api/v1/execution/capabilities");
 if(!capability.autoDispatch||!capability.modelKinds?.includes(task.kind))
  throw Error("本地 SQLite 模型执行服务不可用，请确认本地后端已启动并更新到当前版本");
 const channel=await api<{id:string;provider:string;hasKey:boolean;keyVersion:string|null}>(
  "/api/v1/channels/"+encodeURIComponent(channelId));
 if(channel.id!==channelId||channel.provider!==provider||!channel.hasKey||!channel.keyVersion)
  throw Error("SQLite 后端未配置此模型渠道的加密密钥");
 if((referenceImages.length||maskImage)&&provider!=="openai")
  throw Error("model_provider_image_inputs_unsupported");
 if((referenceImages.length||maskImage)&&!["image","text"].includes(task.kind))
  throw Error("model_image_inputs_kind_unsupported");
 if(maskImage&&(task.kind!=="image"||referenceImages.length!==1))
  throw Error("model_image_mask_inputs_invalid");
 if(task.images||task.mask||task.operation)
  throw Error("model_task_references_must_be_frozen");
 if(task.kind==="text"){
  if(task.messages&&(!Array.isArray(task.messages)||task.messages.length>32||
    task.messages.some(item=>typeof item.content!=="string"||
      item.content.includes("data:image/")||item.content.length>32768)))
   throw Error("model_text_history_invalid");
 }else if(task.messages||task.stream!==undefined)
  throw Error("model_text_options_kind_invalid");
 if(task.skills&&referenceImages.length)
  throw Error("model_skill_images_unsupported");
 if(task.skills&&(task.kind!=="text"||provider!=="openai"||
   !/^[a-f0-9]{64}$/.test(task.skills.blobId)))
  throw Error("model_skill_catalog_invalid");
 const images=referenceImages.length?await freezeModelImages(referenceImages,bridge):[];
 const mask=maskImage?(await freezeModelImages([maskImage],bridge))[0]:undefined;
 await bridge.assertNoActiveJob(sourceNodeId);
 const frozen={nodes:[...nodes],connections:[...connections]};
 const fence=await bridge.saveProjectNow(frozen,sourceNodeId);
 const idempotencyKey=crypto.randomUUID();
 return api<BackendJobView>("/api/v1/jobs","POST",{
  projectId,targetNodeId:sourceNodeId,
  expectedProjectRevision:fence.revision,sourceNodeFingerprint:fence.sourceNodeFingerprint,
  idempotencyKey,requestFingerprint:idempotencyKey,executionMode:task.kind==="video"?"poll":"immediate",
  snapshot:{adapterKind:"model",provider,channelId,
   secretVersionRef:channel.keyVersion,task:{...task,
    ...(images.length?{images}:{}),
    ...(images.length&&task.kind==="image"?{operation:"edit"}:{}),
    ...(mask?{mask}:{})}}
 });
}
export function openAiImageSize(value:string):"auto"|"1024x1024"|"1536x1024"|"1024x1536"{
 if(["1024x1024","1536x1024","1024x1536"].includes(value))
  return value as "1024x1024"|"1536x1024"|"1024x1536";
 if(value==="1:1")return "1024x1024";
 if(["3:2","16:9","4:3"].includes(value))return "1536x1024";
 if(["2:3","9:16","3:4"].includes(value))return "1024x1536";
 return "auto";
}
