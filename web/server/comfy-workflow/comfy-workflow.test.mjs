import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync,readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
const testRoot = join(process.cwd(),"web","node_modules",".comfy-test-fixtures");
mkdirSync(testRoot,{recursive:true});
import { join } from "node:path";
import { createServer } from "node:http";
import { canonical,sha256,compileSingleWorkflow,validateGraph,fingerprintRequest } from "./compiler.mjs";
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
        schemaVersion:2,projectId:"test-project",canvasRevision:"rev-a",instanceId:"comfy-local",
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
const options=(asset)=>({info,imageFiles:asset?{[asset.assetId]:"staged.png"}:{}});
test("all installed classes including custom nodes are accepted, but missing classes rejected",()=>{
    const customInfo={
        ComfySwitchNode:{input:{required:{select:["BOOLEAN",{}],image:["IMAGE",{}]}},output:["IMAGE"]},
        SolidImage:info.SolidImage
    };
    const graph={
        "1":{class_type:"SolidImage",inputs:{}},
        "2":{class_type:"ComfySwitchNode",inputs:{select:true,image:["1",0]}}
    };
    assert.doesNotThrow(()=>validateGraph(graph,customInfo));
    assert.throws(()=>validateGraph(graph,{SolidImage:info.SolidImage}),/comfy_missing_class:ComfySwitchNode/);
});

test("dynamic COMFY_DYNAMICCOMBO_V3 dotted inputs follow selected option schema",()=>{
    const sample={
        TextGenerate:{input:{required:{
            sampling_mode:["COMFY_DYNAMICCOMBO_V3",{options:[
                {key:"on",inputs:{required:{temperature:["FLOAT",{}]},optional:{presence_penalty:["FLOAT",{}]}}},
                {key:"off",inputs:{required:{}}}
            ]}]
        }},output:["STRING"]}
    };
    const graph={"1":{class_type:"TextGenerate",inputs:{
        sampling_mode:"on","sampling_mode.temperature":0.7,"sampling_mode.presence_penalty":0
    }}};
    assert.doesNotThrow(()=>validateGraph(graph,sample));
    graph["1"].inputs["sampling_mode.undocumented"]=3;
    assert.throws(()=>validateGraph(graph,sample),/comfy_unknown_input:sampling_mode.undocumented/);
    delete graph["1"].inputs["sampling_mode.undocumented"];
    graph["1"].inputs.sampling_mode="off";
    assert.throws(()=>validateGraph(graph,sample),/comfy_unknown_input:sampling_mode.temperature/);
});

