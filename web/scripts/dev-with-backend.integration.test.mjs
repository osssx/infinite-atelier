import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {createServer} from "node:net";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
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
 const body=await response.json();
 return {status:response.status,body};
}

test("dev launcher uses only SQLite Fastify and Vite, retires Gateway routes",{
 skip:process.platform!=="win32"&&"local backend uses Windows DPAPI",timeout:60000
},async()=>{
 const launcher=readFileSync(join(webDir,"scripts/dev-with-backend.mjs"),"utf8");
 const vite=readFileSync(join(webDir,"vite.config.ts"),"utf8");
 assert.doesNotMatch(launcher,/ark-gateway\.mjs|GATEWAY_TOKEN|ATELIER_GATEWAY_PORT/);
 assert.doesNotMatch(vite,/MEDIA_GATEWAY_URL|setHeader\("x-gateway-token"/);
 const temp=mkdtempSync(join(tmpdir(),"atelier-no-gateway-dev-"));
 const [backendPort,vitePort,gatewayPort]=await Promise.all([freePort(),freePort(),freePort()]);
 let log="";
 const child=spawn(process.execPath,["scripts/dev-with-backend.mjs"],{
  cwd:webDir,windowsHide:true,stdio:["ignore","pipe","pipe"],
  env:{...process.env,LOCALAPPDATA:join(temp,"localappdata"),ATELIER_DATA_DIR:join(temp,"data"),
   ATELIER_BACKEND_PORT:String(backendPort),ATELIER_VITE_PORT:String(vitePort),
   ATELIER_GATEWAY_PORT:String(gatewayPort),MEDIA_GATEWAY_URL:"http://127.0.0.1:"+gatewayPort,
   GATEWAY_TOKEN:"ignored-obsolete-config"}
 });
 for(const stream of [child.stdout,child.stderr])stream.on("data",data=>{
  log=(log+data.toString()).slice(-12000);
 });
 try{
  const base="http://127.0.0.1:"+vitePort;
  let result,lastError,session,cookie="";
  const deadline=Date.now()+15000;
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
   }catch(error){lastError=String(error)}
   await new Promise(done=>setTimeout(done,200));
  }
  assert.equal(result?.status,200,"Backend unavailable: "+lastError+"; "+log);
  assert.equal(result.body.autoDispatch,true);
  assert.deepEqual(result.body.comfyInstanceIds,["comfy-local"]);
  assert.ok(cookie&&session.csrfToken);
  const old=await jsonRequest(base,"/api/comfy/templates");
  assert.equal(old.status,410);assert.equal(old.body.code,"gateway_removed");
  for(const url of ["/api/ark/contents/generations/tasks","/api/media/uploads","/media/ark/asset"]){
   const response=await jsonRequest(base,url);
   assert.equal(response.status,410,url);
  }
  const headers={origin:base,"sec-fetch-site":"same-origin","content-type":"application/json",cookie,
   "x-atelier-csrf":session.csrfToken};
  const saved=await jsonRequest(base,"/api/v1/comfy/instances",{
   method:"POST",headers,body:JSON.stringify({id:"smoke-local",url:"http://127.0.0.1:8189"})
  });
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const instances=await jsonRequest(base,"/api/v1/comfy/instances",{headers:{cookie}},8000);
  assert.deepEqual(instances.body.instances.map(item=>item.id),["comfy-local","smoke-local"]);
  assert.doesNotMatch(log,/ComfyUI gateway ready|Gateway Token/);
 }finally{
  if(child.pid&&child.exitCode===null){
   if(process.platform==="win32")spawnSync("taskkill",["/T","/F","/PID",String(child.pid)],{stdio:"ignore"});
   else child.kill("SIGTERM");
  }
  await Promise.race([
   new Promise(done=>child.exitCode!==null||child.signalCode!==null?done():child.once("exit",done)),
   new Promise(done=>setTimeout(done,2000))
  ]);
  rmSync(temp,{force:true,recursive:true,maxRetries:8,retryDelay:250});
 }
});
