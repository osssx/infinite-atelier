import {canvasApi,CanvasApiError} from "@/features/backend-sync/canvas-api";
import type {ComfyObjectInfo} from "./template-schema";

const TTL_MS=5*60*1000;
const MAX_CACHE_ENTRIES=4;
type CacheEntry={info:ComfyObjectInfo;storedAt:number};
const cache=new Map<string,CacheEntry>();
const pending=new Map<string,Promise<ComfyObjectInfo>>();
const epochs=new Map<string,number>();

/** The backend owns the Comfy instance URL and proxies /object_info.
 * Do not fetch user-configured origins from the browser.
 */
export async function loadComfyObjectInfo(instanceId:string,force=false):Promise<ComfyObjectInfo>{
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(instanceId))throw Error("请先在 ComfyUI 设置中选择有效实例");
 if(force)invalidateComfyObjectInfo(instanceId);
 const cached=cache.get(instanceId);
 if(cached&&Date.now()-cached.storedAt<TTL_MS)return cached.info;
 if(cached)cache.delete(instanceId);
 const existing=pending.get(instanceId);
 if(existing)return existing;
 const generation=epochs.get(instanceId)??0;
 const request=canvasApi<{instanceId:string;objectInfo:ComfyObjectInfo}>(
  "/api/v1/comfy/instances/"+encodeURIComponent(instanceId)+"/object-info"
 ).then(result=>{
  if(result.instanceId!==instanceId||!result.objectInfo||typeof result.objectInfo!=="object"||
      Array.isArray(result.objectInfo))throw Error("ComfyUI 节点定义响应无效");
  if((epochs.get(instanceId)??0)===generation){
   cache.delete(instanceId);
   cache.set(instanceId,{info:result.objectInfo,storedAt:Date.now()});
   while(cache.size>MAX_CACHE_ENTRIES)cache.delete(cache.keys().next().value!);
  }
  return result.objectInfo;
 }).catch(error=>{
  if(error instanceof CanvasApiError){
   if(error.code==="comfy_instance_not_found")throw Error("ComfyUI 实例不存在，请重新选择实例");
   if(error.code==="backend_unavailable")throw Error("本地后端不可用，无法同步 ComfyUI 节点定义");
  }
  throw error;
 }).finally(()=>{if(pending.get(instanceId)===request)pending.delete(instanceId)});
 pending.set(instanceId,request);
 return request;
}

export function invalidateComfyObjectInfo(instanceId?:string):void{
 const keys=instanceId?[instanceId]:[...new Set([...cache.keys(),...pending.keys(),...epochs.keys()])];
 for(const key of keys){
  epochs.set(key,(epochs.get(key)??0)+1);
  cache.delete(key);
  pending.delete(key);
 }
}
