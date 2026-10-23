import localforage from "localforage";
import {getComfyTemplate, listComfyTemplates} from "./template-registry";

export type ComfyPreset = {id:string;name:string;templateId:string;revision:string};
const db=localforage.createInstance({name:"infinite-canvas",storeName:"comfy_presets"});
const prefix="preset:";
export async function listComfyPresets():Promise<ComfyPreset[]> {
    const explicit:ComfyPreset[]=[];
    await db.iterate<ComfyPreset,void>((value,key)=>{if(key.startsWith(prefix)&&value)explicit.push(value);});
    // Existing immutable templates stay discoverable without pretending that demo presets exist.
    const all=await listComfyTemplates();
    const hidden=new Set<string>();
    await db.iterate<boolean,void>((value,key)=>{if(key.startsWith("hidden:") && value)hidden.add(key.slice(7));});
    const known=new Set([...explicit.map(p=>p.templateId),...hidden]);
    const newest=new Map<string,(typeof all)[number]>();
    for(const t of all)if(!known.has(t.id))newest.set(t.id,t);
    return [...explicit,...[...newest.values()].map(t=>({id:t.id,name:t.name,templateId:t.id,revision:t.revision}))]
        .sort((a,b)=>a.name.localeCompare(b.name));
}
export async function saveComfyPreset(preset:ComfyPreset) {
    if(!/^[\w:-]{1,128}$/.test(preset.id)||!preset.name.trim()||preset.name.length>160)
        throw new Error("预设名称或 ID 不合法");
    if(!await getComfyTemplate(preset.templateId,preset.revision))
        throw new Error("预设引用的模板版本不存在");
    await db.setItem(prefix+preset.id,structuredClone(preset));
    await db.removeItem("hidden:"+preset.id);
    await db.removeItem("hidden:"+preset.templateId);
}
export async function deleteComfyPreset(id:string) {
    // A deleted alias does not delete content-addressed template versions referenced by nodes.
    const existing=await db.getItem<ComfyPreset>(prefix+id);
    await db.setItem("hidden:"+(existing?.templateId||id),true);
    await db.removeItem(prefix+id);
}
