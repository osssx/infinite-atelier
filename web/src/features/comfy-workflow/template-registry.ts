import {canvasApi} from "@/features/backend-sync/canvas-api";
import {createComfyTemplate,verifyComfyTemplate,type ComfyObjectInfo,type ComfyTemplatePayload,type ComfyWorkflowTemplate} from "./template-schema";
const base="/api/v1/comfy/templates";
export const comfyTemplateStorageKey=(id:string,revision:string)=>"v1:"+id+"@"+revision;
export async function listComfyTemplates():Promise<ComfyWorkflowTemplate[]>{
 const {templates}=await canvasApi<{templates:ComfyWorkflowTemplate[]}>(base);
 if(!Array.isArray(templates))throw Error("comfy_templates_invalid_response");
 await Promise.all(templates.map(verifyComfyTemplate));return templates;
}
export async function getComfyTemplate(id:string,revision:string):Promise<ComfyWorkflowTemplate|null>{
 try{
  const {template}=await canvasApi<{template:ComfyWorkflowTemplate}>(base+"/"+encodeURIComponent(id)+"/"+encodeURIComponent(revision));
  await verifyComfyTemplate(template);return template;
 }catch(e){
  if(e&&typeof e==="object"&&"code" in e&&e.code==="comfy_template_not_found")return null;
  throw e;
 }
}
export async function installComfyTemplate(template:ComfyWorkflowTemplate):Promise<"installed"|"existing">{
 await verifyComfyTemplate(template);
 const result=await canvasApi<{status:"installed"|"existing"}>(base,"POST",{template});
 return result.status;
}
export async function saveComfyTemplateVersion(id:string,payload:ComfyTemplatePayload,info?:ComfyObjectInfo){
 const template=await createComfyTemplate(id,payload,info);
 await installComfyTemplate(template);return template;
}
export async function removeComfyTemplateVersion(id:string,revision:string){
 await canvasApi<{deleted:boolean}>(base+"/"+encodeURIComponent(id)+"/"+encodeURIComponent(revision),"DELETE");
}
