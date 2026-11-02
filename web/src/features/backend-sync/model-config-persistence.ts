import type {AiConfig} from "@/stores/use-config-store";
import type {PersistStorage} from "zustand/middleware";
import {PERF_MODE} from "@/lib/perf-mode";
import {publicModelConfig,readUiSetting,saveUiSetting} from "./ui-settings-client";

type Stored={config:AiConfig};
let revision:number|null=null,committed="",blocked=false,lastError:unknown;
let queue:Promise<void>=Promise.resolve();

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
    const remoteChannels=Array.isArray(remote.value.channels)?remote.value.channels:defaults.channels;
    const config={...defaults,...remote.value,
     channels:remoteChannels.map(channel=>({
      ...channel,apiKey:"",
      models:channel.models.map(({script:_script,...model})=>model)
     }))};
    // Secrets and custom executable model scripts are held only in the live
    // Zustand state. The backend settings document accepts allowlisted UI data.
    return {state:{config} as T,version:0};
   }catch(error){blocked=true;lastError=error;throw error}
  },
  setItem(_name,value){
   const current=value.state.config;
   if(PERF_MODE)return Promise.resolve();
   const save=queue.then(async()=>{
    if(blocked||revision===null)throw Error("model_config_reload_required");
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
