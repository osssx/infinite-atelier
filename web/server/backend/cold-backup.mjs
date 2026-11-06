import {createHash} from "node:crypto";
import {createReadStream,existsSync} from "node:fs";
import {copyFile,mkdir,mkdtemp,readFile,rename,rm,writeFile,lstat} from "node:fs/promises";
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from "node:path";
import {DatabaseSync,backup as sqliteBackup} from "node:sqlite";
import {acquireInstanceLock} from "./instance-lock.mjs";
import {acquireDatasetGuard,installStandbyIdentity} from "./dataset-activation.mjs";
import {resolveLocalDataDir} from "./runtime.mjs";
import {createComfyRegistry} from "./comfy-registry.mjs";
import {rebuildBlobReferenceLedger} from "./blob-reference-ledger.mjs";
import {initializeSchema} from "./schema.mjs";

const HASH=/^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES=64*1024*1024;
const MAX_BLOBS=250000;
const error=(code)=>Object.assign(Error(code),{code});
function location(input){
 if(typeof input!=="string"||!isAbsolute(input))throw error("backup_absolute_path_required");
 return resolveLocalDataDir(input);
}
function child(parent,other){
 const rel=relative(parent,other);
 return rel===""||(!isAbsolute(rel)&&rel!==".."&&!rel.startsWith(".."+sep));
}
function disjoint(a,b){
 if(child(a,b)||child(b,a))throw error("backup_paths_overlap");
}
async function mustAbsent(target){
 try{await lstat(target)}catch(e){if(e.code==="ENOENT")return;throw e}
 throw error("backup_destination_exists");
}
async function stageFor(target){
 const parent=dirname(target);
 const info=await lstat(parent);
 if(!info.isDirectory()||info.isSymbolicLink())throw error("backup_parent_not_directory");
 await mustAbsent(target);
 return mkdtemp(join(parent,"."+basename(target)+".partial-"));
}
function readIntegrity(db){
 const result=db.prepare("PRAGMA integrity_check").all();
 if(result.length!==1||result[0].integrity_check!=="ok")throw error("backup_sqlite_integrity_failure");
 if(db.prepare("PRAGMA foreign_key_check").all().length)throw error("backup_sqlite_foreign_key_failure");
 const version=db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version;
 if(!Number.isSafeInteger(version)||version<1)throw error("backup_schema_missing");
 return version;
}
function inventory(db){
 const rows=db.prepare("SELECT id,sha256,byte_size,mime,relative_path,status FROM blobs ORDER BY id").all();
 if(rows.length>MAX_BLOBS)throw error("backup_too_many_blobs");
 return rows.map(row=>{
  if(!HASH.test(row.id)||row.sha256!==row.id||
   !Number.isSafeInteger(row.byte_size)||row.byte_size<0||
   row.status!=="ready"||typeof row.mime!=="string"||!row.mime||
   row.relative_path!=="blobs/"+row.id.slice(0,2)+"/"+row.id)
    throw error("backup_invalid_blob_row");
  return {id:row.id,sha256:row.id,byteSize:row.byte_size,mimeType:row.mime};
 });
}
function workflowInventory(db){
 const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
 if(!tables.has("comfy_workflow_versions"))return [];
 const templates=db.prepare("SELECT template_id,revision,workflow_hash FROM comfy_template_versions ORDER BY template_id,revision").all();
 for(const row of templates)if(!HASH.test(row.workflow_hash??"")||!db.prepare("SELECT 1 FROM comfy_workflow_versions WHERE template_id=? AND revision=? AND workflow_hash=?").get(row.template_id,row.revision,row.workflow_hash))throw error("backup_workflow_reference_mismatch");
 const hashes=db.prepare("SELECT DISTINCT workflow_hash FROM comfy_workflow_versions ORDER BY workflow_hash").all();
 return hashes.map(({workflow_hash:hash})=>{
  if(!HASH.test(hash))throw error("backup_invalid_workflow_row");
  return {sha256:hash,path:"workflows/"+hash+".json"};
 });
}
async function mustRealDirectory(dir){
 const info=await lstat(dir);
 if(!info.isDirectory()||info.isSymbolicLink())
  throw error("backup_symlink_directory_forbidden");
}
async function blobFile(root,id){
 const base=join(root,"blobs"),bucket=join(base,id.slice(0,2));
 await mustRealDirectory(base);
 await mustRealDirectory(bucket);
 return join(bucket,id);
}
async function workflowFile(root,hash){
 const base=join(root,"workflows");await mustRealDirectory(base);return join(base,hash+".json");
}
async function hashedFile(path,expectedBytes){
 const info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||
   expectedBytes!==undefined&&info.size!==expectedBytes)
  throw error("backup_file_integrity_failure");
 const sha=createHash("sha256");let total=0;
 for await(const bytes of createReadStream(path)){
  sha.update(bytes);total+=bytes.length;
 }
 if(expectedBytes!==undefined&&total!==expectedBytes)throw error("backup_file_integrity_failure");
 return {sha256:sha.digest("hex"),bytes:total};
}
async function inspectDatabase(dbFile){
 await mustRealDirectory(dirname(dbFile));
 const info=await lstat(dbFile);
 if(!info.isFile()||info.isSymbolicLink())throw error("backup_database_missing");
 const db=new DatabaseSync(dbFile,{readOnly:true});
 try{return {version:readIntegrity(db),blobs:inventory(db),workflows:workflowInventory(db)}}
 finally{db.close()}
}
async function parseManifest(backupDir){
 const path=join(backupDir,"manifest.json");
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_MANIFEST_BYTES)
  throw error("backup_manifest_invalid");
 const input=JSON.parse(await readFile(path,"utf8"));
 if(!input||typeof input!=="object"||Array.isArray(input)||
  input.format!=="infinite-atelier-cold-backup"||![1,2].includes(input.version)||
  !Number.isSafeInteger(input.createdAt)||input.createdAt<1||
  !Number.isSafeInteger(input.schemaVersion)||input.schemaVersion<1||
  !HASH.test(input.databaseSha256)||!Number.isSafeInteger(input.databaseBytes)||
  input.databaseBytes<0||!Array.isArray(input.blobs)||input.blobs.length>MAX_BLOBS)
  throw error("backup_manifest_invalid");
 if(input.version===2&&(!/^[0-9a-f-]{36}$/i.test(input.lineageId??"")||
  typeof input.originRoot!=="string"||!isAbsolute(input.originRoot)))
  throw error("backup_manifest_invalid");
 let previous="";
 for(const blob of input.blobs){
  if(!blob||typeof blob!=="object"||!HASH.test(blob.id)||blob.sha256!==blob.id||
   blob.id<=previous||!Number.isSafeInteger(blob.byteSize)||blob.byteSize<0||
   typeof blob.mimeType!=="string"||!blob.mimeType||blob.mimeType.length>128)
   throw error("backup_manifest_invalid");
  previous=blob.id;
 }
 if(input.workflows!==undefined){
  if(!Array.isArray(input.workflows)||input.workflows.length>100000)throw error("backup_manifest_invalid");
  let prior="";for(const item of input.workflows){if(!item||!HASH.test(item.sha256)||item.path!=="workflows/"+item.sha256+".json"||item.sha256<=prior)throw error("backup_manifest_invalid");prior=item.sha256;}
 }
 return input;
}
/** Verify every CAS file and the SQLite snapshot, not merely the manifest. */
export async function verifyColdBackup({backupDir}={}){
 const root=location(backupDir);
 const info=await lstat(root);
 if(!info.isDirectory()||info.isSymbolicLink())throw error("backup_directory_invalid");
 const manifest=await parseManifest(root);
 const dbPath=join(root,"db","atelier.sqlite");
 const hash=await hashedFile(dbPath,manifest.databaseBytes);
 if(hash.sha256!==manifest.databaseSha256)throw error("backup_database_digest_mismatch");
 const actual=await inspectDatabase(dbPath);
 if(actual.version!==manifest.schemaVersion||
  actual.blobs.length!==manifest.blobs.length||
  JSON.stringify(actual.workflows)!==JSON.stringify(manifest.workflows??[]))
  throw error("backup_manifest_database_mismatch");
 let totalBytes=0;
 for(let i=0;i<actual.blobs.length;i++){
  const expected=manifest.blobs[i],row=actual.blobs[i];
  if(JSON.stringify(expected)!==JSON.stringify(row))
   throw error("backup_manifest_database_mismatch");
  const file=await blobFile(root,row.id);
  const checked=await hashedFile(file,row.byteSize);
  if(checked.sha256!==row.id)throw error("backup_blob_digest_mismatch");
  totalBytes+=row.byteSize;
 }
 for(const item of actual.workflows){
  const file=await workflowFile(root,item.sha256),checked=await hashedFile(file);
  if(checked.sha256!==item.sha256)throw error("backup_workflow_digest_mismatch");totalBytes+=checked.bytes;
 }
 return {schemaVersion:actual.version,blobCount:actual.blobs.length,workflowCount:actual.workflows.length,
  blobBytes:totalBytes,databaseBytes:manifest.databaseBytes};
}
/** Source backend MUST be completely stopped: acquire the same exclusive
 * instance lock as the live runtime and intentionally refuse stale-lock steal.
 * SQLite backup() captures committed WAL data; CAS publication is quiescent
 * while the lock is held. No HTTP/worker snapshot can claim this guarantee.
 */
