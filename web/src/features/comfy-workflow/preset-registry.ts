import localforage from "localforage";
import {getComfyTemplate} from "./template-registry";

export type ComfyPreset = {id:string;name:string;templateId:string;revision:string};
const db=localforage.createInstance({name:"infinite-canvas",storeName:"comfy_presets"});
const prefix="preset:";
export async function listComfyPresets():Promise<ComfyPreset[]> {
    const explicit:ComfyPreset[]=[];
    await db.iterate<ComfyPreset,void>((value,key)=>{if(key.startsWith(prefix)&&value)explicit.push(value);});
    // Historical immutable template versions are not selectable presets.
    return explicit.sort((a,b)=>a.name.localeCompare(b.name));
}
export async function saveComfyPreset(preset:ComfyPreset) {
    if(!/^[\w:-]{1,128}$/.test(preset.id)||!preset.name.trim()||preset.name.length>160)
        throw new Error("预设名称或 ID 不合法");
    if(!await getComfyTemplate(preset.templateId,preset.revision))
        throw new Error("预设引用的模板版本不存在");
    await db.setItem(prefix+preset.id,structuredClone(preset));
}
/** Update the managed preset pointer instead of accumulating historical versions. */
export async function upsertComfyPresetForTemplate(template:{id:string;name:string;revision:string}):Promise<ComfyPreset> {
    const current=(await listComfyPresets()).find(p=>p.templateId===template.id);
    const next={id:current?.id??template.id,name:current?.name??template.name,templateId:template.id,revision:template.revision};
    await saveComfyPreset(next);
    return next;
}
export async function deleteComfyPreset(id:string) {
    // Removing an alias never deletes immutable template versions still used by canvases.
    await db.removeItem(prefix+id);
}
