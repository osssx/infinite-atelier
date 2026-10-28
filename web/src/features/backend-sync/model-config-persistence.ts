import type {AiConfig} from "@/stores/use-config-store";
import type {ModelChannel} from "@/stores/use-config-store";
import {modelChannelProvider} from "./model-channel-autoroute";
import type {PersistStorage} from "zustand/middleware";
import {PERF_MODE} from "@/lib/perf-mode";
import {publicModelConfig,readUiSetting,saveUiSetting} from "./ui-settings-client";

const LEGACY_KEY="infinite-canvas:ai_config_store";
const CREDENTIALS_KEY="atelier:local-credentials"; // transitional browser-only; NOT encrypted
type Stored={config:AiConfig};
type ChannelCredentials={baseUrl:string;apiFormat:string;apiKey:string;scripts:Record<string,string>};
type Credentials={apiKey:string;baseUrl:string;channels:Record<string,ChannelCredentials>};
let revision:number|null=null,committed="",blocked=false,lastError:unknown;
let queue:Promise<void>=Promise.resolve();
function localGet(key:string){
 if(PERF_MODE||typeof window==="undefined")return null;
 try{return window.localStorage.getItem(key)}catch{return null}
}
function parse(value:string|null){
 try{return value?JSON.parse(value) as unknown:null}catch{return null}
}

// Read-only compatibility: existing markers may have been written by earlier
// versions. Honor them so stale browser copies cannot resurrect vaulted keys.
// The interactive migration feature and marker-writing logic have been removed.
const VAULT_MARKERS_KEY="atelier:vaulted-model-channels";
/** Only channels whose every selected model is handled by the backend may
 * discard their browser API Key. Mixed video/JS/Gemini channels retain it.
 */
export function isVaultOnlyChannel(channel:ModelChannel):boolean{
 const provider=modelChannelProvider(channel);
 if(!provider||!channel.models.length)return false;
 return channel.models.every(model=>!model.script?.trim()&&(
  provider==="volcengine_ark"?model.capability==="video":model.capability!=="video"));
}
/** Called only after an encrypted channel key was confirmed by the backend.
 * Preserve unrelated browser settings, custom scripts and other channels.
 * This is not a user-data migration; it only redacts verified duplicate keys.
 */
