import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createArkVideoAdapter,verifyArkVideoUrl,validateArkVideoSnapshot} from "./ark-video-adapter.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {submitJob,fingerprintSource} from "./repository.mjs";
import {createCanvasMaterializer} from "./canvas-materializer.mjs";
import {createProject,getProject,patchProject} from "./projects.mjs";
import {buildApp} from "./app.mjs";

const mp4=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const trustedUrl="https://ark-content-generation-cn-beijing.tos-cn-beijing.volces.com/videos/test.mp4?X-Tos-Signature=fake";
const root="https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks";
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}});
function fixture(t,upstreamCall){
 const dir=mkdtempSync(join(tmpdir(),"atelier-ark-video-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const vault=createCredentialVault({db,protector:{protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)}});
 const channel=vault.create({id:"ark-test",provider:"volcengine_ark",displayName:"Ark",
  apiKey:"fixture-key-do-not-persist"});
 const blobStore=createBlobStore({dataDir:dir,db});
 const snapshot=task=>({adapterKind:"model",provider:"volcengine_ark",channelId:channel.id,
  secretVersionRef:channel.keyVersion,task});
 const makeAdapter=fn=>createArkVideoAdapter({db,vault,blobStore,upstreamCall:fn});
 const task={kind:"video",model:"doubao-seedance-2-0-260128",prompt:"a fox in the snow",
  duration:6,ratio:"16:9",resolution:"720p",generateAudio:true,watermark:false};
 const add=(key,extra={})=>submitJob(db,{idempotencyKey:key,requestFingerprint:key,
  executionMode:"poll",snapshot:snapshot(task),...extra}).jobId;
 return {db,channel,vault,blobStore,snapshot,task,makeAdapter,add};
}
test("P4.4 Ark video POST once, persist remote task id, resume GET-only after restart, CAS + Canvas materialization",async t=>{
 const calls=[];
 const upstream=async(url,init)=>{
  calls.push({url,method:init.method,headers:init.headers,body:init.body});
  if(url===root&&init.method==="POST")return response({id:"cgt-20261026-abcdef",status:"queued"});
  if(url===root+"/cgt-20261026-abcdef")
   return response({id:"cgt-20261026-abcdef",status:calls.filter(c=>c.url===url).length<2?"running":"succeeded",
    content:{video_url:trustedUrl}});
  if(url===trustedUrl)return new Response(mp4,{status:200,headers:{"content-type":"video/mp4"}});
  throw Error("unexpected url "+url);
 };
 const f=fixture(t,upstream);
 const doc={nodes:[{id:"prompt1",type:"text",title:"Prompt",position:{x:0,y:0},width:320,
  height:200,metadata:{content:"a fox"}}],connections:[]};
 createProject(f.db,{id:"test-project",document:doc});
 const id=f.add("video-1",{projectId:"test-project",targetNodeId:"prompt1",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc,"prompt1")});
 const c=createJobCoordinator({db:f.db,adapters:{model:f.makeAdapter(upstream)}});
 c.recoverAtStartup();await c.tick();
 const created=f.db.prepare("SELECT status,upstream_task_id,snapshot_json FROM jobs WHERE id=?").get(id);
 assert.equal(created.status,"running");
 assert.equal(created.upstream_task_id,"cgt-20261026-abcdef");
 assert.ok(!created.snapshot_json.includes("fixture-key-do-not-persist"));
 assert.equal(calls.filter(x=>x.method==="POST").length,1);
 await c.tick();assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"running");
 const restarted=createJobCoordinator({db:f.db,adapters:{model:f.makeAdapter(upstream)}});
 restarted.recoverAtStartup();await restarted.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(calls.filter(x=>x.method==="POST").length,1);
 assert.deepEqual(JSON.parse(calls.find(x=>x.method==="POST").body),{
  model:f.task.model,content:[{type:"text",text:f.task.prompt}],ratio:"16:9",
  resolution:"720p",duration:6,generate_audio:true,watermark:false});
 const media=f.db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(id);
 assert.equal(media.kind,"video");assert.equal(media.mime,"video/mp4");
 assert.equal((await f.blobStore.stat(media.blob_id)).byteSize,mp4.length);
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 assert.equal((await materializer.runOnce())[0].status,"materialized");
 const project=getProject(f.db,"test-project");
 assert.equal(project.document.nodes[1].type,"video");
 assert.equal(project.document.nodes[1].metadata.storageKey,"cas:"+media.blob_id);
 assert.equal(project.document.nodes[1].metadata.modelArtifact.jobId,id);
 assert.equal(project.document.connections.length,1);
 assert.equal((await materializer.runOnce()).length,0);
});
test("P4.4 failed download retries only signed TOS GET, never another generation POST",async t=>{
 let submits=0,downloads=0;
 const f=fixture(t,async(url,init)=>{
  if(url===root&&init.method==="POST"){submits++;return response({id:"cgt-abc",status:"queued"})}
  if(url===root+"/cgt-abc")return response({id:"cgt-abc",status:"succeeded",content:{video_url:trustedUrl}});
  if(url===trustedUrl){downloads++;if(downloads===1)throw Error("network offline");return new Response(mp4)}
  throw Error("unknown");
 });
 const adapter=f.makeAdapter(async(url,init)=>{
  if(url===root&&init.method==="POST"){submits++;return response({id:"cgt-abc",status:"queued"})}
  if(url===root+"/cgt-abc")return response({id:"cgt-abc",status:"succeeded",content:{video_url:trustedUrl}});
  if(url===trustedUrl){downloads++;if(downloads===1)throw Error("network offline");return new Response(mp4)}
  throw Error("unknown");
 });
 const id=f.add("retry");
 const c=createJobCoordinator({db:f.db,adapters:{model:adapter}});
 c.recoverAtStartup();await c.tick();await c.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"collecting");
 await c.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
 assert.equal(submits,1);assert.equal(downloads,2);
});
test("P4.4 Ark signed download URL allowlist blocks SSRF, redirects and private hosts",()=>{
 for(const url of ["http://169.254.169.254/latest","https://127.0.0.1/video.mp4",
  "https://ark-content-generation-cn-beijing.tos-cn-beijing.volces.com.evil.org/a",
  "https://example.com/video.mp4","https://x:secret@ark-content-generation-cn-beijing.tos-cn-beijing.volces.com/a",
  "https://ark-content-generation-cn-beijing.tos-cn-beijing.volces.com:444/a"])
  assert.throws(()=>verifyArkVideoUrl(url));
 assert.equal(verifyArkVideoUrl(trustedUrl),trustedUrl);
});
test("P4.4 Ark enforces shape and credential constraints and never resubmits ambiguous POST",async t=>{
 const f=fixture(t,async()=>{throw Error("socket closed after accepting")});
 assert.throws(()=>validateArkVideoSnapshot(f.snapshot({...f.task,duration:999})));
 const id=f.add("ambiguous");
 const c=createJobCoordinator({db:f.db,adapters:{model:f.makeAdapter(async()=>{throw Error("lost")})}});
 c.recoverAtStartup();await c.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"submission_unknown");
 const restarted=createJobCoordinator({db:f.db,adapters:{model:f.makeAdapter(async()=>{throw Error("should not retry")})}});
 restarted.recoverAtStartup();assert.equal(await restarted.tick(),0);
});
test("P4.4 cancels local queued video before costly POST via HTTP endpoint",async t=>{
 let submits=0;
 const f=fixture(t,async()=>{submits++;throw Error("must never submit")});
 const id=f.add("local-cancel");
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:f.makeAdapter(async()=>{submits++})}});
 coordinator.recoverAtStartup();
 const app=buildApp({db:f.db,authorize:()=>true,coordinator});
 try{
  const reply=await app.inject({method:"POST",url:"/api/v1/jobs/"+id+"/cancel",payload:{}});
  assert.equal(reply.statusCode,200);
  assert.equal(reply.json().cancelled,true);
  assert.equal(reply.json().remoteCancelled,false);
  assert.equal(await coordinator.tick(),0);
  assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"cancelled");
  assert.equal(submits,0);
 }finally{await app.close()}
});
test("P4.4 Ark remote cancel DELETE only after confirming queued; running must remain running",async t=>{
 const operations=[];let status="queued";
 const f=fixture(t,async(url,init)=>{
  operations.push({url,method:init.method});
  if(init.method==="POST")return response({id:"cgt-test"});
  if(init.method==="GET")return response({id:"cgt-test",status});
  if(init.method==="DELETE"){status="cancelled";return response({})}
  throw Error("unknown");
 });
 const upstream=async(url,init)=>{
  operations.push({url,method:init.method});
  if(init.method==="POST")return response({id:"cgt-test"});
  if(init.method==="GET")return response({id:"cgt-test",status});
  if(init.method==="DELETE"){status="cancelled";return response({})}
 };
 const adapter=f.makeAdapter(upstream),c=createJobCoordinator({db:f.db,adapters:{model:adapter}});
 const id=f.add("remote-cancel");c.recoverAtStartup();await c.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"running");
 assert.deepEqual(await c.cancel(id),{cancelled:true,remoteCancelled:true,reason:undefined});
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"cancelled");
 assert.equal(operations.filter(x=>x.method==="DELETE").length,1);
 assert.equal(operations.filter(x=>x.method==="POST").length,1);
 const id2=f.add("remote-running");
 status="queued";await c.tick();
 status="running";const no=await c.cancel(id2);
 assert.equal(no.cancelled,false);
 assert.equal(no.reason,"ark_video_not_queued");
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id2).status,"running");
 assert.equal(operations.filter(x=>x.method==="DELETE").length,1);
});
test("P4.4 Ark source edits cannot silently adopt generated video",async t=>{
 const f=fixture(t,async(url,init)=>{
  if(url===root&&init.method==="POST")return response({id:"cgt-123"});
  if(url===root+"/cgt-123")return response({id:"cgt-123",status:"succeeded",content:{video_url:trustedUrl}});
  if(url===trustedUrl)return new Response(mp4);
  throw Error("unknown");
 });
 const doc={nodes:[{id:"prompt",type:"text",title:"Prompt",position:{x:0,y:0},width:100,height:100,metadata:{content:"first"}}],connections:[]};
 createProject(f.db,{id:"project-2",document:doc});
 const id=f.add("changed",{projectId:"project-2",targetNodeId:"prompt",expectedProjectRevision:1,
  sourceNodeFingerprint:fingerprintSource(doc,"prompt")});
 const c=createJobCoordinator({db:f.db,adapters:{model:f.makeAdapter(async(url,init)=>{
  if(url===root&&init.method==="POST")return response({id:"cgt-123"});
  if(url===root+"/cgt-123")return response({id:"cgt-123",status:"succeeded",content:{video_url:trustedUrl}});
  if(url===trustedUrl)return new Response(mp4);
 })}});
 c.recoverAtStartup();await c.tick();await c.tick();
 const modified=structuredClone(doc);modified.nodes[0].metadata.content="second";
 patchProject(f.db,{id:"project-2",expectedRevision:1,document:modified});
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 const result=await materializer.runOnce();
 assert.equal(result[0].reason,"materialization_source_changed");
 assert.equal(getProject(f.db,"project-2").document.nodes.length,1);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"succeeded");
});
