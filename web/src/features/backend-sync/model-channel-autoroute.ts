/** Automatic SQLite model routing and DPAPI channel provisioning.
 * Official providers already supported by the local JobCoordinator require
 * no UI toggle or environment flag. Unsupported endpoints keep their existing
 * API path until a backend adapter exists.
 */
import type {ModelChannel,ModelCapability} from "@/stores/use-config-store";
import {canvasApi,CanvasApiError} from "./canvas-api";

export type SqliteModelProvider="openai"|"volcengine_ark";
export function modelChannelProvider(channel:ModelChannel|null,kind?:ModelCapability):SqliteModelProvider|null{
 if(!channel)return null;
 const endpoint=channel.baseUrl.trim().replace(/\/$/,"");
 if(channel.apiFormat==="openai"&&
   (endpoint==="https://api.openai.com"||endpoint==="https://api.openai.com/v1"))
  return kind==="video"?null:"openai";
 if(channel.apiFormat==="volcengine_ark"&&
   endpoint==="https://ark.cn-beijing.volces.com/api/v3")
  return kind&&kind!=="video"?null:"volcengine_ark";
 return null;
}
export type VaultChannelView={id:string;provider:string;hasKey:boolean;keyVersion:string|null};
export async function ensureSqliteModelChannel(channel:ModelChannel,
 provider:SqliteModelProvider,api:typeof canvasApi=canvasApi):Promise<ModelChannel>{
 if(!/^[a-zA-Z0-9_-]{1,128}$/.test(channel.id))throw Error("后端渠道 ID 不符合要求");
 if(modelChannelProvider(channel)!==provider)throw Error("SQLite 渠道地址不受支持");
 let existing:VaultChannelView|null=null;
 try{existing=await api<VaultChannelView>("/api/v1/channels/"+encodeURIComponent(channel.id))}
 catch(error){
  if(!(error instanceof CanvasApiError&&error.status===404))throw error;
 }
 if(existing&&existing.provider!==provider)throw Error("后端渠道 ID 已被其他模型服务占用");
 const key=channel.apiKey.trim();
 if(key){
  if(existing){
   await api("/api/v1/channels/"+encodeURIComponent(channel.id)+"/credential","PATCH",{
    apiKey:key,expectedKeyVersion:existing.keyVersion
   });
  }else{
   await api("/api/v1/channels","POST",{
    id:channel.id,displayName:channel.name,provider,apiKey:key
   });
  }
 }else if(!existing?.hasKey||!existing.keyVersion){
  throw Error("此渠道尚未配置 API Key，请在渠道设置中填写并保存");
 }
 // Never persist a newly vaulted key back into browser/Zustand.
 return {...channel,apiKey:""};
}
