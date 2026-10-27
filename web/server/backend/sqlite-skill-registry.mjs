import {verifySkillPackageContent} from "./skill-package-integrity.mjs";
import {writeTransaction} from "./repository.mjs";
const problem=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const idRule=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const versionRule=/^[a-f0-9]{12}$/;
const hashRule=/^[a-f0-9]{64}$/;
const projectRule=/^[A-Za-z0-9_-]{1,128}$/;
const plain=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const exact=(v,names)=>plain(v)&&Object.keys(v).every(key=>names.includes(key));
const bytes=v=>Buffer.byteLength(v,"utf8");
const MAX_ARCHIVE=5*1024*1024,MAX_CONTENT=5*1024*1024,MAX_FILE=512*1024;
function pathValid(path){
 return typeof path==="string"&&path.length<=240&&
  !path.includes("\\")&&!/[\x00-\x1f\x7f]/.test(path)&&
  !path.startsWith("/")&&!/^(?:https?:|file:|data:)/i.test(path)&&
  !/^[a-zA-Z]:/.test(path)&&
  !path.split("/").some(item=>!item||item==="."||item==="..");
}
function readVersionRow(row){
 if(!row)return null;
 return {manifest:JSON.parse(row.manifest_json),skillMd:row.skill_md,
  resources:JSON.parse(row.resources_json),
  ...(row.archive_bytes?{sourceArchiveBase64:Buffer.from(row.archive_bytes).toString("base64")}:{})};
}
function validatePackage(value){
 if(!exact(value,["manifest","skillMd","resources","sourceArchiveBase64"])||
  !exact(value.manifest,["id","name","description","hash","version","resources","warnings"]))
  throw problem("skill_package_invalid");
 const m=value.manifest;
 if(typeof m.id!=="string"||!idRule.test(m.id)||m.id.length>80||
  typeof m.name!=="string"||!m.name.trim()||m.name.length>180||
  typeof m.description!=="string"||!m.description.trim()||m.description.length>1000||
  typeof m.hash!=="string"||!hashRule.test(m.hash)||
  !versionRule.test(m.version)||!m.hash.startsWith(m.version)||
  !Array.isArray(m.resources)||m.resources.length>100||
  !Array.isArray(m.warnings)||m.warnings.length>100||
  m.warnings.some(x=>typeof x!=="string"||x.length>500)||
  typeof value.skillMd!=="string"||bytes(value.skillMd)>MAX_FILE||
  !plain(value.resources))
  throw problem("skill_package_invalid");
 const paths=new Set();
 for(const path of m.resources){
  if(!pathValid(path)||paths.has(path))throw problem("skill_package_invalid");
  paths.add(path);
 }
 if(!value.skillMd.startsWith("---")||!value.skillMd.includes("\n---")||
  !value.skillMd.includes("name:")||!value.skillMd.includes("description:"))
  throw problem("skill_package_invalid");
 let sum=bytes(value.skillMd);
 if(Object.keys(value.resources).length>100)throw problem("skill_package_invalid");
 for(const [path,body] of Object.entries(value.resources)){
  if(!pathValid(path)||!/^references\/.+\.(?:md|txt|markdown)$/i.test(path)||
    !paths.has(path)||typeof body!=="string"||bytes(body)>MAX_FILE)
   throw problem("skill_package_invalid");
  sum+=bytes(body);
 }
 if(sum>MAX_CONTENT)throw problem("skill_package_too_large",413);
 let archive=null;
 if(value.sourceArchiveBase64!==undefined){
  const encoded=value.sourceArchiveBase64;
  if(typeof encoded!=="string"||encoded.length>Math.ceil(MAX_ARCHIVE/3)*4+4||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw problem("skill_package_invalid");
  archive=Buffer.from(encoded,"base64");
  if(archive.length>MAX_ARCHIVE||archive.toString("base64")!==encoded)
   throw problem("skill_package_invalid");
  if(archive.length<4||archive.readUInt32LE(0)!==0x04034b50)
   throw problem("skill_package_invalid");
 }
 verifySkillPackageContent(value,archive);
 return {manifest:m,skillMd:value.skillMd,resources:value.resources,archive};
}
function listRows(db){
 const rows=db.prepare("SELECT * FROM skill_entries ORDER BY rowid").all();
 return rows.map(row=>({
  id:row.id,name:row.name,description:row.description,enabled:!!row.enabled,
  ...(row.scope_project_id?{scope:{type:"project",projectId:row.scope_project_id}}:{}),
  activeVersion:row.active_version,
  versions:db.prepare("SELECT version FROM skill_versions WHERE skill_id=? ORDER BY rowid")
    .all(row.id).map(v=>v.version),
  updatedAt:row.updated_at
 }));
}
function requireRevision(db,expectedRevision){
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)
  throw problem("skill_revision_required");
 const revision=db.prepare("SELECT revision FROM skill_registry_state WHERE id=1").get().revision;
 if(revision!==expectedRevision)throw problem("skill_revision_conflict",409);
}
function bump(db){
 db.prepare("UPDATE skill_registry_state SET revision=revision+1 WHERE id=1").run();
}
export function listSkillRegistry(db){
 return {revision:db.prepare("SELECT revision FROM skill_registry_state WHERE id=1").get().revision,
  skills:listRows(db)};
}
export function getSkillRegistryPackage(db,id,version){
 if(!idRule.test(id))throw problem("skill_not_found",404);
 const row=db.prepare("SELECT active_version FROM skill_entries WHERE id=?").get(id);
 if(!row)throw problem("skill_not_found",404);
 const selected=version??row.active_version;
 if(!versionRule.test(selected))throw problem("skill_version_not_found",404);
 const record=db.prepare("SELECT * FROM skill_versions WHERE skill_id=? AND version=?")
  .get(id,selected);
 if(!record)throw problem("skill_version_not_found",404);
 const pkg=readVersionRow(record);
 verifySkillPackageContent(pkg,record.archive_bytes);
 if(pkg.manifest.hash!==record.hash||pkg.manifest.version!==record.version)
  throw problem("skill_package_integrity_failed",422);
 return {package:pkg};
}
export function registerSqliteSkill(db,raw,expectedRevision){
 const pkg=validatePackage(raw);
 return writeTransaction(db,()=>{
  requireRevision(db,expectedRevision);
  const m=pkg.manifest;
  const row=db.prepare("SELECT * FROM skill_entries WHERE id=?").get(m.id);
  if(!row&&db.prepare("SELECT COUNT(*) AS n FROM skill_entries").get().n>=100)
   throw problem("skill_catalog_full",409);
  const existing=db.prepare("SELECT hash FROM skill_versions WHERE skill_id=? AND version=?").get(m.id,m.version);
  if(existing&&existing.hash!==m.hash)throw problem("skill_version_conflict",409);
  if(!existing&&row&&db.prepare("SELECT COUNT(*) AS n FROM skill_versions WHERE skill_id=?").get(m.id).n>=30)
   throw problem("skill_versions_full",409);
  if(!existing&&db.prepare("SELECT COUNT(*) AS n FROM skill_versions").get().n>=500)
   throw problem("skill_versions_full",409);
  const updatedAt=new Date().toISOString();
  if(!row){
   db.prepare("INSERT INTO skill_entries(id,name,description,enabled,scope_project_id,active_version,updated_at) VALUES(?,?,?,1,NULL,?,?)")
    .run(m.id,m.name,m.description,m.version,updatedAt);
  }else{
   db.prepare("UPDATE skill_entries SET name=?,description=?,active_version=?,updated_at=? WHERE id=?")
    .run(m.name,m.description,m.version,updatedAt,m.id);
  }
  if(!existing){
   db.prepare("INSERT INTO skill_versions(skill_id,version,hash,manifest_json,skill_md,resources_json,archive_bytes) VALUES(?,?,?,?,?,?,?)")
    .run(m.id,m.version,m.hash,JSON.stringify(m),pkg.skillMd,JSON.stringify(pkg.resources),pkg.archive);
  }else{
   const old=getSkillRegistryPackage(db,m.id,m.version).package;
   if(old.skillMd!==pkg.skillMd||JSON.stringify(old.manifest)!==JSON.stringify(m)||
      JSON.stringify(old.resources)!==JSON.stringify(pkg.resources)||
      (old.sourceArchiveBase64??null)!==(pkg.archive?.toString("base64")??null))
    throw problem("skill_version_conflict",409);
  }
  bump(db);
  return listRows(db).find(item=>item.id===m.id);
 });
}
export function updateSqliteSkill(db,id,body){
 if(!idRule.test(id)||!exact(body,["action","enabled","scope","version","expectedRevision"]))
  throw problem("skill_update_invalid");
 return writeTransaction(db,()=>{
  requireRevision(db,body.expectedRevision);
  const row=db.prepare("SELECT * FROM skill_entries WHERE id=?").get(id);
  if(!row)throw problem("skill_not_found",404);
  const fields=["action","expectedRevision",body.action==="enabled"?"enabled":body.action==="scope"?"scope":"version"];
  if(!exact(body,fields)||Object.keys(body).length!==3)throw problem("skill_update_invalid");
  const at=new Date().toISOString();
  if(body.action==="enabled"){
   if(typeof body.enabled!=="boolean")throw problem("skill_update_invalid");
   db.prepare("UPDATE skill_entries SET enabled=?,updated_at=? WHERE id=?")
    .run(body.enabled?1:0,at,id);
  }else if(body.action==="scope"){
   const scope=body.scope;
   if(!exact(scope,["type","projectId"])||
      !["global","project"].includes(scope.type)||
      (scope.type==="global"&&Object.keys(scope).length!==1)||
      (scope.type==="project"&&(!projectRule.test(scope.projectId)||Object.keys(scope).length!==2)))
    throw problem("skill_update_invalid");
   db.prepare("UPDATE skill_entries SET scope_project_id=?,updated_at=? WHERE id=?")
    .run(scope.type==="project"?scope.projectId:null,at,id);
  }else if(body.action==="activate"){
   if(typeof body.version!=="string"||!versionRule.test(body.version))
    throw problem("skill_update_invalid");
   const selected=db.prepare("SELECT manifest_json FROM skill_versions WHERE skill_id=? AND version=?")
    .get(id,body.version);
   if(!selected)throw problem("skill_version_not_found",404);
   const manifest=JSON.parse(selected.manifest_json);
   db.prepare("UPDATE skill_entries SET active_version=?,name=?,description=?,updated_at=? WHERE id=?")
    .run(body.version,manifest.name,manifest.description,at,id);
  }else throw problem("skill_update_invalid");
  bump(db);
  return listRows(db).find(item=>item.id===id);
 });
}
export function deleteSqliteSkill(db,id,expectedRevision){
 if(!idRule.test(id))throw problem("skill_not_found",404);
 return writeTransaction(db,()=>{
  requireRevision(db,expectedRevision);
  const changes=db.prepare("DELETE FROM skill_entries WHERE id=?").run(id).changes;
  if(changes)bump(db);
  return {removed:!!changes};
 });
}
