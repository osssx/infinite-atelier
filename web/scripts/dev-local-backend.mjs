import {createLocalBackend} from "../server/backend/runtime.mjs";
import {startServer} from "../server/backend/app.mjs";

const raw=process.env.ATELIER_BACKEND_PORT??"8788";
const port=Number(raw);
if(!Number.isInteger(port)||port<1024||port>65535){
 throw Error("ATELIER_BACKEND_PORT must be between 1024 and 65535");
}
const runtime=createLocalBackend(); // local-only; no adapter/autoDispatch unless explicitly configured
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
 console.log("One-time session bootstrap token (copy to Canvas sync dialog; never commit or share):");
 console.log(runtime.sessionAuth.bootstrapToken);
 console.log("Start Vite with ATELIER_BACKEND_URL=http://127.0.0.1:"+port);
}catch(error){
 await shutdown();
 throw error;
}
