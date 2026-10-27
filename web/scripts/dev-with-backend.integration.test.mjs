import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {createServer} from "node:net";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";

const webDir=resolve(dirname(fileURLToPath(import.meta.url)),"..");
async function freePort(){
 const server=createServer();
 await new Promise((done,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",done)});
 const port=server.address().port;
 await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));
 return port;
}
async function jsonRequest(base,path,init,timeoutMs=2000){
 const response=await fetch(base+path,{...init,signal:AbortSignal.timeout(timeoutMs)});
 const text=await response.text();
 let body;
 try {body=JSON.parse(text);}catch {throw Error("Non-JSON HTTP "+response.status+" for "+path+": "+text.slice(0,300));}
 return {status:response.status,body};
}

test("default dev launcher makes Comfy instance configuration available through Vite",{
 skip:process.platform!=="win32" && "local backend uses Windows DPAPI",
 timeout:60000,
},async()=>{
 const temp=mkdtempSync(join(tmpdir(),"atelier-comfy-dev-test-"));
 const [backendPort,gatewayPort,vitePort]=await Promise.all([freePort(),freePort(),freePort()]);
 assert.equal(new Set([backendPort,gatewayPort,vitePort]).size,3);
 const env={...process.env,
  ATELIER_DATA_DIR:join(temp,"data"),COMFY_DATA_DIR:join(temp,"comfy"),
  ATELIER_BACKEND_PORT:String(backendPort),ATELIER_GATEWAY_PORT:String(gatewayPort),
  ATELIER_VITE_PORT:String(vitePort),GATEWAY_TOKEN:"dev-gateway-smoke-only",
  MEDIA_GATEWAY_URL:"http://127.0.0.1:"+gatewayPort,
 };
 let log="";
 const child=spawn(process.execPath,["scripts/dev-with-backend.mjs"],{
  cwd:webDir,env,windowsHide:true,stdio:["ignore","pipe","pipe"]
 });
 for(const stream of [child.stdout,child.stderr])stream.on("data",data=>{
  log=(log+data.toString()).slice(-12000);
 });
 try {
  const base="http://127.0.0.1:"+vitePort;
  let result,lastError,session,cookie="";
  const deadline=Date.now()+12000;
  while(Date.now()<deadline){
   if(child.exitCode!==null)throw Error("launcher exited early: "+log);
   try{
    const response=await fetch(base+"/api/v1/session",{signal:AbortSignal.timeout(2000)});
    if(response.ok){
     cookie=(response.headers.get("set-cookie")||"").split(";")[0];
     session=await response.json();
     result=await jsonRequest(base,"/api/v1/execution/capabilities",{headers:{cookie}});
     if(result.status===200)break;
    }
   }catch(error){lastError=String(error);}
   await new Promise(done=>setTimeout(done,200));
  }
  assert.equal(result?.status,200,"SQLite capabilities did not become available through Vite: "+lastError+"; "+log);
  assert.equal(result.body.autoDispatch,true);
  assert.deepEqual(result.body.comfyInstanceIds,["comfy-local"]);
  const gateway=await jsonRequest(base,"/api/comfy/templates");
  assert.equal(gateway.status,200,"Legacy gateway health must stay available for other routes");
  assert.ok(session?.csrfToken&&cookie,"SQLite session must remain available through Vite");
  const origin={origin:base,"sec-fetch-site":"same-origin","content-type":"application/json",cookie,
   "x-atelier-csrf":session.csrfToken};
  const saved=await jsonRequest(base,"/api/v1/comfy/instances",{
   method:"POST",headers:origin,
   body:JSON.stringify({id:"smoke-local",url:"http://127.0.0.1:8189"})
  });
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal(saved.body.instance.id,"smoke-local");
  const selected=await jsonRequest(base,"/api/v1/execution/capabilities",{headers:{cookie}});
  assert.deepEqual(selected.body.comfyInstanceIds,["comfy-local","smoke-local"]);
  const instances=await jsonRequest(base,"/api/v1/comfy/instances",{headers:{cookie}},8000);
  assert.equal(instances.status,200);
  assert.deepEqual(instances.body.instances.map(item=>item.id),["comfy-local","smoke-local"]);
 }finally{
  if(child.pid && child.exitCode===null){
   if(process.platform==="win32")spawnSync("taskkill",["/T","/F","/PID",String(child.pid)],{stdio:"ignore"});
   else child.kill("SIGTERM");
  }
  await new Promise(done=>child.exitCode!==null?done():child.once("exit",done));
  rmSync(temp,{force:true,recursive:true,maxRetries:8,retryDelay:250});
 }
});

test("a failed optional Comfy gateway does not take down the SQLite app",{
 skip:process.platform!=="win32" && "local backend uses Windows DPAPI",
 timeout:30000,
},async()=>{
 const temp=mkdtempSync(join(tmpdir(),"atelier-comfy-conflict-test-"));
 const backendPort=await freePort(),vitePort=await freePort();
 const sockets=new Set();
 const blocker=createServer(socket=>{
  sockets.add(socket);socket.once("close",()=>sockets.delete(socket));
  socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
 });
 await new Promise(done=>blocker.listen(0,"127.0.0.1",done));
 const gatewayPort=blocker.address().port;
 let log="";
 const child=spawn(process.execPath,["scripts/dev-with-backend.mjs"],{
  cwd:webDir,windowsHide:true,stdio:["ignore","pipe","pipe"],
  env:{...process.env,ATELIER_DATA_DIR:join(temp,"data"),COMFY_DATA_DIR:join(temp,"comfy"),
   ATELIER_BACKEND_PORT:String(backendPort),ATELIER_VITE_PORT:String(vitePort),
   ATELIER_GATEWAY_PORT:String(gatewayPort),GATEWAY_TOKEN:"dev-gateway-conflict-test",
   MEDIA_GATEWAY_URL:"http://127.0.0.1:"+gatewayPort}
 });
 for(const stream of [child.stdout,child.stderr])stream.on("data",data=>{
  log=(log+data.toString()).slice(-12000);
 });
 try{
  let result,lastError;
  const base="http://127.0.0.1:"+vitePort,deadline=Date.now()+12000;
  while(Date.now()<deadline){
   if(child.exitCode!==null)throw Error("launcher crashed after gateway port conflict: "+log);
   try{result=await jsonRequest(base,"/api/v1/session");if(result.status===200)break;}
   catch(error){lastError=String(error);}
   await new Promise(done=>setTimeout(done,200));
  }
  assert.equal(result?.status,200,"SQLite/Vite must stay available: "+lastError+"; "+log);
  assert.match(log,/ComfyUI gateway unavailable/);
 }finally{
  if(child.pid && child.exitCode===null){
   if(process.platform==="win32")spawnSync("taskkill",["/T","/F","/PID",String(child.pid)],{stdio:"ignore"});
   else child.kill("SIGTERM");
  }
  await Promise.race([
   new Promise(done=>child.exitCode!==null||child.signalCode!==null?done():child.once("exit",done)),
   new Promise(done=>setTimeout(done,2000))
  ]);
  for(const socket of sockets)socket.destroy();
  blocker.close();
  rmSync(temp,{force:true,recursive:true,maxRetries:8,retryDelay:250});
 }
});
