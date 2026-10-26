import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import type {BackendJobView} from "@/types/backend-contracts";
import {canvasApi} from "./canvas-api";
import {createSqliteComfyBridge} from "./sqlite-comfy-bridge";

/** Ordinary OpenAI calls use the same SQLite revision/source-fingerprint fence
 * as Comfy, with encrypted backend channel references (never raw API keys).
 * This V1 supports one output, text-only inputs, and the official OpenAI API.
 */
export async function startSqliteModelGeneration({
 projectId,sourceNodeId,nodes,connections,channelId,task,
 api=canvasApi,bridge=createSqliteComfyBridge({projectId,
  getLocalGraph:()=>({nodes:[...nodes],connections:[...connections]})})
}:{
 projectId:string;sourceNodeId:string;
 nodes:readonly CanvasNodeData[];connections:readonly CanvasConnection[];
 channelId:string;
 task:{kind:"image"|"audio"|"text";model:string;prompt:string;
  size?:string;quality?:string;voice?:string;format?:string;speed?:number};
 api?:typeof canvasApi;bridge?:ReturnType<typeof createSqliteComfyBridge>;
}):Promise<BackendJobView>{
 if(!nodes.some(node=>node.id===sourceNodeId))throw Error("model_source_node_missing");
 const capability=await api<{autoDispatch:boolean;modelKinds?:string[]}>(
  "/api/v1/execution/capabilities");
 if(!capability.autoDispatch||!capability.modelKinds?.includes(task.kind))
  throw Error("SQLite OpenAI 模型执行不可用，请设置 ATELIER_OPENAI_MODELS=1 并重启后端");
 const channel=await api<{id:string;provider:string;hasKey:boolean;keyVersion:string|null}>(
  "/api/v1/channels/"+encodeURIComponent(channelId));
 if(channel.id!==channelId||channel.provider!=="openai"||!channel.hasKey||!channel.keyVersion)
  throw Error("SQLite 后端未配置此 OpenAI 渠道的加密密钥");
 await bridge.assertNoActiveJob(sourceNodeId);
 const frozen={nodes:[...nodes],connections:[...connections]};
 const fence=await bridge.saveProjectNow(frozen,sourceNodeId);
 const idempotencyKey=crypto.randomUUID();
 return api<BackendJobView>("/api/v1/jobs","POST",{
  projectId,targetNodeId:sourceNodeId,
  expectedProjectRevision:fence.revision,sourceNodeFingerprint:fence.sourceNodeFingerprint,
  idempotencyKey,requestFingerprint:idempotencyKey,executionMode:"immediate",
  snapshot:{adapterKind:"model",provider:"openai",channelId,
   secretVersionRef:channel.keyVersion,task}
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
