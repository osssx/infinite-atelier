import {canvasApi} from "@/features/backend-sync/canvas-api";
import {getComfyTemplate} from "./template-registry";
export type ComfyPreset={id:string;name:string;templateId:string;revision:string};
const root="/api/v1/comfy/presets";
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
export async function upsertComfyPresetForTemplate(template:{id:string;name:string;revision:string}):Promise<ComfyPreset>{
 const current=(await listComfyPresets()).find(p=>p.templateId===template.id);
 const next={id:current?.id??template.id,name:current?.name??template.name,templateId:template.id,revision:template.revision};
 await saveComfyPreset(next);return next;
}
export async function deleteComfyPreset(id:string){
 await canvasApi(root+"/"+encodeURIComponent(id),"DELETE");
}
