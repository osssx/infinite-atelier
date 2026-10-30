import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {Readable} from "node:stream";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createOpenAiModelAdapter,validateModelSnapshot} from "./openai-model-adapter.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {submitJob} from "./repository.mjs";
import {fingerprintSource} from "./repository.mjs";
import {createProject,getProject,patchProject} from "./projects.mjs";
import {createCanvasMaterializer} from "./canvas-materializer.mjs";
import {createBackendWorker} from "./worker.mjs";
import {buildApp} from "./app.mjs";
const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082","hex");
const wav=Buffer.from("524946460800000057415645666d7420","hex");
const fakeProtector={protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)};
function fixture(t,upstreamCall){
 const dir=mkdtempSync(join(tmpdir(),"atelier-openai-jobs-"));
 const db=new DatabaseSync(":memory:");
 initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const vault=createCredentialVault({db,protector:fakeProtector});
 const channel=vault.create({id:"openai-channel",provider:"openai",displayName:"OpenAI",
  apiKey:"fixture-only-not-a-real-secret"});
 const snapshot=task=>({adapterKind:"model",provider:"openai",channelId:channel.id,
  secretVersionRef:channel.keyVersion,task});
 const blobStore=createBlobStore({dataDir:dir,db});
 const adapter=createOpenAiModelAdapter({db,blobStore,vault,upstreamCall});
 const coordinator=createJobCoordinator({db,adapters:{model:adapter}});
 const enqueue=(name,task)=>{
  const result=submitJob(db,{idempotencyKey:name,requestFingerprint:name,
   executionMode:"immediate",snapshot:snapshot(task)});
  return result.jobId;
 };
 return {db,vault,snapshot,enqueue,blobStore,coordinator};
}
test("vault-only model catalog uses read-only GET and redacts keys from HTTP response",async t=>{
 const calls=[];
 const f=fixture(t,async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify({data:[
   {id:"z-model"},{id:"a-model"},{id:"a-model"},{id:42}
  ]}),{status:200});
 });
 const adapter=createOpenAiModelAdapter({db:f.db,blobStore:f.blobStore,vault:f.vault,
  upstreamCall:async(url,options)=>{
   calls.push({url,options});
   return new Response(JSON.stringify({data:[{id:"z-model"},{id:"a-model"}]}),{status:200});
  },
  compatibleUpstreamCall:async(url,options)=>{
   calls.push({url,options});
   return new Response(JSON.stringify({data:[{id:"local-model"},{id:"another"}]}),{status:200});
  }
 });
 const compat=f.vault.create({id:"local-proxy",displayName:"Local proxy",
  provider:"openai_compatible",apiKey:"local-secret-for-tests"});
 assert.deepEqual(await adapter.listModels({channelId:"openai-channel",endpointBaseUrl:"https://api.openai.com"}),
  {models:["a-model","z-model"]});
 assert.deepEqual(await adapter.listModels({channelId:compat.id,endpointBaseUrl:"http://127.0.0.1:8188/v1"}),
  {models:["another","local-model"]});
 assert.equal(calls[0].url,"https://api.openai.com/v1/models");
 assert.equal(calls[0].options.headers.Authorization,"Bearer fixture-only-not-a-real-secret");
 assert.equal(calls[1].url,"http://127.0.0.1:8188/v1/models");
 assert.equal(calls[1].options.headers.Authorization,"Bearer local-secret-for-tests");
 assert.equal(calls[0].options.method,"GET");
 await assert.rejects(adapter.listModels({channelId:compat.id,
  endpointBaseUrl:"http://169.254.169.254/v1"}),/model_catalog_origin_invalid/);
 await assert.rejects(adapter.listModels({channelId:"missing",
  endpointBaseUrl:"https://api.openai.com"}),/channel_not_found/);
 const app=buildApp({db:f.db,authorize:async()=>true,vault:f.vault,
  modelCatalog:args=>adapter.listModels(args)});
 t.after(()=>app.close());
 const reply=await app.inject({method:"POST",url:"/api/v1/channels/local-proxy/models",
  headers:{host:"localhost"},payload:{baseUrl:"http://127.0.0.1:8188/v1"}});
 assert.equal(reply.statusCode,200);
 assert.deepEqual(reply.json(),{models:["another","local-model"]});
 assert.ok(!reply.body.includes("local-secret-for-tests"));
 const wrong=await app.inject({method:"POST",url:"/api/v1/channels/local-proxy/models",
  headers:{host:"localhost"},payload:{baseUrl:"http://169.254.169.254/v1"}});
 assert.equal(wrong.statusCode,400);
});
test("model catalog exposes safe upstream failure codes instead of internal_error",async t=>{
 const f=fixture(t,async()=>new Response("{}"));
 const c=f.vault.create({id:"catalog-testing",provider:"openai_compatible",
  displayName:"Catalog testing",apiKey:"not-a-real-secret"});
 const scenarios=[
  {expected:"model_catalog_upstream_unavailable",status:502,network:async()=>{throw Error("private upstream detail");}},
  {expected:"model_catalog_timeout",status:502,network:async()=>{throw Object.assign(Error("timeout"),{name:"TimeoutError"});}},
  {expected:"model_catalog_dns_blocked",status:502,network:async()=>{throw Object.assign(Error("fetch failed"),{cause:Object.assign(Error("pinning rejected"),{code:"model_endpoint_dns_forbidden"})});}},
  {expected:"model_catalog_unauthorized",status:502,network:async()=>new Response("{}",{status:403})},
  {expected:"model_catalog_upstream_rejected",status:502,network:async()=>new Response("{}",{status:404})},
  {expected:"model_catalog_response_invalid",status:502,network:async()=>new Response(JSON.stringify({wrong:[]}),{status:200})}
 ];
 for(const s of scenarios){
  const adapter=createOpenAiModelAdapter({db:f.db,blobStore:f.blobStore,vault:f.vault,
   compatibleUpstreamCall:s.network});
  const app=buildApp({db:f.db,authorize:async()=>true,vault:f.vault,
   modelCatalog:args=>adapter.listModels(args)});
  try{
   const response=await app.inject({method:"POST",url:"/api/v1/channels/catalog-testing/models",
    headers:{host:"localhost"},payload:{baseUrl:"https://api.cline.bot/api/v1"}});
   assert.equal(response.statusCode,s.status);
   assert.equal(response.json().code,s.expected);
   assert.ok(!response.body.includes("not-a-real-secret"));
   assert.ok(!response.body.includes("private upstream detail"));
  }finally{await app.close()}
 }
});
test("namespaced model IDs pass preparation and are submitted unchanged",async t=>{
 const calls=[];
 const f=fixture(t,async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify({choices:[{message:{content:"generation succeeded"}}]}),{
   status:200,headers:{"content-type":"application/json"}});
 });
 const model="cline-pass/deepseek-v4.1-flash-1017";
 const task={kind:"text",model,prompt:"test prompt",messages:[{role:"user",content:"test prompt"}],stream:false,images:[]};
 assert.equal(validateModelSnapshot(f.snapshot(task)),task);
 const id=f.enqueue("namespace-model",task);
 f.coordinator.recoverAtStartup();
 await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status,submission_started_at FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,"https://api.openai.com/v1/chat/completions");
 assert.equal(JSON.parse(calls[0].options.body).model,model);
 assert.equal(f.db.prepare("SELECT outcome FROM job_attempts WHERE job_id=?").get(id).outcome,"succeeded");
 for(const invalid of ["/model","model/","model//item","model/../item","model?x=1",
  "model#fragment","model\\path","model name","a".repeat(129)]){
  assert.throws(()=>validateModelSnapshot(f.snapshot({...task,model:invalid})),/model_task_invalid/);
 }
 for(const valid of ["org/model","org/group/model",model,"model.v1"]){
  assert.equal(validateModelSnapshot(f.snapshot({...task,model:valid})).model,valid);
 }
});
test("long Chinese prompt with multiple manual Skills is frozen and forwarded intact",async t=>{
 const calls=[];
 const f=fixture(t,async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body)});
  return new Response(JSON.stringify({choices:[{message:{content:"已生成"}}]}),{status:200});
 });
 const skill1="片段甲".repeat(13000),skill2="片段乙".repeat(13000);
 const prompt='<selected-skill id="drama-a">\n'+skill1+'\n</selected-skill>\n'+
  '<selected-skill id="drama-b">\n'+skill2+'\n</selected-skill>\n'+
  '<user-request>请生成分镜</user-request>';
 assert.ok(Buffer.byteLength(prompt,"utf8")>16000);
 const task={kind:"text",model:"gpt-4o-mini",prompt,
  messages:[{role:"system",content:"你是专业导演"},{role:"user",content:prompt}],stream:false};
 assert.equal(validateModelSnapshot(f.snapshot(task)),task);
 const id=f.enqueue("chinese-skills-text",task);
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(calls.length,1);
 assert.equal(calls[0].body.messages[1].content,prompt);
 assert.ok(calls[0].body.messages[1].content.includes(skill1));
 assert.ok(calls[0].body.messages[1].content.includes(skill2));
});
test("text byte bounds are enforced while image and audio retain 16KB prompts",t=>{
 const f=fixture(t,async()=>new Response("{}"));
 const task={kind:"text",model:"gpt-4o-mini",prompt:"safe"};
 const multi="字".repeat(150000); // 450KB of UTF-8: allowed for text
 assert.doesNotThrow(()=>validateModelSnapshot(f.snapshot({...task,prompt:multi,messages:[
  {role:"system",content:"规则"},{role:"user",content:multi}
 ]})));
 const oversize="字".repeat(Math.ceil((512*1024+1)/3));
 assert.throws(()=>validateModelSnapshot(f.snapshot({...task,prompt:oversize})),/model_task_invalid/);
 assert.doesNotThrow(()=>validateModelSnapshot(f.snapshot({...task,messages:[
  {role:"system",content:"a".repeat(512*1024)},{role:"user",content:"safe"}
 ]})));
 assert.throws(()=>validateModelSnapshot(f.snapshot({...task,prompt:multi,messages:[
  {role:"system",content:"s".repeat(512*1024)},{role:"system",content:"额".repeat(30000)},
  {role:"assistant",content:"a".repeat(30000)},
  {role:"user",content:multi}
 ]})),/model_text_history_invalid/);
 for(const kind of ["image","audio"])
  assert.throws(()=>validateModelSnapshot(f.snapshot({kind,model:"gpt-4o-mini",prompt:"x".repeat(16001)})),/model_task_invalid/);
});
test("P4.4 OpenAI image generation uses encrypted channel, immutable CAS, and a single GPU POST",async t=>{
 const calls=[];
 const f=fixture(t,async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}),{
   status:200,headers:{"content-type":"application/json"}});
 });
 const id=f.enqueue("image-1",{kind:"image",model:"gpt-image-2",prompt:"a fox",
  size:"1024x1024",quality:"high"});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,"https://api.openai.com/v1/images/generations");
 assert.equal(calls[0].options.redirect,"manual");
 assert.equal(calls[0].options.headers.authorization,"Bearer fixture-only-not-a-real-secret");
 assert.deepEqual(JSON.parse(calls[0].options.body),{model:"gpt-image-2",prompt:"a fox",
  n:1,size:"1024x1024",quality:"high"});
 assert.ok(!f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(id).snapshot_json
  .includes("fixture-only-not-a-real-secret"));
 const a=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(id);
 assert.equal(a.kind,"image");assert.equal(a.port_id,"image");
 const blob=await f.blobStore.stat(a.blob_id);
 assert.equal(blob.mimeType,"image/png");assert.equal(blob.byteSize,png.length);
 // Idempotent same-key POST cannot repeat provider generation.
 assert.equal(f.enqueue("image-1",{kind:"image",model:"gpt-image-2",prompt:"a fox",
  size:"1024x1024",quality:"high"}),id);
 await f.coordinator.tick();
 assert.equal(calls.length,1);
});
test("P4.4 speech and text share durable model queue and CAS artifact lifecycle",async t=>{
 const calls=[];
 const f=fixture(t,async(url,options)=>{
  calls.push(url);
  return url.endsWith("/audio/speech")?new Response(wav,{status:200}):
   new Response(JSON.stringify({choices:[{message:{content:"hello world"}}]}),{status:200});
 });
 const audio=f.enqueue("speech",{kind:"audio",model:"gpt-4o-mini-tts",
  prompt:"hello",voice:"alloy",format:"wav",speed:1});
 const text=f.enqueue("text",{kind:"text",model:"gpt-4o-mini",prompt:"Say hello"});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 for(const [job,kind,mime] of [[audio,"audio","audio/wav"],[text,"text","text/plain"]]){
  assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(job).status,"succeeded");
  const row=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(job);
  assert.equal(row.kind,kind);assert.equal((await f.blobStore.stat(row.blob_id)).mimeType,mime);
 }
 assert.deepEqual(calls.sort(),["https://api.openai.com/v1/audio/speech",
  "https://api.openai.com/v1/chat/completions"]);
});
test("P4.4 refuses revoked, malformed, unsafe-provider, and unsupported requests before sending",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;return new Response("",{status:400})});
 assert.throws(()=>validateModelSnapshot({...f.snapshot({kind:"text",model:"gpt-4o-mini",prompt:"safe"}),
  task:{kind:"text",model:"gpt-4o-mini",prompt:"safe",apiKey:"oops"}}),/model_task_invalid/);
 assert.throws(()=>validateModelSnapshot(f.snapshot({kind:"audio",model:"gpt-4o-mini-tts",
  prompt:"Hi",voice:"alloy",format:"exe"})),/model_task_invalid/);
 const queued=f.enqueue("revoked",{kind:"text",model:"gpt-4o-mini",prompt:"test"});
 const channel=f.vault.get("openai-channel");
 f.vault.revoke(channel.id,channel.keyVersion);
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(queued).status,"blocked_credential");
 assert.equal(calls,0);
});
test("P4.4 ambiguous provider response blocks re-submission even across coordinator restart",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;throw Error("socket reset after provider accepted");});
 const id=f.enqueue("uncertain",{kind:"image",model:"gpt-image-2",prompt:"test"});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"submission_unknown");
 const restarted=createJobCoordinator({db:f.db,adapters:{model:createOpenAiModelAdapter({
  db:f.db,blobStore:f.blobStore,vault:f.vault,upstreamCall:async()=>{calls++;return new Response("");}
 })}});
 restarted.recoverAtStartup();await restarted.tick();
 assert.equal(calls,1);
});
test("P4.4 ordinary Canvas text→image uses SQLite save fence then safely materializes and survives restart",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;return new Response(JSON.stringify({
  data:[{b64_json:png.toString("base64")}]}),{status:200})});
 const original={nodes:[{id:"prompt-1",type:"text",title:"Prompt",position:{x:25,y:35},
  width:320,height:200,metadata:{content:"a fox"}}],connections:[]};
 createProject(f.db,{id:"canvas-1",document:original});
 const fingerprint=fingerprintSource(original,"prompt-1");
 const key="canvas-image";
 const id=submitJob(f.db,{idempotencyKey:key,requestFingerprint:key,
  executionMode:"immediate",projectId:"canvas-1",targetNodeId:"prompt-1",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprint,
  snapshot:f.snapshot({kind:"image",model:"gpt-image-2",prompt:"a fox"})}).jobId;
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 assert.equal((await materializer.runOnce())[0].status,"materialized");
 const project=getProject(f.db,"canvas-1");
 assert.equal(project.revision,2);
 assert.equal(project.document.nodes.length,2);
 assert.equal(project.document.connections.length,1);
 const image=project.document.nodes[1];
 assert.equal(image.type,"image");
 assert.equal(image.metadata.modelArtifact.jobId,id);
 assert.match(image.metadata.storageKey,/^cas:[a-f0-9]{64}$/);
 assert.equal(project.document.connections[0].fromNodeId,"prompt-1");
 assert.equal(project.document.connections[0].fromPortId,undefined);
 assert.equal((await materializer.runOnce()).length,0);
 assert.equal(getProject(f.db,"canvas-1").revision,2);
 assert.equal(calls,1);
});
test("P4.4 ordinary model artifacts do not overwrite edited Canvas source",async t=>{
 const f=fixture(t,async()=>new Response(JSON.stringify({
  data:[{b64_json:png.toString("base64")}]}),{status:200}));
 const doc={nodes:[{id:"prompt-1",type:"text",title:"Prompt",position:{x:0,y:0},
  width:320,height:200,metadata:{content:"first"}}],connections:[]};
 createProject(f.db,{id:"canvas-2",document:doc});
 const key="stale";
 const id=submitJob(f.db,{idempotencyKey:key,requestFingerprint:key,
  executionMode:"immediate",projectId:"canvas-2",targetNodeId:"prompt-1",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"prompt-1"),
  snapshot:f.snapshot({kind:"image",model:"gpt-image-2",prompt:"first"})}).jobId;
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 const updated=structuredClone(doc);updated.nodes[0].metadata.content="second";
 patchProject(f.db,{id:"canvas-2",expectedRevision:1,document:updated});
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 const result=await materializer.runOnce();
 assert.equal(result[0].status,"materialized");
 const after=getProject(f.db,"canvas-2").document;
 assert.equal(after.nodes.length,2);
 assert.equal(after.nodes[0].metadata.content,"second");
 assert.equal(after.nodes[1].metadata.sourceChangedSinceSubmit,true);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
});
test("P4.4 Fastify /jobs HTTP -> auto Worker -> BlobStore -> ordinary Canvas materialization",async t=>{
 const f=fixture(t,async(_url,options)=>{
  assert.ok(!options.body.includes("fixture-only-not-a-real-secret"));
  return new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}),{status:200});
 });
 const doc={nodes:[{id:"prompt-1",type:"text",title:"Prompt",position:{x:0,y:0},
  width:330,height:180,metadata:{content:"a forest"}}],connections:[]};
 createProject(f.db,{id:"http-project",document:doc});
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 f.coordinator.recoverAtStartup();
 const worker=createBackendWorker({coordinator:f.coordinator,materializer,intervalMs:25}).start();
 const app=buildApp({db:f.db,authorize:()=>true,vault:f.vault,
  blobStore:f.blobStore,coordinator:f.coordinator,materializer,worker,
  modelKinds:["image","audio","text"]});
 try{
  const capabilities=await app.inject({method:"GET",url:"/api/v1/execution/capabilities"});
  assert.equal(capabilities.statusCode,200);
  assert.deepEqual(capabilities.json().modelKinds,["image","audio","text"]);
  const channel=await app.inject({method:"GET",url:"/api/v1/channels/openai-channel"});
  assert.equal(channel.statusCode,200);
  assert.ok(channel.json().hasKey);
  assert.ok(!JSON.stringify(channel.json()).includes("fixture-only-not-a-real-secret"));
  const key="http-model-request";
  const body={projectId:"http-project",targetNodeId:"prompt-1",
   expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"prompt-1"),
   idempotencyKey:key,requestFingerprint:key,executionMode:"immediate",
   snapshot:f.snapshot({kind:"image",model:"gpt-image-2",prompt:"a forest"})};
  const response=await app.inject({method:"POST",url:"/api/v1/jobs",payload:body});
  assert.equal(response.statusCode,201,response.body);
  const jobId=response.json().id;
  const duplicate=await app.inject({method:"POST",url:"/api/v1/jobs",payload:body});
  assert.equal(duplicate.statusCode,200);
  assert.equal(duplicate.json().id,jobId);
  let project;
  for(let i=0;i<110;i++){
   project=getProject(f.db,"http-project");
   if(project.document.nodes.length===2)break;
   await new Promise(resolve=>setTimeout(resolve,15));
  }
  assert.equal(project.document.nodes.length,2);
  assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
  assert.equal(project.document.nodes[1].metadata.modelArtifact.jobId,jobId);
  const artifacts=await app.inject({method:"GET",url:"/api/v1/jobs/"+jobId+"/artifacts"});
  assert.equal(artifacts.statusCode,200);
  assert.equal(artifacts.json().artifacts.length,1);
  const media=await app.inject({method:"GET",url:project.document.nodes[1].metadata.content});
  assert.equal(media.statusCode,200);
  assert.deepEqual(media.rawPayload,png);
 }finally{await worker.stop();await f.coordinator.stop();await app.close()}
});
test("P4.4 provider 4xx is confirmed failure; 5xx or network uncertainty is not retried",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;return new Response(JSON.stringify({error:"secret ignored"}),{status:400})});
 const id=f.enqueue("rejected",{kind:"text",model:"gpt-4o-mini",prompt:"hello"});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"failed");
 assert.equal(calls,1);
});


