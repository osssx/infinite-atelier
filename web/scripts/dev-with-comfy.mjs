/** Development-only: launch authenticated local gateway and Vite with one shared secret. */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root=fileURLToPath(new URL("../",import.meta.url));
const port=Number(process.env.PORT||8787);
const gatewayUrl="http://127.0.0.1:"+port;
const configured=process.env.MEDIA_GATEWAY_URL;
if(configured && configured.replace(/\/$/,"")!==gatewayUrl){
    console.error("dev:comfy targets "+gatewayUrl+"; unset MEDIA_GATEWAY_URL or run the servers separately.");
    process.exit(1);
}
const token=process.env.GATEWAY_TOKEN||randomBytes(32).toString("hex");
const env={...process.env,GATEWAY_TOKEN:token,MEDIA_GATEWAY_URL:gatewayUrl,GATEWAY_HOST:"127.0.0.1",PORT:String(port)};
let gateway, vite, stopping=false;
function terminate(child){if(child && child.exitCode===null){try{child.kill()}catch{}}}
function stop(){
    if(stopping)return;
    stopping=true;
    terminate(vite);
    terminate(gateway);
}
process.on("SIGINT",()=>{stop();process.exitCode=130;});
process.on("SIGTERM",()=>{stop();process.exitCode=143;});
function monitor(child,name){
    child.on("error",err=>{console.error(name+" failed:",err);process.exitCode=1;stop();});
    child.on("exit",(code,signal)=>{
        if(stopping)return;
        console.error(name+" stopped ("+(signal||code)+"); shutting down development services.");
        process.exitCode=code||1;stop();
    });
}
gateway=spawn(process.execPath,["server/ark-gateway.mjs"],{cwd:root,env,stdio:"inherit"});
monitor(gateway,"ark-gateway");
let available=false;
for(let n=0;n<40 && !stopping;n++){
    try{
        const result=await fetch(gatewayUrl+"/api/comfy/templates",{
            headers:{"x-gateway-token":token},signal:AbortSignal.timeout(1000)
        });
        if(result.ok){available=true;break;}
    }catch{/* gateway still starting */}
    await new Promise(resolve=>setTimeout(resolve,250));
}
if(!available){
    console.error("Local ComfyUI gateway did not become ready. Check port "+port+" and GATEWAY_TOKEN.");
    process.exitCode=1;stop();
}else{
    console.log("ComfyUI gateway ready at "+gatewayUrl+". Starting Vite with the matching gateway token.");
    vite=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","0.0.0.0","--port",process.env.COMFY_DEV_PORT||"3000","--strictPort"],{cwd:root,env,stdio:"inherit"});
    monitor(vite,"vite");
}
