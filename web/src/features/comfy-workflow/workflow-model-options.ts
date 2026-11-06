import {listComfyPresetCatalog} from "./preset-catalog";
import type {ComfyWorkflowCapability} from "@/stores/use-config-store";

export type WorkflowModelOption={value:string;label:string;disabled?:boolean;templateId:string;templateRevision:string};
export const workflowModelValue=(templateId:string,revision:string)=>templateId+"@"+revision;
export async function listComfyWorkflowModelOptionsByCapability():Promise<Record<ComfyWorkflowCapability,WorkflowModelOption[]>>{
 const presets=await listComfyPresetCatalog();
 const result:Record<ComfyWorkflowCapability,WorkflowModelOption[]>={image:[],video:[],audio:[]};
 for(const capability of ["image","video","audio"] as const)result[capability]=presets.filter(item=>item.mediaWorkflowEligible&&item.mediaType===capability).map(item=>({
   value:workflowModelValue(item.templateId,item.revision),
   label:item.status==="missing"?`${item.name} · 模板不可用`:`${item.name} · ComfyUI`,
   ...(item.status==="missing"?{disabled:true}:{}),templateId:item.templateId,templateRevision:item.revision,
  }));
 return result;
}