const skillPack={format:"atelier-skill-snapshot-v1",entries:[{
 id:"shot-style",version:"a".repeat(12),hash:"a".repeat(64),
 name:"Shot Style",description:"Film shot list and cinematic lighting",
 skillMd:"---\\nname: shot-style\\ndescription: Shot Style\\n---\\nUse soft light",
 resources:{"references/camera.md":"Camera: 35mm"}}
]};
const toolCall=(id,name,args)=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const skillResponse=(tools,text="")=>new Response(JSON.stringify({choices:[{
 finish_reason:tools.length?"tool_calls":"stop",
 message:{role:"assistant",content:text,tool_calls:tools}
}]}),{status:200});
test("P5.4f SQLite Skill agent executes authorized read-only tool rounds and saves one CAS text artifact",async t=>{
 const requests=[];
 const f=fixture(t,async(url,options)=>{
  assert.equal(url,"https://api.openai.com/v1/chat/completions");
  const body=JSON.parse(options.body);requests.push(body);
  assert.equal(body.stream,false);
  assert.deepEqual(body.tools.map(t=>t.function.name),
   ["search_skills","activate_skill","read_skill_resource"]);
  if(requests.length===1)return skillResponse([
   toolCall("a1","search_skills",{query:"lighting"})]);
  if(requests.length===2)return skillResponse([
   toolCall("a2","activate_skill",{skill_id:"shot-style"})]);
  if(requests.length===3)return skillResponse([
   toolCall("a3","read_skill_resource",{skill_id:"shot-style",path:"references/camera.md"})]);
  assert.equal(body.messages.at(-1).role,"tool");
  assert.ok(body.messages.at(-1).content.includes("35mm"));
  return skillResponse([],"Use 35mm film and soft light.");
 });
 const input=Buffer.from(JSON.stringify(skillPack));
 const stored=await f.blobStore.put([input],{mime:"text/plain"});
 const id=f.enqueue("auto-skills",{
  kind:"text",model:"gpt-4o-mini",prompt:"Write a shot list",stream:false,
  messages:[{role:"user",content:"Write a shot list"}],
  skills:{blobId:stored.blobId}
 });
 f.coordinator.recoverAtStartup();await f.coordinator.tick();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 const artifact=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(id);
 assert.equal(artifact.kind,"text");
 const {readFile}=await import("node:fs/promises");
 assert.equal(await readFile((await f.blobStore.stat(artifact.blob_id)).path,"utf8"),
  "Use 35mm film and soft light.");
 const log=f.db.prepare("SELECT payload_json FROM job_events WHERE job_id=? AND kind='skill_tool'").all(id);
 assert.equal(log.length,6); // 3 started + 3 completed, no Skill body
 assert.ok(log.every(e=>!e.payload_json.includes("Camera: 35mm")));
 assert.equal(requests.length,4);
 assert.ok(!JSON.stringify(requests).includes("fixture-only-not-a-real-secret"));
 const snapshot=f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(id).snapshot_json;
 assert.ok(snapshot.includes(stored.blobId));
 assert.ok(!snapshot.includes("Shot Style"));
 assert.equal(f.enqueue("auto-skills",{
  kind:"text",model:"gpt-4o-mini",prompt:"Write a shot list",stream:false,
  messages:[{role:"user",content:"Write a shot list"}],
  skills:{blobId:stored.blobId}
 }),id);
 assert.equal(requests.length,4);
});
test("P5.4f unauthorized function requests never invoke arbitrary tools or retry upstream",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;return skillResponse([toolCall("evil","exec_shell",{cmd:"whoami"})])});
 const stored=await f.blobStore.put([Buffer.from(JSON.stringify(skillPack))],{mime:"text/plain"});
 const id=f.enqueue("unauthorized-skill",{
  kind:"text",model:"gpt-4o-mini",prompt:"Check",stream:false,
  messages:[{role:"user",content:"Check"}],skills:{blobId:stored.blobId}
 });
 f.coordinator.recoverAtStartup();await f.coordinator.tick();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"submission_unknown");
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(id).n,0);
 assert.equal(calls,1);
});
test("P5.4f unauthorized path and unactivated skill reference fail closed",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{
  calls++;return skillResponse([toolCall("r1","read_skill_resource",{
   skill_id:"shot-style",path:"../../secrets.txt"})]);
 });
 const stored=await f.blobStore.put([Buffer.from(JSON.stringify(skillPack))],{mime:"text/plain"});
 const id=f.enqueue("path-skill",{
  kind:"text",model:"gpt-4o-mini",prompt:"Check",stream:false,
  messages:[{role:"user",content:"Check"}],skills:{blobId:stored.blobId}
 });
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"submission_unknown");
 assert.equal(calls,1);
});
test("P5.4f invalid/missing CAS snapshots are rejected before any billable call",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;return skillResponse([],"ok")});
 const base={kind:"text",model:"gpt-4o-mini",prompt:"task",stream:false,
  messages:[{role:"user",content:"task"}]};
 for(const invalid of [
  {skills:{blobId:"ab"}},{skills:{blobId:"a".repeat(64),apiKey:"inject"}},
  {skills:{blobId:"a".repeat(64)},stream:"yes"}
 ])assert.throws(()=>validateModelSnapshot(f.snapshot({...base,...invalid})));
 const id=f.enqueue("skill-missing",{...base,skills:{blobId:"a".repeat(64)}});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"failed");
 assert.equal(calls,0);
});

