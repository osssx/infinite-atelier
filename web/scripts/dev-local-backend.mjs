import {createLocalBackend,resolveLocalDataDir} from "../server/backend/runtime.mjs";
import {adoptMovedDataset} from "../server/backend/dataset-activation.mjs";
import {startServer} from "../server/backend/app.mjs";
import {loadBackendEnv} from "./load-backend-env.mjs";
import {existsSync,readdirSync} from "node:fs";
import {join} from "node:path";
loadBackendEnv();
const dataRoot=resolveLocalDataDir();
// Support relocating a stopped dataset by cutting all its files to this root.
if(process.env.ATELIER_DATA_DIR!==undefined&&existsSync(dataRoot)&&
   !existsSync(join(dataRoot,"atelier-dataset-identity.json"))&&
   readdirSync(dataRoot).length>0)
 throw Error("configured_data_directory_incomplete: expected the complete old data directory including atelier-dataset-identity.json");
const relocation=adoptMovedDataset(dataRoot);
if(relocation.migrated)
 console.log("Activated moved data directory:",relocation.from,"=>",relocation.to);
if(process.env.ATELIER_DATA_DIR!==undefined&&!existsSync(join(dataRoot,"db","atelier.sqlite")))
 console.warn("Configured ATELIER_DATA_DIR has no existing SQLite database. A new dataset will be initialized; existing projects/media are NOT migrated.");

const raw=process.env.ATELIER_BACKEND_PORT??"8788";
const port=Number(raw);
if(!Number.isInteger(port)||port<1024||port>65535){
 throw Error("ATELIER_BACKEND_PORT must be between 1024 and 65535");
}
// Local SQLite model adapters are available by default. Generation itself
// remains user-triggered and requires an authorized DPAPI channel key.
const comfyId=process.env.ATELIER_COMFY_INSTANCE_ID;
const comfyUrl=process.env.ATELIER_COMFY_URL;
if(Boolean(comfyId)!==Boolean(comfyUrl))
 throw Error("ATELIER_COMFY_INSTANCE_ID and ATELIER_COMFY_URL must be set together");
// An initial local instance is always available for configuration. SQLite
// persists subsequent edits; legacy gateway instance state is not authoritative.
const comfyInstances=[{id:comfyId||"comfy-local",url:comfyUrl||"http://127.0.0.1:8188"}];
const enableOpenAiModels=true;
const enableArkVideos=true;
const runtime=createLocalBackend({comfyInstances,enableComfyManagement:true,enableOpenAiModels,enableArkVideos,
 autoDispatch:true,autoLocalSession:true});
let stopped=false;
let shutdownPromise;
async function shutdown(){
 if(shutdownPromise)return shutdownPromise;
 stopped=true;
 shutdownPromise=runtime.close();
 return shutdownPromise;
}
async function exitAfterShutdown(code=0){
 try{await shutdown();process.exit(code)}catch(error){
  console.error("Local backend shutdown failed:",error?.message||"unknown");
  process.exit(1);
 }
}
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>{
 void exitAfterShutdown(0);
});
process.on("message",message=>{
 if(message?.type==="atelier:shutdown")void exitAfterShutdown(0);
});
process.on("disconnect",()=>{
 if(!stopped)void exitAfterShutdown(0);
});
try{
 const address=await startServer(runtime.app,{host:"127.0.0.1",port});
 console.log("Infinite Atelier private backend ready:",address);
 console.log("Backend storage root:",dataRoot);
 console.log("Comfy SQLite instances:",runtime.comfyRegistry.list().map(item=>item.id).join(", ")||"none (configure in settings)");
 console.log("SQLite OpenAI / Volcengine Ark model adapters: enabled by default (DPAPI channel required).");
 console.log("Canvas sessions: automatic same-origin loopback login (no manual token).");
 console.log("API origin: http://127.0.0.1:"+port);
}catch(error){
 await shutdown();
 throw error;
}