test("COMFY_AUTOGROW_V3 accepts the bundled MiniMax ComfyMathExpression values.a without a values marker",()=>{
    const realWorkflow=JSON.parse(readFileSync(new URL("../../../workflows/video_minimax_h3_i2v_turbo.json",import.meta.url),"utf8"));
    const schema={
        PrimitiveFloat:{input:{required:{value:["FLOAT",{}]}},output:["FLOAT"]},
        ComfyMathExpression:{input:{required:{
            expression:["STRING",{}],
            values:["COMFY_AUTOGROW_V3",{template:{
                names:[..."abcdefghijklmnopqrstuvwxyz"],min:1,
                input:{required:{value:["FLOAT,INT,BOOLEAN",{}]}}
            }}]
        }},output:["FLOAT","INT","BOOLEAN"]}
    };
    const graph={"128":realWorkflow["128"],"105_111":realWorkflow["105_111"],"105_107":realWorkflow["105_107"]};
    assert.equal(graph["105_107"].inputs["values.a"][0],"105_111");
    assert.doesNotThrow(()=>validateGraph(graph,schema));
    const bogus=structuredClone(graph);
    bogus["105_107"].inputs["values.unknown"]=1;
    assert.throws(()=>validateGraph(bogus,schema),/comfy_unknown_input:values.unknown/);
    delete bogus["105_107"].inputs["values.unknown"];
    bogus["105_107"].inputs["values.z.other"]=1;
    assert.throws(()=>validateGraph(bogus,schema),/comfy_unknown_input:values.z.other/);
    delete bogus["105_107"].inputs["values.z.other"];
    delete bogus["105_107"].inputs["values.a"];
    assert.throws(()=>validateGraph(bogus,schema),/comfy_required_input_missing:values.a/);
    bogus["105_107"].inputs.values={"a":1};
    assert.throws(()=>validateGraph(bogus,schema),/comfy_unknown_input:values/);
});
test("COMFY_AUTOGROW_V3 prefix templates allow declared slots only",()=>{
    const info={Grow:{input:{required:{
        items:["COMFY_AUTOGROW_V3",{template:{prefix:"item",min:1,max:3,input:{required:{item:["INT",{}]}}}}]
    }},output:["INT"]}};
    const graph={"1":{class_type:"Grow",inputs:{"items.item0":1,"items.item2":2}}};
    assert.doesNotThrow(()=>validateGraph(graph,info));
    graph["1"].inputs["items.item3"]=3;
    assert.throws(()=>validateGraph(graph,info),/comfy_unknown_input:items.item3/);
    delete graph["1"].inputs["items.item3"];
    delete graph["1"].inputs["items.item0"];
    assert.throws(()=>validateGraph(graph,info),/comfy_required_input_missing:items.item0/);
});
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
test("file input requires an uploaded canvas edge; template filename cannot silently become first_frame",()=>{
    const t=template();
    t.apiGraph["21"]={class_type:"LoadImage",inputs:{image:"sample_from_author_machine.png"}};
    t.apiGraph["20"].inputs.image=["21",0];
    t.ports.push({
        id:"first_frame",label:"首帧图片",direction:"target",valueKind:"IMAGE",required:true,
        inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId:"21",inputName:"image"}]},
        absentPolicy:{mode:"keep-template"}
    });
    t.requirements.classTypes=[...new Set(Object.values(t.apiGraph).map(n=>n.class_type))].sort();
    t.revision=sha256(canonical({name:t.name,apiGraph:t.apiGraph,ports:t.ports,requirements:t.requirements}));
    const missing=req();missing.nodes[0].templateRevision=t.revision;
    assert.throws(()=>compileSingleWorkflow(missing,t,options()),/media_input_requires_connection:first_frame/);
    const asset={assetId:"image-staged",sha256:"a".repeat(64)};
    const connected=req(asset);connected.nodes[0].templateRevision=t.revision;
    connected.edges[1].toPortId="first_frame";
    const result=compileSingleWorkflow(connected,t,options(asset));
    assert.equal(result.decisions.first_frame,"edge");
    assert.equal(result.graph["w_wf-1__21"].inputs.image,"staged.png");
    assert.ok(result.graph["w_wf-1__capture_image"]);    const liveInfo={...info,LoadImage:{input:{required:{image:[["already_existing.png"],{"image_upload":true}]}},output:["IMAGE","MASK"]}};
    const dryrun=compileSingleWorkflow(connected,t,{info:liveInfo,imageFiles:{[asset.assetId]:"dryrun.png"}});
    assert.equal(dryrun.graph["w_wf-1__21"].inputs.image,"dryrun.png");
    // The uploaded filename is registered AFTER the initial /object_info snapshot.
    const real=compileSingleWorkflow(connected,t,{info:liveInfo,imageFiles:{[asset.assetId]:"atelier_image-staged.png"}});
    assert.equal(real.graph["w_wf-1__21"].inputs.image,"atelier_image-staged.png");
    // The exception is strictly scoped to the bound node/input, never a blanket LoadImage bypass.
    const unsafe=structuredClone(t);
    unsafe.apiGraph["22"]={class_type:"LoadImage",inputs:{image:"untrusted_author_file.png"}};
    unsafe.apiGraph["20"].inputs.other=["22",0];
    unsafe.requirements.classTypes=[...new Set(Object.values(unsafe.apiGraph).map(n=>n.class_type))].sort();
    unsafe.revision=sha256(canonical({name:unsafe.name,apiGraph:unsafe.apiGraph,ports:unsafe.ports,requirements:unsafe.requirements}));
    const unsafeRun=structuredClone(connected);unsafeRun.nodes[0].templateRevision=unsafe.revision;
    const infoWithOther={...liveInfo,Generate:{...info.Generate,input:{...info.Generate.input,optional:{other:["IMAGE",{}]}}}};
    assert.throws(()=>compileSingleWorkflow(unsafeRun,unsafe,{info:infoWithOther,imageFiles:{[asset.assetId]:"dryrun.png"}}),
        /comfy_option_invalid:LoadImage.image:untrusted_author_file.png/);

});
test("image staged LoadImage replaces internal IMAGE link, multi-source rejects",()=>{
    const asset={assetId:"a-1",sha256:"0".repeat(64)};
    const compiled=compileSingleWorkflow(req(asset),template(),options(asset));
    assert.deepEqual(compiled.graph["w_wf-1__20"].inputs.image,["w_wf-1__loader_source",0]);
    assert.equal(compiled.graph["w_wf-1__loader_source"].inputs.image,"staged.png");
    assert.equal(compiled.graph["w_wf-1__40"],undefined);    const liveInfo={...info,LoadImage:{input:{required:{image:[["old_visible.png"],{"image_upload":true}]}},output:["IMAGE","MASK"]}};
    const dryrun=compileSingleWorkflow(req(asset),template(),{info:liveInfo,imageFiles:{[asset.assetId]:"dryrun.png"}});
    assert.equal(dryrun.graph["w_wf-1__loader_source"].inputs.image,"dryrun.png");
    const real=compileSingleWorkflow(req(asset),template(),{info:liveInfo,imageFiles:{[asset.assetId]:"atelier_staged.png"}});
    assert.equal(real.graph["w_wf-1__loader_source"].inputs.image,"atelier_staged.png");

    const corrupted=req(asset);
    corrupted.edges.push({fromNodeId:"text-2",fromPortId:"text",toNodeId:"wf-1",toPortId:"text"});
    corrupted.externalInputs.push({kind:"scalar",sourceNodeId:"text-2",sourcePortId:"text",valueKind:"STRING",value:"override"});
    assert.throws(()=>compileSingleWorkflow(corrupted,template(),options(asset)),/multiple_sources_for_input/);
    const multi=req();multi.nodes.push({...multi.nodes[0],id:"wf-2"});
    assert.throws(()=>compileSingleWorkflow(multi,template(),options()),/single_workflow_request_required/);
});

