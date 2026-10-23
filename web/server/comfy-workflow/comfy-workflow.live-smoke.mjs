/** Real ComfyUI smoke: opt-in GPU submissions; never run during normal test suite. */
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createComfyService } from "./service.mjs";
import { canonical, sha256 } from "./compiler.mjs";

if (process.env.COMFY_LIVE_TEST !== "1") {
    console.error("GPU smoke is opt-in: set COMFY_LIVE_TEST=1 to submit two small real jobs.");
    process.exit(2);
}
const COMFY = "http://127.0.0.1:8188";
const get = async (path) => {
    const response=await fetch(COMFY+path,{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error(`Comfy ${path} HTTP ${response.status}`);
    return response.json();
};
const queue=await get("/queue");
if((queue.queue_pending?.length??0)+(queue.queue_running?.length??0)>0)
    throw Error("Comfy queue not empty: live smoke refused to alter running GPU work");
const info=await get("/object_info");
const ckpts=info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]??[];
const checkpoint=ckpts.find(x=>x==="dreamshaperXL_lightningDPMSDE.safetensors") ||
    ckpts.find(x=>/lightning/i.test(x)) || ckpts.find(x=>/sdxl/i.test(x));
if(!checkpoint)throw Error("No suitable installed Lightning/SDXL checkpoint; not submitting arbitrary model.");
for(const name of ["CheckpointLoaderSimple","KSampler","CLIPTextEncode","EmptyLatentImage","VAEDecode","LoadImage","SaveImage","ImageScaleBy"]){
    if(!info[name])throw Error("Comfy class missing: "+name);
}
const textGraph={
    "1":{class_type:"CheckpointLoaderSimple",inputs:{ckpt_name:checkpoint}},
    "2":{class_type:"CLIPTextEncode",inputs:{text:"red paper kite above a green hill",clip:["1",1]}},
    "3":{class_type:"CLIPTextEncode",inputs:{text:"watermark, blurry, text",clip:["1",1]}},
    "4":{class_type:"EmptyLatentImage",inputs:{width:256,height:256,batch_size:2}},
    "5":{class_type:"KSampler",inputs:{model:["1",0],seed:42,steps:4,cfg:1,sampler_name:"euler",scheduler:"sgm_uniform",
        positive:["2",0],negative:["3",0],latent_image:["4",0],denoise:1}},
    "6":{class_type:"VAEDecode",inputs:{samples:["5",0],vae:["1",2]}},
    "7":{class_type:"SaveImage",inputs:{images:["6",0],filename_prefix:"unused_pruned"}},
};
const textPorts=[
    {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",
        inputBinding:{mode:"literal",targets:[{nodeId:"2",inputName:"text"}]}},
    {id:"seed",label:"Seed",direction:"target",valueKind:"INT",defaultValue:123,
        inputBinding:{mode:"literal",targets:[{nodeId:"5",inputName:"seed"}]}},
    {id:"result",label:"Result",direction:"source",valueKind:"IMAGE",
        outputBinding:{nodeId:"6",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}},
];
const upscaleGraph={
    "1":{class_type:"LoadImage",inputs:{image:"placeholder.png"}},
    "2":{class_type:"ImageScaleBy",inputs:{image:["1",0],upscale_method:"lanczos",scale_by:1.25}},
    "3":{class_type:"SaveImage",inputs:{images:["2",0],filename_prefix:"unused_pruned"}},
};
const upscalePorts=[
    {id:"source",label:"Image",direction:"target",valueKind:"IMAGE",
        inputBinding:{mode:"socket",replaceInternalLink:true,targets:[{nodeId:"2",inputName:"image"}]}},
    {id:"result",label:"Result",direction:"source",valueKind:"IMAGE",
        outputBinding:{nodeId:"2",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}},
];
function template(name,graph,ports) {
    const payload={name,apiGraph:graph,ports,requirements:{
        classTypes:[...new Set(Object.values(graph).map(n=>n.class_type))].sort()
    }};
    return {id:"comfy-smoke-"+name,revision:sha256(canonical(payload)),...payload};
}
const textTemplate=template("text",textGraph,textPorts),upscaleTemplate=template("upscale",upscaleGraph,upscalePorts);
const dir=mkdtempSync(join(tmpdir(),"atelier-live-smoke-"));
const instanceId="comfy-local",projectId="comfy-smoke";
const service=createComfyService({root:dir,tickMs:1000,fetchInfo:async()=>info,
    env:{COMFY_INSTANCES_JSON:JSON.stringify([{id:instanceId,url:COMFY}])}});
const server=createServer((req,res)=>void service.handle(req,res,new URL(req.url,"http://smoke.local")));
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const base="http://127.0.0.1:"+server.address().port;
async function api(path,method="GET",body=null,headers={}) {
    const res=await fetch(base+"/api/comfy"+path,{method,headers,body});
    if(!res.ok)throw Error(`API ${method} ${path} HTTP ${res.status} ${(await res.text()).slice(0,300)}`);
    return res.json();
}
async function waitForRun(runId,label){
    const until=Date.now()+300000;let prev="";
    while(Date.now()<until){
        const run=await api("/runs/"+runId);
        if(run.status!==prev){console.log(label,"status",run.status,run.promptId??"",run.error??"");prev=run.status;}
        if(["succeeded","failed","cancelled","timed_out","submission_unknown"].includes(run.status))return run;
        await new Promise(resolve=>setTimeout(resolve,1800));
    }
    throw Error(label+" timed out; run="+runId+" (look up Comfy queue; DO NOT blindly retry)");
}
function request(t,nodeId,edges,externalInputs,overrides={}){
    return {schemaVersion:1,projectId,canvasRevision:"smoke-v1",instanceId,idempotencyKey:randomUUID(),
        rootOutputs:[{nodeId,portId:"result"}],
        nodes:[{id:nodeId,templateId:t.id,templateRevision:t.revision,inputOverrides:overrides}],
        edges,externalInputs,runOptions:{}};
}
let success=false;
try{
    for(const t of [textTemplate,upscaleTemplate]){
        console.log("Register",t.id,(await api("/templates","POST",JSON.stringify({instanceId,template:t}),
            {"content-type":"application/json"})).result);
    }
    const textRequest=request(textTemplate,"smoke-text",[{
        fromNodeId:"text-external",fromPortId:"text",toNodeId:"smoke-text",toPortId:"prompt"
    }],[{kind:"scalar",sourceNodeId:"text-external",sourcePortId:"text",valueKind:"STRING",
        value:"One small red kite soaring in blue sky, green mountain at sunrise"}],{seed:42});
    const textRun=await api("/runs","POST",JSON.stringify(textRequest),{"content-type":"application/json"});
    console.log("Text runId",textRun.runId);
    const textFinal=await waitForRun(textRun.runId,"Text-to-image");
    if(textFinal.status!=="succeeded" || textFinal.artifacts.length!==2)throw Error("Text-to-image did not capture 2 images");
    console.log("Text-to-image artifacts",textFinal.artifacts.map(a=>({id:a.artifactId,bytes:a.byteSize,sha256:a.sha256.slice(0,12)})));
    const first=textFinal.artifacts[0];
    const result=await fetch(base+first.url);
    if(!result.ok)throw Error("Artifact GET HTTP "+result.status);
    const imageBytes=Buffer.from(await result.arrayBuffer());
    if(sha256(imageBytes)!==first.sha256)throw Error("Artifact content digest mismatch");
    const input=await api("/inputs","POST",imageBytes,{"content-type":first.mimeType});
    const imageRequest=request(upscaleTemplate,"smoke-upscale",[{
        fromNodeId:"image-external",fromPortId:"image",toNodeId:"smoke-upscale",toPortId:"source"
    }],[{kind:"asset",sourceNodeId:"image-external",sourcePortId:"image",valueKind:"IMAGE",
        assetId:input.assetId,sha256:input.sha256}]);
    const upscaleRun=await api("/runs","POST",JSON.stringify(imageRequest),{"content-type":"application/json"});
    console.log("Upscale runId",upscaleRun.runId);
    const imageFinal=await waitForRun(upscaleRun.runId,"Image-to-image");
    if(imageFinal.status!=="succeeded" || imageFinal.artifacts.length!==1)
        throw Error("Image-to-image did not return one image");
    const up=imageFinal.artifacts[0];
    const upResult=await fetch(base+up.url);
    const upBytes=Buffer.from(await upResult.arrayBuffer());
    if(sha256(upBytes)!==up.sha256 || up.byteSize!==upBytes.length)
        throw Error("Upscale artifact mismatch");
    console.log("LIVE_E2E_PASS",JSON.stringify({checkpoint,outputPort:"result",textRunId:textRun.runId,
        textImageCount:2,upscaleRunId:upscaleRun.runId,upscaleImageCount:1,
        inputImageBytes:imageBytes.length,upscaleImageBytes:upBytes.length}));
    success=true;
}finally{
    await new Promise(resolve=>server.close(resolve));
    service.close();
    try{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:300});}
    catch(e){console.error("Could not remove temporary smoke data:",dir,e.message);}
    if(!success)console.error("LIVE_SMOKE_INCOMPLETE; prior run may remain in Comfy queue. Do not rerun without reviewing /queue.");
}
