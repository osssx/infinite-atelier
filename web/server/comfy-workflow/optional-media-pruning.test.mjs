import {test} from "node:test";
import assert from "node:assert/strict";
import {canonical,sha256,compileSingleWorkflow,verifyTemplate,validateSingleRequest} from "./compiler.mjs";

const info={
    Text:{input:{required:{text:["STRING",{}]}},output:["STRING"]},
    LoadImage:{input:{required:{image:["STRING",{}]}},output:["IMAGE","MASK"]},
    LoadAudio:{input:{required:{file:["STRING",{}]}},output:["AUDIO"]},
    LoadVideo:{input:{required:{file:["STRING",{}]}},output:["VIDEO"]},
    ResizeImage:{input:{required:{image:["IMAGE",{}]}},output:["IMAGE"]},
    AdaptiveVideo:{input:{
        required:{prompt:["STRING",{}]},
        optional:{first_frame:["IMAGE",{}],last_frame:["IMAGE",{}],reference:["IMAGE",{}],
            audio:["AUDIO",{}],video:["VIDEO",{}]}
    },output:["VIDEO"]},
    StrictVideo:{input:{required:{prompt:["STRING",{}],first_frame:["IMAGE",{}]}},output:["VIDEO"]},
    SaveVideo:{input:{required:{video:["VIDEO",{}],filename_prefix:["STRING",{}]}},output:[]},
};
const graph={
    "1":{class_type:"Text",inputs:{text:"a flying bird"}},
    "2":{class_type:"LoadImage",inputs:{image:"untrusted-first.png"}},
    "3":{class_type:"LoadImage",inputs:{image:"untrusted-last.png"}},
    "4":{class_type:"LoadAudio",inputs:{file:"untrusted-audio.wav"}},
    "5":{class_type:"LoadVideo",inputs:{file:"untrusted-video.mp4"}},
    "6":{class_type:"LoadImage",inputs:{image:"untrusted-reference.png"}},
    "7":{class_type:"ResizeImage",inputs:{image:["6",0]}},
    "10":{class_type:"AdaptiveVideo",inputs:{
        prompt:["1",0],first_frame:["2",0],last_frame:["3",0],
        reference:["7",0],audio:["4",0],video:["5",0]
    }},
};
const media={first:{kind:"IMAGE",node:"2",field:"image"},
    last:{kind:"IMAGE",node:"3",field:"image"},
    reference:{kind:"IMAGE",node:"6",field:"image"},
    audio:{kind:"AUDIO",node:"4",field:"file"},
    video:{kind:"VIDEO",node:"5",field:"file"}};
const target=(id)=>({
    id,label:id,direction:"target",valueKind:media[id].kind,required:false,
    inputBinding:{mode:"media-file",mediaKind:media[id].kind,targets:[{
        nodeId:media[id].node,inputName:media[id].field
    }]},absentPolicy:{mode:"auto-prune"}
});
const payload={
    name:"Model chooses generation mode itself",
    apiGraph:graph,
    ports:[...Object.keys(media).map(target),{
        id:"output",label:"output",direction:"source",valueKind:"VIDEO",
        outputBinding:{nodeId:"10",outputIndex:0},capture:{kind:"video",adapterId:"SaveVideo"}
    }],
    requirements:{classTypes:[...new Set(Object.values(graph).map(n=>n.class_type))].sort()}
};
const template={...payload,id:"optional-media",revision:sha256(canonical(payload))};
const source=(id)=>({
    kind:"asset",sourceNodeId:"source-"+id,sourcePortId:media[id].kind.toLowerCase(),
    valueKind:media[id].kind,assetId:"asset-"+id,sha256:"a".repeat(64)
});
const request=(names,tmpl=template)=>({
    schemaVersion:2,projectId:"project",canvasRevision:"rev",instanceId:"local",
    idempotencyKey:"click-1",runOptions:{},nodes:[{
        id:"wf-1",templateId:tmpl.id,templateRevision:tmpl.revision,inputOverrides:{}
    }],rootOutputs:[{nodeId:"wf-1",portId:"output"}],
    edges:names.map(id=>({
        fromNodeId:"source-"+id,fromPortId:media[id].kind.toLowerCase(),toNodeId:"wf-1",toPortId:id
    })),externalInputs:names.map(source),
});
const k=id=>"w_wf-1__"+id;
const opts=names=>({info,mediaFiles:Object.fromEntries(names.map(id=>["asset-"+id,"verified-"+id+".png"]))});
const compile=names=>compileSingleWorkflow(request(names),template,opts(names));
const versioned=p=>({...p,id:"optional-media",revision:sha256(canonical(p))});
test("absent AUTOGROW reference leaves are pruned without making minimum required slots optional",()=>{
    const p=structuredClone(payload);
    p.apiGraph["10"].inputs["images.image_1"]=p.apiGraph["10"].inputs.first_frame;
    delete p.apiGraph["10"].inputs.first_frame;
    const tmpl=versioned(p),dynamicInfo=structuredClone(info);
    delete dynamicInfo.AdaptiveVideo.input.optional.first_frame;
    dynamicInfo.AdaptiveVideo.input.required.images=["COMFY_AUTOGROW_V3",{template:{names:["image_1","image_2"],min:0,input:{required:{image:["IMAGE",{}]}}}}];
    const result=compileSingleWorkflow(request([],tmpl),tmpl,{...opts([]),info:dynamicInfo});
    assert.equal(Object.hasOwn(result.graph[k("10")].inputs,"images.image_1"),false);
    const supplied=compileSingleWorkflow(request(["first"],tmpl),tmpl,{...opts(["first"]),info:dynamicInfo});
    assert.deepEqual(supplied.graph[k("10")].inputs["images.image_1"],[k("2"),0]);
    dynamicInfo.AdaptiveVideo.input.required.images[1].template.min=1;
    assert.throws(()=>compileSingleWorkflow(request([],tmpl),tmpl,{...opts([]),info:dynamicInfo}));
});

