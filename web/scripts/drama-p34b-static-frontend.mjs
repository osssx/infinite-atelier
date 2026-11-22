/** Isolated production-build harness for P3.4b5. Only loopback requests,
 * serves a verified local dist and forwards /api/v1 to the ephemeral fixture.
 * Never reads application credentials or proxies arbitrary hostnames.
 */
import {createServer,request as httpRequest} from "node:http";
import {readFile,stat} from "node:fs/promises";
import {resolve,extname,sep} from "node:path";
import {fileURLToPath} from "node:url";

const opts=Object.fromEntries(process.argv.slice(2).reduce((arr,value,index,all)=>{
 if(index%2===0&&value.startsWith("--"))arr.push([value.slice(2),all[index+1]]);
 return arr;
},[]));
const host="127.0.0.1";
const port=Number(opts.port);
const dataDir=resolve(String(opts.dist??""));
const backend=new URL(String(opts.backend??""));
if(process.env.ATELIER_P34B_BROWSER_E2E!=="1"||!Number.isInteger(port)||port<1024||port>65535||
 backend.protocol!=="http:"||!["127.0.0.1","localhost"].includes(backend.hostname)||!backend.port||
 !dataDir.includes("p34b")&&!dataDir.endsWith(sep+"dist"))throw Error("p34b_production_harness_invalid_config");
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",
 ".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".webp":"image/webp",
 ".ico":"image/x-icon",".woff2":"font/woff2",".json":"application/json",".wasm":"application/wasm"};
const loopback=addr=>addr==="127.0.0.1"||addr==="::1"||addr?.startsWith("::ffff:127.");
const server=createServer(async(req,res)=>{
 if(!loopback(req.socket.remoteAddress)){res.writeHead(403);res.end();return}
 const path=new URL(req.url??"/","http://local.invalid").pathname;
 if(path.startsWith("/api/v1/")||path==="/api/v1"){
  const target=new URL(req.url,backend);
  const headers={...req.headers,host:req.headers.host,"accept-encoding":"identity"};
  const outbound=httpRequest(target,{method:req.method,headers,timeout:30000},upstream=>{
   res.writeHead(upstream.statusCode??502,upstream.headers);
   upstream.pipe(res);
  });
  outbound.on("timeout",()=>outbound.destroy(Error("upstream timeout")));
  outbound.on("error",()=>{if(!res.headersSent)res.writeHead(502);res.end()});
  req.pipe(outbound);return;
 }
 if(!["GET","HEAD"].includes(req.method??"")){res.writeHead(405);res.end();return}
 try{
  const safePath=decodeURIComponent(path).replaceAll("\\","/");
  const file=resolve(dataDir,"."+safePath);
  if(file!==dataDir&&!file.startsWith(dataDir+sep)){res.writeHead(403);res.end();return}
  let chosen=file;
  const info=await stat(file).catch(()=>null);
  if(!info?.isFile()){
   if(!path.startsWith("/assets/"))chosen=resolve(dataDir,"index.html");
   else{res.writeHead(404);res.end();return}
  }
  const bytes=await readFile(chosen);
  res.writeHead(200,{"content-type":mime[extname(chosen)]??"application/octet-stream",
    "cache-control":"no-store","content-length":bytes.length});
  if(req.method!=="HEAD")res.end(bytes);else res.end();
 }catch{res.writeHead(404);res.end()}
});
server.listen(port,host,()=>console.log("P34B_PROD_FRONTEND_READY",port));
