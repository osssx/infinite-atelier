import {createHash} from "node:crypto";
import {mkdirSync,writeFileSync,readFileSync,renameSync,openSync,fsyncSync,closeSync,existsSync,unlinkSync,mkdtempSync} from "node:fs";
import {join,dirname} from "node:path";
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {writeTransaction,assertNoRawCredentials} from "./repository.mjs";
import {verifyTemplate as verifyCompilerTemplate} from "../comfy-workflow/compiler.mjs";

const idRe=/^[A-Za-z0-9_:.-]{1,128}$/, shaRe=/^[a-f0-9]{64}$/;
const error=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const object=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const registryRoots=new WeakMap();
function graphBlobRefs(value){
 const found=new Set(),seen=new WeakSet(),hash=/[a-f0-9]{64}/g;
 const visit=item=>{if(typeof item==="string"){for(const match of item.matchAll(hash))found.add(match[0]);return;}
  if(!item||typeof item!=="object"||seen.has(item))return;seen.add(item);
  if(Array.isArray(item))for(const child of item)visit(child);else for(const child of Object.values(item))visit(child);
 };
 visit(value);return [...found].sort();
}
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
const sameTemplateContent=(a,b)=>{const strip=value=>{const copy={...value};delete copy.name;delete copy.revisionName;return copy;};return stable(strip(a))===stable(strip(b));};
export function validateComfyTemplate(template){
 if(!object(template)||!idRe.test(template.id)||!shaRe.test(template.revision)||
    !object(template.apiGraph)||!Array.isArray(template.ports)||!object(template.requirements)||
    typeof template.name!=="string"||!template.name.trim()||template.name.length>160||
    template.revisionName!==undefined&&(typeof template.revisionName!=="string"||!template.revisionName.trim()||template.revisionName.length>160)||
    Object.keys(template.apiGraph).length<1||Object.keys(template.apiGraph).length>500||
    template.ports.length>64||!Array.isArray(template.requirements.classTypes))
  throw error("comfy_template_invalid");
 if(Object.keys(template).some(k=>!["id","revision","name","revisionName","apiGraph","ports","requirements","previewBinding","mediaUseCase"].includes(k)))
  throw error("comfy_template_invalid");
 const payload={name:template.name,apiGraph:template.apiGraph,ports:template.ports,requirements:template.requirements,
  ...(template.previewBinding!==undefined?{previewBinding:template.previewBinding}:{})};
 if(template.mediaUseCase!==undefined)payload.mediaUseCase=template.mediaUseCase;
 assertNoRawCredentials(payload);
 const json=stable(payload);
 if(Buffer.byteLength(json)>2_000_000)throw error("comfy_template_too_large",413);
 const {name,...nameIndependent}=payload;
 const currentDigest=createHash("sha256").update(stable(nameIndependent)).digest("hex");
 const legacyPayload={...payload,name:template.revisionName??name};
 const legacyDigest=createHash("sha256").update(stable(legacyPayload)).digest("hex");
 if(currentDigest===template.revision){if(template.revisionName!==undefined)throw error("comfy_template_revision_mismatch",409);}
 else if(legacyDigest!==template.revision)throw error("comfy_template_revision_mismatch",409);
 // Defense in depth: verify basic graph and port topology even when the client
 // has already run the full ComfyUI schema validator.
 const graph=template.apiGraph;
 if(template.previewBinding!==undefined){
  const binding=template.previewBinding;
  if(!object(binding)||Object.keys(binding).some(k=>!["protocol","nodeId"].includes(k))||
    binding.protocol!=="kj-preview"||!idRe.test(binding.nodeId)||
    graph[binding.nodeId]?.class_type!=="ModelPreviewOverrideKJ")
   throw error("comfy_template_preview_binding_invalid");
 }
 if(template.mediaUseCase!==undefined){
  const u=template.mediaUseCase,mediaKinds=["image","video","audio"];
  if(!object(u)||!mediaKinds.includes(u.channel)||!mediaKinds.includes(u.primaryOutputKind)||
    u.channel!==u.primaryOutputKind||!idRe.test(u.promptPortId)||!idRe.test(u.primaryOutputPortId)||
    !Array.isArray(u.slots)||u.slots.length>16||
    (u.additionalOutputPortIds!==undefined&&(!Array.isArray(u.additionalOutputPortIds)||u.additionalOutputPortIds.length>16))||Object.hasOwn(u,"settings"))
   throw error("comfy_template_media_use_case_invalid");
  const byId=new Map(template.ports.map(p=>[p?.id,p]));
  const prompt=byId.get(u.promptPortId),primary=byId.get(u.primaryOutputPortId);
  if(prompt?.direction!=="target"||prompt.valueKind!=="STRING"||prompt.inputBinding?.mode!=="literal"||
    primary?.direction!=="source"||primary.capture?.kind!==u.primaryOutputKind||!primary.capture.adapterId)
   throw error("comfy_template_media_use_case_invalid");
  const slotIds=new Set();
  for(const slot of u.slots){
   const port=byId.get(slot?.id);
   if(!object(slot)||!idRe.test(slot.id)||slotIds.has(slot.id)||typeof slot.label!=="string"||slot.label.length>90||
    !["IMAGE","MASK","VIDEO","AUDIO"].includes(slot.valueKind)||port?.direction!=="target"||port.valueKind!==slot.valueKind||
    Boolean(slot.required)!==Boolean(port.required)||(slot.required!==undefined&&typeof slot.required!=="boolean"))
    throw error("comfy_template_media_slot_invalid");
   slotIds.add(slot.id);
  }
  const outputIds=[u.primaryOutputPortId,...(u.additionalOutputPortIds??[])];
  if(new Set(outputIds).size!==outputIds.length)throw error("comfy_template_media_output_invalid");
  for(const id of u.additionalOutputPortIds??[]){const port=byId.get(id);
   if(port?.direction!=="source"||!port.capture||port.capture.kind==="none"||!port.capture.adapterId)throw error("comfy_template_media_output_invalid");}
 }
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
 return {id:template.id,revision:template.revision,...JSON.parse(json),...(template.revisionName?{revisionName:template.revisionName}:{})};
}
export function createComfyRegistry(db,{workflowsDir}={}){
 if(!db)throw Error("comfy_registry_database_required");
 workflowsDir??=registryRoots.get(db);
 if(!workflowsDir){
  const databaseFile=db.prepare("PRAGMA database_list").all().find(item=>item.name==="main")?.file;
  workflowsDir=databaseFile?join(dirname(dirname(databaseFile)),"workflows"):mkdtempSync(join(tmpdir(),"infinite-atelier-workflows-"));
 }
 registryRoots.set(db,workflowsDir);
 mkdirSync(workflowsDir,{recursive:true});
 function publishGraph(graph){
  const bytes=Buffer.from(stable(graph),"utf8"),hash=createHash("sha256").update(bytes).digest("hex"),path=join(workflowsDir,hash+".json");
  if(!existsSync(path)){
   const temp=path+".part-"+randomUUID();writeFileSync(temp,bytes,{flag:"wx",mode:0o600});const fd=openSync(temp,"r+");try{fsyncSync(fd)}finally{closeSync(fd)}
   try{renameSync(temp,path)}catch(e){try{unlinkSync(temp)}catch{}if(!existsSync(path))throw e}
  }
  if(createHash("sha256").update(readFileSync(path)).digest("hex")!==hash)throw error("comfy_workflow_file_corrupt",500);
  return hash;
 }
 function compose(row){
  if(!row)return null;let payload=JSON.parse(row.payload_json),hash=row.workflow_hash;
  if(!hash){hash=publishGraph(payload.apiGraph);const normalized={...payload};delete normalized.apiGraph;
   writeTransaction(db,()=>{db.prepare("UPDATE comfy_template_versions SET payload_json=?,workflow_hash=? WHERE template_id=? AND revision=? AND workflow_hash IS NULL")
    .run(stable(normalized),hash,row.template_id,row.revision);const t=Date.now();
    db.prepare("INSERT OR IGNORE INTO comfy_workflows(workflow_id,name,source,created_at,updated_at) VALUES(?,?,'migration',?,?)").run(row.template_id,payload.name,t,t);
    db.prepare("INSERT INTO comfy_workflow_versions(workflow_id,revision,template_id,workflow_hash,blob_refs_json,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(template_id,revision) DO UPDATE SET workflow_hash=excluded.workflow_hash,blob_refs_json=excluded.blob_refs_json")
     .run(row.template_id,row.revision,row.template_id,hash,stable(graphBlobRefs(payload.apiGraph)),t);
   });payload=normalized;
  }
  let bytes;try{bytes=readFileSync(join(workflowsDir,hash+".json"))}catch{throw error("comfy_workflow_file_missing",500)}
  if(createHash("sha256").update(bytes).digest("hex")!==hash)throw error("comfy_workflow_file_corrupt",500);
  const name=db.prepare("SELECT display_name FROM comfy_template_names WHERE template_id=?").get(row.template_id)?.display_name??payload.name;
  const apiGraph=JSON.parse(bytes.toString("utf8"));
  const content={apiGraph,ports:payload.ports,requirements:payload.requirements,
   ...(payload.previewBinding!==undefined?{previewBinding:payload.previewBinding}:{}),
   ...(payload.mediaUseCase!==undefined?{mediaUseCase:payload.mediaUseCase}:{})};
  const nameIndependent=createHash("sha256").update(stable(content)).digest("hex")===row.revision;
  const {revisionName:storedRevisionName,...binding}=payload;
  return {id:row.template_id,revision:row.revision,...binding,name,
   ...(!nameIndependent&&(storedRevisionName!==undefined||payload.name!==name)?{revisionName:storedRevisionName??payload.name}:{}),apiGraph};
 }
 const find=(id,revision)=>{
  const row=db.prepare("SELECT template_id,revision,payload_json,workflow_hash FROM comfy_template_versions WHERE template_id=? AND revision=?").get(id,revision);
  return compose(row);
 };
 function listTemplates(){
  return db.prepare("SELECT template_id,revision,payload_json,workflow_hash FROM comfy_template_versions ORDER BY template_id,revision")
   .all().map(compose);
 }
 function installMany(input){
  if(!Array.isArray(input)||input.length>128)throw error("comfy_template_invalid");
  const templates=input.map(raw=>{const template=validateComfyTemplate(raw);verifyCompilerTemplate(template);return template;});
  const graphHashes=new Map(templates.map(template=>[template.id+"@"+template.revision,publishGraph(template.apiGraph)]));
  return writeTransaction(db,()=>{
   const result=[];
   for(const template of templates){
    const workflowHash=graphHashes.get(template.id+"@"+template.revision),binding={...template};delete binding.apiGraph;
    const content=stable(binding);
    const existing=db.prepare("SELECT payload_json,workflow_hash FROM comfy_template_versions WHERE template_id=? AND revision=?")
     .get(template.id,template.revision);
    if(existing&&existing.workflow_hash&&(existing.workflow_hash!==workflowHash||!sameTemplateContent(JSON.parse(existing.payload_json),binding)))
     throw error("comfy_template_immutable_conflict",409);
    if(existing&&!existing.workflow_hash){
     const old=JSON.parse(existing.payload_json);if(stable(old)!==stable(template))throw error("comfy_template_immutable_conflict",409);
     db.prepare("UPDATE comfy_template_versions SET payload_json=?,workflow_hash=? WHERE template_id=? AND revision=?")
      .run(content,workflowHash,template.id,template.revision);
    }else if(!existing)db.prepare("INSERT INTO comfy_template_versions(template_id,revision,payload_json,created_at,workflow_hash) VALUES(?,?,?,?,?)")
     .run(template.id,template.revision,content,Date.now(),workflowHash);
    const stamp=Date.now();
    db.prepare("INSERT OR IGNORE INTO comfy_template_names(template_id,display_name,updated_at) VALUES(?,?,?)").run(template.id,template.name,stamp);
    db.prepare("INSERT INTO comfy_workflows(workflow_id,name,source,created_at,updated_at) VALUES(?,?,'import',?,?) ON CONFLICT(workflow_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at")
     .run(template.id,template.name,stamp,stamp);
    db.prepare("INSERT INTO comfy_workflow_versions(workflow_id,revision,template_id,workflow_hash,blob_refs_json,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(template_id,revision) DO UPDATE SET workflow_hash=excluded.workflow_hash,blob_refs_json=excluded.blob_refs_json")
     .run(template.id,template.revision,template.id,workflowHash,stable(graphBlobRefs(template.apiGraph)),stamp);
    result.push({id:template.id,revision:template.revision,status:existing?"existing":"installed"});
   }
   return result;
  });
 }
 function deleteTemplate(id,revision){
  if(!idRe.test(id)||!shaRe.test(revision))throw error("comfy_template_invalid");
  return {...deleteTemplates([{templateId:id,revision}]),deleted:true};
 }
 function versionReferences(id,revision){
  return versionReferenceIndex().get(id+"@"+revision)??{presets:[],projectNodes:[],tasks:[],defaults:[],count:0};
 }
 function versionReferenceIndex(){
  const index=new Map(),key=(id,revision)=>id+"@"+revision;
  const get=k=>{
   if(!index.has(k))index.set(k,{presets:[],projectNodes:[],tasks:[],defaults:[],count:0});
   return index.get(k);
  };
  for(const p of db.prepare("SELECT id,name,kind,parent_id AS parentId,template_id,revision FROM comfy_presets").iterate()){
   get(key(p.template_id,p.revision)).presets.push({id:p.id,name:p.name,kind:p.kind,parentId:p.parentId??undefined});
  }
  // Stream snapshots once per operation; never scan all tasks once per version.
  for(const row of db.prepare("SELECT id,document_json FROM projects").iterate()){
   const doc=JSON.parse(row.document_json);
   for(const node of doc.nodes??[]){
    const references=new Set();
    for(const prop of ["comfyWorkflow","comfyMediaPreset"]){
     const binding=node.metadata?.[prop];
     if(binding?.templateId&&binding?.templateRevision)references.add(key(binding.templateId,binding.templateRevision));
    }
    for(const identity of references)get(identity).projectNodes.push({projectId:row.id,projectName:doc.title??row.id,nodeId:node.id,nodeTitle:node.title??""});
   }
  }
  for(const row of db.prepare("SELECT id,snapshot_json FROM jobs").iterate()){
   const snapshot=JSON.parse(row.snapshot_json),references=new Set();
   if(snapshot.comfyTemplate?.id&&snapshot.comfyTemplate?.revision)references.add(key(snapshot.comfyTemplate.id,snapshot.comfyTemplate.revision));
   for(const node of snapshot.comfyRequest?.nodes??[]){
    if(node.templateId&&node.templateRevision)references.add(key(node.templateId,node.templateRevision));
   }
   for(const identity of references)get(identity).tasks.push({taskId:row.id});
  }
  // Protect Task-frozen Comfy versions even before a Job has been queued.
  for(const row of db.prepare("SELECT s.id,s.task_id,s.action_json FROM assistant_task_steps s JOIN assistant_tasks t ON t.id=s.task_id JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL WHERE s.kind IN ('model_job','comfy_workflow') AND s.superseded_at IS NULL AND s.status NOT IN ('blocked','failed','skipped') AND t.cancel_requested_at IS NULL AND t.status NOT IN ('cancelled','completed','failed')").iterate()){
   const action=JSON.parse(row.action_json),snapshot=action?.job?.snapshot,references=new Set();
   if(snapshot?.comfyTemplate?.id&&snapshot.comfyTemplate?.revision)
    references.add(key(snapshot.comfyTemplate.id,snapshot.comfyTemplate.revision));
   for(const node of snapshot?.comfyRequest?.nodes??[]){
    if(node.templateId&&node.templateRevision)references.add(key(node.templateId,node.templateRevision));
   }
   for(const identity of references)get(identity).tasks.push({taskId:row.task_id,stepId:row.id});
  }
  const setting=db.prepare("SELECT value_json FROM ui_settings WHERE name='model_config'").get();
  if(setting){
   const config=JSON.parse(setting.value_json);
   for(const [model,binding] of Object.entries(config.comfyWorkflowDefaults??{})){
    if(binding?.templateId&&binding?.templateRevision)get(key(binding.templateId,binding.templateRevision)).defaults.push({model});
   }
  }
  for(const refs of index.values())refs.count=refs.presets.length+refs.projectNodes.length+refs.tasks.length+refs.defaults.length;
  return index;
 }
 function deleteTemplates(items){return writeTransaction(db,()=>{
  if(!Array.isArray(items)||!items.length||items.length>128||items.some(v=>!object(v)||!idRe.test(v.templateId)||!shaRe.test(v.revision)))throw error("comfy_template_invalid");
  const unique=new Map(items.map(v=>[v.templateId+"@"+v.revision,v]));
  if(unique.size!==items.length)throw error("comfy_template_invalid");
  const checked=[],referenceIndex=versionReferenceIndex();
  for(const {templateId,revision} of unique.values()){
   if(!db.prepare("SELECT 1 FROM comfy_template_versions WHERE template_id=? AND revision=?").get(templateId,revision))throw error("comfy_template_not_found",404);
   const references=referenceIndex.get(templateId+"@"+revision);if(references?.count)throw Object.assign(error("comfy_template_in_use",409),{references,templateId,revision});
   checked.push({templateId,revision});
  }
  for(const {templateId,revision} of checked){
   const workflowIds=db.prepare("SELECT workflow_id FROM comfy_workflow_versions WHERE template_id=? AND revision=?").all(templateId,revision).map(x=>x.workflow_id);
   db.prepare("DELETE FROM comfy_workflow_versions WHERE template_id=? AND revision=?").run(templateId,revision);
   db.prepare("DELETE FROM comfy_template_versions WHERE template_id=? AND revision=?").run(templateId,revision);
   for(const workflowId of workflowIds)db.prepare("DELETE FROM comfy_workflows WHERE workflow_id=? AND NOT EXISTS(SELECT 1 FROM comfy_workflow_versions WHERE workflow_id=?)").run(workflowId,workflowId);
  }
  return {deleted:checked.length};
 });}
 function listTemplateVersions(workflowId){
  if(!idRe.test(workflowId))throw error("comfy_template_invalid");
  const refs=versionReferenceIndex();
  return db.prepare(`SELECT v.template_id AS templateId,v.revision,v.workflow_hash AS workflowHash,v.created_at AS createdAt,
   COALESCE(n.display_name,json_extract(t.payload_json,'$.name')) AS name,
   COALESCE(x.note,'') AS note,v.workflow_id AS workflowId,
   EXISTS(SELECT 1 FROM comfy_presets cp WHERE cp.workflow_id=v.workflow_id AND cp.template_id=v.template_id AND cp.revision=v.revision) AS current
   FROM comfy_workflow_versions v JOIN comfy_template_versions t ON t.template_id=v.template_id AND t.revision=v.revision
   LEFT JOIN comfy_template_names n ON n.template_id=v.template_id LEFT JOIN comfy_template_version_notes x ON x.template_id=v.template_id AND x.revision=v.revision
   WHERE v.workflow_id=? ORDER BY v.created_at DESC,v.revision DESC,v.template_id`).all(workflowId).map(row=>({...row,shortRevision:row.revision.slice(0,10),current:Boolean(row.current),references:{count:refs.get(row.templateId+"@"+row.revision)?.count??0}}));
 }
 function templateReferences(id,revision){if(!idRe.test(id)||!shaRe.test(revision))throw error("comfy_template_invalid");if(!db.prepare("SELECT 1 FROM comfy_template_versions WHERE template_id=? AND revision=?").get(id,revision))throw error("comfy_template_not_found",404);return versionReferences(id,revision);}
 function setVersionNote(id,revision,note){
  if(!idRe.test(id)||!shaRe.test(revision)||typeof note!=="string"||note.length>200)throw error("comfy_template_invalid");
  return writeTransaction(db,()=>{if(!db.prepare("SELECT 1 FROM comfy_template_versions WHERE template_id=? AND revision=?").get(id,revision))throw error("comfy_template_not_found",404);
   db.prepare("INSERT INTO comfy_template_version_notes(template_id,revision,note) VALUES(?,?,?) ON CONFLICT(template_id,revision) DO UPDATE SET note=excluded.note").run(id,revision,note);
   return {templateId:id,revision,note};});
 }
 function getVersionNote(id,revision){
  if(!idRe.test(id)||!shaRe.test(revision))throw error("comfy_template_invalid");
  if(!db.prepare("SELECT 1 FROM comfy_template_versions WHERE template_id=? AND revision=?").get(id,revision))throw error("comfy_template_not_found",404);
  return {note:db.prepare("SELECT note FROM comfy_template_version_notes WHERE template_id=? AND revision=?").get(id,revision)?.note??""};
 }
 function restorePresetVersion(presetId,{templateId,revision,expectedTemplateId,expectedRevision}){
  if(!idRe.test(presetId)||!idRe.test(templateId)||!shaRe.test(revision)||!idRe.test(expectedTemplateId)||!shaRe.test(expectedRevision))throw error("comfy_template_invalid");
  return writeTransaction(db,()=>{const p=db.prepare("SELECT * FROM comfy_presets WHERE id=?").get(presetId);if(!p)throw error("comfy_preset_not_found",404);
   if(p.template_id!==expectedTemplateId||p.revision!==expectedRevision)throw error("comfy_template_restore_conflict",409);
   const targetWorkflow=db.prepare("SELECT workflow_id FROM comfy_workflow_versions WHERE template_id=? AND revision=?").get(templateId,revision)?.workflow_id;
   if(!find(templateId,revision)||targetWorkflow!==p.workflow_id)throw error("comfy_template_not_found",404);
   db.prepare("UPDATE comfy_presets SET template_id=?,revision=?,updated_at=? WHERE id=? AND template_id=? AND revision=?").run(templateId,revision,Date.now(),presetId,expectedTemplateId,expectedRevision);
   return {...p,template_id:templateId,revision};});
 }
 function listPresets(){
  return db.prepare("SELECT p.id,p.name,p.template_id,p.revision,p.source,p.kind,p.parent_id,p.workflow_id FROM comfy_presets p ORDER BY p.name,p.id")
   .all().map(row=>({id:row.id,name:row.name,workflowId:row.workflow_id,templateId:row.template_id,revision:row.revision,source:row.source,kind:row.kind,
    ...(row.parent_id?{parentId:row.parent_id}:{})}));
 }
 function savePreset(preset){
  if(!object(preset)||Object.keys(preset).some(k=>!["id","name","workflowId","templateId","revision","source","kind","parentId"].includes(k))||
    !idRe.test(preset.id)||!idRe.test(preset.templateId)||
    !shaRe.test(preset.revision)||typeof preset.name!=="string"||
    !preset.name.trim()||preset.name.length>160||preset.workflowId!==undefined&&!idRe.test(preset.workflowId)||preset.source!==undefined&&!['user','builtin','import'].includes(preset.source)||
    preset.kind!==undefined&&!['base','variant'].includes(preset.kind)||preset.parentId!==undefined&&!idRe.test(preset.parentId))throw error("comfy_preset_invalid");
  if(!find(preset.templateId,preset.revision))throw error("comfy_template_not_found",404);
  const record={id:preset.id,name:preset.name,templateId:preset.templateId,revision:preset.revision,
   workflowId:preset.workflowId??preset.templateId,source:preset.source??"user",kind:preset.kind??"base",parentId:preset.parentId??null};
  if(record.kind==="variant"&&(!record.parentId||!db.prepare("SELECT id FROM comfy_presets WHERE id=?").get(record.parentId)))throw error("comfy_preset_parent_not_found",404);
  if(record.kind==="base"&&record.parentId)throw error("comfy_preset_invalid");
  if(record.kind==="variant"&&db.prepare("SELECT workflow_id FROM comfy_presets WHERE id=?").get(record.parentId)?.workflow_id!==record.workflowId)throw error("comfy_preset_parent_workflow_mismatch");
  writeTransaction(db,()=>{const stamp=Date.now();
   db.prepare("INSERT INTO comfy_template_names(template_id,display_name,updated_at) VALUES(?,?,?) ON CONFLICT(template_id) DO UPDATE SET display_name=excluded.display_name,updated_at=excluded.updated_at").run(record.templateId,record.name,stamp);
   db.prepare("UPDATE comfy_presets SET name=?,updated_at=? WHERE template_id=?").run(record.name,stamp,record.templateId);
   db.prepare("INSERT INTO comfy_presets(id,name,template_id,revision,updated_at,source,kind,parent_id,workflow_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,template_id=excluded.template_id,revision=excluded.revision,updated_at=excluded.updated_at,source=excluded.source,kind=excluded.kind,parent_id=excluded.parent_id,workflow_id=excluded.workflow_id")
    .run(record.id,record.name,record.templateId,record.revision,stamp,record.source,record.kind,record.parentId,record.workflowId);});
  return record;
 }
 function savePresetBinding(preset,workflowHash,binding){
  if(!object(preset)||Object.keys(preset).some(k=>!["id","name","workflowId","templateId","revision","source","kind","parentId"].includes(k))||
    !idRe.test(preset.id)||typeof preset.name!=="string"||!preset.name.trim()||preset.name.length>160||
    preset.workflowId!==undefined&&!idRe.test(preset.workflowId)||preset.source!==undefined&&!['user','builtin','import'].includes(preset.source)||preset.kind!==undefined&&!['base','variant'].includes(preset.kind)||
    preset.parentId!==undefined&&!idRe.test(preset.parentId)||!shaRe.test(workflowHash)||!object(binding))throw error("comfy_preset_invalid");
  if(binding.id!==preset.templateId||binding.revision!==preset.revision)throw error("comfy_preset_binding_mismatch");
  let graphBytes;try{graphBytes=readFileSync(join(workflowsDir,workflowHash+".json"))}catch{throw error("comfy_workflow_file_missing",500)}
  if(createHash("sha256").update(graphBytes).digest("hex")!==workflowHash)throw error("comfy_workflow_file_corrupt",500);
  const template=validateComfyTemplate({...binding,id:preset.templateId,revision:preset.revision,apiGraph:JSON.parse(graphBytes.toString("utf8"))});
  verifyCompilerTemplate(template);
  const contents={...template};delete contents.apiGraph;
  const stamp=Date.now();
  const record={...preset,workflowId:preset.workflowId??preset.templateId,source:preset.source??"user",kind:preset.kind??"base",parentId:preset.parentId??null};
  if(record.kind==="variant"&&(!record.parentId||record.parentId===record.id||!db.prepare("SELECT id FROM comfy_presets WHERE id=?").get(record.parentId)))throw error("comfy_preset_parent_not_found",404);
  if(record.kind==="variant"&&db.prepare("SELECT workflow_id FROM comfy_presets WHERE id=?").get(record.parentId)?.workflow_id!==record.workflowId)throw error("comfy_preset_parent_workflow_mismatch");
  if(record.kind==="base"&&record.parentId)throw error("comfy_preset_invalid");
  return writeTransaction(db,()=>{
   const existing=db.prepare("SELECT payload_json,workflow_hash FROM comfy_template_versions WHERE template_id=? AND revision=?").get(template.id,template.revision);
   if(existing&&(existing.workflow_hash!==workflowHash||!sameTemplateContent(JSON.parse(existing.payload_json),contents)))throw error("comfy_template_immutable_conflict",409);
   if(!existing)db.prepare("INSERT INTO comfy_template_versions(template_id,revision,payload_json,created_at,workflow_hash) VALUES(?,?,?,?,?)").run(template.id,template.revision,stable(contents),stamp,workflowHash);
   db.prepare("INSERT INTO comfy_template_names(template_id,display_name,updated_at) VALUES(?,?,?) ON CONFLICT(template_id) DO UPDATE SET display_name=excluded.display_name,updated_at=excluded.updated_at")
    .run(template.id,template.name,stamp);
   db.prepare("INSERT INTO comfy_workflows(workflow_id,name,source,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at")
    .run(record.workflowId,template.name,record.source,stamp,stamp);
   db.prepare("INSERT INTO comfy_workflow_versions(workflow_id,revision,template_id,workflow_hash,blob_refs_json,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(template_id,revision) DO UPDATE SET workflow_id=excluded.workflow_id,workflow_hash=excluded.workflow_hash,blob_refs_json=excluded.blob_refs_json")
    .run(record.workflowId,template.revision,template.id,workflowHash,stable(graphBlobRefs(template.apiGraph)),stamp);
   db.prepare("INSERT INTO comfy_presets(id,name,template_id,revision,updated_at,source,kind,parent_id,workflow_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,template_id=excluded.template_id,revision=excluded.revision,updated_at=excluded.updated_at,source=excluded.source,kind=excluded.kind,parent_id=excluded.parent_id,workflow_id=excluded.workflow_id")
    .run(record.id,record.name,record.templateId,record.revision,stamp,record.source,record.kind,record.parentId,record.workflowId);
   return record;
  });
 }
 function renameTemplate(id,name){
  if(!idRe.test(id)||typeof name!=="string"||!name.trim()||name.length>160)throw error("comfy_template_invalid");
  return writeTransaction(db,()=>{
   if(!db.prepare("SELECT 1 FROM comfy_template_versions WHERE template_id=? LIMIT 1").get(id))throw error("comfy_template_not_found",404);
   const stamp=Date.now();db.prepare("INSERT INTO comfy_template_names(template_id,display_name,updated_at) VALUES(?,?,?) ON CONFLICT(template_id) DO UPDATE SET display_name=excluded.display_name,updated_at=excluded.updated_at").run(id,name.trim(),stamp);
   db.prepare("UPDATE comfy_presets SET name=?,updated_at=? WHERE template_id=?").run(name.trim(),stamp,id);
   return {templateId:id,name:name.trim()};
  });
 }
 function deletePreset(id){
  if(!idRe.test(id))throw error("comfy_preset_invalid");
  if(!db.prepare("DELETE FROM comfy_presets WHERE id=?").run(id).changes)
   throw error("comfy_preset_not_found",404);
  return {deleted:true};
 }
  function listWorkflows(){return db.prepare(`SELECT w.workflow_id AS id,w.name,w.source,w.created_at AS createdAt,w.updated_at AS updatedAt,
  (SELECT revision FROM comfy_workflow_versions v WHERE v.workflow_id=w.workflow_id ORDER BY created_at DESC LIMIT 1) AS latestRevision
  FROM comfy_workflows w ORDER BY w.name,w.workflow_id`).all();}
 function workflowVersions(id){if(!idRe.test(id))throw error("comfy_template_invalid");return db.prepare("SELECT revision,template_id AS templateId,workflow_hash AS workflowHash,created_at AS createdAt FROM comfy_workflow_versions WHERE workflow_id=? ORDER BY created_at DESC,revision,template_id").all(id);}
 function publishWorkflowGraph(id,graph){
  if(!idRe.test(id)||!object(graph)||Object.keys(graph).length<1||Object.keys(graph).length>500)throw error("comfy_template_invalid");
  const hash=publishGraph(graph),stamp=Date.now();
  writeTransaction(db,()=>db.prepare("INSERT INTO comfy_workflows(workflow_id,name,source,created_at,updated_at) VALUES(?,?,'import',?,?) ON CONFLICT(workflow_id) DO UPDATE SET updated_at=excluded.updated_at")
   .run(id,id,stamp,stamp));
  return {workflowId:id,workflowHash:hash};
 }
 function workflowGraphAvailable(id,hash){
  if(!idRe.test(id)||!shaRe.test(hash))throw error("comfy_template_invalid");
  try{return createHash("sha256").update(readFileSync(join(workflowsDir,hash+".json"))).digest("hex")===hash}
  catch(e){if(e.code==="ENOENT")return false;throw e}
 }
 // Finish legacy payload_json extraction before routes are served. Already
 // split rows are validated when individually read, so one damaged graph cannot
 // prevent unrelated workflows from loading.
 db.prepare("SELECT template_id,revision,payload_json,workflow_hash FROM comfy_template_versions WHERE workflow_hash IS NULL ORDER BY template_id,revision")
  .all().forEach(compose);
 return {find,listTemplates,installMany,deleteTemplate,deleteTemplates,listPresets,savePreset,savePresetBinding,renameTemplate,deletePreset,listWorkflows,workflowVersions,listTemplateVersions,templateReferences,getVersionNote,setVersionNote,restorePresetVersion,publishWorkflowGraph,workflowGraphAvailable};
}
