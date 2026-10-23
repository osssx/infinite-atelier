import { krea2TurboBundledTemplate, KREA2_TURBO_TEMPLATE_ID } from "./krea2-turbo-preset";
import { minimaxH3I2VBundledTemplate, MINIMAX_H3_I2V_TEMPLATE_ID } from "./minimax-h3-i2v-preset";
import { createComfyTemplate, type ComfyWorkflowTemplate } from "./template-schema";
import { installComfyTemplate } from "./template-registry";
import { listComfyPresets, saveComfyPreset, type ComfyPreset } from "./preset-registry";

/** Shared catalog for global settings and the canvas preset selector. */
export type ComfyCatalogPreset = ComfyPreset & {
    builtIn: boolean;
    modified: boolean;
    defaultRevision?: string;
    builtinId?: string;
};

const builtins=[
    {id:KREA2_TURBO_TEMPLATE_ID, payload:krea2TurboBundledTemplate},
    {id:MINIMAX_H3_I2V_TEMPLATE_ID, payload:minimaxH3I2VBundledTemplate},
] as const;

const bundledTemplates=new Map<string,Promise<ComfyWorkflowTemplate>>();
export function bundledComfyTemplate(id:string):Promise<ComfyWorkflowTemplate> {
    const descriptor=builtins.find(item=>item.id===id);
    if(!descriptor)throw new Error("未知的内置 ComfyUI 预设："+id);
    let cached=bundledTemplates.get(id);
    if(!cached){
        cached=createComfyTemplate(id,descriptor.payload());
        bundledTemplates.set(id,cached);
    }
    return cached;
}
export function bundledKrea2Template():Promise<ComfyWorkflowTemplate> {
    return bundledComfyTemplate(KREA2_TURBO_TEMPLATE_ID);
}
export async function installBundledComfyTemplate(id:string):Promise<ComfyWorkflowTemplate> {
    const template=await bundledComfyTemplate(id);
    await installComfyTemplate(template);
    return template;
}
export function installBundledKrea2Template():Promise<ComfyWorkflowTemplate> {
    return installBundledComfyTemplate(KREA2_TURBO_TEMPLATE_ID);
}

/** Visible defaults require no IndexedDB writes; edited versions replace the alias, not the history. */
export async function listComfyPresetCatalog():Promise<ComfyCatalogPreset[]> {
    const [managed,defaults]=await Promise.all([
        listComfyPresets(),Promise.all(builtins.map(item=>bundledComfyTemplate(item.id))),
    ]);
    const usedAliases=new Set<string>();
    const rows:ComfyCatalogPreset[]=defaults.map(template=>{
        const override=managed.find(p=>p.id===template.id && !usedAliases.has(p.id)) ??
            managed.find(p=>p.templateId===template.id && !usedAliases.has(p.id));
        if(override)usedAliases.add(override.id);
        return {
            id:override?.id??template.id,
            name:override?.name??template.name,
            templateId:override?.templateId??template.id,
            revision:override?.revision??template.revision,
            builtIn:true,
            builtinId:template.id,
            modified:Boolean(override&&(override.templateId!==template.id ||
                override.revision!==template.revision || override.name!==template.name)),
            defaultRevision:template.revision,
        };
    });
    const builtInIds=new Set<string>(builtins.map(item=>item.id));
    return [...rows,...managed.filter(p=>!usedAliases.has(p.id) && !builtInIds.has(p.templateId))
        .map(p=>({...p,builtIn:false,modified:false}))];
}

/** Re-point a single built-in alias without deleting old versions pinned to canvas nodes. */
export async function resetBundledComfyPreset(id:string=KREA2_TURBO_TEMPLATE_ID):Promise<ComfyPreset> {
    const [template,managed]=await Promise.all([installBundledComfyTemplate(id),listComfyPresets()]);
    const override=managed.find(p=>p.id===id)??managed.find(p=>p.templateId===id);
    const restored={id:override?.id??id,name:template.name,templateId:id,revision:template.revision};
    await saveComfyPreset(restored);
    return restored;
}