const ssePacket=value=>"data: "+JSON.stringify({choices:[{index:0,...value}]})+"\n\n";
function fragmentedSseResponse(parts){
 const encoder=new TextEncoder();
 return new Response(new ReadableStream({
  start(ctrl){
   for(const part of parts)for(const segment of [part.slice(0,Math.floor(part.length/3)),
      part.slice(Math.floor(part.length/3))])ctrl.enqueue(encoder.encode(segment));
   ctrl.close();
  }
 }),{status:200,headers:{"content-type":"text/event-stream"}});
}
test("P5.4g mixed SSE streams partial function names and JSON args, then final text without double billing",async t=>{
 let requests=0;
 const f=fixture(t,async(url,options)=>{
  requests++;
  assert.equal(url,"https://api.openai.com/v1/chat/completions");
  const payload=JSON.parse(options.body);
  assert.equal(payload.stream,true);
  if(requests===1){
   return fragmentedSseResponse([
    ssePacket({delta:{role:"assistant",tool_calls:[{index:0,id:"g1",type:"function",
      function:{name:"activate_",arguments:'{"skill_'}}]},finish_reason:null}),
    ssePacket({delta:{tool_calls:[{index:0,function:{name:"skill",arguments:'id":"shot-style"}'}}]},
      finish_reason:null}),
    ssePacket({delta:{},finish_reason:"tool_calls"}),"data: [DONE]\n\n"
   ]);
  }
  assert.equal(payload.messages.at(-1).role,"tool");
  assert.ok(payload.messages.at(-1).content.includes("Use soft light"));
  return fragmentedSseResponse([
   ssePacket({delta:{role:"assistant",content:"Shoot "},finish_reason:null}),
   ssePacket({delta:{content:"with care."},finish_reason:null}),
   ssePacket({delta:{},finish_reason:"stop"}),"data: [DONE]\n\n"
  ]);
 });
 const frozen=await f.blobStore.put([Buffer.from(JSON.stringify(skillPack))],{mime:"text/plain"});
 const id=f.enqueue("g-stream",{kind:"text",model:"gpt-4o-mini",
  prompt:"Make shots",messages:[{role:"user",content:"Make shots"}],
  stream:true,skills:{blobId:frozen.blobId}});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 const log=f.db.prepare("SELECT kind,payload_json FROM job_events WHERE job_id=? AND kind IN ('skill_tool','skill_text_delta') ORDER BY seq").all(id);
 assert.equal(log.filter(e=>e.kind==="skill_tool").length,2);
 const deltas=log.filter(e=>e.kind==="skill_text_delta").map(e=>JSON.parse(e.payload_json));
 assert.equal(deltas.map(d=>d.delta).join(""),"Shoot with care.");
 assert.ok(deltas.every(d=>d.round===1));
 assert.ok(!JSON.stringify(log).includes("shot-style"+"\\nUse soft light"));
 const artifact=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(id);
 const {readFile}=await import("node:fs/promises");
 assert.equal(await readFile((await f.blobStore.stat(artifact.blob_id)).path,"utf8"),"Shoot with care.");
 await f.coordinator.tick();
 assert.equal(requests,2);
});
test("P5.4g incomplete SSE with a partial function call remains submission_unknown",async t=>{
 let requests=0;
 const f=fixture(t,async()=>{requests++;
  return fragmentedSseResponse([ssePacket({delta:{
   tool_calls:[{index:0,id:"g-incomplete",type:"function",
    function:{name:"activate_skill",arguments:'{"skill_id":"shot-style"}'}}]},
   finish_reason:"tool_calls"})]); // no DONE
 });
 const frozen=await f.blobStore.put([Buffer.from(JSON.stringify(skillPack))],{mime:"text/plain"});
 const id=f.enqueue("g-incomplete",{kind:"text",model:"gpt-4o-mini",
  prompt:"Make shots",messages:[{role:"user",content:"Make shots"}],
  stream:true,skills:{blobId:frozen.blobId}});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"submission_unknown");
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(id).n,0);
 assert.equal(requests,1);
});
test("P5.4g project-scoped Skill audit and explicit frozen replay preserve provenance",async t=>{
 let requests=0;
 const f=fixture(t,async()=>{requests++;return skillResponse([],"Frozen response")});
 const doc={nodes:[{id:"skill-src",type:"text",title:"Skill",position:{x:0,y:0},
  width:300,height:200,metadata:{prompt:"Generate"}}],connections:[]};
 createProject(f.db,{id:"skill-project",document:doc});
 createProject(f.db,{id:"other-project",document:doc});
 const frozen=await f.blobStore.put([Buffer.from(JSON.stringify(skillPack))],{mime:"text/plain"});
 const task={kind:"text",model:"gpt-4o-mini",prompt:"Generate",
  messages:[{role:"user",content:"Generate"}],skills:{blobId:frozen.blobId},stream:false};
 const id=submitJob(f.db,{projectId:"skill-project",targetNodeId:"skill-src",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"skill-src"),
  idempotencyKey:"first-run",requestFingerprint:"first-run",
  executionMode:"immediate",snapshot:f.snapshot(task)}).jobId;
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(requests,1);
 const app=buildApp({db:f.db,authorize:()=>true,blobStore:f.blobStore});
 try{
  const url="/api/v1/projects/skill-project/jobs/"+id;
  const detail=await app.inject({method:"GET",url:url+"/skill-audit"});
  assert.equal(detail.statusCode,200,detail.body);
  const audit=detail.json();
  assert.equal(audit.canReplay,true);
  assert.deepEqual(audit.versionPins.map(s=>s.version),["a".repeat(12)]);
  assert.ok(!detail.body.includes("Generate"));
  assert.ok(!detail.body.includes("Use soft light"));
  assert.ok(!detail.body.includes("fixture-only-not-a-real-secret"));
  assert.equal((await app.inject({method:"GET",
   url:"/api/v1/projects/other-project/jobs/"+id+"/skill-audit"})).statusCode,404);
  const payload={expectedProjectRevision:1,
   idempotencyKey:"rerun-key",requestFingerprint:"rerun-key"};
  const replay=await app.inject({method:"POST",url:url+"/replay-skills",payload});
  assert.equal(replay.statusCode,201,replay.body);
  assert.notEqual(replay.json().id,id);
  assert.deepEqual(JSON.parse(f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(replay.json().id).snapshot_json),
   JSON.parse(f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(id).snapshot_json));
  const duplicate=await app.inject({method:"POST",url:url+"/replay-skills",payload});
  assert.equal(duplicate.statusCode,200,duplicate.body);
  assert.equal(duplicate.json().id,replay.json().id);
  const newRequest=await app.inject({method:"POST",url:url+"/replay-skills",payload:{
   expectedProjectRevision:1,idempotencyKey:"other-new",requestFingerprint:"other-new"
  }});
  // Text requests are explicitly independent: a separate replay click gets
  // a fresh job even while the preceding text replay is still queued.
  assert.equal(newRequest.statusCode,201,newRequest.body);
  assert.notEqual(newRequest.json().id,replay.json().id);
  assert.equal(requests,1); // creating a job does not directly bill upstream
  const updated=structuredClone(doc);updated.nodes[0].metadata.prompt="modified";
  patchProject(f.db,{id:"skill-project",expectedRevision:1,document:updated});
  const stale=await app.inject({method:"POST",url:url+"/replay-skills",payload:{
   expectedProjectRevision:2,idempotencyKey:"stale",requestFingerprint:"stale"
  }});
  assert.equal(stale.statusCode,409);
  assert.equal(stale.json().code,"skill_replay_source_changed");
 }finally{await app.close()}
});
test("P5.4e frozen multi-turn history with past Skill tool results maps safely to OpenAI chat roles",async t=>{
 let sent;
 const f=fixture(t,async(url,opts)=>{
  sent={url,body:JSON.parse(opts.body)};
  return new Response(JSON.stringify({choices:[{message:{content:"Done."}}]}),{status:200});
 });
 const messages=[
  {role:"system",content:"Be concise."},
  {role:"user",content:"Locate a suitable Skill."},
  {role:"assistant",content:"",toolCalls:[{id:"call_a1",name:"search_skills",argumentsJson:'{"query":"style"}'}]},
  {role:"tool",callId:"call_a1",name:"search_skills",content:'{"matches":[]}'},
  {role:"user",content:"Write the final answer"}
 ];
 const id=f.enqueue("multiturn",{
  kind:"text",model:"gpt-4o-mini",prompt:"Write the final answer",messages
 });
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(sent.url,"https://api.openai.com/v1/chat/completions");
 assert.deepEqual(sent.body.messages,[messages[0],messages[1],{
  role:"assistant",content:null,tool_calls:[{id:"call_a1",type:"function",
   function:{name:"search_skills",arguments:'{"query":"style"}'}}]
 },{role:"tool",tool_call_id:"call_a1",content:'{"matches":[]}'},messages[4]]);
 assert.ok(!JSON.stringify(sent).includes("fixture-only-not-a-real-secret"));
});
test("P5.4e accepts fragmented SSE, records bounded replayable deltas, and materializes only complete text",async t=>{
 let calls=0;
 const f=fixture(t,async(url,opts)=>{
  calls++;
  assert.equal(url,"https://api.openai.com/v1/chat/completions");
  assert.equal(JSON.parse(opts.body).stream,true);
  const encoder=new TextEncoder();
  const chunks=[
   'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n',
   '\ndata: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
   'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
   'data: [DONE]\n\n'
  ];
  return new Response(new ReadableStream({
   start(ctrl){for(const chunk of chunks)ctrl.enqueue(encoder.encode(chunk));ctrl.close()}
  }),{status:200,headers:{"content-type":"text/event-stream"}});
 });
 const id=f.enqueue("stream-text",{
  kind:"text",model:"gpt-4o-mini",prompt:"Say hello",stream:true
 });
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 const artifact=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(id);
 const {readFile}=await import("node:fs/promises");
 assert.equal(await readFile((await f.blobStore.stat(artifact.blob_id)).path,"utf8"),"Hello world");
 const events=f.db.prepare("SELECT * FROM job_events WHERE job_id=? AND kind='model_text_delta' ORDER BY seq").all(id);
 assert.ok(events.length>0);
 assert.equal(events.map(e=>JSON.parse(e.payload_json).delta).join(""),"Hello world");
 assert.equal(calls,1);
 const {readEventsAfter}=await import("./repository.mjs");
 assert.ok(readEventsAfter(f.db,0).some(e=>e.kind==="model_text_delta"));
});
test("P5.4e truncated SSE is submission_unknown, not successful or retried",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;return new Response(
  'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',{status:200});
 });
 const id=f.enqueue("stream-truncated",{kind:"text",model:"gpt-4o-mini",prompt:"test",stream:true});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"submission_unknown");
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM artifacts WHERE job_id=?").get(id).n,0);
 assert.equal(calls,1);
});
test("P5.4e rejects fabricated/unsafe conversation transcripts before billing",async t=>{
 let calls=0;
 const f=fixture(t,async()=>{calls++;return new Response("{}",{status:200})});
 const base={kind:"text",model:"gpt-4o-mini",prompt:"Now"};
 const variants=[
  [{role:"system",content:"rules"}],
  [{role:"user",content:"not equal"}],
  [{role:"user",content:"Now",apiKey:"leak"}],
  [{role:"assistant",content:"",toolCalls:[{id:"id",name:"tool",argumentsJson:"not-json"}]},{role:"user",content:"Now"}],
  [{role:"tool",content:"invented",callId:"fake",name:"search_skills"},{role:"user",content:"Now"}],
  [{role:"assistant",content:"",toolCalls:[{id:"id",name:"tool",argumentsJson:"{}"}]},{role:"user",content:"Now"}],
  Array.from({length:33},()=>({role:"user",content:"Now"}))
 ];
 for(const messages of variants)
  assert.throws(()=>validateModelSnapshot(f.snapshot({...base,messages})),/history_invalid/);
 assert.throws(()=>validateModelSnapshot(f.snapshot({...base,stream:"yes"})),/model_task_invalid/);
 assert.equal(calls,0);
});
test("P5.4d image edits use frozen CAS files, official multipart endpoint and DPAPI key",async t=>{
 const calls=[];
 const f=fixture(t,async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}),{status:200});
 });
 const input=await f.blobStore.put([png],{mime:"image/png"});
 const task={kind:"image",model:"gpt-image-2",prompt:"Add a hat",operation:"edit",
  images:[{blobId:input.blobId,mimeType:"image/png"}],size:"1024x1024",quality:"low"};
 const id=f.enqueue("edit-one",task);
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,"https://api.openai.com/v1/images/edits");
 const opts=calls[0].options;
 assert.equal(opts.headers.authorization,"Bearer fixture-only-not-a-real-secret");
 assert.equal(opts.headers["content-type"],undefined);
 assert.ok(opts.body instanceof FormData);
 assert.equal(opts.body.get("prompt"),"Add a hat");
 assert.equal(opts.body.get("model"),"gpt-image-2");
 assert.equal(opts.body.getAll("image").length,1);
 assert.deepEqual(Buffer.from(await opts.body.get("image").arrayBuffer()),png);
 assert.ok(!f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(id).snapshot_json
  .includes(png.toString("base64")));
 const output=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(id);
 assert.equal(output.kind,"image");
 assert.equal((await f.blobStore.stat(output.blob_id)).mimeType,"image/png");
});
test("P5.4d optional frozen PNG mask remains isolated to image editing",async t=>{
 let submitted;
 const f=fixture(t,async(_url,options)=>{
  submitted=options.body;
  return new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}),{status:200});
 });
 const input=await f.blobStore.put([png],{mime:"image/png"});
 f.enqueue("masked-edit",{kind:"image",model:"gpt-image-2",prompt:"replace background",
  operation:"edit",images:[{blobId:input.blobId,mimeType:"image/png"}],
  mask:{blobId:input.blobId,mimeType:"image/png"}});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.ok(submitted instanceof FormData);
 assert.equal(submitted.getAll("image").length,1);
 assert.deepEqual(Buffer.from(await submitted.get("mask").arrayBuffer()),png);
});
test("P5.4d vision question sends CAS-backed multimodal Chat Completions with no browser key",async t=>{
 let sent;
 const f=fixture(t,async(url,options)=>{
  sent={url,body:JSON.parse(options.body),authorization:options.headers.authorization};
  return new Response(JSON.stringify({choices:[{message:{content:"It is a fox."}}]}),{status:200});
 });
 const input=await f.blobStore.put([png],{mime:"image/png"});
 const id=f.enqueue("vision-text",{kind:"text",model:"gpt-4o-mini",
  prompt:"Describe this image",images:[{blobId:input.blobId,mimeType:"image/png"}]});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(sent.url,"https://api.openai.com/v1/chat/completions");
 assert.equal(sent.authorization,"Bearer fixture-only-not-a-real-secret");
 assert.deepEqual(sent.body.messages,[{role:"user",content:[
  {type:"text",text:"Describe this image"},
  {type:"image_url",image_url:{url:"data:image/png;base64,"+png.toString("base64")}}
 ]}]);
 const artifact=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(id);
 assert.equal(artifact.kind,"text");
 const {readFile}=await import("node:fs/promises");
 const stored=await f.blobStore.stat(artifact.blob_id);
 const content=await readFile(stored.path,"utf8");
 assert.equal(content,"It is a fox.");
 assert.ok(!f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(id).snapshot_json.includes("base64"));
});

