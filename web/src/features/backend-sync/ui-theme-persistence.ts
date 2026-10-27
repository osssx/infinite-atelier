import type {PersistStorage} from "zustand/middleware";
import {PERF_MODE} from "@/lib/perf-mode";
import {readUiSetting,saveUiSetting} from "./ui-settings-client";

type Theme="light"|"dark";
type Stored={theme:Theme};
let revision:number|null=null,lastValue:Theme="dark",blocked=false,lastError:unknown;
let queue:Promise<void>=Promise.resolve();
export async function awaitThemePersistence(){await queue;if(lastError)throw lastError}
export function createThemeStorage<T extends Stored>():PersistStorage<T>{
 return {
  async getItem(){
   if(PERF_MODE)return {state:{theme:"dark"} as T,version:0};
   try{
   const remote=await readUiSetting<Theme>("theme");
   if(remote.value!=="light"&&remote.value!=="dark")throw Error("theme_invalid_response");
   revision=remote.revision;lastValue=remote.value;blocked=false;lastError=null;
   return {state:{theme:remote.value} as T,version:0};
   }catch(error){blocked=true;lastError=error;throw error}
  },
  setItem(_name,value){
   if(PERF_MODE)return Promise.resolve();
   const next=value.state.theme;
   const save=queue.then(async()=>{
    if(blocked||revision===null)throw Error("theme_reload_required");
    if(next!==lastValue){
     try{
      const result=await saveUiSetting("theme",revision,next);
      if(result.revision!==revision+1)throw Error("theme_invalid_response");
      revision=result.revision;lastValue=next;
     }catch(error){blocked=true;throw error}
    }
    lastError=null;
   }).catch(error=>{lastError=error;throw error});
   queue=save.catch(()=>{});
   return save;
  },
  async removeItem(){throw Error("theme_removal_forbidden")}
 } as PersistStorage<T>;
}
