import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {submitJob} from "./repository.mjs";
import {createOpenAiModelAdapter,validateModelSnapshot} from "./openai-model-adapter.mjs";
import {parseRestrictedModelScript,runRestrictedModelScript} from "./restricted-model-script.mjs";

const script='const data = await http.post("/chat/completions", {model, messages});\nreturn data.choices?.[0]?.message?.content || "";';
test("restricted AST interpreter invokes one trusted HTTP request and extracts text",async()=>{
 let calls=0;
 const result=await runRestrictedModelScript({
  script,model:"sample",prompt:"hello",messages:[{role:"user",content:"hello"}],
  http:async(method,path,body)=>{
   calls++;assert.equal(method,"post");assert.equal(path,"/chat/completions");
   assert.deepEqual(JSON.parse(JSON.stringify(body)),{model:"sample",messages:[{role:"user",content:"hello"}]});
   return {choices:[{message:{content:"hello world"}}]};
  }
 });
 assert.equal(result,"hello world");assert.equal(calls,1);
});
test("rejects access to node, dynamic code, constructor/prototype, loops and multi-POST",async()=>{
 const scripts=[
  "return process.env;",
  "return globalThis;",
  'return require("fs");',
  'return eval("process.env");',
  'return new Function("return process")();',
  'return ({})["constructor"];',
  'const a=await http.post("/ok",{model}); const b=await http.post("/ok",{model});return a;',
  "for(;;){}","while(true){}","const token=apiKey;return token;"
 ];
 for(const value of scripts)await assert.rejects(runRestrictedModelScript({
  script:value,model:"x",prompt:"x",messages:[],
  http:async()=>{throw Error("network_called")}
 }));
 for(const path of ["https://evil.test/x","//evil.test/x","/../../internal",
  "/v1/admin?secret=key","/a%2f..","/a\\b"]){
  await assert.rejects(runRestrictedModelScript({
   script:'const res=await http.post('+JSON.stringify(path)+',{model});return res.answer;',
   model:"x",prompt:"x",messages:[],
   http:async()=>{throw Error("network_called")}
  }),/model_script_endpoint_invalid/);
 }
 // Parser rejects arbitrary globals even when the result would be ignored.
 for(const key of ["__proto__","prototype","constructor"])
  assert.throws(()=>parseRestrictedModelScript(
   'const x=await http.post("/chat/completions",{model});return x.'+key+";"),
   /model_script_property_forbidden/);
 assert.throws(()=>parseRestrictedModelScript("return 'literal';"),
  /model_script_return_and_request_required/);
});
test("SQLite text script has a frozen source, vault ref, trusted request and CAS text artifact",async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),"atelier-script-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dataDir,{recursive:true,force:true})});
 const vault=createCredentialVault({db,protector:{protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)}});
 const channel=vault.create({id:"script-channel",provider:"openai_compatible",
  displayName:"Script",apiKey:"SECRET_FROM_VAULT"});
 const blobStore=createBlobStore({dataDir,db}),calls=[];
 const adapter=createOpenAiModelAdapter({db,blobStore,vault,
  compatibleUpstreamCall:async(url,options)=>{
   calls.push({url,options});
   return new Response(JSON.stringify({choices:[{message:{content:"Server script result"}}]}),{status:200});
  },upstreamCall:async()=>{throw Error("must not send to official provider")}
 });
 const snapshot={adapterKind:"model",provider:"openai_compatible",
  channelId:"script-channel",secretVersionRef:channel.keyVersion,
  endpointBaseUrl:"http://127.0.0.1:8188/v1",
  task:{kind:"text",model:"my-chat",prompt:"Hello",stream:true,
   messages:[{role:"user",content:"Hello"}],script}};
 const job=submitJob(db,{idempotencyKey:"script-one",requestFingerprint:"script-one",
  executionMode:"immediate",snapshot}).jobId;
 const coordinator=createJobCoordinator({db,adapters:{model:adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(job).status,"succeeded");
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,"http://127.0.0.1:8188/v1/chat/completions");
 assert.equal(calls[0].options.headers.authorization,"Bearer SECRET_FROM_VAULT");
 assert.equal(JSON.parse(calls[0].options.body).model,"my-chat");
 assert.ok(!db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(job).snapshot_json.includes("SECRET_FROM_VAULT"));
 const stored=db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(job);
 assert.equal(stored.kind,"text");
 assert.equal((await blobStore.stat(stored.blob_id)).mimeType,"text/plain");
 assert.equal(submitJob(db,{idempotencyKey:"script-one",requestFingerprint:"script-one",
  executionMode:"immediate",snapshot}).jobId,job);
 await coordinator.tick();assert.equal(calls.length,1);
 assert.throws(()=>validateModelSnapshot({...snapshot,task:{...snapshot.task,
  script:"return process.env;"}}),/model_script/);
 assert.throws(()=>validateModelSnapshot({...snapshot,task:{...snapshot.task,
  kind:"image"}}),/model_(script_kind_unsupported|task_invalid)/);
});

