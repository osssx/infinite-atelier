import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { mkdirSync } from "node:fs";
const testRoot = join(process.cwd(),"web","node_modules",".comfy-test-fixtures");
mkdirSync(testRoot,{recursive:true});
import { join } from "node:path";
import { createServer } from "node:http";
import { canonical,sha256,compileSingleWorkflow } from "./compiler.mjs";
import { createComfyStore } from "./store.mjs";
import { createComfyService } from "./service.mjs";

const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082","hex");
const info = {
    Text:{input:{required:{text:["STRING",{}]}},output:["STRING"]},
    Generate:{input:{required:{prompt:["STRING",{}],image:["IMAGE",{}],strength:["FLOAT",{}]}},output:["IMAGE"]},
    SolidImage:{input:{required:{}},output:["IMAGE"]},
    SaveImage:{input:{required:{images:["IMAGE",{}],filename_prefix:["STRING",{}]}},output:[]},
    LoadImage:{input:{required:{image:["STRING",{}]}},output:["IMAGE","MASK"]},
};
function template() {
    const payload={
        name:"Single workflow",
        apiGraph:{
            "10":{class_type:"Text",inputs:{text:"original"}},
            "20":{class_type:"Generate",inputs:{prompt:["10",0],image:["40",0],strength:0.7}},
            "40":{class_type:"SolidImage",inputs:{}},
            "90":{class_type:"SolidImage",inputs:{}},
            "100":{class_type:"SaveImage",inputs:{images:["90",0],filename_prefix:"unselected"}},
        },
        ports:[
            {id:"text",label:"Text",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"10",inputName:"text"}]}},
            {id:"source",label:"Image",direction:"target",valueKind:"IMAGE",inputBinding:{mode:"socket",replaceInternalLink:true,targets:[{nodeId:"20",inputName:"image"}]}},
            {id:"strength",label:"Strength",direction:"target",valueKind:"FLOAT",defaultValue:0,inputBinding:{mode:"literal",targets:[{nodeId:"20",inputName:"strength"}]}},
            {id:"image",label:"Image",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:"20",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}},
        ],
        requirements:{classTypes:["Generate","SaveImage","SolidImage","Text"]},
    };
    return {id:"demo",revision:sha256(canonical(payload)),...payload};
}
function req(asset) {
    return {
        schemaVersion:1,projectId:"test-project",canvasRevision:"rev-a",instanceId:"comfy-local",
        rootOutputs:[{nodeId:"wf-1",portId:"image"}],
        nodes:[{id:"wf-1",templateId:"demo",templateRevision:template().revision,inputOverrides:{strength:0}}],
        edges:[
            {fromNodeId:"text-1",fromPortId:"text",toNodeId:"wf-1",toPortId:"text"},
            ...(asset?[{fromNodeId:"image-1",fromPortId:"image",toNodeId:"wf-1",toPortId:"source"}]:[])
        ],
        externalInputs:[
            {kind:"scalar",sourceNodeId:"text-1",sourcePortId:"text",valueKind:"STRING",value:""},
            ...(asset?[{kind:"asset",sourceNodeId:"image-1",sourcePortId:"image",valueKind:"IMAGE",assetId:asset.assetId,sha256:asset.sha256}]:[])
        ],
        idempotencyKey:"click-001",runOptions:{}
    };
}
const classes=new Set(Object.keys(info));
const options=(asset)=>({info,allowClasses:classes,imageFiles:asset?{[asset.assetId]:"staged.png"}:{}});
test("CF-01 selected intermediate IMAGE captures before prune, one graph and zero/empty frozen input",()=>{
    const t=template(), r=req();
    const before=canonical(t);
    const compiled=compileSingleWorkflow(r,t,options());
    assert.ok(compiled.graph["w_wf-1__capture_image"]);
    assert.ok(compiled.graph["w_wf-1__20"]);
    assert.equal(compiled.graph["w_wf-1__10"].inputs.text,"");
    assert.equal(compiled.graph["w_wf-1__20"].inputs.strength,0);
    assert.equal(compiled.graph["w_wf-1__100"],undefined);
    assert.equal(compiled.graph["w_wf-1__90"],undefined);
    assert.equal(compiled.captureMap[0].portId,"image");
    assert.equal(canonical(t),before);
});
test("image staged LoadImage replaces internal IMAGE link, multi-source rejects",()=>{
    const asset={assetId:"a-1",sha256:"0".repeat(64)};
    const compiled=compileSingleWorkflow(req(asset),template(),options(asset));
    assert.deepEqual(compiled.graph["w_wf-1__20"].inputs.image,["w_wf-1__loader_source",0]);
    assert.equal(compiled.graph["w_wf-1__loader_source"].inputs.image,"staged.png");
    assert.equal(compiled.graph["w_wf-1__40"],undefined);
    const corrupted=req(asset);
    corrupted.edges.push({fromNodeId:"text-2",fromPortId:"text",toNodeId:"wf-1",toPortId:"text"});
    corrupted.externalInputs.push({kind:"scalar",sourceNodeId:"text-2",sourcePortId:"text",valueKind:"STRING",value:"override"});
    assert.throws(()=>compileSingleWorkflow(corrupted,template(),options(asset)),/multiple_sources_for_input/);
    const multi=req();multi.nodes.push({...multi.nodes[0],id:"wf-2"});
    assert.throws(()=>compileSingleWorkflow(multi,template(),options()),/single_workflow_request_required/);
});
test("SQLite atomic idempotency, restart queued and submitting recovery",()=>{
    const dir=mkdtempSync(join(testRoot,"atelier-comfy-sql-"));
    try {
        let db=createComfyStore(dir);
        const asset=db.addAsset(png,"image/png");
        const r=req(asset), f=sha256(canonical(r));
        const one=db.addRun("owner",r,f);
        assert.equal(one.existing,false);
        assert.equal(db.addRun("owner",r,f).run.id,one.run.id);
        assert.throws(()=>db.addRun("owner",r,"different"),/idempotency_key_conflict/);
        db.cas(one.run.id,"queued","preparing");
        db.close();
        db=createComfyStore(dir);
        db.resumeAfterRestart();
        assert.equal(db.read(one.run.id).status,"queued");
        assert.equal(db.asset(asset.assetId).sha256,asset.sha256);
        db.cas(one.run.id,"queued","submitting",{attempt_id:"attempt-1",submit_marker:"mark-1",submission_started_at:Date.now()});
        db.close();
        db=createComfyStore(dir);
        db.resumeAfterRestart();
        assert.equal(db.read(one.run.id).status,"submission_unknown");
        assert.equal(db.addRun("owner",r,f).run.id,one.run.id);
        db.close();
    }finally{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:300});}
});
test("HTTP template + staging + submit once + two captured images + interrupted download recover",async()=>{
    const dir=mkdtempSync(join(testRoot,"atelier-comfy-api-"));
    const submissions=[],uploaded=[];
    let outputFailOnce=true;
    let allowInfo=true;
    const mock=async(_instance,path,opts={})=>{
        if(path==="/object_info"){if(!allowInfo)throw Error("Comfy offline");return info;}
        if(path==="/upload/image"){uploaded.push(opts.body.get("image").name);return {name:opts.body.get("image").name,type:"input",subfolder:""};}
        if(path==="/prompt"){submissions.push(JSON.parse(opts.body));return {prompt_id:"prompt-A"};}
        if(path.startsWith("/history/"))return {"prompt-A":{status:{completed:true,status_str:"success"},outputs:{
            "w_wf-1__capture_image":{images:[
                {filename:"first.png",subfolder:"",type:"output"},
                {filename:"second.png",subfolder:"",type:"output"}
            ]}
        }}};
        if(path.startsWith("/view?")){
            if (outputFailOnce && path.includes("second.png")){outputFailOnce=false;throw Error("download interrupted");}
            return {bytes:png,mime:"image/png"};
        }
        throw Error("unexpected upstream "+path);
    };
    const service=createComfyService({root:dir,upstreamCall:mock,tickMs:0,
        env:{COMFY_ALLOWED_CLASSES:[...classes].join(",")}});
    const server=createServer((incoming,out)=>{void service.handle(incoming,out,new URL(incoming.url,"http://test"));});
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const base="http://127.0.0.1:"+server.address().port;
    const post=async(path,value)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
    try {
        let res=await post("/api/comfy/templates",{instanceId:"comfy-local",template:template()});
        assert.equal(res.status,200);
        res=await fetch(base+"/api/comfy/inputs",{method:"POST",headers:{"content-type":"image/png"},body:png});
        assert.equal(res.status,201,await res.clone().text());
        const asset=await res.json();
        const runRequest=req(asset);
        res=await post("/api/comfy/runs",runRequest);
        assert.equal(res.status,201,await res.clone().text());
        const initial=await res.json();
        const second=await post("/api/comfy/runs",runRequest);
        assert.equal(second.status,200);
        assert.equal((await second.json()).runId,initial.runId);
        const different=structuredClone(runRequest);
        different.externalInputs[0].value="B";
        assert.equal((await post("/api/comfy/runs",different)).status,409);
        for(let i=0;i<12;i++) {
            await service.tick();
            const state=(await (await fetch(base+"/api/comfy/runs/"+initial.runId)).json());
            if(state.status==="succeeded")break;
            await new Promise(resolve=>setTimeout(resolve,10));
        }
        const final=await (await fetch(base+"/api/comfy/runs/"+initial.runId)).json();
        assert.equal(final.status,"succeeded");
        assert.equal(final.artifacts.length,2);
        assert.equal(final.artifacts[0].workflowNodeId,"wf-1");
        assert.equal(final.artifacts[1].portId,"image");
        assert.equal(submissions.length,1);
        // The same idempotency key must return its original task even if Comfy is now offline.
        allowInfo=false;
        const offlineReplay=await post("/api/comfy/runs",runRequest);
        assert.equal(offlineReplay.status,200);
        assert.equal((await offlineReplay.json()).runId,initial.runId);
        assert.equal(uploaded.length,1);
        assert.equal(submissions[0].prompt["w_wf-1__10"].inputs.text,"");
        assert.equal(submissions[0].prompt["w_wf-1__100"],undefined);
        for(const a of final.artifacts) {
            const downloaded=await fetch(base+a.url);
            assert.equal(downloaded.status,200);
            assert.equal(sha256(Buffer.from(await downloaded.arrayBuffer())),a.sha256);
        }
    }finally{
        await new Promise(resolve=>server.close(resolve));
        service.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:300});
    }
});

