import {createHash} from "node:crypto";
import {writeTransaction,assertNoRawCredentials} from "./repository.mjs";

const idRe=/^[A-Za-z0-9_:.-]{1,128}$/, shaRe=/^[a-f0-9]{64}$/;
const error=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const object=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(object(value)){
  const out={};
  for(const key of Object.keys(value).sort()){
   if(["__proto__","constructor","prototype"].includes(key))throw error("comfy_template_invalid");
   out[key]=canonical(value[key]);
  }
  return out;
 }
 if(!["string","number","boolean"].includes(typeof value)&&value!==null||
    typeof value==="number"&&!Number.isFinite(value))throw error("comfy_template_invalid");
 return value;
}
const stable=v=>JSON.stringify(canonical(v));
export function validateComfyTemplate(template){
 if(!object(template)||!idRe.test(template.id)||!shaRe.test(template.revision)||
    !object(template.apiGraph)||!Array.isArray(template.ports)||!object(template.requirements)||
    typeof template.name!=="string"||!template.name.trim()||template.name.length>160||
    Object.keys(template.apiGraph).length<1||Object.keys(template.apiGraph).length>500||
    template.ports.length>64||!Array.isArray(template.requirements.classTypes))
  throw error("comfy_template_invalid");
 if(Object.keys(template).some(k=>!["id","revision","name","apiGraph","ports","requirements"].includes(k)))
  throw error("comfy_template_invalid");
 const payload={name:template.name,apiGraph:template.apiGraph,ports:template.ports,requirements:template.requirements};
 assertNoRawCredentials(payload);
 const json=stable(payload);
 if(Buffer.byteLength(json)>2_000_000)throw error("comfy_template_too_large",413);
 const digest=createHash("sha256").update(json).digest("hex");
 if(digest!==template.revision)throw error("comfy_template_revision_mismatch",409);
 // Defense in depth: verify basic graph and port topology even when the client
 // has already run the full ComfyUI schema validator.
 const graph=template.apiGraph;
 const nodeIds=Object.keys(graph);
 if(nodeIds.some(k=>!idRe.test(k)||!object(graph[k])||
    !idRe.test(graph[k].class_type)||!object(graph[k].inputs))||
    !template.ports.some(port=>port?.direction==="source"))
  throw error("comfy_template_invalid");
 const classTypes=[...new Set(nodeIds.map(k=>graph[k].class_type))].sort();
 if(stable(classTypes)!==stable(template.requirements.classTypes))
  throw error("comfy_template_invalid");
 const ports=new Set();
 for(const port of template.ports){
  if(!object(port)||!idRe.test(port.id)||ports.has(port.id)||
      !["source","target"].includes(port.direction)||typeof port.label!=="string"||
      port.label.length>90)throw error("comfy_template_invalid");
  ports.add(port.id);
  if(port.direction==="source"&&(!object(port.outputBinding)||
     !Object.hasOwn(graph,port.outputBinding.nodeId)||
     !Number.isInteger(port.outputBinding.outputIndex)||port.outputBinding.outputIndex<0))
   throw error("comfy_template_invalid");
 }
 return {id:template.id,revision:template.revision,...JSON.parse(json)};
}
export function createComfyRegistry(db){
 if(!db)throw Error("comfy_registry_database_required");
 const find=(id,revision)=>{
  const row=db.prepare("SELECT payload_json FROM comfy_template_versions WHERE template_id=? AND revision=?").get(id,revision);
  return row?JSON.parse(row.payload_json):null;
 };
 function listTemplates(){
  return db.prepare("SELECT payload_json FROM comfy_template_versions ORDER BY template_id,revision")
   .all().map(x=>JSON.parse(x.payload_json));
 }
 function installMany(input){
  if(!Array.isArray(input)||input.length>128)throw error("comfy_template_invalid");
  const templates=input.map(validateComfyTemplate);
  return writeTransaction(db,()=>{
   const result=[];
   for(const template of templates){
    const content=stable(template);
    const existing=db.prepare("SELECT payload_json FROM comfy_template_versions WHERE template_id=? AND revision=?")
     .get(template.id,template.revision);
    if(existing&&stable(JSON.parse(existing.payload_json))!==content)
     throw error("comfy_template_immutable_conflict",409);
    if(!existing)db.prepare("INSERT INTO comfy_template_versions(template_id,revision,payload_json,created_at) VALUES(?,?,?,?)")
     .run(template.id,template.revision,content,Date.now());
    result.push({id:template.id,revision:template.revision,status:existing?"existing":"installed"});
   }
   return result;
  });
 }
 function deleteTemplate(id,revision){
  if(!idRe.test(id)||!shaRe.test(revision))throw error("comfy_template_invalid");
  return writeTransaction(db,()=>{
   if(!find(id,revision))throw error("comfy_template_not_found",404);
   if(db.prepare("SELECT id FROM comfy_presets WHERE template_id=? AND revision=? LIMIT 1")
     .get(id,revision))throw error("comfy_template_in_use",409);
   const projects=db.prepare("SELECT document_json FROM projects WHERE deleted_at IS NULL").all();
   if(projects.some(({document_json})=>JSON.parse(document_json).nodes?.some(node=>
      node.metadata?.comfyWorkflow?.templateId===id&&
      node.metadata?.comfyWorkflow?.templateRevision===revision)))
    throw error("comfy_template_in_use",409);
   db.prepare("DELETE FROM comfy_template_versions WHERE template_id=? AND revision=?").run(id,revision);
   return {deleted:true};
  });
 }
 function listPresets(){
  return db.prepare("SELECT id,name,template_id,revision FROM comfy_presets ORDER BY name,id")
   .all().map(row=>({id:row.id,name:row.name,templateId:row.template_id,revision:row.revision}));
 }
 function savePreset(preset){
  if(!object(preset)||Object.keys(preset).some(k=>!["id","name","templateId","revision"].includes(k))||
    !idRe.test(preset.id)||!idRe.test(preset.templateId)||
    !shaRe.test(preset.revision)||typeof preset.name!=="string"||
    !preset.name.trim()||preset.name.length>160)throw error("comfy_preset_invalid");
  if(!find(preset.templateId,preset.revision))throw error("comfy_template_not_found",404);
  db.prepare("INSERT INTO comfy_presets(id,name,template_id,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,template_id=excluded.template_id,revision=excluded.revision,updated_at=excluded.updated_at")
    .run(preset.id,preset.name,preset.templateId,preset.revision,Date.now());
  return preset;
 }
 function deletePreset(id){
  if(!idRe.test(id))throw error("comfy_preset_invalid");
  if(!db.prepare("DELETE FROM comfy_presets WHERE id=?").run(id).changes)
   throw error("comfy_preset_not_found",404);
  return {deleted:true};
 }
 return {find,listTemplates,installMany,deleteTemplate,listPresets,savePreset,deletePreset};
}