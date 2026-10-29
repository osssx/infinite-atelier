import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {createComfyInstanceRegistry} from "./comfy-instances.mjs";

test("ComfyUI instance object-info now comes from authenticated Fastify backend, not gateway",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 let calls=0;
 const comfyRegistry=createComfyInstanceRegistry({db,blobStore:{},initialInstances:[{
  id:"comfy-local",url:"http://127.0.0.1:8188"
 }],upstreamCall:async(instance,path)=>{
  calls++;assert.equal(instance.url,"http://127.0.0.1:8188");
  assert.equal(path,"/object_info");
  return {KSampler:{input:{required:{}},output:["LATENT"]}};
 }});
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner",comfyRegistry});
 t.after(async()=>{await app.close();db.close()});
 assert.equal((await app.inject({method:"GET",url:"/api/v1/comfy/instances/comfy-local/object-info"})).statusCode,401);
 const resp=await app.inject({method:"GET",url:"/api/v1/comfy/instances/comfy-local/object-info",headers:{"x-test-owner":"owner"}});
 assert.equal(resp.statusCode,200,resp.body);
 assert.deepEqual(Object.keys(resp.json().objectInfo),["KSampler"]);
 assert.equal(resp.json().instanceId,"comfy-local");
 assert.equal(calls,1);
 const absent=await app.inject({method:"GET",url:"/api/v1/comfy/instances/absent/object-info",headers:{"x-test-owner":"owner"}});
 assert.equal(absent.statusCode,404,absent.body);
 assert.equal(calls,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
});
test("instance status probes lightweight /system_stats instead of heavy /object_info",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const calls=[];
 const registry=createComfyInstanceRegistry({db,blobStore:{},
  initialInstances:[{id:"comfy-local",url:"http://127.0.0.1:8188"}],
  upstreamCall:async(instance,path,options)=>{
   calls.push({id:instance.id,path,timeoutMs:options?.timeoutMs});
   // /object_info may be large and would exceed the old 2.5s health deadline.
   if(path==="/object_info")throw Error("slow_object_info");
   assert.equal(path,"/system_stats");
   return {system:{os:"windows"},devices:[]};
  }});
 const app=buildApp({db,authorize:()=>true,comfyRegistry:registry});
 t.after(async()=>{await app.close();db.close()});
 const response=await app.inject({method:"GET",url:"/api/v1/comfy/instances"});
 assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(response.json().instances,[{
  id:"comfy-local",url:"http://127.0.0.1:8188",reachable:true,classTypes:[]
 }]);
 assert.deepEqual(calls,[{id:"comfy-local",path:"/system_stats",timeoutMs:5000}]);
});

test("unreachable /system_stats marks only the failing instance offline",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const registry=createComfyInstanceRegistry({db,blobStore:{},initialInstances:[
  {id:"healthy",url:"http://127.0.0.1:8188"},
  {id:"offline",url:"http://127.0.0.1:8189"},
  {id:"bad_stats",url:"http://127.0.0.1:8190"}
 ],upstreamCall:async(instance,path)=>{
  assert.equal(path,"/system_stats");
  if(instance.id==="offline")throw Error("ECONNREFUSED");
  if(instance.id==="bad_stats")return {something:"not ComfyUI"};
  return {system:{os:"windows"},devices:[]};
 }});
 const app=buildApp({db,authorize:()=>true,comfyRegistry:registry});
 t.after(async()=>{await app.close();db.close()});
 const response=await app.inject({method:"GET",url:"/api/v1/comfy/instances"});
 assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(Object.fromEntries(response.json().instances.map(x=>[x.id,x.reachable])),{
  bad_stats:false,healthy:true,offline:false
 });
});
