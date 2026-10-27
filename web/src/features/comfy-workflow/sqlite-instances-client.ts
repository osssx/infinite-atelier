import {canvasApi,CanvasApiError} from "@/features/backend-sync/canvas-api";
import type {ComfyInstance} from "./run-types";

function explain(error:unknown):never{
 if(error instanceof CanvasApiError){
  const messages:Record<string,string>={
   comfy_instance_has_pending_jobs:"该实例仍有未完成或提交状态不明的 SQLite 任务，请先处理任务后再修改或删除。",
   comfy_instance_conflict:"实例名称已存在，请换一个名称。",
   comfy_instance_limit_reached:"最多只能配置 16 个 ComfyUI 实例。",
   comfy_instance_must_be_exact_loopback_origin:"仅允许 127.0.0.1 或 [::1] 的 HTTP 完整端口地址。",
   invalid_comfy_instance:"实例名称仅允许英文、数字、下划线和短横线，最长 64 字符。",
   invalid_comfy_instance_url:"ComfyUI 地址不正确。",
   backend_unavailable:"SQLite 后端不可用，请在 web 目录运行 npm run dev。",
  };
  throw new Error(messages[error.code]??"ComfyUI 实例配置失败："+error.code);
 }
 throw error;
}
export async function listSqliteComfyInstances():Promise<ComfyInstance[]>{
 try{
  const data=await canvasApi<{instances:ComfyInstance[]}>("/api/v1/comfy/instances");
  if(!Array.isArray(data.instances))throw Error("SQLite ComfyUI 实例列表响应无效");
  return data.instances;
 }catch(error){return explain(error)}
}
export async function saveSqliteComfyInstance(id:string,url:string,oldId?:string){
 try{
  const result=await canvasApi<{instance:{id:string;url:string}}>(
   oldId?"/api/v1/comfy/instances/"+encodeURIComponent(oldId):"/api/v1/comfy/instances",
   oldId?"PUT":"POST",{id,url}
  );
  window.dispatchEvent(new Event("atelier:comfy-instances-changed"));
  return result;
 }catch(error){return explain(error)}
}
export async function deleteSqliteComfyInstance(id:string){
 try{
  const result=await canvasApi<{deleted:string}>("/api/v1/comfy/instances/"+encodeURIComponent(id),"DELETE");
  window.dispatchEvent(new Event("atelier:comfy-instances-changed"));
  return result;
 }catch(error){return explain(error)}
}