test("SQLite restricted image and audio scripts store CAS outputs with Vault-only network auth",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-script-media-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const vault=createCredentialVault({db,protector:{protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)}});
 const channel=vault.create({id:"media-script",provider:"openai_compatible",
  displayName:"Media",apiKey:"SECRET_MEDIA_VAULT"});
 const blobStore=createBlobStore({dataDir:dir,db}),calls=[];
 const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082","hex");
 const wav=Buffer.from("524946460800000057415645666d7420","hex");
 const adapter=createOpenAiModelAdapter({db,blobStore,vault,
  compatibleUpstreamCall:async(url,options)=>{
   calls.push({url,options});
   const image=url.endsWith("/images/generations");
   return new Response(JSON.stringify(image?
    {data:[{b64_json:png.toString("base64")}]}:
    {data:wav.toString("base64")}),{status:200});
  }
 });
 const base={adapterKind:"model",provider:"openai_compatible",channelId:"media-script",
  secretVersionRef:channel.keyVersion,endpointBaseUrl:"http://127.0.0.1:8188/v1"};
 const scriptImage='const data=await http.post("/images/generations",{model,prompt,n:params.count,size:params.size});return data.data?.[0]?.b64_json||"";';
 const scriptAudio='const data=await http.post("/audio/speech",{model,input:prompt,voice:params.voice,response_format:params.format});return data.data||"";';
 const tasks=[
  {kind:"image",model:"image-model",prompt:"a cat",size:"1024x1024",script:scriptImage},
  {kind:"audio",model:"speech-model",prompt:"hello",voice:"alloy",format:"wav",script:scriptAudio}
 ];
 const ids=tasks.map((task,i)=>submitJob(db,{idempotencyKey:"media-"+i,
  requestFingerprint:"media-"+i,executionMode:"immediate",
  snapshot:{...base,task}}).jobId);
 const coordinator=createJobCoordinator({db,adapters:{model:adapter}});
 coordinator.recoverAtStartup();await coordinator.tick();
 for(let i=0;i<2;i++){
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(ids[i]).status,"succeeded");
  const row=db.prepare("SELECT * FROM artifacts WHERE job_id=?").get(ids[i]);
  assert.equal(row.kind,tasks[i].kind);
  assert.equal((await blobStore.stat(row.blob_id)).mimeType,
   i===0?"image/png":"audio/wav");
 }
 assert.equal(calls.length,2);
 const imageCall=calls.find(call=>call.url.endsWith("/images/generations"));
 const audioCall=calls.find(call=>call.url.endsWith("/audio/speech"));
 assert.equal(JSON.parse(imageCall.options.body).size,"1024x1024");
 assert.equal(JSON.parse(audioCall.options.body).voice,"alloy");
 assert.ok(calls.every(call=>call.options.headers.authorization==="Bearer SECRET_MEDIA_VAULT"));
 assert.throws(()=>validateModelSnapshot({...base,task:{...tasks[0],
  operation:"edit",images:[]}}),/model_script_kind_unsupported/);
 const reject=await runRestrictedModelScript({script:
  'const data=await http.post("/images/generations",{model,prompt});return data.url;',
  model:"x",prompt:"x",messages:[],http:async()=>({url:"http://evil.test/private"})});
 assert.equal(reject,"http://evil.test/private");
 // A URL result will never be fetched; the adapter requires image bytes.
});

