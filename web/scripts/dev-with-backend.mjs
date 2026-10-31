/** Single local Fastify backend + Vite. No Ark/Comfy Gateway process. */
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {resolve,dirname} from "node:path";
import {loadBackendEnv} from "./load-backend-env.mjs";
loadBackendEnv();
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const port=Number(process.env.ATELIER_BACKEND_PORT??"8788");
const vitePort=Number(process.env.ATELIER_VITE_PORT??"3000");
for(const [name,value] of [["vite",vitePort],["backend",port]]){
 if(!Number.isSafeInteger(value)||value<1024||value>65535)throw Error("invalid_"+name+"_port");
}
if(port===vitePort)throw Error("development_service_ports_must_be_distinct");
const children=[];
let stopping=false;
let shutdownPromise;
let backendChild=null;
function start(name,entry,args=[],env={}){
 const child=spawn(process.execPath,[resolve(root,entry),...args],{
  cwd:root,env:{...process.env,...env},stdio:["inherit","inherit","inherit","ipc"],windowsHide:false
 });
 children.push(child);
 child.on("exit",(code,signal)=>{
  if(!stopping){
   console.error(name+" exited: "+(code??signal));
   void shutdown(1);
  }
 });
 return child;
}
async function shutdown(code=0){
 if(shutdownPromise)return shutdownPromise;
 stopping=true;
 process.exitCode=code;
 shutdownPromise=(async()=>{
  const backend=backendChild;
  if(backend?.exitCode===null&&!backend.killed&&backend.connected){
   try{backend.send({type:"atelier:shutdown"})}catch{}
  }
  for(const child of children){
   if(child===backend)continue;
   if(child.exitCode===null&&!child.killed)child.kill();
  }
  const waitForExit=child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>child.once("exit",resolve));
  const allExited=Promise.all(children.map(waitForExit));
  await Promise.race([allExited,new Promise(resolve=>setTimeout(resolve,10000))]);
  for(const child of children)if(child.exitCode===null&&!child.killed)child.kill();
  await Promise.race([allExited,new Promise(resolve=>setTimeout(resolve,1000))]);
 })();
 return shutdownPromise;
}
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>{void shutdown()});
backendChild=start("Atelier backend","scripts/dev-local-backend.mjs");
let ready=false;
for(let i=0;i<100;i++){
 if(backendChild.exitCode!==null)break;
 try{
  const result=await fetch("http://127.0.0.1:"+port+"/health",{signal:AbortSignal.timeout(400)});
  if(result.ok){await new Promise(resolve=>setTimeout(resolve,120));if(backendChild.exitCode===null){ready=true;break}}
 }catch{}
 await new Promise(resolve=>setTimeout(resolve,100));
}
if(!ready){
 console.error("Atelier backend did not start; Canvas will not fall back to browser storage.");
 await shutdown(1);
}else if(!stopping){
 console.log("Atelier backend ready at http://127.0.0.1:"+port+"; starting Vite (no gateway).");
 start("Vite","node_modules/vite/bin/vite.js",["--host","127.0.0.1","--port",String(vitePort),"--strictPort"],{
  ATELIER_BACKEND_URL:"http://127.0.0.1:"+port
 });
}
