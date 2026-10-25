import {openSync,closeSync,readFileSync,writeFileSync,unlinkSync,existsSync,mkdirSync} from "node:fs";
import {join,isAbsolute,resolve} from "node:path";
import {randomUUID} from "node:crypto";
const fail=code=>Object.assign(Error(code),{code});
function pidAlive(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)return true;
 try{process.kill(pid,0);return true}catch(e){return e.code!=="ESRCH"}
}
/** Fail-closed PID lock. Only a verified-dead owner can be recovered, with
 * a second exclusive recovery mutex protecting the stale recheck/unlink.
 * An orphan recovery mutex requires operator attention; no unsafe steal.
 */
export function acquireInstanceLock(dataDir,{recoverStale=true}={}){
 if(typeof dataDir!=="string"||!isAbsolute(dataDir))throw fail("absolute_data_dir_required");
 const root=resolve(dataDir);mkdirSync(root,{recursive:true,mode:0o700});
 const path=join(root,"atelier-instance.lock"),token=randomUUID();
 const create=()=>{
  const fd=openSync(path,"wx",0o600);
  try{writeFileSync(fd,JSON.stringify({pid:process.pid,token,createdAt:Date.now()}))}
  finally{closeSync(fd)}
 };
 const handle=()=>{
  let released=false;
  return {path,token,release(){
   if(released)return;released=true;
   try{const data=JSON.parse(readFileSync(path,"utf8"));if(data.token===token)unlinkSync(path)}
   catch(e){if(e.code!=="ENOENT")throw e}
  }};
 };
 try{create();return handle()}catch(e){
  if(e.code!=="EEXIST")throw e;
  if(!recoverStale)throw fail("instance_already_running");
 }
 const recoverPath=join(root,"atelier-recovery.lock");
 let recoveryFd;
 try{recoveryFd=openSync(recoverPath,"wx",0o600)}
 catch(e){if(e.code==="EEXIST")throw fail("instance_lock_recovery_required");throw e}
 try{
  let previous;
  try{previous=JSON.parse(readFileSync(path,"utf8"))}
  catch(e){if(e.code==="ENOENT"){create();return handle()}throw fail("instance_lock_recovery_required")}
  if(!previous?.token||!Number.isSafeInteger(previous.pid)||pidAlive(previous.pid))
   throw fail("instance_already_running");
  const current=JSON.parse(readFileSync(path,"utf8"));
  if(current.token!==previous.token)throw fail("instance_already_running");
  unlinkSync(path);
  create();
  return handle();
 }finally{
  closeSync(recoveryFd);
  try{unlinkSync(recoverPath)}catch{}
 }
}
export function hasInstanceLock(dataDir){return existsSync(join(dataDir,"atelier-instance.lock"))}
