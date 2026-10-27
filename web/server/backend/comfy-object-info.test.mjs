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
