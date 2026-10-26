import {canvasApi} from "@/features/backend-sync/canvas-api";
import {verifyComfyTemplate,type ComfyWorkflowTemplate} from "./template-schema";
import {type ComfyPreset,listComfyPresets,saveComfyPreset} from "./preset-registry";

type LegacySnapshot={templates:ComfyWorkflowTemplate[];presets:ComfyPreset[]};
const validId=/^[A-Za-z0-9_:.-]{1,128}$/;
/** Read old origin-local stores only after explicit user action. Never migrate
 * during bootstrap and never delete the original files on successful import. */
export async function readLegacyComfySnapshot():Promise<LegacySnapshot>{
 const {default:localforage}=await import("localforage");
 const templatesDb=localforage.createInstance({name:"infinite-canvas",storeName:"comfy_templates"});
 const presetsDb=localforage.createInstance({name:"infinite-canvas",storeName:"comfy_presets"});
 const templates:ComfyWorkflowTemplate[]=[],presets:ComfyPreset[]=[];
 await templatesDb.iterate<ComfyWorkflowTemplate,void>((value,key)=>{
  if(key.startsWith("v1:")&&value){
   if(key!=="v1:"+value.id+"@"+value.revision)throw Error("旧模板版本索引与内容不匹配");
   templates.push(value);
  }
 });
 await presetsDb.iterate<ComfyPreset,void>((value,key)=>{
  if(key.startsWith("preset:")&&value){
   if(key!=="preset:"+value.id||!validId.test(value.id))throw Error("旧预设 ID 无效");
   presets.push(value);
  }
 });
 if(templates.length>128||presets.length>128)throw Error("旧模板或预设数量超过单次导入限制");
 await Promise.all(templates.map(verifyComfyTemplate));
 return {templates,presets};
}
export async function importLegacyComfySnapshot(snapshot:LegacySnapshot){
 // No browser fallback: successful import writes only to the SQLite API.
 for(const template of snapshot.templates)await verifyComfyTemplate(template);
 const current=await listComfyPresets();
 for(const item of snapshot.presets){
  const found=current.find(x=>x.id===item.id);
  if(found&&JSON.stringify(found)!==JSON.stringify(item))
   throw Error("已有同名但不同版本的后端预设，请先手动处理冲突："+item.id);
 }
 const response=await canvasApi<{results:Array<{status:string}>}>(
  "/api/v1/comfy/templates/batch","POST",{templates:snapshot.templates});
 let saved=0;
 for(const preset of snapshot.presets){
  if(current.some(x=>x.id===preset.id))continue;
  await saveComfyPreset(preset);saved++;
 }
 return {templates:response.results.filter(x=>x.status==="installed").length,presets:saved};
}