test("a populated canvas image can provide its own frozen media slot",()=>{
 const tmpl=structuredClone(template);
 tmpl.mediaUseCase={channel:"video",slots:[{id:"first",valueKind:"IMAGE"}],promptPortId:"prompt",primaryOutputPortId:"output"};
 const req=request(["first"],tmpl);
 req.edges[0].fromNodeId="wf-1";
 req.externalInputs[0].sourceNodeId="wf-1";
 assert.doesNotThrow(()=>validateSingleRequest(req,tmpl));
 assert.throws(()=>validateSingleRequest(req,template),/self_external_input_invalid/);
});

test("auto-prune is per media input, not a mode router or extra top-level schema",()=>{
    assert.doesNotThrow(()=>verifyTemplate(template));
    assert.equal(Object.hasOwn(template,"dynamicRoutes"),false);
    assert.equal(template.ports.filter(p=>p.absentPolicy?.mode==="auto-prune").length,5);
});
test("no media yields prompt-only adaptive model without any file loaders",()=>{
    const result=compile([]);
    assert.equal(result.decisions.first,"auto-prune");
    assert.equal(result.graph[k("10")].inputs.prompt[0],k("1"));
    for(const field of ["first_frame","last_frame","reference","audio","video"])
        assert.equal(result.graph[k("10")].inputs[field],undefined);
    for(const id of ["2","3","4","5","6","7"])assert.equal(result.graph[k(id)],undefined);
    assert.equal(result.graph[k("10")].class_type,"AdaptiveVideo");
});
test("first frame only is kept; other unconnected IMAGE/AUDIO/VIDEO sockets are removed",()=>{
    const result=compile(["first"]);
    assert.equal(result.decisions.first,"edge");
    assert.equal(result.graph[k("2")].inputs.image,"verified-first.png");
    assert.deepEqual(result.graph[k("10")].inputs.first_frame,[k("2"),0]);
    for(const field of ["last_frame","reference","audio","video"])
        assert.equal(Object.hasOwn(result.graph[k("10")].inputs,field),false);
});
test("first and last frame kept without selecting a client-side fl2v mode",()=>{
    const result=compile(["first","last"]);
    assert.deepEqual(result.graph[k("10")].inputs.first_frame,[k("2"),0]);
    assert.deepEqual(result.graph[k("10")].inputs.last_frame,[k("3"),0]);
    assert.equal(result.decisions.$route,undefined);
    assert.equal(result.graph[k("10")].inputs.reference,undefined);
});
test("reference/media input types independently retained and pruned",()=>{
    const result=compile(["first","reference","audio","video"]);
    assert.deepEqual(result.graph[k("10")].inputs.reference,[k("7"),0]);
    assert.deepEqual(result.graph[k("7")].inputs.image,[k("6"),0]);
    assert.deepEqual(result.graph[k("10")].inputs.audio,[k("4"),0]);
    assert.deepEqual(result.graph[k("10")].inputs.video,[k("5"),0]);
    assert.equal(result.graph[k("3")],undefined);
    assert.equal(result.graph[k("4")].inputs.file,"verified-audio.png");
    assert.equal(result.graph[k("5")].inputs.file,"verified-video.png");
});
test("socket-bound optional image removes model socket directly",()=>{
    const modified=structuredClone(payload);
    modified.ports=modified.ports.filter(p=>p.id!=="first");
    modified.ports.splice(0,0,{id:"first",label:"first",direction:"target",valueKind:"IMAGE",
        inputBinding:{mode:"socket",replaceInternalLink:true,targets:[{nodeId:"10",inputName:"first_frame"}]},
        absentPolicy:{mode:"auto-prune"}});
    const tmpl=versioned(modified);
    const result=compileSingleWorkflow(request([],tmpl),tmpl,{info,mediaFiles:{}});
    assert.equal(result.graph[k("10")].inputs.first_frame,undefined);
});
test("schema-required media consumer is not silently made optional",()=>{
    const broken=structuredClone(payload);
    broken.apiGraph["10"].class_type="StrictVideo";
    delete broken.apiGraph["10"].inputs.last_frame;
    delete broken.apiGraph["10"].inputs.reference;
    delete broken.apiGraph["10"].inputs.audio;
    delete broken.apiGraph["10"].inputs.video;
    broken.requirements.classTypes=[...new Set(Object.values(broken.apiGraph).map(n=>n.class_type))].sort();
    const tmpl=versioned(broken);
    assert.throws(()=>compileSingleWorkflow(request([],tmpl),tmpl,{info,mediaFiles:{}}),
        /comfy_auto_prune_media_still_reachable:first/);
});
test("pruning one absent media never silently drops an unrelated supplied asset",()=>{
    const modified=structuredClone(payload);
    modified.apiGraph["7"].inputs.image=["2",0];
    const tmpl=versioned(modified);
    assert.throws(()=>compileSingleWorkflow(request(["reference"],tmpl),tmpl,opts(["reference"])),
        /comfy_supplied_media_pruned:reference/);
});
test("missing media without auto-prune still rejects template filenames",()=>{
    const legacy=structuredClone(payload);
    legacy.ports[0].absentPolicy={mode:"keep-template"};
    const tmpl=versioned(legacy);
    assert.throws(()=>compileSingleWorkflow(request([],tmpl),tmpl,{info,mediaFiles:{}}),
        /media_input_requires_connection:first/);
});
test("invalid auto-prune configuration is rejected at template verification",()=>{
    const wrong=structuredClone(payload);
    wrong.ports[0].required=true;
    const tmpl=versioned(wrong);
    assert.throws(()=>verifyTemplate(tmpl),/template_auto_prune_invalid/);
});
test("VHS video file loader produces IMAGE frames and prunes optional H3 AUTOGROW input",()=>{
    const p=structuredClone(payload),live=structuredClone(info);
    p.apiGraph["5"]={class_type:"VHS_LoadVideo",inputs:{video:"sample.mp4"}};
    p.ports.find(port=>port.id==="video").inputBinding.targets=[{nodeId:"5",inputName:"video"}];
    delete p.apiGraph["10"].inputs.video;
    p.apiGraph["10"].inputs["ref_videos.ref_video_0"]=["5",0];
    live.VHS_LoadVideo={input:{required:{video:[["sample.mp4"],{}]}},output:["IMAGE","INT","AUDIO","VHS_VIDEOINFO"]};
    live.AdaptiveVideo.input.optional.ref_videos=["COMFY_AUTOGROW_V3",{template:{prefix:"ref_video_",min:0,max:3,input:{required:{ref_video:["IMAGE",{}]}}}}];
    p.requirements.classTypes=[...new Set(Object.values(p.apiGraph).map(n=>n.class_type))].sort();
    const tmpl=versioned(p);
    const omitted=compileSingleWorkflow(request([],tmpl),tmpl,{info:live,mediaFiles:{}});
    assert.equal(omitted.graph[k("5")],undefined);
    assert.equal(omitted.graph[k("10")].inputs["ref_videos.ref_video_0"],undefined);
    const linked=compileSingleWorkflow(request(["video"],tmpl),tmpl,{info:live,mediaFiles:{"asset-video":"verified.mp4"}});
    assert.equal(linked.graph[k("5")].inputs.video,"verified.mp4");
    assert.deepEqual(linked.graph[k("10")].inputs["ref_videos.ref_video_0"],[k("5"),0]);
    live.VHS_LoadVideo.output=["VIDEO"];
    assert.throws(()=>compileSingleWorkflow(request([],tmpl),tmpl,{info:live,mediaFiles:{}}),/comfy_auto_prune_required_input/);
    assert.throws(()=>compileSingleWorkflow(request(["video"],tmpl),tmpl,{info:live,mediaFiles:{"asset-video":"verified.mp4"}}),/comfy_media_loader_type_mismatch/);
});
