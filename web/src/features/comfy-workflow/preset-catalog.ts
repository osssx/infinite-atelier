import { listComfyPresets, type ComfyPreset } from "./preset-registry";
import { getComfyTemplate } from "./template-registry";
import type { ComfyWorkflowTemplate } from "./template-schema";

/** User-owned catalog entries only. Legacy builtin rows are shown as imports. */
export type ComfyCatalogPreset = ComfyPreset & {
    mediaType?:"image"|"video"|"audio"|"other";
    mediaWorkflowEligible?:boolean;
    status?:"available"|"missing";
};
export type ComfyCatalogLoadFailure={presetId:string;name:string;message:string};

export async function loadComfyPresetCatalogTemplates(
    items:readonly ComfyCatalogPreset[],
    resolve:(item:ComfyCatalogPreset)=>Promise<ComfyWorkflowTemplate|null>,
):Promise<{templates:Record<string,ComfyWorkflowTemplate>;failures:ComfyCatalogLoadFailure[]}> {
    const results=await Promise.all(items.map(async item=>{
        try{return {item,template:await resolve(item)};}
        catch(error){return {item,error};}
    }));
    const templates:Record<string,ComfyWorkflowTemplate>={};
    const failures:ComfyCatalogLoadFailure[]=[];
    for(const result of results){
        if("error" in result){
            failures.push({presetId:result.item.id,name:result.item.name,
                message:result.error instanceof Error?result.error.message:String(result.error)});
            continue;
        }
        if(result.template)templates[result.item.templateId+"@"+result.item.revision]=result.template;
        else failures.push({presetId:result.item.id,name:result.item.name,message:"模板版本不存在"});
    }
    return {templates,failures};
}

export async function listComfyPresetCatalog():Promise<ComfyCatalogPreset[]> {
    const managed=await listComfyPresets();
    const entries=managed.map(preset=>({...preset,source:preset.source==="builtin"?"import" as const:preset.source}));
    return Promise.all(entries.map(async preset=>{
        try{
            const template=await getComfyTemplate(preset.templateId,preset.revision);
            const output=template?.ports.find(port=>port.direction==="source")?.valueKind;
            const mediaType=template?.mediaUseCase?.channel??(output==="VIDEO"?"video":output==="AUDIO"?"audio":output==="IMAGE"?"image":"other");
            const mediaWorkflowEligible=Boolean(template?.mediaUseCase&&["image","video","audio"].includes(template.mediaUseCase.channel));
            return {...preset,mediaType,mediaWorkflowEligible,status:template?"available" as const:"missing" as const};
        }catch{return {...preset,mediaType:"other" as const,mediaWorkflowEligible:false,status:"missing" as const};}
    }));
}