test("Krea2 LoRA path typo resolves to the unique installed exact enum without changing saved templates",()=>{
    const t=template();
    t.apiGraph["model"]={class_type:"ModelNode",inputs:{}};
    t.apiGraph["lora"]={class_type:"LoraLoaderModelOnly",inputs:{
        model:["model",0],lora_name:"kera2\\krea2filterbypass3.safetensors",strength_model:0.8
    }};
    t.apiGraph["20"].inputs.model=["lora",0];
    t.requirements.classTypes=[...new Set(Object.values(t.apiGraph).map(n=>n.class_type))].sort();
    t.revision=sha256(canonical({name:t.name,apiGraph:t.apiGraph,ports:t.ports,requirements:t.requirements}));
    const r=req();r.nodes[0].templateRevision=t.revision;
    const options=["krea2\\KNP_000003000.safetensors","krea2\\krea2filterbypass3.safetensors"];
    const live={...info,
        Generate:{...info.Generate,input:{...info.Generate.input,optional:{model:["MODEL",{}]}}},
        ModelNode:{input:{required:{}},output:["MODEL"]},
        LoraLoaderModelOnly:{input:{required:{
            model:["MODEL",{}],strength_model:["FLOAT",{}],lora_name:[options,{}]
        }},output:["MODEL"]}
    };
    const compiled=compileSingleWorkflow(r,t,{info:live});
    assert.equal(compiled.graph["w_wf-1__lora"].inputs.lora_name,options[1]);
    assert.equal(t.apiGraph.lora.inputs.lora_name,"kera2\\krea2filterbypass3.safetensors");
    const withPath=(path,details=live)=>{
        const copy=structuredClone(t);
        copy.apiGraph.lora.inputs.lora_name=path;
        copy.revision=sha256(canonical({name:copy.name,apiGraph:copy.apiGraph,ports:copy.ports,requirements:copy.requirements}));
        const request=structuredClone(r);
        request.nodes[0].templateRevision=copy.revision;
        return compileSingleWorkflow(request,copy,{info:details});
    };
    assert.equal(withPath("KREA2/krea2filterbypass3.safetensors").graph["w_wf-1__lora"].inputs.lora_name,options[1]);
    assert.throws(()=>withPath("kera2\\unknown-filter.safetensors"),/comfy_model_missing:LoraLoaderModelOnly.lora_name/);
    const ambiguous={...live,LoraLoaderModelOnly:{...live.LoraLoaderModelOnly,
        input:{required:{...live.LoraLoaderModelOnly.input.required,
            lora_name:[[options[1],"other\\krea2filterbypass3.safetensors"],{}]}}}};
    assert.throws(()=>compileSingleWorkflow(r,t,{info:ambiguous}),/comfy_model_ambiguous:LoraLoaderModelOnly.lora_name/);
});
test("ResolutionSelector short aspect ratio is normalized to the live ComfyUI enum before /prompt",()=>{
    const choices=["1:1 (Square)","3:4 (Portrait Standard)","9:16 (Portrait Widescreen)","16:9 (Widescreen)","21:9 (Ultrawide)"];
    const t=template();
    t.apiGraph["115"]={class_type:"ResolutionSelector",inputs:{aspect_ratio:"1:1 (Square)"}};
    t.apiGraph["20"].inputs.resolution=["115",0];
    t.ports.push({id:"aspect_ratio",label:"画面比例",direction:"target",valueKind:"STRING",
        inputBinding:{mode:"literal",targets:[{nodeId:"115",inputName:"aspect_ratio"}]}});
    t.requirements.classTypes=[...new Set(Object.values(t.apiGraph).map(n=>n.class_type))].sort();
    t.revision=sha256(canonical({name:t.name,apiGraph:t.apiGraph,ports:t.ports,requirements:t.requirements}));
    const liveInfo={...info,Generate:{...info.Generate,input:{...info.Generate.input,
        optional:{resolution:["INT",{}]}}},
        ResolutionSelector:{input:{required:{aspect_ratio:[choices,{}]}},output:["INT"]}};
    const r=req();r.nodes[0].templateRevision=t.revision;
    r.nodes[0].inputOverrides.aspect_ratio="16:9";
    const compiled=compileSingleWorkflow(r,t,{info:liveInfo});
    assert.equal(compiled.graph["w_wf-1__115"].inputs.aspect_ratio,"16:9 (Widescreen)");
    assert.equal(t.apiGraph["115"].inputs.aspect_ratio,"1:1 (Square)");
    r.nodes[0].inputOverrides.aspect_ratio="21:9 (Ultrawide)";
    assert.equal(compileSingleWorkflow(r,t,{info:liveInfo}).graph["w_wf-1__115"].inputs.aspect_ratio,"21:9 (Ultrawide)");
    r.nodes[0].inputOverrides.aspect_ratio="18:9";
    assert.throws(()=>compileSingleWorkflow(r,t,{info:liveInfo}),/comfy_option_invalid:ResolutionSelector.aspect_ratio:18:9/);
});
test("a confirmed ComfyUI /prompt 400 validation rejection fails the run and unblocks subsequent submissions",async()=>{
    const dir=mkdtempSync(join(testRoot,"atelier-comfy-invalid-prompt-"));
    let posts=0;
    const fake=createServer(async(req,res)=>{
        if(req.url==="/object_info") {
            res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(info));return;
        }
        if(req.url==="/prompt" && req.method==="POST") {
            for await(const _chunk of req) {}
            posts++;
            res.writeHead(posts===1?400:200,{"content-type":"application/json"});
            res.end(JSON.stringify(posts===1?{
                error:{type:"prompt_outputs_failed_validation",message:"Prompt outputs failed validation"},
                node_errors:{"w_wf-1__115":{errors:[{message:"Value not in list",details:"aspect_ratio: 16:9"}]}}
            }:{prompt_id:"accepted-second"}));return;
        }
        res.writeHead(404);res.end();
    });
    await new Promise(resolve=>fake.listen(0,"127.0.0.1",resolve));
    const env={COMFY_INSTANCES_JSON:JSON.stringify([{id:"comfy-local",url:"http://127.0.0.1:"+fake.address().port}])};
    const service=createComfyService({root:dir,env,tickMs:0});
    try{
        service.store.addTemplate(template());
        const first=req();
        const firstRun=service.store.addRun("local-owner",first,sha256(canonical(first))).run;
        await service.tick();
        const rejected=service.store.read(firstRun.id);
        assert.equal(rejected.status,"failed",rejected.error);
        assert.match(rejected.error,/comfy_prompt_rejected:Prompt outputs failed validation/);
        assert.match(rejected.error,/aspect_ratio: 16:9/);
        const second=req();second.idempotencyKey="click-after-failed";
        const secondRun=service.store.addRun("local-owner",second,sha256(canonical(second))).run;
        await service.tick();
        assert.equal(service.store.read(secondRun.id).status,"running");
        assert.equal(posts,2);
    }finally{
        service.close();
        await new Promise(resolve=>fake.close(resolve));
        rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:300});
    }
});
test("on restart only previously confirmed 400 rejections unlock the queue, not network unknowns",()=>{
    const dir=mkdtempSync(join(testRoot,"atelier-comfy-old-rejection-"));
    let db=createComfyStore(dir);
    const known=req(),unknown=req();unknown.idempotencyKey="network-uncertain";
    const k=db.addRun("local-owner",known,sha256(canonical(known))).run;
    const u=db.addRun("local-owner",unknown,sha256(canonical(unknown))).run;
    db.cas(k.id,"queued","submission_unknown",{error:"Error: comfy_upstream_400"});
    db.cas(u.id,"queued","submission_unknown",{error:"Error: network response lost"});
    db.close();
    try{
        db=createComfyStore(dir);
        db.resumeAfterRestart();
        assert.equal(db.read(k.id).status,"failed");
        assert.equal(db.read(u.id).status,"submission_unknown");
        db.resumeAfterRestart();
        assert.equal(db.read(k.id).status,"failed");
    }finally{
        db.close();
        rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:300});
    }
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
    // The live /object_info image COMBO is stale until after /upload/image.
    const liveInfo={...info,LoadImage:{input:{required:{image:[["already_on_disk.png"],{"image_upload":true}]}},output:["IMAGE","MASK"]}};
    let outputFailOnce=true;
    let allowInfo=true;
    const mock=async(_instance,path,opts={})=>{
        if(path==="/object_info"){if(!allowInfo)throw Error("Comfy offline");return liveInfo;}
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
        env:{}});
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
        assert.equal(submissions[0].prompt["w_wf-1__loader_source"].inputs.image,uploaded[0]);
        assert.notEqual(uploaded[0],"dryrun.png");
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
        env:{},
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
        env:{},
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