export function redactConfirmedVaultKey(channel:ModelChannel):boolean{
 if(!isVaultOnlyChannel(channel))return false;
 if(PERF_MODE||typeof window==="undefined")return false;
 const storage=window.localStorage;
 const markers=vaultMarkers();
 const scrub=(key:string,legacy=false)=>{
  const raw=storage.getItem(key);
  if(!raw)return;
  const parsed=parse(raw);
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return;
  const record=parsed as Record<string,unknown>;
  const state=legacy?(record.state as Record<string,unknown>|undefined):undefined;
  const config=legacy?(state?.config as Record<string,unknown>|undefined):record;
  if(!config||typeof config!=="object")return;
  const selected=legacy?Array.isArray(config.channels)?
    (config.channels as Array<Record<string,unknown>>).find(item=>
      item?.id===channel.id&&item.baseUrl===channel.baseUrl&&item.apiFormat===channel.apiFormat):null:
    ((config.channels as Record<string,Record<string,unknown>>|undefined)?.[channel.id]);
  if(!selected||selected.baseUrl!==channel.baseUrl||
     selected.apiFormat!==channel.apiFormat)return;
  const oldKey=typeof selected.apiKey==="string"?selected.apiKey:"";
  const nextChannels=legacy?(config.channels as Array<Record<string,unknown>>).map(item=>
      item===selected?{...item,apiKey:""}:item):
    {...config.channels as Record<string,unknown>,[channel.id]:{...selected,apiKey:""}};
  const nextConfig={...config,channels:nextChannels,
   ...(oldKey&&config.baseUrl===channel.baseUrl&&config.apiKey===oldKey?{apiKey:""}:{})};
  storage.setItem(key,JSON.stringify(legacy?{...record,state:{...state,config:nextConfig}}:nextConfig));
 }; scrub(CREDENTIALS_KEY);
 scrub(LEGACY_KEY,true);
 // Mark redaction complete only after both stores were updated successfully.
 storage.setItem(VAULT_MARKERS_KEY,JSON.stringify({
  ...markers,[channel.id]:{id:channel.id,baseUrl:channel.baseUrl,apiFormat:channel.apiFormat}
 }));
 return true;
}
type VaultedChannelBinding={id:string;baseUrl:string;apiFormat:string};
function vaultMarkers():Record<string,VaultedChannelBinding>{
 const value=parse(localGet(VAULT_MARKERS_KEY));
 if(!value||typeof value!=="object"||Array.isArray(value))return {};
 const found:Record<string,VaultedChannelBinding>={};
 for(const [id,row] of Object.entries(value)){
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||!row||typeof row!=="object")continue;
  const x=row as VaultedChannelBinding;
  if(x.id===id&&typeof x.baseUrl==="string"&&typeof x.apiFormat==="string")
   found[id]={id,baseUrl:x.baseUrl,apiFormat:x.apiFormat};
 }
 return found;
}
function isVaulted(id:string,baseUrl:string,apiFormat:string){
 const marker=vaultMarkers()[id];
 return marker?.baseUrl===baseUrl&&marker?.apiFormat===apiFormat;
}
function scrubCredentialObject(record:Credentials){
 const markers=vaultMarkers();
 const channels=Object.fromEntries(Object.entries(record.channels||{}).map(([id,c])=>{
  const marker=markers[id];
  const clean=marker?.baseUrl===c.baseUrl&&marker?.apiFormat===c.apiFormat;
  return [id,clean?{...c,apiKey:""}:c];
 }));
 const rootUsed=Object.entries(record.channels||{}).some(([id,c])=>
  markers[id]?.baseUrl===record.baseUrl&&markers[id]?.baseUrl===c.baseUrl&&
  markers[id]?.apiFormat===c.apiFormat&&Boolean(c.apiKey)&&c.apiKey===record.apiKey);
 return {...record,channels,apiKey:rootUsed?"":record.apiKey};
}
function safeCredentials(c:AiConfig):Credentials{
 return scrubCredentialObject({apiKey:c.apiKey||"",baseUrl:c.baseUrl,
 channels:Object.fromEntries(c.channels.map(ch=>[ch.id,{
  baseUrl:ch.baseUrl,apiFormat:ch.apiFormat,apiKey:ch.apiKey||"",
  scripts:Object.fromEntries(ch.models.filter(m=>m.script).map(m=>[m.name,m.script!]))
 }]))});
}
function legacyConfig():AiConfig|null{
 const legacy=parse(localGet(LEGACY_KEY));
 const state=legacy&&typeof legacy==="object"&&"state" in legacy?legacy.state:null;
 const config=state&&typeof state==="object"&&"config" in state?state.config:null;
 return config&&typeof config==="object"&&Array.isArray((config as AiConfig).channels)?config as AiConfig:null;
}
function credentials():Credentials{
 const local=parse(localGet(CREDENTIALS_KEY));
 if(local&&typeof local==="object"&&"channels" in local&&"baseUrl" in local)
  return scrubCredentialObject(local as Credentials);
 const legacy=legacyConfig();
 return legacy?safeCredentials(legacy):{apiKey:"",baseUrl:"",channels:{}};
}
function withBrowserSecrets(config:AiConfig,hasRemoteProfile:boolean):AiConfig{
 if(!hasRemoteProfile)return config; // Never pair an old API key with default endpoint.
 const creds=credentials();
 return {...config,apiKey:creds.baseUrl===config.baseUrl?(creds.apiKey||""):"",
  channels:config.channels.map(ch=>{
   const candidate=creds.channels[ch.id];
   const matches=candidate?.baseUrl===ch.baseUrl&&candidate?.apiFormat===ch.apiFormat;
   const allowKey=matches&&!isVaulted(ch.id,ch.baseUrl,ch.apiFormat);
   return {...ch,apiKey:allowKey?(candidate.apiKey||""):"",
    models:ch.models.map(model=>({...model,
     ...(matches&&candidate.scripts?.[model.name]?{script:candidate.scripts[model.name]}:{})}))};
  })};
}
function saveLocalSecrets(config:AiConfig){
 if(PERF_MODE||typeof window==="undefined")return;
 const raw=JSON.stringify(safeCredentials(config));
 try{window.localStorage.setItem(CREDENTIALS_KEY,raw)}
 catch{throw Error("model_credentials_browser_storage_unavailable")}
}
export async function awaitModelConfigPersistence(){
 await queue;
 if(lastError)throw lastError;
}
export function createModelConfigStorage<T extends Stored>(defaults:AiConfig):PersistStorage<T>{
 return {
  async getItem(){
   if(PERF_MODE)return {state:{config:defaults} as T,version:0};
   try{
   const remote=await readUiSetting<Partial<AiConfig>>("model_config");
   if(!Number.isSafeInteger(remote.revision)||!remote.value||typeof remote.value!=="object"||
    Array.isArray(remote.value))throw Error("model_config_invalid_response");
   revision=remote.revision;
   committed=JSON.stringify(remote.value);
   blocked=false;lastError=null;
   const base={...defaults,...remote.value,
    channels:Array.isArray(remote.value.channels)?remote.value.channels:defaults.channels};
   return {state:{config:withBrowserSecrets(base,Object.keys(remote.value).length>0)} as T,version:0};
   }catch(error){blocked=true;lastError=error;throw error}
  },
  setItem(_name,value){
   const current=value.state.config;
   if(PERF_MODE)return Promise.resolve();
   const save=queue.then(async()=>{
    if(blocked||revision===null)throw Error("model_config_reload_required");
    // Browser-only credentials remain separate from non-secret SQLite settings.
    // Existing custom/browser-direct API calls still require local credentials.
    saveLocalSecrets(current);
    const sanitized=publicModelConfig(current),snapshot=JSON.stringify(sanitized);
    if(snapshot!==committed){
     try{
      const result=await saveUiSetting("model_config",revision,sanitized);
      if(result.revision!==revision+1)throw Error("model_config_invalid_response");
      revision=result.revision;committed=snapshot;
     }catch(error){
      const status=(error as {status?:number})?.status;
      // User typing a temporarily invalid field can correct it in the next
      // write. Stale revisions and network-unknown outcomes remain blocked.
      if(status!==400&&status!==413&&status!==422)blocked=true;
      throw error;
     }
    }
    lastError=null;
   }).catch(error=>{lastError=error;throw error});
   queue=save.catch(()=>{});
   return save;
  },
  async removeItem(){throw Error("model_config_remove_forbidden")}
 } as PersistStorage<T>;
}