test("restart running with persisted promptId resumes history and multi-image collection without resubmit",async()=>{
    const dir=mkdtempSync(join(testRoot,"atelier-comfy-recover-"));
    let db=createComfyStore(dir);
    const t=template(),r=req(),run=db.addRun("local-owner",r,sha256(canonical(r))).run;
    db.addTemplate(t);
    const compiled=compileSingleWorkflow(r,t,options());
    db.cas(run.id,"queued","running",{
        compiled:canonical(compiled.graph),
        capture_map:canonical(compiled.captureMap),graph_hash:compiled.graphHash,
        prompt_id:"persisted-A",attempt_id:"attempt-old",submit_marker:"marker-old"
    });
    db.close();
    let posts=0;
    const service=createComfyService({root:dir,tickMs:0,
        env:{COMFY_ALLOWED_CLASSES:[...classes].join(",")},
        upstreamCall:async(_instance,path,opts={})=>{
            if(path.startsWith("/history/"))return {"persisted-A":{
                status:{status_str:"success",completed:true},outputs:{
                    [compiled.captureMap[0].captureNodeId]:{images:[
                        {filename:"recovered.png",subfolder:"",type:"output"}
                    ]}
                }
            }};
            if(path.startsWith("/view?"))return {bytes:png,mime:"image/png"};
            if(path==="/prompt"){posts++;return {prompt_id:"duplicate"};}
            throw Error("unexpected path "+path);
        }
    });
    try{
        await service.tick();
        const completed=service.store.read(run.id);
        assert.equal(completed.status,"succeeded");
        assert.equal(service.store.artifacts(run.id).length,1);
        assert.equal(posts,0);
        await service.tick();
        assert.equal(service.store.artifacts(run.id).length,1);
    }finally{service.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:300});}
});
test("uncertain /prompt never automatically resubmits and freezes future queue",async()=>{
    const dir=mkdtempSync(join(testRoot,"atelier-comfy-unknown-"));let submits=0;
    const service=createComfyService({root:dir,tickMs:0,
        env:{COMFY_ALLOWED_CLASSES:[...classes].join(",")},
        upstreamCall:async(_inst,path,opts={})=>{
            if(path==="/object_info")return info;
            if(path==="/prompt"){submits++;throw Error("response lost after acceptance");}
            throw Error("unexpected path");
        }
    });
    const server=createServer((req,res)=>void service.handle(req,res,new URL(req.url,"http://test")));
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const url="http://127.0.0.1:"+server.address().port;
    const post=(path,value)=>fetch(url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
    try{
        assert.equal((await post("/api/comfy/templates",{instanceId:"comfy-local",template:template()})).status,200);
        const r=req(), created=await(await post("/api/comfy/runs",r)).json();
        for(let i=0;i<6;i++){await service.tick();if(service.store.read(created.runId).status==="submission_unknown")break;await new Promise(res=>setTimeout(res,10));}
        assert.equal(service.store.read(created.runId).status,"submission_unknown");
        assert.equal(submits,1);
        await service.tick();
        assert.equal(submits,1);
        assert.equal((await(await post("/api/comfy/runs",r)).json()).runId,created.runId);
    }finally{await new Promise(resolve=>server.close(resolve));service.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:300});}
});