const mp4=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const wav=Buffer.from("524946460800000057415645666d7420","hex");
function mixedFixture() {
    const base=template();
    base.apiGraph["200"]={class_type:"Motion",inputs:{image:["20",0]}};
    base.apiGraph["201"]={class_type:"SaveVideo",inputs:{video:["200",0],filename_prefix:"video"}};
    base.apiGraph["210"]={class_type:"Sound",inputs:{}};
    base.apiGraph["211"]={class_type:"SaveAudio",inputs:{audio:["210",0],filename_prefix:"audio"}};
    base.apiGraph["220"]={class_type:"Text",inputs:{text:"output text"}};
    base.apiGraph["221"]={class_type:"SaveText",inputs:{text:["220",0],filename_prefix:"text"}};
    base.ports.push(
        {id:"video",label:"Video",direction:"source",valueKind:"VIDEO",outputBinding:{nodeId:"200",outputIndex:0},capture:{kind:"video",adapterId:"SaveVideo"}},
        {id:"audio",label:"Audio",direction:"source",valueKind:"AUDIO",outputBinding:{nodeId:"210",outputIndex:0},capture:{kind:"audio",adapterId:"SaveAudio"}},
        {id:"text-output",label:"Text",direction:"source",valueKind:"STRING",outputBinding:{nodeId:"220",outputIndex:0},capture:{kind:"text",adapterId:"SaveText"}}
    );
    base.requirements.classTypes=[...new Set(Object.values(base.apiGraph).map(n=>n.class_type))].sort();
    base.revision=sha256(canonical({name:base.name,apiGraph:base.apiGraph,ports:base.ports,requirements:base.requirements}));
    const capabilities={...info,
        Motion:{input:{required:{image:["IMAGE",{}]}},output:["VIDEO"]},
        SaveVideo:{input:{required:{video:["VIDEO",{}],filename_prefix:["STRING",{}]}},output:[]},
        Sound:{input:{required:{}},output:["AUDIO"]},
        SaveAudio:{input:{required:{audio:["AUDIO",{}],filename_prefix:["STRING",{}]}},output:[]},
        SaveText:{input:{required:{text:["STRING",{}],filename_prefix:["STRING",{}]}},output:[]}
    };
    return {t:base,capabilities};
}
test("v2 requires explicit schema, normalizes multi-root fingerprint and does not read v1",()=>{
    const r=req();const t=template();
    assert.throws(()=>compileSingleWorkflow({...r,schemaVersion:1},t,options()),/unsupported_schema_version/);
    const mixed=mixedFixture();
    const one={...r,nodes:[{...r.nodes[0],templateRevision:mixed.t.revision}],rootOutputs:[
        {nodeId:"wf-1",portId:"video"},{nodeId:"wf-1",portId:"image"}
    ]};
    const two={...one,rootOutputs:[...one.rootOutputs].reverse()};
    assert.equal(sha256(canonical(one))===sha256(canonical(two)),false);
    assert.equal(fingerprintRequest(one),fingerprintRequest(two));
});
test("one graph captures four independent output types, reuses existing video/audio/text sinks",()=>{
    const {t,capabilities}=mixedFixture();
    const r=req();r.nodes[0].templateRevision=t.revision;
    r.rootOutputs=["image","video","audio","text-output"].map(portId=>({nodeId:"wf-1",portId}));
    const c=compileSingleWorkflow(r,t,{info:capabilities});
    assert.equal(c.captureMap.length,4);
    assert.deepEqual(c.captureMap.map(x=>x.kind),["image","video","audio","text"]);
    assert.equal(c.captureMap[1].captureNodeId,"w_wf-1__201");
    assert.equal(c.captureMap[2].captureNodeId,"w_wf-1__211");
    assert.equal(c.captureMap[3].captureNodeId,"w_wf-1__221");
    assert.ok(c.graph["w_wf-1__20"]);
    assert.ok(c.graph["w_wf-1__220"]);
    assert.equal(c.graph["w_wf-1__100"],undefined);
});
test("empty text and streaming video larger than the old 40 MB limit",async()=>{
    const dir=mkdtempSync(join(testRoot,"atelier-comfy-stream-"));
    const db=createComfyStore(dir);
    try{
        const r=req(),run=db.addRun("local-owner",r,sha256(canonical(r))).run;
        const cap={workflowNodeId:"wf-1",portId:"text",captureNodeId:"sink",kind:"text",adapterId:"SaveText"};
        const empty=await db.addArtifact(run,cap,"empty",0,Buffer.alloc(0),"text/plain");
        assert.equal(empty.size,0);
        async function* chunks(){yield mp4;for(let i=0;i<45;i++)yield Buffer.alloc(1024*1024);}
        const video={...cap,portId:"video",kind:"video",adapterId:"SaveVideo"};
        const stored=await db.addArtifact(run,video,"large",0,chunks(),"video/mp4",{filename:"clip.mp4"});
        assert.ok(stored.size>40_000_000);
        await assert.rejects(db.addArtifact(run,video,"fake",1,Buffer.from("bad"),"video/mp4",{filename:"fake.mp4"}),/invalid_media/);
    }finally{db.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:300});}
});
test("mixed IMAGE/VIDEO/AUDIO/TEXT collector persists, resumes and serves range",async()=>{
    const dir=mkdtempSync(join(testRoot,"atelier-comfy-mixed-"));
    const {t,capabilities}=mixedFixture();
    const r=req();r.nodes[0].templateRevision=t.revision;
    r.rootOutputs=["image","video","audio","text-output"].map(portId=>({nodeId:"wf-1",portId}));
    let submits=0;
    const mock=async(_instance,path,opts={})=>{
        if(path==="/object_info")return capabilities;
        if(path==="/prompt"){submits++;return {prompt_id:"mixed-A"};}
        if(path.startsWith("/history/"))return {"mixed-A":{status:{completed:true,status_str:"success"},outputs:{
            "w_wf-1__capture_image":{images:[{filename:"still.png",type:"output"}]},
            "w_wf-1__201":{images:[{filename:"output.mp4",type:"output",animated:true}]},
            "w_wf-1__211":{audio:[{filename:"audio.wav",type:"output"}]},
            "w_wf-1__221":{text:["actual model text"]}
        }}};
        if(path.startsWith("/view?")) {
            const filename=new URL("http://local"+path).searchParams.get("filename");
            if(filename==="output.mp4")return {bytes:mp4,mime:"video/mp4"};
            if(filename==="audio.wav")return {bytes:wav,mime:"audio/wav"};
            return {bytes:png,mime:"image/png"};
        }
        throw Error("unexpected "+path);
    };
    const service=createComfyService({root:dir,upstreamCall:mock,tickMs:0,env:{}});
    const server=createServer((incoming,out)=>void service.handle(incoming,out,new URL(incoming.url,"http://test")));
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const base="http://127.0.0.1:"+server.address().port;
    const post=(path,value)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
    try {
        assert.equal((await post("/api/comfy/templates",{template:t,instanceId:"comfy-local"})).status,200);
        const created=await post("/api/comfy/runs",r);
        assert.equal(created.status,201,await created.clone().text());
        const run=await created.json();
        for(let i=0;i<10;i++){await service.tick();if(service.store.read(run.runId).status==="succeeded")break;}
        const state=await(await fetch(base+"/api/comfy/runs/"+run.runId)).json();
        assert.equal(state.status,"succeeded",state.error);
        assert.deepEqual(state.artifacts.map(x=>x.kind).sort(),["audio","image","text","video"]);
        assert.equal(submits,1);
        for(const a of state.artifacts) {
            const response=await fetch(base+a.url);
            assert.equal(response.status,200);
            assert.equal(response.headers.get("content-type"),a.mimeType);
            assert.equal(sha256(Buffer.from(await response.arrayBuffer())),a.sha256);
        }
        const video=state.artifacts.find(a=>a.kind==="video");
        const partial=await fetch(base+video.url,{headers:{Range:"bytes=4-7"}});
        assert.equal(partial.status,206);
        assert.equal(partial.headers.get("content-range"),"bytes 4-7/"+mp4.length);
        assert.equal((await partial.arrayBuffer()).byteLength,4);
        await service.tick();
        assert.equal(service.store.artifacts(run.runId).length,4);
    } finally {
        await new Promise(resolve=>server.close(resolve));service.close();
        rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:300});
    }
});
