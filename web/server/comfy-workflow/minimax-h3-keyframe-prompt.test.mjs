import {test} from "node:test";
import assert from "node:assert/strict";
import {canonical,sha256,compileSingleWorkflow} from "./compiler.mjs";

const info={
 LoadImage:{input:{required:{image:["STRING",{}]}},output:["IMAGE","MASK"]},
 MiniMaxH3ReferenceToVideo:{input:{required:{prompt:["STRING",{}]},optional:{
  ref_images:["COMFY_AUTOGROW_V3",{template:{prefix:"ref_image_",min:0,max:9,input:{required:{ref_image:["IMAGE",{}]}}}}]
 }},output:["VIDEO"]},
 SaveVideo:{input:{required:{video:["VIDEO",{}],filename_prefix:["STRING",{}]}},output:[]}
};
const roles={text_to_video:{},first_frame:{first_frame:["imageA"]},last_frame:{last_frame:["imageA"]},
 first_last_frame:{first_frame:["imageA"],last_frame:["imageB"]},omni_reference:{reference_image:["imageA","imageB"]}};
const modes=Object.entries(roles).map(([id,rolePorts])=>({id,enabled:true,parameters:[],
 inputs:Object.entries(rolePorts).map(([role,ids])=>({role,kind:"image",minItems:role==="reference_image"?0:1,maxItems:ids.length}))}));
function fixture(legacy=false){
 const mediaPort=(id,nodeId)=>({id,label:id,direction:"target",valueKind:"IMAGE",required:false,
  inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId,inputName:"image"}]},absentPolicy:{mode:"auto-prune"}});
 const payload={name:"H3 user prompt regression",requirements:{classTypes:["LoadImage","MiniMaxH3ReferenceToVideo"]},
  apiGraph:{
   "10":{class_type:"LoadImage",inputs:{image:"sample-a.png"}},
   "20":{class_type:"LoadImage",inputs:{image:"sample-b.png"}},
   "129":{class_type:"MiniMaxH3ReferenceToVideo",inputs:{prompt:"template default",
    "ref_images.ref_image_2":["10",0],"ref_images.ref_image_7":["20",0]}}
  },
  ports:[mediaPort("imageA","10"),mediaPort("imageB","20"),{id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",
    inputBinding:{mode:"literal",targets:[{nodeId:"129",inputName:"prompt"}]},absentPolicy:{mode:"keep-template"}},
   {id:"video",label:"Video",direction:"source",valueKind:"VIDEO",outputBinding:{nodeId:"129",outputIndex:0},capture:{kind:"video",adapterId:"SaveVideo"}}],
  mediaUseCase:{channel:"video",primaryOutputKind:"video",promptPortId:"prompt",primaryOutputPortId:"video",
   slots:["imageA","imageB"].map(id=>({id,label:id,valueKind:"IMAGE",required:false})),
   mediaCapabilities:{schemaVersion:1,kind:"video",defaultMode:"text_to_video",modes},
   modeBindings:Object.fromEntries(Object.entries(roles).map(([id,rolePorts])=>[id,{promptPortId:"prompt",parameterPorts:{},rolePorts,
    ...(legacy&&["first_frame","last_frame","first_last_frame"].includes(id)?{promptTransform:"minimax_h3_keyframes"}:{})}]))}
 };
 return {...payload,id:"h3",revision:sha256(canonical(payload))};
}
function compile(template,mode,mediaIds,prompt,{connected=false}={}){
 const nodeId="wf-1";
 const externalInputs=mediaIds.map((id,i)=>({kind:"asset",sourceNodeId:"asset-"+id,sourcePortId:"image",valueKind:"IMAGE",
  assetId:("abcdef"[i]).repeat(64),sha256:("abcdef"[i]).repeat(64)}));
 const edges=mediaIds.map(id=>({fromNodeId:"asset-"+id,fromPortId:"image",toNodeId:nodeId,toPortId:id}));
 if(connected){
  externalInputs.push({kind:"scalar",sourceNodeId:"text-1",sourcePortId:"text",valueKind:"STRING",value:prompt});
  edges.push({fromNodeId:"text-1",fromPortId:"text",toNodeId:nodeId,toPortId:"prompt"});
 }
 const req={schemaVersion:2,projectId:"p1",canvasRevision:"1",instanceId:"local",idempotencyKey:"click-1",
  nodes:[{id:nodeId,templateId:template.id,templateRevision:template.revision,inputOverrides:{prompt:connected?"unused override":prompt}}],
  rootOutputs:[{nodeId,portId:"video"}],edges,externalInputs,runOptions:{mediaMode:mode}};
 const before=canonical({template,req});
 const opts={info,mediaFiles:Object.fromEntries(externalInputs.filter(input=>input.kind==="asset").map(input=>[input.assetId,"staged-"+input.sourceNodeId+".png"]))};
 const result=compileSingleWorkflow(req,template,opts);
 assert.equal(canonical({template,req}),before);
 assert.equal(compileSingleWorkflow(req,template,opts).graphHash,result.graphHash);
 return result.graph["w_wf-1__129"].inputs;
}
const samples=[
 ["first_frame",["imageA"],"  <Picture 1> 作为开场。\n缓慢推进。  "],
 ["last_frame",["imageA"],"以 <Picture 1> 结束。\n"],
 ["first_last_frame",["imageA","imageB"],"<Picture 1> 至 <Picture 2>，镜头持续平移。"],
 ["text_to_video",[],"文生视频，不需要参考。"],
 ["omni_reference",["imageB"],"仅参考 <Picture 1> 的构图。"]
];
for(const legacy of [false,true])test((legacy?"historical":"new")+" template preserves exact user prompt and reference bindings in all five modes",()=>{
 const template=fixture(legacy);
 for(const [mode,ids,prompt] of samples){
  const model=compile(template,mode,ids,prompt);
  assert.equal(model.prompt,prompt);
  assert.deepEqual(Object.keys(model).filter(key=>key.startsWith("ref_images.")).sort(),
   ids.map(id=>"ref_images.ref_image_"+(id==="imageA"?"2":"7")).sort());
  assert.equal(model.first_frame,undefined);
  assert.equal(model.last_frame,undefined);
 }
});
test("a connected text node wins, preserving whitespace, multilingual text and user tags exactly",()=>{
 const prompt="  自定义 <Picture 1>\n<Picture 2>\r\n No generated instructions.  ";
 for(const legacy of [false,true])assert.equal(compile(fixture(legacy),"first_last_frame",["imageA","imageB"],prompt,{connected:true}).prompt,prompt);
});
test("no endpoint marker is required or synthesized; ordinary and empty user prompts remain unchanged",()=>{
 for(const legacy of [false,true])for(const prompt of ["Camera pans.", ""])assert.equal(compile(fixture(legacy),"first_frame",["imageA"],prompt).prompt,prompt);
});
test("required and inactive media validation still applies",()=>{
 for(const legacy of [false,true]){
  const template=fixture(legacy);
  assert.throws(()=>compile(template,"first_last_frame",["imageA"],"custom prompt"),/template_media_request_invalid/);
  assert.throws(()=>compile(template,"first_frame",["imageA","imageB"],"custom prompt"),/template_media_input_inactive/);
 }
});