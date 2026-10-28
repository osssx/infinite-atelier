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
import {normalizeOpenAiCompatBaseUrl,createPinnedOpenAiCompatCall,validateCompatResolvedAddress} from "./openai-compat-endpoints.mjs";

test("all custom HTTP(S) channel addresses accepted by default without a server allowlist",()=>{
 for(const [input,expected] of [
  ["https://models.example.net/v1/","https://models.example.net/v1"],
  ["https://models.example.net/custom/openai","https://models.example.net/custom/openai"],
  ["https://models.example.net:8443/api/v1","https://models.example.net:8443/api/v1"],
  ["http://127.0.0.1:8188/v1","http://127.0.0.1:8188/v1"],
  ["http://localhost:8000/v1","http://localhost:8000/v1"],
  ["http://192.168.1.23:8080/api/v1","http://192.168.1.23:8080/api/v1"],
  ["http://10.1.2.3:8080/v1","http://10.1.2.3:8080/v1"],
  ["http://[::1]:1234/v1","http://[::1]:1234/v1"]
 ]) assert.equal(normalizeOpenAiCompatBaseUrl(input),expected);
});
test("deny malformed addresses and sensitive metadata and non-HTTP schemes",()=>{
 for(const input of [
  "ftp://models.example.net/v1","file:///etc/passwd","http://user:pass@host/v1",
  "http://169.254.169.254/latest/meta-data","http://0.0.0.0/v1",
  "https://metadata.google.internal/v1","https://foo.internal/v1",
  "http://[fe80::1]:1234/v1","http://models.example.net/v1?secret=xyz",
  "http://models.example.net/v1#frag","http://models.example.net/v1%2fother",
  "http://models.example.net:bad/v1",""
 ])assert.throws(()=>normalizeOpenAiCompatBaseUrl(input),/model_endpoint_config_invalid/);
 for(const [host,addr] of [
  ["models.example.net","127.0.0.1"],["models.example.net","192.168.1.12"],
  ["models.example.net","169.254.169.254"],["localhost","10.0.0.1"],
  ["192.168.1.10","127.0.0.1"],["127.0.0.1","169.254.169.254"]
 ])assert.throws(()=>validateCompatResolvedAddress(host,addr),/model_endpoint_dns_forbidden/);
 assert.doesNotThrow(()=>validateCompatResolvedAddress("models.example.net","8.8.8.8"));
 assert.doesNotThrow(()=>validateCompatResolvedAddress("localhost","127.0.0.1"));
 assert.doesNotThrow(()=>validateCompatResolvedAddress("192.168.1.10","192.168.1.10"));
});
test("compatible JobCoordinator uses frozen user endpoint and vault key, not official OpenAI",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-openai-compatible-"));
 const db=new DatabaseSync(":memory:");
 initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const vault=createCredentialVault({db,protector:{
  protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)
 }});
 const credential=vault.create({id:"proxyChannel",provider:"openai_compatible",
  displayName:"Custom OpenAI",apiKey:"fake-compat-secret"});
 const blobStore=createBlobStore({dataDir:dir,db});
 const calls=[];
 const create=()=>createOpenAiModelAdapter({db,blobStore,vault,
  compatibleUpstreamCall:async(url,options)=>{
   calls.push({url,options});
   return new Response(JSON.stringify({choices:[{message:{content:"answer"}}]}),{status:200});
  },
  upstreamCall:async()=>{throw Error("custom request unexpectedly sent to OpenAI")}
 });
 const snapshot={adapterKind:"model",provider:"openai_compatible",channelId:"proxyChannel",
  secretVersionRef:credential.keyVersion,endpointBaseUrl:"http://127.0.0.1:8188/v1",
  task:{kind:"text",model:"proxy-model",prompt:"hello"}};
 const jobId=submitJob(db,{idempotencyKey:"one",requestFingerprint:"one",
  executionMode:"immediate",snapshot}).jobId;
 const coordinator=createJobCoordinator({db,adapters:{model:create()}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,"http://127.0.0.1:8188/v1/chat/completions");
 assert.equal(calls[0].options.headers.authorization,"Bearer fake-compat-secret");
 assert.ok(!db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(jobId).snapshot_json.includes("fake-compat-secret"));
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(jobId).n,1);
 const other={...snapshot,endpointBaseUrl:"https://models.example.net/v1",task:{...snapshot.task,prompt:"new"}};
 const second=submitJob(db,{idempotencyKey:"two",requestFingerprint:"two",
  executionMode:"immediate",snapshot:other}).jobId;
 const resumed=createJobCoordinator({db,adapters:{model:create()}});
 resumed.recoverAtStartup();await resumed.tick();
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(second).status,"succeeded");
 assert.equal(calls[1].url,"https://models.example.net/v1/chat/completions");
 assert.notEqual(calls[0].url,calls[1].url);
 for(const forged of [
  {...snapshot,endpointBaseUrl:"http://169.254.169.254/latest"},
  {...snapshot,endpointBaseUrl:"https://evil.test/v1",endpointFingerprint:"sha256:"+"0".repeat(64)},
  {...snapshot,endpointBaseUrl:undefined}
 ])assert.throws(()=>validateModelSnapshot(forged),/model_endpoint_reference_invalid/);
});
test("outbound model POST keeps pinned DNS and rejects redirects; no arbitrary method",async()=>{
 const calls=[];
 const request=createPinnedOpenAiCompatCall({fetcher:async(url,options)=>{
  calls.push({url,options});return new Response("ok");
 }});
 await request("http://localhost:8188/v1/images/generations",{
  method:"POST",headers:{"content-type":"application/json"},body:"{}"
 });
 assert.equal(calls.length,1);
 assert.equal(calls[0].options.redirect,"manual");
 assert.ok(calls[0].options.dispatcher,"pinned DNS/TLS dispatcher required");
 await assert.rejects(request("http://169.254.169.254/v1/images/generations",{method:"POST"}),
  /model_endpoint_config_invalid/);
 await assert.rejects(request("http://localhost:8188/v1/images/generations",{method:"GET"}),
  /model_endpoint_url_invalid/);
});
