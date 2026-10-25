import {resolve,isAbsolute,join,relative,dirname,basename,sep} from "node:path";
import {realpathSync,existsSync} from "node:fs";
import {homedir} from "node:os";
import {fileURLToPath} from "node:url";
import {openMainDatabase} from "./database.mjs";
import {acquireInstanceLock} from "./instance-lock.mjs";
import {createLocalSessionAuth} from "./session.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {buildApp} from "./app.mjs";
import {createWindowsDpapiProtector} from "./credential-protection.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
/** Resolve the user-data directory; reject worktree paths and junction aliases. */
const sourceRoot=realpathSync(fileURLToPath(new URL("../../../",import.meta.url)));
export function resolveLocalDataDir(dataDir=process.env.ATELIER_DATA_DIR){
 const defaultDir=process.platform==="win32"
  ?join(process.env.LOCALAPPDATA||join(homedir(),"AppData","Local"),"InfiniteAtelier","data")
  :join(process.env.XDG_DATA_HOME||join(homedir(),".local","share"),"InfiniteAtelier","data");
 const input=dataDir??defaultDir;
 if(typeof input!=="string"||!isAbsolute(input))throw Error("absolute_data_dir_required");
 let existing=resolve(input);const suffix=[];
 while(!existsSync(existing)){
  suffix.unshift(basename(existing));
  const parent=dirname(existing);
  if(parent===existing)throw Error("invalid_data_dir");
  existing=parent;
 }
 const actual=resolve(realpathSync(existing),...suffix),rel=relative(sourceRoot,actual);
 if(!rel||(!isAbsolute(rel)&&rel!==".."&&!rel.startsWith(".."+sep)))throw Error("data_dir_inside_repo");
 return actual;
}
/** Explicit opt-in backend assembly. Does not replace existing dev/start or Comfy gateway. */
export function createLocalBackend({dataDir,streamPollMs=200}={}){
 const root=resolveLocalDataDir(dataDir),lock=acquireInstanceLock(root);
 let db;
 try{
  db=openMainDatabase(root);
  // Fail closed if CurrentUser DPAPI is unavailable; no plaintext fallback.
  const protector=createWindowsDpapiProtector();
  const vault=createCredentialVault({db,protector});
  const sessionAuth=createLocalSessionAuth(),blobStore=createBlobStore({dataDir:root,db});
  const app=buildApp({db,sessionAuth,blobStore,vault,streamPollMs});
  let closed=false;
  return {app,db,sessionAuth,vault,lock,async close(){
   if(closed)return;closed=true;
   try{await app.close()}finally{try{db.close()}finally{lock.release()}}
  }};
 }catch(e){db?.close();lock.release();throw e}
}
