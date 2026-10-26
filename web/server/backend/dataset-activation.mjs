import {createHash,randomUUID} from "node:crypto";
import {existsSync,mkdirSync,openSync,closeSync,readSync,readFileSync,writeFileSync,renameSync,unlinkSync,lstatSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {homedir} from "node:os";
import {isAbsolute,join,resolve} from "node:path";
import {acquireInstanceLock} from "./instance-lock.mjs";

const fail=code=>Object.assign(Error(code),{code,statusCode:409});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const IDENTITY="atelier-dataset-identity.json";
const format="infinite-atelier-dataset-identity";
const formatRegistry="infinite-atelier-active-dataset";
export function defaultActivationRoot(){
 return process.platform==="win32"?
  join(process.env.LOCALAPPDATA||join(homedir(),"AppData","Local"),"InfiniteAtelier","activation"):
  join(process.env.XDG_DATA_HOME||join(homedir(),".local","share"),"InfiniteAtelier","activation");
}
function canonicalRoot(path){
 if(typeof path!=="string"||!isAbsolute(path))throw fail("dataset_absolute_path_required");
 return resolve(path);
}
function validateIdentity(data,root){
 if(!data||data.format!==format||data.version!==1||
  !UUID.test(data.lineageId)||!UUID.test(data.replicaId)||
  !["active","standby"].includes(data.status)||
  typeof data.originRoot!=="string"||!isAbsolute(data.originRoot))
  throw fail("dataset_identity_invalid");
 // A copied identity file cannot silently register a new active location:
 // it must be the origin or be explicitly promoted from a standby clone.
 if(data.status==="active"&&root!==resolve(data.originRoot)&&
  root!==resolve(data.currentRoot??""))
  throw fail("dataset_identity_location_mismatch");
 return data;
}
function fileOf(root){return join(root,IDENTITY)}
function writeAtomic(path,data){
 const tmp=path+"."+randomUUID()+".tmp";
 let fd;
 try{
  fd=openSync(tmp,"wx",0o600);
  writeFileSync(fd,JSON.stringify(data)+"\n");
  closeSync(fd);fd=null;
  renameSync(tmp,path);
 }finally{
  if(fd!==undefined&&fd!==null)closeSync(fd);
  try{unlinkSync(tmp)}catch(e){if(e.code!=="ENOENT")throw e}
 }
}
export function readDatasetIdentity(dataDir,{bootstrap=false}={}){
 const root=canonicalRoot(dataDir),file=fileOf(root);
 if(!existsSync(file)){
  if(!bootstrap)throw fail("dataset_identity_missing");
  const identity={format,version:1,lineageId:randomUUID(),replicaId:randomUUID(),
   status:"active",originRoot:root,currentRoot:root};
  const fd=openSync(file,"wx",0o600);
  try{writeFileSync(fd,JSON.stringify(identity)+"\n")}finally{closeSync(fd)}
 }
 const stats=lstatSync(file);
 if(!stats.isFile()||stats.isSymbolicLink()||stats.size>8192)
  throw fail("dataset_identity_invalid");
 let identity;
 try{identity=JSON.parse(readFileSync(file,"utf8"))}catch{throw fail("dataset_identity_invalid")}
 return validateIdentity(identity,root);
}
export function installStandbyIdentity(dataDir,{lineageId,originRoot}={}){
 const root=canonicalRoot(dataDir);
 if(!UUID.test(lineageId)||typeof originRoot!=="string"||!isAbsolute(originRoot))
  throw fail("dataset_identity_invalid");
 if(existsSync(fileOf(root)))throw fail("dataset_identity_already_exists");
 const identity={format,version:1,lineageId,replicaId:randomUUID(),status:"standby",
  originRoot:resolve(originRoot),currentRoot:root};
 const fd=openSync(fileOf(root),"wx",0o600);
 try{writeFileSync(fd,JSON.stringify(identity)+"\n")}finally{closeSync(fd)}
 return identity;
}
function registryPath(activationRoot,lineageId){
 const base=canonicalRoot(activationRoot);
 mkdirSync(base,{recursive:true,mode:0o700});
 const root=join(base,lineageId);
 mkdirSync(root,{recursive:true,mode:0o700});
 return {root,file:join(root,"active.json"),established:join(root,"registry-established")};
}
function readRegistry(path){
 if(!existsSync(path))return null;
 let data;
 try{data=JSON.parse(readFileSync(path,"utf8"))}catch{throw fail("dataset_registry_invalid")}
 if(data?.format!==formatRegistry||data.version!==1||
  !UUID.test(data.lineageId)||!UUID.test(data.activeReplicaId)||
  typeof data.activeRoot!=="string"||!isAbsolute(data.activeRoot))
  throw fail("dataset_registry_invalid");
 return data;
}
function matches(identity,root,registry){
 return registry?.lineageId===identity.lineageId&&
  registry.activeReplicaId===identity.replicaId&&
  resolve(registry.activeRoot)===root;
}
/** Process-wide guard shared by every clone of a backed-up dataset.
 * Must be acquired BEFORE the coordinator can recover/start submitting.
 * First-run registration is allowed only for the original identity.
 */
export function acquireDatasetGuard(dataDir,{activationRoot=defaultActivationRoot(),
 bootstrap=true}={}){
 const root=canonicalRoot(dataDir);
 const identity=readDatasetIdentity(root,{bootstrap});
 const holder=registryPath(activationRoot,identity.lineageId);
 const mutex=acquireInstanceLock(holder.root); // process-verifiable stale lock recovery
 try{
  let registry=readRegistry(holder.file);
  if(!registry){
   // A deleted/corrupt active registry must not let the original silently
   // reclaim a lineage already promoted to another root.
   if(existsSync(holder.established))throw fail("dataset_registry_missing");
   if(identity.status!=="active"||resolve(identity.originRoot)!==root)
    throw fail("dataset_activation_required");
   const marker=openSync(holder.established,"wx",0o600);
   try{writeFileSync(marker,"1\\n")}finally{closeSync(marker)}
   registry={format:formatRegistry,version:1,lineageId:identity.lineageId,
    activeReplicaId:identity.replicaId,activeRoot:root,updatedAt:Date.now()};
   writeAtomic(holder.file,registry);
  }
  if(identity.status!=="active"||!matches(identity,root,registry))
   throw fail("dataset_not_active");
  return {identity,release:()=>mutex.release()};
 }catch(e){mutex.release();throw e}
}
/** Pre-activation audit of the restored SQLite and all registered CAS bytes.
 * This is intentionally offline and streaming (fixed 1 MiB buffer).
 * The dataset local process lock must already be held by the caller.
 */
function auditRestoredDataset(root){
 let db;
 const rejected=()=>{throw fail("dataset_restore_integrity_failed")};
 try{
  const parent=join(root,"db"),dbFile=join(parent,"atelier.sqlite");
  const p=lstatSync(parent),info=lstatSync(dbFile);
  if(p.isSymbolicLink()||!p.isDirectory()||info.isSymbolicLink()||!info.isFile())rejected();
  db=new DatabaseSync(dbFile,{readOnly:true});
  const integrity=db.prepare("PRAGMA integrity_check").all();
  if(integrity.length!==1||integrity[0].integrity_check!=="ok"||
   db.prepare("PRAGMA foreign_key_check").all().length)rejected();
  const rows=db.prepare("SELECT id,sha256,byte_size,relative_path,status FROM blobs").all();
  for(const item of rows){
   if(!/^[a-f0-9]{64}$/.test(item.id)||item.sha256!==item.id||
    !Number.isSafeInteger(item.byte_size)||item.byte_size<0||
    item.relative_path!=="blobs/"+item.id.slice(0,2)+"/"+item.id||
    item.status!=="ready")rejected();
   const dir=join(root,"blobs"),bucket=join(dir,item.id.slice(0,2));
   for(const d of [dir,bucket]){
    const st=lstatSync(d);
    if(st.isSymbolicLink()||!st.isDirectory())rejected();
   }
   const file=join(bucket,item.id),st=lstatSync(file);
   if(st.isSymbolicLink()||!st.isFile()||st.size!==item.byte_size)rejected();
   const fd=openSync(file,"r"),bytes=Buffer.allocUnsafe(1024*1024),hash=createHash("sha256");
   let size=0;
   try{
    for(;;){const n=readSync(fd,bytes,0,bytes.length,null);if(!n)break;size+=n;hash.update(bytes.subarray(0,n))}
   }finally{closeSync(fd)}
   if(size!==item.byte_size||hash.digest("hex")!==item.id)rejected();
  }
 }catch(e){
  if(e.code==="dataset_restore_integrity_failed")throw e;
  rejected();
 }finally{db?.close()}
}
/** Explicit OFFLINE fail-closed switch. Does not start any backend.
 * The old lineage holder must be stopped; activating standby permanently
 * fences the old root on this OS user account until another explicit switch.
 */
export function activateRestoredDataset(dataDir,{activationRoot=defaultActivationRoot(),
 confirmation}={}){
 if(confirmation!=="ACTIVATE_RESTORED_DATASET")throw fail("dataset_confirmation_required");
 const root=canonicalRoot(dataDir);
 const local=acquireInstanceLock(root,{recoverStale:false});
 let mutex;
 try{
  const identity=readDatasetIdentity(root);
  if(identity.status!=="standby")throw fail("dataset_not_standby");
  const holder=registryPath(activationRoot,identity.lineageId);
  mutex=acquireInstanceLock(holder.root,{recoverStale:false});
  const registry=readRegistry(holder.file);
  // If the original registry disappeared, explicit promotion is allowed,
  // but never a silent first-start of a copied dataset.
  if(registry&&registry.lineageId!==identity.lineageId)
   throw fail("dataset_registry_invalid");
  auditRestoredDataset(root);
  const next={format:formatRegistry,version:1,lineageId:identity.lineageId,
   activeReplicaId:identity.replicaId,activeRoot:root,updatedAt:Date.now()};
  if(!existsSync(holder.established)){
   const marker=openSync(holder.established,"wx",0o600);
   try{writeFileSync(marker,"1\\n")}finally{closeSync(marker)}
  }
  writeAtomic(holder.file,next);
  writeAtomic(fileOf(root),{...identity,status:"active",currentRoot:root});
  return {lineageId:identity.lineageId,replicaId:identity.replicaId,activeRoot:root};
 }finally{try{mutex?.release()}finally{local.release()}}
}
