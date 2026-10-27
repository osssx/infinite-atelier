import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {fileURLToPath} from "node:url";
import {resolve,dirname} from "node:path";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const port=Number(process.env.ATELIER_BACKEND_PORT??"8788");
const vitePort=Number(process.env.ATELIER_VITE_PORT??"3000");
const gatewayPort=Number(process.env.ATELIER_GATEWAY_PORT??process.env.PORT??"8787");
for(const [name,value] of [["vite",vitePort],["backend",port],["gateway",gatewayPort]]) {
 if(!Number.isSafeInteger(value)||value<1024||value>65535)throw Error("invalid_"+name+"_port");
}
if(new Set([port,vitePort,gatewayPort]).size!==3)throw Error("development_service_ports_must_be_distinct");
const gatewayUrl="http://127.0.0.1:"+gatewayPort;
if(process.env.MEDIA_GATEWAY_URL && process.env.MEDIA_GATEWAY_URL.replace(/\/$/,"")!==gatewayUrl)
 throw Error("MEDIA_GATEWAY_URL must match the local gateway at "+gatewayUrl+" when using npm run dev");
// Keep the credential entirely server-side: Vite injects it into its /api/comfy proxy.
const gatewayToken=process.env.GATEWAY_TOKEN||randomBytes(32).toString("hex");
const gatewayEnv={PORT:String(gatewayPort),GATEWAY_HOST:"127.0.0.1",GATEWAY_TOKEN:gatewayToken,MEDIA_GATEWAY_URL:gatewayUrl};
const children=[];
let stopping=false;
function start(name,entry,args=[],env={},critical=true){
 const child=spawn(process.execPath,[resolve(root,entry),...args],{
  cwd:root,env:{...process.env,...env},stdio:"inherit",windowsHide:false
 });
 children.push(child);
 child.on("exit",(code,signal)=>{
  if(!stopping){
   console.error(name+" exited: "+(code??signal));
   if(critical)void shutdown(1);
   else console.error("Optional ComfyUI gateway stopped; SQLite backend and Vite remain available.");
  }
 });
 return child;
}
async function shutdown(code=0){
 if(stopping)return;stopping=true;
 for(const child of children)if(child.exitCode===null&&!child.killed)child.kill();
 // The local backend keeps a process lock and drains the worker on SIGTERM.
 process.exitCode=code;
}
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>{void shutdown()});
const backend=start("SQLite backend","scripts/dev-local-backend.mjs");
let ready=false;
for(let i=0;i<100;i++){
 if(backend.exitCode!==null)break;
 try{
  const result=await fetch("http://127.0.0.1:"+port+"/health",{signal:AbortSignal.timeout(400)});
  if(result.ok){await new Promise(resolve=>setTimeout(resolve,120));if(backend.exitCode===null){ready=true;break}}
 }catch{}
 await new Promise(resolve=>setTimeout(resolve,100));
}
if(!ready){
 console.error("SQLite backend did not start; Canvas will not fall back to browser storage.");
 await shutdown(1);
}else{
 const gateway=start("ComfyUI gateway","server/ark-gateway.mjs",[],gatewayEnv,false);
 let gatewayReady=false;
 for(let i=0;i<60 && !stopping;i++){
  if(gateway.exitCode!==null)break;
  try{
   // This route is local and does not depend on an online ComfyUI instance.
   const response=await fetch(gatewayUrl+"/api/comfy/templates",{
    headers:{"x-gateway-token":gatewayToken},signal:AbortSignal.timeout(700)
   });
   if(response.ok && gateway.exitCode===null){gatewayReady=true;break;}
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 if(!gatewayReady){
  console.error("ComfyUI gateway unavailable at "+gatewayUrl+". Check port conflicts and gateway startup errors; other features remain usable.");
 }else{
  console.log("ComfyUI gateway ready at "+gatewayUrl+" (shared token injected by Vite).");
 }
 if(!stopping)start("Vite","node_modules/vite/bin/vite.js",["--host","127.0.0.1","--port",String(vitePort),"--strictPort"],{
  ...gatewayEnv,ATELIER_BACKEND_URL:"http://127.0.0.1:"+port
 });
}
