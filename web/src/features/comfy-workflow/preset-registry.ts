import {canvasApi} from "@/features/backend-sync/canvas-api";
import {getComfyTemplate} from "./template-registry";
import {canonicalComfyJson,comfySha256,verifyComfyTemplate,type ComfyWorkflowTemplate} from "./template-schema";
export type ComfyPreset={id:string;name:string;workflowId?:string;templateId:string;revision:string;source?:"user"|"builtin"|"import";kind?:"base"|"variant";parentId?:string};
const root="/api/v1/comfy/presets";
export async function renameComfyTemplate(id:string,name:string){
 if(!/^[\w:.-]{1,128}$/.test(id)||!name.trim()||name.length>160)throw Error("模板名称或 ID 不合法");
 await canvasApi("/api/v1/comfy/templates/"+encodeURIComponent(id)+"/name","PUT",{name:name.trim()});
}
export async function listComfyPresets():Promise<ComfyPreset[]>{
 const {presets}=await canvasApi<{presets:ComfyPreset[]}>(root);
 if(!Array.isArray(presets))throw Error("comfy_presets_invalid_response");
 return presets.sort((a,b)=>a.name.localeCompare(b.name));
}
export async function saveComfyPreset(preset:ComfyPreset){
 if(!/^[\w:.-]{1,128}$/.test(preset.id)||!preset.name.trim()||preset.name.length>160)
  throw Error("预设名称或 ID 不合法");
 if(!await getComfyTemplate(preset.templateId,preset.revision))
  throw Error("预设引用的模板版本不存在");
 await canvasApi(root+"/"+encodeURIComponent(preset.id),"PUT",preset);
}
export async function saveComfyPresetBinding(preset:ComfyPreset,template:ComfyWorkflowTemplate){
 if(!/^[\w:.-]{1,128}$/.test(preset.id)||!preset.name.trim()||preset.name.length>160)throw Error("预设名称或 ID 不合法");
 await verifyComfyTemplate(template);
 if(preset.templateId!==template.id||preset.revision!==template.revision)throw Error("预设绑定与工作流版本不匹配");
 const workflowId=preset.workflowId??template.id;
 const workflowHash=await comfySha256(canonicalComfyJson(template.apiGraph));
 const graphPath="/api/v1/comfy/workflows/"+encodeURIComponent(workflowId)+"/graphs/"+workflowHash;
 const available=await canvasApi<{available:boolean}>(graphPath);
 if(!available.available)await canvasApi("/api/v1/comfy/workflows/"+encodeURIComponent(workflowId)+"/graphs","POST",{graph:template.apiGraph});
 const {apiGraph,...binding}=template;
 await canvasApi(root+"/"+encodeURIComponent(preset.id)+"/bind","PUT",{preset:{...preset,workflowId},workflowHash,binding});
}
export async function upsertComfyPresetForTemplate(template:{id:string;name:string;revision:string}):Promise<ComfyPreset>{
 const current=(await listComfyPresets()).find(p=>p.templateId===template.id);
 const next:ComfyPreset={id:current?.id??template.id,name:current?.name??template.name,workflowId:current?.workflowId??template.id,
  templateId:template.id,revision:template.revision,source:current?.source??"user",kind:current?.kind??"base",
  ...(current?.parentId?{parentId:current.parentId}:{})};
 await saveComfyPreset(next);return next;
}
export async function deleteComfyPreset(id:string){
 await canvasApi(root+"/"+encodeURIComponent(id),"DELETE");
}
export async function listComfyWorkflowVersions(id:string){
 const {versions}=await canvasApi<{versions:ComfyVersion[]}>("/api/v1/comfy/workflows/"+encodeURIComponent(id)+"/versions");
 return versions;
}
export type ComfyVersion={revision:string;templateId:string;workflowId:string;workflowHash:string;createdAt:number;name:string;note:string;shortRevision:string;current:boolean;
 references:{count:number}};
export type ComfyVersionReferences={presets:{id:string;name:string;kind:string;parentId?:string}[];projectNodes:{projectId:string;projectName:string;nodeId:string;nodeTitle:string}[];tasks:{taskId:string}[];defaults:{model:string}[];count:number};
export async function getComfyVersionNote(templateId:string,revision:string){
 const {note}=await canvasApi<{note:string}>("/api/v1/comfy/templates/"+encodeURIComponent(templateId)+"/"+revision+"/note");return note;
}
export async function setComfyVersionNote(templateId:string,revision:string,note:string){
 return canvasApi("/api/v1/comfy/templates/"+encodeURIComponent(templateId)+"/"+revision+"/note","PUT",{note});
}
export async function restoreComfyPresetVersion(id:string,version:ComfyVersion,current:ComfyPreset){
 return canvasApi(root+"/"+encodeURIComponent(id)+"/restore","POST",{templateId:version.templateId,revision:version.revision,
  expectedTemplateId:current.templateId,expectedRevision:current.revision});
}
export async function deleteComfyVersions(versions:{templateId:string;revision:string}[]){
 return canvasApi("/api/v1/comfy/templates/delete-batch","POST",{versions});
}
export async function getComfyVersionReferences(templateId:string,revision:string){
 const {references}=await canvasApi<{references:ComfyVersionReferences}>("/api/v1/comfy/templates/"+encodeURIComponent(templateId)+"/"+revision+"/references");return references;
}
