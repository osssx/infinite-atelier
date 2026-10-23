import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,mkdirSync,rmSync} from "node:fs";
import {join} from "node:path";
import {createComfyService} from "./service.mjs";
const testRoot=join(process.cwd(),"web","node_modules",".comfy-test-fixtures");
mkdirSync(testRoot,{recursive:true});
const fakeInfo={SaveImage:{output:[],input:{required:{images:["IMAGE",{}],filename_prefix:["STRING",{}]}}}};
const env={COMFY_INSTANCES_JSON:JSON.stringify([{id:"comfy-local",url:"http://127.0.0.1:8188"}])};
async function harness(root) {
    const service=createComfyService({root,env,tickMs:0,fetchInfo:async()=>fakeInfo});
    const server=createServer((req,res)=>void service.handle(req,res,new URL(req.url,"http://local.test")));
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const base="http://127.0.0.1:"+server.address().port+"/api/comfy";
    const request=async(path,method="GET",body)=>{
        const response=await fetch(base+path,{method,
            ...(body?{headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{})});
        return {status:response.status,value:await response.json()};
    };
    return {service,request,close:async()=>{await new Promise(resolve=>server.close(resolve));service.close();}};
}
test("Comfy instance CRUD persists across gateway restarts and rejects SSRF targets",async()=>{
    const root=mkdtempSync(join(testRoot,"instance-crud-"));
    try{
        let a=await harness(root);
        try{
            const initial=await a.request("/instances");
            assert.equal(initial.status,200);
            assert.equal(initial.value.instances[0].url,"http://127.0.0.1:8188");
            for(const url of ["https://127.0.0.1:8188","http://localhost:8188","http://192.168.1.2:8188",
                "http://127.0.0.1:8188/a","http://127.0.0.1:8188?x=1","http://user:pass@127.0.0.1:8188"]){
                const out=await a.request("/instances","POST",{id:"bad",url});
                assert.equal(out.status,400,url);
            }
            let result=await a.request("/instances","POST",{id:"secondary",url:"http://127.0.0.1:8189"});
            assert.equal(result.status,200);
            result=await a.request("/instances","POST",{id:"secondary",url:"http://127.0.0.1:8189"});
            assert.equal(result.status,409);
            result=await a.request("/instances/secondary","PUT",{id:"secondary-v2",url:"http://[::1]:8190"});
            assert.equal(result.status,200);
            assert.equal(result.value.instance.url,"http://[::1]:8190");
            // A pending run locks mutations so its instance URL cannot be swapped during execution.
            a.service.store.addRun("local-owner",{projectId:"p",idempotencyKey:"key",instanceId:"secondary-v2",
                nodes:[{id:"wf"}],rootOutputs:[]}, "fingerprint");
            result=await a.request("/instances/secondary-v2","DELETE");
            assert.equal(result.status,409);
            const pending=a.service.store.listStatuses(["queued"])[0];
            a.service.store.cas(pending.id,"queued","failed");
        } finally {await a.close();}
        a=await harness(root);
        try{
            const saved=await a.request("/instances");
            assert.equal(saved.value.instances.find(x=>x.id==="secondary-v2")?.url,"http://[::1]:8190");
            assert.equal(saved.value.instances.some(x=>x.id==="secondary"),false);
            assert.equal((await a.request("/instances/secondary-v2","DELETE")).status,200);
            assert.equal((await a.request("/instances")).value.instances.length,1);
        }finally{await a.close();}
    }finally{rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