export async function createColdBackup({dataDir,backupDir,activationRoot}={}){
 const source=location(dataDir),target=location(backupDir);
 disjoint(source,target);
 if(!existsSync(join(source,"db","atelier.sqlite")))
  throw error("backup_source_database_missing");
 await mustAbsent(target);
 const guard=acquireInstanceLock(source,{recoverStale:false});
 let stage=null,db=null,datasetGuard=null;
 try{
  datasetGuard=acquireDatasetGuard(source,{activationRoot});
  stage=await stageFor(target);
  db=new DatabaseSync(join(source,"db","atelier.sqlite"));
  await mustRealDirectory(join(source,"db"));
  initializeSchema(db);
  readIntegrity(db);
  createComfyRegistry(db,{workflowsDir:join(source,"workflows")});
  rebuildBlobReferenceLedger(db);
  await mkdir(join(stage,"db"),{recursive:true,mode:0o700});
  await sqliteBackup(db,join(stage,"db","atelier.sqlite"));
  // Inventory is taken from the committed snapshot, never from a live cursor.
  const copy=await inspectDatabase(join(stage,"db","atelier.sqlite"));
  const original=inventory(db);
  if(JSON.stringify(original)!==JSON.stringify(copy.blobs))
   throw error("backup_source_changed");
  db.close();db=null;
  for(const row of copy.blobs){
   const path=await blobFile(source,row.id);
   const checked=await hashedFile(path,row.byteSize);
   if(checked.sha256!==row.id)throw error("backup_blob_digest_mismatch");
   const dest=join(stage,"blobs",row.id.slice(0,2),row.id);
   await mkdir(dirname(dest),{recursive:true,mode:0o700});
   await copyFile(path,dest);
   const copied=await hashedFile(dest,row.byteSize);
   if(copied.sha256!==row.id)throw error("backup_blob_digest_mismatch");
  }
  for(const item of copy.workflows){
   const sourceFile=await workflowFile(source,item.sha256),checked=await hashedFile(sourceFile);
   if(checked.sha256!==item.sha256)throw error("backup_workflow_digest_mismatch");
   const dest=join(stage,item.path);await mkdir(dirname(dest),{recursive:true,mode:0o700});await copyFile(sourceFile,dest);
   const copied=await hashedFile(dest);if(copied.sha256!==item.sha256)throw error("backup_workflow_digest_mismatch");
  }
  const dbHash=await hashedFile(join(stage,"db","atelier.sqlite"));
  const manifest={
   format:"infinite-atelier-cold-backup",version:2,createdAt:Date.now(),
   lineageId:datasetGuard.identity.lineageId,originRoot:datasetGuard.identity.originRoot,
   schemaVersion:copy.version,databaseSha256:dbHash.sha256,
   databaseBytes:dbHash.bytes,blobs:copy.blobs,workflows:copy.workflows
  };
  await writeFile(join(stage,"manifest.json"),JSON.stringify(manifest)+"\n",{flag:"wx",mode:0o600});
  const verified=await verifyColdBackup({backupDir:stage});
  await mustAbsent(target);
  await rename(stage,target);stage=null;
  return {backupDir:target,...verified};
 }finally{
  try{db?.close()}finally{
   if(stage)await rm(stage,{recursive:true,force:true});
   try{datasetGuard?.release()}finally{guard.release()}
  }
 }
}
/** Non-destructive restore: never overwrite an existing data root. The
 * entire new root is staged and verified before one final directory rename.
 * No app instance can run at target because it must not exist yet.
 * DPAPI ciphertext is portable only to the original Windows user/context.
 */
