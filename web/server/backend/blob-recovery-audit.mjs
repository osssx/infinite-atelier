import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {lstat,readdir} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {join} from "node:path";
import {acquireInstanceLock} from "./instance-lock.mjs";
import {resolveLocalDataDir} from "./runtime.mjs";

// Strictly diagnostic: never delete an unindexed CAS object or an interrupted
// upload. An unindexed disk file can be the residue of a crash after link()
// but before INSERT into blobs, and must not be silently discarded.
const HASH=/^[0-9a-f]{64}$/;
const fail=code=>Object.assign(Error(code),{code});
export async function auditColdBlobStore({dataDir,maxIssues=100}={}){
 if(!Number.isSafeInteger(maxIssues)||maxIssues<1||maxIssues>500)throw fail("blob_audit_invalid_limit");
 const root=resolveLocalDataDir(dataDir),guard=acquireInstanceLock(root,{recoverStale:false});
 let db;
 const totals={registered:0,verified:0,missing:0,corrupt:0,orphanFiles:0,staleTemps:0,unexpectedFiles:0};
 const issues=[];let truncated=false;
 function issue(type,path){
  totals[type]++;
  if(issues.length<maxIssues)issues.push({type,path});
  else truncated=true;
 }
 async function dirEntries(path){
  try{
   const st=await lstat(path);
   if(st.isSymbolicLink()||!st.isDirectory()){
    issue("unexpectedFiles",path);return [];
   }
   return await readdir(path,{withFileTypes:true});
  }catch(e){if(e.code==="ENOENT")return [];throw e}
 }
 async function fileHash(path,size){
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size!==size)return false;
  const sha=createHash("sha256");let bytes=0;
  for await(const chunk of createReadStream(path)){sha.update(chunk);bytes+=chunk.length}
  return bytes===size?sha.digest("hex"):null;
 }
 try{
  db=new DatabaseSync(join(root,"db","atelier.sqlite"),{readOnly:true});
  if(db.prepare("PRAGMA integrity_check").get()?.integrity_check!=="ok"||
   db.prepare("PRAGMA foreign_key_check").all().length)throw fail("blob_audit_database_integrity_failure");
  const rows=db.prepare("SELECT id,sha256,byte_size,relative_path,status FROM blobs ORDER BY id").all();
  const indexed=new Set(rows.map(x=>x.id));
  for(const row of rows){
   totals.registered++;
   if(!HASH.test(row.id)||row.sha256!==row.id||row.status!=="ready"||
    !Number.isSafeInteger(row.byte_size)||row.byte_size<0||
    row.relative_path!=="blobs/"+row.id.slice(0,2)+"/"+row.id){
    issue("corrupt","blobs/"+String(row.id));continue;
   }
   const blobsRoot=join(root,"blobs"),bucket=join(blobsRoot,row.id.slice(0,2));
   const path=join(bucket,row.id);
   try{
    // Do not follow a symlinked parent into an arbitrary filesystem path.
    const a=await lstat(blobsRoot),b=await lstat(bucket);
    if(!a.isDirectory()||a.isSymbolicLink()||!b.isDirectory()||b.isSymbolicLink()){
     issue("corrupt",row.relative_path);continue;
    }
    const actual=await fileHash(path,row.byte_size);
    if(actual!==row.id)issue("corrupt",row.relative_path);
    else totals.verified++;
   }catch(e){if(e.code==="ENOENT")issue("missing",row.relative_path);else throw e}
  }
  const buckets=await dirEntries(join(root,"blobs"));
  for(const bucket of buckets){
   const prefix=bucket.name;
   if(!/^[0-9a-f]{2}$/.test(prefix)||!bucket.isDirectory()||bucket.isSymbolicLink()){
    issue("unexpectedFiles","blobs/"+prefix);continue;
   }
   const entries=await dirEntries(join(root,"blobs",prefix));
   for(const ent of entries){
    const key="blobs/"+prefix+"/"+ent.name;
    if(!HASH.test(ent.name)||!ent.name.startsWith(prefix)||!ent.isFile()||ent.isSymbolicLink()){
     issue("unexpectedFiles",key);continue;
    }
    if(!indexed.has(ent.name))issue("orphanFiles",key);
   }
  }
  for(const tmp of await dirEntries(join(root,"tmp"))){
   if(tmp.isFile()&&!tmp.isSymbolicLink()&&tmp.name.endsWith(".part"))
    issue("staleTemps","tmp/"+tmp.name);
   else issue("unexpectedFiles","tmp/"+tmp.name);
  }
  const needsReview=totals.missing+totals.corrupt+totals.orphanFiles+totals.staleTemps+totals.unexpectedFiles>0;
  return {ok:!needsReview,needsReview,
   ...totals,issues,truncated,readOnly:true,
   explanation:"Orphans and partial uploads are reported only. No deletion or retry is performed."};
 }finally{try{db?.close()}finally{guard.release()}}
}
