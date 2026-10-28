/** Automatic SQLite model routing and DPAPI channel provisioning.
 * Official providers already supported by the local JobCoordinator require
 * no UI toggle or operator allowlist. Custom HTTP(S) OpenAI-compatible
 * endpoints use the exact validated channel URL in a frozen job snapshot.
 */
import type {ModelChannel,ModelCapability} from "@/stores/use-config-store";
import {canvasApi,CanvasApiError} from "./canvas-api";

export type SqliteModelProvider="openai"|"openai_compatible"|"volcengine_ark";
const isCompatibleHostSafe=(hostname:string)=>{
 const host=hostname.toLowerCase().replace(/^\[|\]$/g,"");
 if(["metadata","metadata.google.internal","instance-data","instance-data.ec2.internal"].includes(host)||
   host.endsWith(".internal")||host.endsWith(".localhost")&&host!=="localhost")return false;
 if(host.includes(":"))return host==="::1";
 const numeric=/^(\d{1,3}\.){3}\d{1,3}$/.test(host);
 if(!numeric)return true;
 const [a,b,c]=host.split(".").map(Number);
 if(host==="127.0.0.1"||a===10||a===172&&b>=16&&b<=31||a===192&&b===168)return true;
 return !(a===0||a===10||a===127||a>=224||
  a===169&&b===254||a===100&&b>=64&&b<=127||
  a===172&&b>=16&&b<=31||a===192&&[0,168,88].includes(b)||
  a===198&&[18,19,51].includes(b)||a===203&&b===0||
  a===198&&b===51&&c===100);};
export function normalizeCompatBaseUrl(value:string){
 let url:URL;
 try{url=new URL(value.trim())}catch{throw Error("自定义 API 地址无效");}
 if(!["https:","http:"].includes(url.protocol)||url.username||url.password||
    url.search||url.hash||!url.hostname||!isCompatibleHostSafe(url.hostname)||value.length>1024||
    /%(?:2f|5c|00)/i.test(value)||
    ["metadata","metadata.google.internal","instance-data","instance-data.ec2.internal"].includes(url.hostname.toLowerCase())||
    url.hostname.toLowerCase().endsWith(".internal"))
  throw Error("自定义 API 地址不安全或无效");
 return url.toString().replace(/[/]+$/,"");
}
export function modelChannelProvider(channel:ModelChannel|null,kind?:ModelCapability):SqliteModelProvider|null{
 if(!channel)return null;
 const endpoint=channel.baseUrl.trim().replace(/\/$/,"");
 if(channel.apiFormat==="openai"&&
   (endpoint==="https://api.openai.com"||endpoint==="https://api.openai.com/v1"))
  return kind==="video"?null:"openai";
 // All custom OpenAI-format endpoints, including local HTTP proxies,
 // go through the backend. Invalid URLs fail closed during provisioning.
 if(channel.apiFormat==="openai")return kind==="video"?null:"openai_compatible";
 if(channel.apiFormat==="volcengine_ark"&&
   endpoint==="https://ark.cn-beijing.volces.com/api/v3")
  return kind&&kind!=="video"?null:"volcengine_ark";
 return null;
}
export type VaultChannelView={id:string;provider:string;hasKey:boolean;keyVersion:string|null};
export async function ensureSqliteModelChannel(channel:ModelChannel,
 provider:SqliteModelProvider,api:typeof canvasApi=canvasApi):Promise<ModelChannel>{
 if(!/^[a-zA-Z0-9_-]{1,128}$/.test(channel.id))throw Error("后端渠道 ID 不符合要求");
 if(modelChannelProvider(channel)!==provider)throw Error("该渠道地址不受本地后端支持");
 if(provider==="openai_compatible")normalizeCompatBaseUrl(channel.baseUrl);
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
/** Execution is not a key rotation or user-triggered migration. Existing
 * vaulted versions win; only a missing version may be provisioned on first use.
 * Compatibility browser credentials must remain available for legacy routes.
 */
export async function ensureSqliteModelChannelForExecution(channel:ModelChannel,
 provider:SqliteModelProvider,api:typeof canvasApi=canvasApi):Promise<void>{
 if(modelChannelProvider(channel)!==provider)throw Error("该渠道地址不受本地后端支持");
 if(provider==="openai_compatible")normalizeCompatBaseUrl(channel.baseUrl);
 let existing:VaultChannelView|null=null;
 try{existing=await api<VaultChannelView>("/api/v1/channels/"+encodeURIComponent(channel.id))}
 catch(error){if(!(error instanceof CanvasApiError&&error.status===404))throw error}
 if(existing&&existing.provider!==provider)throw Error("后端渠道 ID 已被其他模型服务占用");
 if(existing?.hasKey&&existing.keyVersion)return;
 if(!channel.apiKey.trim())throw Error("本地后端未配置此模型渠道的加密密钥");
 await ensureSqliteModelChannel(channel,provider,api);
}
/** Ordinary editor save is not an explicit key rotation. If the browser key
 * is unchanged and this channel already has a live encrypted version, reuse
 * it. Explicit migration/changed keys still require version-fenced rotation.
 */
export async function saveSqliteModelChannelFromEditor(channel:ModelChannel,
 previous:ModelChannel|null,provider:SqliteModelProvider,
 api:typeof canvasApi=canvasApi):Promise<ModelChannel>{
 if(provider==="openai_compatible")normalizeCompatBaseUrl(channel.baseUrl);
 if(previous?.id===channel.id&&previous.apiKey===channel.apiKey&&
  previous.baseUrl===channel.baseUrl&&previous.apiFormat===channel.apiFormat&&
  channel.apiKey.trim()){
  const id=encodeURIComponent(channel.id);
  let record:VaultChannelView|null=null;
  try{record=await api<VaultChannelView>("/api/v1/channels/"+id)}
  catch(error){
   if(!(error instanceof CanvasApiError&&error.status===404))throw error;
  }
  if(record){
   if(record.provider!==provider)throw Error("vault_channel_provider_mismatch");
   if(record.hasKey&&record.keyVersion)return {...channel,apiKey:""};
  }
 }
 return ensureSqliteModelChannel(channel,provider,api);
}