export async function restoreColdBackup({backupDir,dataDir}={}){
 const source=location(backupDir),target=location(dataDir);
 disjoint(source,target);
 await mustAbsent(target);
 const expected=await verifyColdBackup({backupDir:source});
 const manifest=await parseManifest(source);
 if(manifest.version!==2)throw error("backup_activation_identity_required");
 let stage=null;
 try{
  stage=await stageFor(target);
  await mkdir(join(stage,"db"),{recursive:true,mode:0o700});
  await copyFile(join(source,"db","atelier.sqlite"),join(stage,"db","atelier.sqlite"));
  for(const row of manifest.blobs){
   const dest=join(stage,"blobs",row.id.slice(0,2),row.id);
   await mkdir(dirname(dest),{recursive:true,mode:0o700});
   await copyFile(await blobFile(source,row.id),dest);
  }
  for(const item of manifest.workflows??[]){
   const dest=join(stage,item.path);await mkdir(dirname(dest),{recursive:true,mode:0o700});
   await copyFile(await workflowFile(source,item.sha256),dest);
  }
  await writeFile(join(stage,"manifest.json"),JSON.stringify(manifest)+"\n",{flag:"wx",mode:0o600});
  const checked=await verifyColdBackup({backupDir:stage});
  if(JSON.stringify(expected)!==JSON.stringify(checked))throw error("backup_restore_verification_failed");
  installStandbyIdentity(stage,{lineageId:manifest.lineageId,originRoot:manifest.originRoot});
  // Only user data is published; backup manifest is kept in the source copy.
  await rm(join(stage,"manifest.json"));
  await mustAbsent(target);
  await rename(stage,target);stage=null;
  return {dataDir:target,...checked};
 }finally{if(stage)await rm(stage,{recursive:true,force:true})}
}
