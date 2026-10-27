import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {createArkChannelHealth} from "./ark-channel-health.mjs";
import {ARK_HEALTH_URL,validateTrustedHttpsUrl,isPublicIPv4,resolvePinnedPublicIp} from "./trusted-http.mjs";

const fakeVault={
 get:id=>id==="ark"?{id,provider:"volcengine_ark",hasKey:true,keyVersion:"secret-1"}:
  id==="openai"?{id,provider:"openai",hasKey:true,keyVersion:"secret-2"}:
  id==="missing"?{id,provider:"volcengine_ark",hasKey:false,keyVersion:null}:
  Object.assign(Error("channel_not_found"),{code:"channel_not_found",statusCode:404}),
 withSecretVersion:(version,callback,{channelId})=>{
  assert.equal(channelId,"ark");assert.equal(version,"secret-1");
  const secret=Buffer.from("dummy-local-secret");
  try{return callback(secret)}finally{secret.fill(0)}
 }
};
test("Ark health probe is GET-only, fixed host and never creates a GPU task",async()=>{
 let calls=0;
 const check=createArkChannelHealth({vault:fakeVault,probe:async(url,opts)=>{
  calls++;assert.equal(url,ARK_HEALTH_URL);
  assert.deepEqual(opts.allowedHosts,["ark.cn-beijing.volces.com"]);
  assert.equal(opts.headers.authorization,"Bearer dummy-local-secret");
  assert.ok(!url.includes("/prompt")&&!url.includes("/create"));
  return {statusCode:404,body:Buffer.from("not found")};
 }});
 assert.deepEqual(await check("ark"),{reachable:true,authenticated:true});
 assert.equal(calls,1);
 await assert.rejects(check("openai"),{code:"ark_channel_provider_invalid"});
 await assert.rejects(check("missing"),{code:"ark_channel_key_missing"});
 assert.equal(calls,1);
});
test("health response does not disclose vault API key or upstream response",async()=>{
 for(const [status,expected] of [[401,"ark_auth_failed"],[403,"ark_auth_failed"],[500,"ark_upstream_unexpected_status"]]){
  const check=createArkChannelHealth({vault:fakeVault,probe:async()=>({statusCode:status,body:Buffer.from("dummy-local-secret")} )});
  const outcome=await check("ark");
  assert.equal(outcome.reason,expected);
  assert.doesNotMatch(JSON.stringify(outcome),/secret/);
 }
});
test("Fastify channel health uses normal auth, never accepts remote URL, and does not require gateway token",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const check=createArkChannelHealth({vault:fakeVault,probe:async()=>({statusCode:404})});
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner",vault:fakeVault,
  arkChannelHealth:check});
 t.after(async()=>{await app.close();db.close()});
 const url="/api/v1/channels/ark/health";
 assert.equal((await app.inject({method:"GET",url})).statusCode,401);
 assert.equal((await app.inject({method:"GET",url,headers:{"x-test-owner":"owner",host:"evil.example"}})).statusCode,403);
 const result=await app.inject({method:"GET",url,headers:{"x-test-owner":"owner"}});
 assert.equal(result.statusCode,200,result.body);
 assert.deepEqual(result.json(),{reachable:true,authenticated:true});
 assert.equal((await app.inject({method:"POST",url,headers:{"x-test-owner":"owner"},payload:{apiKey:"hack"}})).statusCode,404);
 assert.equal((await app.inject({method:"GET",url:"/api/v1/channels/missing/health",headers:{"x-test-owner":"owner"}})).statusCode,409);
});
test("trusted HTTPS target and DNS IP guard block internal destinations and redirects",async()=>{
 assert.equal(validateTrustedHttpsUrl(ARK_HEALTH_URL).hostname,"ark.cn-beijing.volces.com");
 for(const input of ["http://ark.cn-beijing.volces.com/api/v3", "https://127.0.0.1/foo",
 "https://evil.example/foo","https://ark.cn-beijing.volces.com:444/foo",
 "https://user:pass@ark.cn-beijing.volces.com/foo","https://ark.cn-beijing.volces.com/foo#fragment"])
  assert.throws(()=>validateTrustedHttpsUrl(input));
 for(const ip of ["127.0.0.1","10.0.0.1","172.16.1.9","192.168.1.1","169.254.3.4","0.0.0.0","203.0.113.4","198.51.100.1","::ffff:127.0.0.1"])
  assert.equal(isPublicIPv4(ip),false,ip);
 assert.equal(isPublicIPv4("8.8.8.8"),true);
 await assert.rejects(resolvePinnedPublicIp(new URL(ARK_HEALTH_URL),{
  resolver:async()=>[{address:"127.0.0.1",family:4}]
 }),{code:"upstream_dns_destination_forbidden"});
 await assert.rejects(resolvePinnedPublicIp(new URL(ARK_HEALTH_URL),{
  resolver:async()=>[{address:"8.8.8.8",family:4},{address:"10.0.0.1",family:4}]
 }),{code:"upstream_dns_destination_forbidden"});
});