test("P5.4d full SQLite image edit materializes an immutable child, retains CAS input",async t=>{
 const f=fixture(t,async(url,options)=>{
  assert.equal(url,"https://api.openai.com/v1/images/edits");
  assert.ok(options.body instanceof FormData);
  return new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}),{status:200});
 });
 const ref=await f.blobStore.put([png],{mime:"image/png"});
 const source={id:"source-image",type:"image",title:"Original",
  position:{x:0,y:0},width:420,height:400,
  metadata:{storageKey:"cas:"+ref.blobId,content:"/api/v1/blobs/"+ref.blobId,mimeType:"image/png"}};
 const doc={nodes:[source],connections:[]};
 createProject(f.db,{id:"edit-canvas",document:doc});
 const key="edit-canvas-job";
 const job=submitJob(f.db,{idempotencyKey:key,requestFingerprint:key,
  executionMode:"immediate",projectId:"edit-canvas",targetNodeId:"source-image",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"source-image"),
  snapshot:f.snapshot({kind:"image",model:"gpt-image-2",prompt:"add a cat",
   operation:"edit",images:[{blobId:ref.blobId,mimeType:"image/png"}]})}).jobId;
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 const first=await materializer.runOnce();
 assert.equal(first.length,1);
 assert.equal(first[0].status,"materialized");
 const project=getProject(f.db,"edit-canvas");
 assert.equal(project.document.nodes.length,2);
 assert.equal(project.document.nodes[1].metadata.modelArtifact.jobId,job);
 assert.equal(project.document.nodes[1].type,"image");
 assert.equal(project.document.connections.length,1);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(job).status,"succeeded");
 assert.equal((await materializer.runOnce()).length,0);
 const {currentBlobReferences}=await import("./blob-reference-ledger.mjs");
 assert.ok(currentBlobReferences(f.db).has(ref.blobId));
});
test("P5.4d multimodal question saves text node and input CAS is still referenced",async t=>{
 const f=fixture(t,async(url,options)=>{
  assert.equal(url,"https://api.openai.com/v1/chat/completions");
  assert.match(options.body,/data:image\/png;base64,/);
  return new Response(JSON.stringify({choices:[{message:{content:"A fox on snow."}}]}),{status:200});
 });
 const ref=await f.blobStore.put([png],{mime:"image/png"});
 const doc={nodes:[{id:"question",type:"text",title:"Question",
  position:{x:0,y:0},width:330,height:220,metadata:{content:"What is in this image?"}}],connections:[]};
 createProject(f.db,{id:"vision-canvas",document:doc});
 const key="vision-canvas-job";
 submitJob(f.db,{idempotencyKey:key,requestFingerprint:key,
  executionMode:"immediate",projectId:"vision-canvas",targetNodeId:"question",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"question"),
  snapshot:f.snapshot({kind:"text",model:"gpt-4o-mini",prompt:"What is in this image?",
   images:[{blobId:ref.blobId,mimeType:"image/png"}]})});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 assert.equal((await materializer.runOnce())[0].status,"materialized");
 const nodes=getProject(f.db,"vision-canvas").document.nodes;
 assert.equal(nodes.length,2);assert.equal(nodes[1].type,"text");
 assert.equal(nodes[1].metadata.content,"A fox on snow.");
 const {currentBlobReferences}=await import("./blob-reference-ledger.mjs");
 assert.ok(currentBlobReferences(f.db).has(ref.blobId));
});
test("P5.4d rejects raw inline media, unauthorized mime, invalid task fields and missing CAS before upstream",async t=>{
 let posted=0;
 const f=fixture(t,async()=>{posted++;return new Response("{}",{status:200})});
 const base={kind:"text",model:"gpt-4o-mini",prompt:"What is this"};
 const goodId="a".repeat(64),ref={blobId:goodId,mimeType:"image/png"};
 for(const task of [
  {...base,images:[{...ref,dataUrl:"data:image/png;base64,secret"}]},
  {...base,images:[{blobId:"https://evil.example/pic",mimeType:"image/png"}]},
  {...base,images:[{blobId:goodId,mimeType:"text/html"}]},
  {...base,images:Array.from({length:9},()=>ref)},
  {kind:"image",model:"gpt-image-2",prompt:"edit",images:[ref]},
  {kind:"image",model:"gpt-image-2",prompt:"edit",operation:"edit",images:[ref],mask:{...ref,mimeType:"image/jpeg"}},
  {...base,mask:ref}
 ])assert.throws(()=>validateModelSnapshot(f.snapshot(task)));
 const id=f.enqueue("missing-image",{...base,images:[ref]});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.notEqual(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(posted,0);
});
test("P5.4d rejects CAS MIME mismatch before making any billable API call",async t=>{
 let posted=0;
 const f=fixture(t,async()=>{posted++;return new Response("{}",{status:200})});
 const image=await f.blobStore.put([png],{mime:"image/png"});
 const id=f.enqueue("invalid-mime",{kind:"image",model:"gpt-image-2",prompt:"edit",
  operation:"edit",images:[{blobId:image.blobId,mimeType:"image/jpeg"}]});
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.notEqual(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(posted,0);
});
