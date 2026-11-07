import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtemp,rm,writeFile,readdir,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {request as httpRequest} from "node:http";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createProject,getProject,saveSingleUserCanvas} from "./projects.mjs";
import {createLocalSessionAuth} from "./session.mjs";
import {buildApp} from "./app.mjs";
import {createAudioExtractionService,runMediaProcess,extractionError} from "./audio-extraction.mjs";

const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from("ftypM4A "),Buffer.alloc(40)]);
const audioBytes=Buffer.concat([mp4,Buffer.from("audio")]);
const probe=JSON.stringify({streams:[{codec_type:"audio",codec_name:"aac"}],format:{duration:"1.024"}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const waitAbort=signal=>new Promise((_,reject)=>{
 if(signal.aborted)reject(signal.reason);
 else signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
});
async function fixture(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),"atelier-extract-test-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const blobStore=createBlobStore({dataDir:dir,db,maxBlobBytes:options.maxBlobBytes??1024*1024});
 const source=await blobStore.put([mp4],{mime:"video/mp4"});
 const node={id:"video-1",type:"video",metadata:{storageKey:"cas:"+source.blobId,content:"/api/v1/blobs/"+source.blobId}};
 createProject(db,{id:"project",document:{nodes:[node],connections:[]}});
 const calls=[];
 const run=options.run??(async(executable,args)=>{
  calls.push({executable,args});
  if(args.includes("-show_streams"))return probe;
  await writeFile(args.at(-1),audioBytes);return "";
 });
 const service=createAudioExtractionService({dataDir:dir,blobStore,run,...options});
 let app;
 t.after(async()=>{if(app)await app.close();else await service.close();db.close();await rm(dir,{recursive:true,force:true})});
 return {dir,db,blobStore,source,node,calls,service,
  app(extra={}){return app=buildApp({db,blobStore,audioExtraction:service,authorize:()=>true,...extra})}};
}

test("extracts one AAC stream into CAS, with fixed safe arguments and cleanup",async t=>{
 const f=await fixture(t);
 const value=await f.service.extract(f.source.blobId);
 assert.equal(value.mimeType,"audio/mp4");assert.equal(value.durationMs,1024);
 const stored=await f.blobStore.stat(value.blobId);assert.equal(stored.mimeType,"audio/mp4");
 const args=f.calls.find(call=>call.args.includes("-map")).args;
 for(const arg of ["0:a:0","-vn","-sn","-dn","aac","192k","48000","2","file","-fs"])assert.ok(args.includes(arg),arg);
 assert.equal(args[args.indexOf("-i")+1],f.blobStore.pathFor(f.source.blobId));
 assert.deepEqual(await readdir(join(f.dir,"tmp")),[]);
});

test("source with no audio never starts FFmpeg",async t=>{
 let calls=0;const f=await fixture(t,{run:async()=>{calls++;return '{"streams":[{"codec_type":"video"}]}'}});
 await assert.rejects(f.service.extract(f.source.blobId),{code:"audio_extraction_no_audio"});assert.equal(calls,1);
});

test("invalid input/probe output and missing source are rejected",async t=>{
 const f=await fixture(t,{run:async()=>"not json"});
 await assert.rejects(f.service.extract(f.source.blobId),{code:"audio_extraction_failed"});
 await assert.rejects(f.service.extract("a".repeat(64)),{code:"blob_not_found"});
 const text=await f.blobStore.put([Buffer.from("x")],{mime:"text/plain"});
 await assert.rejects(f.service.extract(text.blobId),{code:"audio_extraction_source_invalid"});
});

test("conversion failure and quota overflow remove temporary output",async t=>{
 for(const quota of [false,true]){
  const f=await fixture(t,{maxBlobBytes:1000,run:async(_exe,args)=>{
   if(args.includes("-show_streams"))return probe;
   await writeFile(args.at(-1),quota?Buffer.alloc(1001):mp4);
   if(!quota)throw extractionError("audio_extraction_failed");return "";
  }});
  await assert.rejects(f.service.extract(f.source.blobId),{code:quota?"audio_extraction_quota_exceeded":"audio_extraction_failed"});
  assert.deepEqual(await readdir(join(f.dir,"tmp")),[]);
 }
});

test("cancels queued work immediately and bounds active/waiting tasks",async t=>{
 let probes=0;const f=await fixture(t,{maxConcurrent:2,maxQueued:1,run:async(_exe,_args,{signal})=>{probes++;return waitAbort(signal)}});
 const a=new AbortController(),b=new AbortController(),c=new AbortController();
 const pa=assert.rejects(f.service.extract(f.source.blobId,{signal:a.signal}),{code:"audio_extraction_cancelled"});
 const pb=assert.rejects(f.service.extract(f.source.blobId,{signal:b.signal}),{code:"audio_extraction_cancelled"});
 const pc=assert.rejects(f.service.extract(f.source.blobId,{signal:c.signal}),{code:"audio_extraction_cancelled"});
 await assert.rejects(f.service.extract(f.source.blobId),{code:"audio_extraction_busy"});
 c.abort();a.abort();b.abort();await Promise.all([pa,pb,pc]);assert.ok(probes<=2);
});

test("timeout aborts the process and cleans a partially written file",async t=>{
 const f=await fixture(t,{timeoutMs:50,run:async(_exe,args,{signal})=>{
  if(args.includes("-show_streams"))return probe;
  await writeFile(args.at(-1),audioBytes);return waitAbort(signal);
 }});
 await assert.rejects(f.service.extract(f.source.blobId),{code:"audio_extraction_timeout"});
 assert.deepEqual(await readdir(join(f.dir,"tmp")),[]);
});

test("revalidates source after processing, before publishing",async t=>{
 const f=await fixture(t);let validations=0;
 await assert.rejects(f.service.extract(f.source.blobId,{validate:()=>{
  if(++validations===2)throw extractionError("audio_extraction_source_invalid",409);
 }}),{code:"audio_extraction_source_invalid"});
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM blobs").get().n,1);
});

test("process runner reports missing tools, failures, and cancellation",async()=>{
 await assert.rejects(runMediaProcess("atelier-ffmpeg-not-installed",[]),{code:"audio_extraction_tool_unavailable"});
 await assert.rejects(runMediaProcess(process.execPath,["-e","process.exit(1)"]),{code:"audio_extraction_failed"});
 const controller=new AbortController();
 const pending=runMediaProcess(process.execPath,["-e","setInterval(()=>{},1000)"],{signal:controller.signal});
 controller.abort(extractionError("audio_extraction_cancelled",499));
 await assert.rejects(pending,{code:"audio_extraction_cancelled"});
});

test("HTTP endpoint validates project/source, ignores extra parameters, returns M4A and persists graph",async t=>{
 const f=await fixture(t),app=f.app();
 const url="/api/v1/projects/project/media/extract-audio";
 const payload={sourceNodeId:f.node.id,sourceBlobId:f.source.blobId};
 const response=await app.inject({method:"POST",url,payload});
 assert.equal(response.statusCode,200,response.body);
 const result=response.json();
 const blob=await app.inject({url:"/api/v1/blobs/"+result.blobId});
 assert.equal(blob.statusCode,200);assert.equal(blob.headers["content-type"],"audio/mp4");
 const graph=getProject(f.db,"project").document;
 graph.nodes.push({id:"audio-1",type:"audio",metadata:{content:"/api/v1/blobs/"+result.blobId,storageKey:"cas:"+result.blobId,mimeType:"audio/mp4",audioExtraction:payload}});
 graph.connections.push({id:"edge",fromNodeId:f.node.id,toNodeId:"audio-1"});
 saveSingleUserCanvas(f.db,{id:"project",document:graph});
 assert.equal(getProject(f.db,"project").document.nodes[1].metadata.mimeType,"audio/mp4");
 for(const [path,body,status] of [
  ["/api/v1/projects/missing/media/extract-audio",payload,404],
  [url,{...payload,sourceNodeId:"other"},409],
  [url,{...payload,sourceBlobId:"b".repeat(64)},409],
  [url,{...payload,sourceBlobId:"../bad"},400],
 ])assert.equal((await app.inject({method:"POST",url:path,payload:body})).statusCode,status);
 // Fastify removes additional fields: they can never reach the process runner.
 await app.inject({method:"POST",url,payload:{...payload,path:"C:/arbitrary",args:["-evil"]}});
 assert.ok(f.calls.every(call=>!call.args.includes("-evil")&&!call.args.includes("C:/arbitrary")));
});

test("endpoint requires session + CSRF and same-origin access",async t=>{
 const f=await fixture(t),sessionAuth=createLocalSessionAuth(),session=sessionAuth.issueLocalSession();
 const app=f.app({sessionAuth});
 const request={method:"POST",url:"/api/v1/projects/project/media/extract-audio",payload:{sourceNodeId:f.node.id,sourceBlobId:f.source.blobId}};
 assert.equal((await app.inject(request)).statusCode,401);
 const headers={cookie:"atelier_session="+session.id,origin:"http://localhost"};
 assert.equal((await app.inject({...request,headers})).statusCode,401);
 assert.equal((await app.inject({...request,headers:{...headers,"x-atelier-csrf":session.csrf}})).statusCode,200);
 assert.equal((await app.inject({...request,headers:{...headers,"x-atelier-csrf":session.csrf,origin:"https://evil.test"}})).statusCode,403);
});

test("client disconnect cancels backend work",async t=>{
 const started=deferred(),aborted=deferred();
 const f=await fixture(t,{run:async(_exe,_args,{signal})=>{
  started.resolve();signal.addEventListener("abort",()=>aborted.resolve(),{once:true});return waitAbort(signal);
 }});
 const app=f.app();await app.listen({port:0,host:"127.0.0.1"});
 const port=app.server.address().port;
 const request=httpRequest({host:"127.0.0.1",port,path:"/api/v1/projects/project/media/extract-audio",method:"POST",
  headers:{"content-type":"application/json"}});
 request.on("error",()=>{});request.end(JSON.stringify({sourceNodeId:f.node.id,sourceBlobId:f.source.blobId}));
 await started.promise;request.destroy();await aborted.promise;
});

test("real FFmpeg extracts only the first audio stream as playable AAC/M4A",{timeout:30000},async t=>{
 try{await runMediaProcess(process.env.ATELIER_FFMPEG_PATH||"ffmpeg",["-version"]);
  await runMediaProcess(process.env.ATELIER_FFPROBE_PATH||"ffprobe",["-version"])}
 catch{t.skip("FFmpeg/FFprobe not installed");return}
 const f=await fixture(t,{run:runMediaProcess});
 await assert.rejects(f.service.extract(f.source.blobId),{code:"audio_extraction_failed"});
 const sourceFile=join(f.dir,"sample.mp4");
 await runMediaProcess(process.env.ATELIER_FFMPEG_PATH||"ffmpeg",["-v","error","-f","lavfi","-i","color=c=black:s=32x32:d=1",
  "-f","lavfi","-i","sine=frequency=440:duration=1","-f","lavfi","-i","sine=frequency=880:duration=2",
  "-map","0:v:0","-map","1:a:0","-map","2:a:0","-c:v","mpeg4","-c:a","aac","-y",sourceFile]);
 const input=await f.blobStore.put([await readFile(sourceFile)],{mime:"video/mp4"});
 const result=await f.service.extract(input.blobId);
 assert.ok(result.durationMs>=950&&result.durationMs<1300,JSON.stringify(result));
 const info=JSON.parse(await runMediaProcess(process.env.ATELIER_FFPROBE_PATH||"ffprobe",["-v","error","-show_streams","-of","json",f.blobStore.pathFor(result.blobId)]));
 assert.equal(info.streams.length,1);assert.equal(info.streams[0].codec_name,"aac");
 assert.equal(info.streams[0].channels,2);assert.equal(info.streams[0].sample_rate,"48000");
 await runMediaProcess(process.env.ATELIER_FFMPEG_PATH||"ffmpeg",["-v","error","-i",f.blobStore.pathFor(result.blobId),"-f","null","-"]);
});

test("rejects fake MP4 audio signatures and reports an unavailable FFprobe",async t=>{
 const f=await fixture(t,{run:runMediaProcess,ffprobe:"atelier-ffprobe-not-installed"});
 await assert.rejects(f.service.extract(f.source.blobId),{code:"audio_extraction_tool_unavailable"});
 await assert.rejects(f.blobStore.put([Buffer.from("not an m4a")],{mime:"audio/mp4"}),{code:"blob_mime_mismatch"});
});
