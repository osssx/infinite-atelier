import {createLocalBackend} from "../server/backend/runtime.mjs";
import {startServer} from "../server/backend/app.mjs";

const raw=process.env.ATELIER_BACKEND_PORT??"8788";
const port=Number(raw);
if(!Number.isInteger(port)||port<1024||port>65535){
 throw Error("ATELIER_BACKEND_PORT must be between 1024 and 65535");
}
// Real Comfy is intentionally opt-in. Without both variables this remains
// the safe project-sync-only backend and never initiates GPU submissions.
const comfyId=process.env.ATELIER_COMFY_INSTANCE_ID;
const comfyUrl=process.env.ATELIER_COMFY_URL;
if(Boolean(comfyId)!==Boolean(comfyUrl))
 throw Error("ATELIER_COMFY_INSTANCE_ID and ATELIER_COMFY_URL must be set together");
const comfyInstances=comfyId&&comfyUrl?[{id:comfyId,url:comfyUrl}]:undefined;
const runtime=createLocalBackend({comfyInstances,autoDispatch:Boolean(comfyInstances),autoLocalSession:true});
let stopped=false;
async function shutdown(){
 if(stopped)return;
 stopped=true;
 await runtime.close();
}
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>{
 void shutdown().then(()=>process.exit(0)).catch(error=>{
  console.error("Local backend shutdown failed:",error?.message||"unknown");
  process.exit(1);
 });
});
try{
 const address=await startServer(runtime.app,{host:"127.0.0.1",port});
 console.log("Infinite Atelier private backend ready:",address);
 console.log("Comfy backend GPU dispatch:",comfyInstances?"enabled (explicit opt-in)":"disabled");
 console.log("Canvas sessions: automatic same-origin loopback login (no manual token).");
 console.log("API origin: http://127.0.0.1:"+port);
}catch(error){
 await shutdown();
 throw error;
}
