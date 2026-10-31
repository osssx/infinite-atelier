import {openSync,closeSync,readFileSync,writeFileSync,unlinkSync,existsSync,mkdirSync} from "node:fs";
import {join,isAbsolute,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";

const LOCK_VERSION=2;
const PROCESS_QUERY_TIMEOUT_MS=2000;
let currentProcessStartedAt;

function fail(code,{path,pid,reason,cause}={}){
 const details=[path&&`lock=${path}`,Number.isSafeInteger(pid)&&`pid=${pid}`,reason&&`reason=${reason}`].filter(Boolean);
 const error=Object.assign(Error([code,...details].join(":")),{code});
 if(path)error.path=path;
 if(Number.isSafeInteger(pid))error.pid=pid;
 if(reason)error.reason=reason;
 if(cause)error.cause=cause;
 return error;
}

function pidAlive(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)return true;
 try{process.kill(pid,0);return true}catch(e){return e.code!=="ESRCH"}
}

/**
 * Query the Windows process creation time without adding a runtime dependency.
 * A null result means the PID no longer exists; all other query failures are
 * deliberately surfaced so a live owner is never guessed away.
 */
function queryWindowsProcessStartedAt(pid){
 const command="$ErrorActionPreference='Stop';$target=Get-Process -Id "+String(pid)+" -ErrorAction SilentlyContinue;if($null -eq $target){exit 3};[Console]::Write($target.StartTime.ToUniversalTime().Ticks)";
 const result=spawnSync("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-WindowStyle","Hidden","-Command",command],{
  encoding:"utf8",timeout:PROCESS_QUERY_TIMEOUT_MS,windowsHide:true,maxBuffer:1024
 });
 if(result.error)throw fail("instance_lock_identity_unavailable",{pid,reason:"process_start_time_query_failed",cause:result.error});
 if(result.status===3)return null;
 if(result.status!==0)throw fail("instance_lock_identity_unavailable",{pid,reason:"process_start_time_query_failed",cause:result.stderr?.trim()||`powershell_exit_${result.status}`});
 const value=String(result.stdout??"").trim();
 if(!/^\d+$/.test(value))throw fail("instance_lock_identity_unavailable",{pid,reason:"invalid_process_start_time"});
 return value;
}

function processStartedAt(pid){
 if(process.platform!=="win32")return null;
 if(pid===process.pid&&currentProcessStartedAt!==undefined)return currentProcessStartedAt;
 const value=queryWindowsProcessStartedAt(pid);
 if(pid===process.pid){
  if(value===null)throw fail("instance_lock_identity_unavailable",{pid,reason:"current_process_not_found"});
  currentProcessStartedAt=value;
 }
 return value;
}

function createOwnerIdentity(pid){
 return {version:LOCK_VERSION,pid,processStartedAt:processStartedAt(pid)};
}

function ownerState(previous,path){
 if(!previous?.token||!Number.isSafeInteger(previous.pid)||previous.pid<=0)
  throw fail("instance_lock_recovery_required",{path,reason:"malformed_lock_owner"});
 const identityFieldValid=process.platform==="win32"?typeof previous.processStartedAt==="string":previous.processStartedAt===null;
 if(previous.version!==LOCK_VERSION||!identityFieldValid){
  if(!pidAlive(previous.pid))return "stale";
  throw fail("instance_lock_legacy",{path,pid:previous.pid,reason:"process_identity_missing"});
 }
 if(process.platform!=="win32")return pidAlive(previous.pid)?"live":"stale";
 const actual=processStartedAt(previous.pid);
 if(actual===null)return "stale";
 return actual===previous.processStartedAt?"live":"stale";
}

/** Fail-closed process lock. Recovery requires an owner that is proven dead
 * or whose PID now belongs to a different process. A second exclusive
 * recovery mutex protects the stale recheck/unlink sequence.
 */
export function acquireInstanceLock(dataDir,{recoverStale=true}={}){
 if(typeof dataDir!=="string"||!isAbsolute(dataDir))throw fail("absolute_data_dir_required");
 const root=resolve(dataDir);mkdirSync(root,{recursive:true,mode:0o700});
 const path=join(root,"atelier-instance.lock"),token=randomUUID();
 const create=()=>{
  const fd=openSync(path,"wx",0o600);
  let closed=false;
  try{
   const owner=createOwnerIdentity(process.pid);
   writeFileSync(fd,JSON.stringify({...owner,token,createdAt:Date.now()}));
  }catch(error){
   closeSync(fd);closed=true;
   try{unlinkSync(path)}catch{}
   throw error;
  }finally{if(!closed)closeSync(fd)}
 };
 const handle=()=>{
  let released=false;
  return {path,token,release(){
   if(released)return;released=true;
   try{const data=JSON.parse(readFileSync(path,"utf8"));if(data.token===token)unlinkSync(path)}
   catch(e){if(e.code!=="ENOENT")throw e}
  }};
 };
 try{create();return handle();}catch(e){
  if(e.code!=="EEXIST")throw e;
  if(!recoverStale)throw fail("instance_already_running",{path,reason:"recovery_disabled"});
 }
 const recoverPath=join(root,"atelier-recovery.lock");
 let recoveryFd;
 try{recoveryFd=openSync(recoverPath,"wx",0o600)}
 catch(e){if(e.code==="EEXIST")throw fail("instance_lock_recovery_required",{path:recoverPath,reason:"recovery_mutex_exists"});throw e}
 try{
  let previous;
  try{previous=JSON.parse(readFileSync(path,"utf8"))}
  catch(e){if(e.code==="ENOENT"){create();return handle();}throw fail("instance_lock_recovery_required",{path,reason:"malformed_lock",cause:e});}
  const state=ownerState(previous,path);
  if(state!=="stale")throw fail("instance_already_running",{path,pid:previous.pid,reason:"owner_is_running"});
  const current=JSON.parse(readFileSync(path,"utf8"));
  if(current.token!==previous.token)throw fail("instance_already_running",{path,reason:"lock_changed_during_recovery"});
  unlinkSync(path);
  create();
  return handle();
 }finally{
  closeSync(recoveryFd);
  try{unlinkSync(recoverPath)}catch{}
 }
}
export function hasInstanceLock(dataDir){return existsSync(join(dataDir,"atelier-instance.lock"))}
