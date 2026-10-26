import {resolve,isAbsolute,join,relative,dirname,basename,sep} from "node:path";
import {realpathSync,existsSync} from "node:fs";
import {homedir} from "node:os";
import {fileURLToPath} from "node:url";
import {openMainDatabase} from "./database.mjs";
import {acquireInstanceLock} from "./instance-lock.mjs";
import {createLocalSessionAuth} from "./session.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createProjectArchive} from "./project-archive.mjs";
import {createMediaPreviewStore} from "./media-preview.mjs";
import {createBlobGarbageCollector} from "./blob-gc.mjs";
import {buildApp} from "./app.mjs";
import {createWindowsDpapiProtector} from "./credential-protection.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {createComfyV2Adapters} from "./comfy-v2-adapter.mjs";
import {createOpenAiModelAdapter} from "./openai-model-adapter.mjs";
import {createArkVideoAdapter} from "./ark-video-adapter.mjs";
import {createCanvasMaterializer} from "./canvas-materializer.mjs";
import {createBackendWorker} from "./worker.mjs";
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
export function createLocalBackend({dataDir,streamPollMs=200,adapters,comfyInstances,comfyUpstreamCall,enableOpenAiModels=false,modelUpstreamCall,enableArkVideos=false,arkUpstreamCall,blobMaxBytes=2_000_000_000,autoDispatch=false,autoLocalSession=false,dispatchIntervalMs=250}={}){
 const root=resolveLocalDataDir(dataDir),lock=acquireInstanceLock(root);
 let db;
 try{
  db=openMainDatabase(root);
  // Fail closed if CurrentUser DPAPI is unavailable; no plaintext fallback.
  const protector=createWindowsDpapiProtector();
  const vault=createCredentialVault({db,protector});
  const sessionAuth=createLocalSessionAuth(),blobStore=createBlobStore({dataDir:root,db,maxBlobBytes:blobMaxBytes});
  const mediaPreview=createMediaPreviewStore({dataDir:root,blobStore});
  const blobGc=createBlobGarbageCollector({db,blobStore});
  const projectArchive=createProjectArchive({db,blobStore});
  // Explicit opt-in only: no adapters means no scheduling/real generation calls.
  // Startup recovery requires the exclusive instance lock acquired above.
  if(comfyInstances&&adapters?.comfy)throw Error("duplicate_comfy_adapter_configuration");
  if((enableOpenAiModels||enableArkVideos)&&adapters?.model)throw Error("duplicate_model_adapter_configuration");
  const comfy=comfyInstances?createComfyV2Adapters({instances:comfyInstances,db,blobStore,
    upstreamCall:comfyUpstreamCall}):null;
  const openai=enableOpenAiModels?createOpenAiModelAdapter({db,blobStore,vault,
    ...(modelUpstreamCall?{upstreamCall:modelUpstreamCall}:{})}):null;
  const ark=enableArkVideos?createArkVideoAdapter({db,blobStore,vault,
    ...(arkUpstreamCall?{upstreamCall:arkUpstreamCall}:{})}):null;
  const model=openai||ark?Object.fromEntries(["prepare","submit","poll","collect","cancel"].map(method=>[
   method,async args=>{
    const provider=args.job.snapshot?.provider??JSON.parse(args.job.snapshot_json).provider;
    const instance=provider==="openai"?openai:provider==="volcengine_ark"?ark:null;
    if(!instance||typeof instance[method]!=="function")throw Error("model_provider_not_enabled");
    return instance[method](args);
   }
  ])):null;
  const configured={...adapters,...(comfy?{comfy}:{}),...(model?{model}:{})};
  if(autoDispatch&&!Object.keys(configured).length)throw Error("auto_dispatch_requires_adapters");
  const coordinator=Object.keys(configured).length?createJobCoordinator({db,adapters:configured,
   retryPolicy:autoDispatch?{pollMs:500,collectMs:1000,maxMs:60000}:null}):null;
  coordinator?.recoverAtStartup();
  const materializer=createCanvasMaterializer({db,blobStore});
  const worker=autoDispatch?createBackendWorker({coordinator,materializer,intervalMs:dispatchIntervalMs}):null;
  const app=buildApp({db,sessionAuth,autoLocalSession,blobStore,mediaPreview,blobGc,projectArchive,vault,coordinator,materializer,worker,
   comfyInstanceIds:comfyInstances?.map(item=>item.id)??[],modelKinds:[...(enableOpenAiModels?["image","audio","text"]:[]),...(enableArkVideos?["video"]:[])],streamPollMs});
  worker?.start();
  let closed=false;
  return {app,db,sessionAuth,vault,blobStore,mediaPreview,blobGc,projectArchive,coordinator,materializer,worker,lock,async close(){
   if(closed)return;closed=true;
   try{await worker?.stop();await coordinator?.stop();await app.close()}
   finally{try{db.close()}finally{lock.release()}}
  }};
 }catch(e){db?.close();lock.release();throw e}
}
