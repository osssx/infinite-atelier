// @vitest-environment happy-dom
import {describe,expect,it,vi} from "vitest";
import type {CanvasNodeData,CanvasConnection} from "@/types/canvas";
import type {ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";
import {startBackendComfyWorkflowRun} from "./backend-comfy-run";
import {defaultConfig} from "@/stores/use-config-store";
import {setAssistantWorkflowParameter} from "@/features/canvas-assistant/canvas-assistant-workflow-params";
import {fingerprintBackendSource,canonicalBackendGraph} from "./backend-source-fingerprint";
import {fingerprintSource} from "../../../server/backend/repository.mjs";
import {registerCanvasPortResolver} from "@/lib/canvas/canvas-ports";
import type {BackendJobView,BlobUploadResponse} from "@/types/backend-contracts";

const workflow:CanvasNodeData={
 id:"wf-1",type:"comfy:workflow",title:"Demo",width:410,height:290,position:{x:10,y:20},
 metadata:{comfyWorkflow:{templateId:"demo",templateRevision:"rev1",bindingState:"bound",inputOverrides:{}},
  comfyPorts:[{id:"image",label:"Image",direction:"source",valueKind:"IMAGE"}]}
};
const template={
 id:"demo",revision:"rev1",name:"Demo",
 apiGraph:{"1":{class_type:"SolidImage",inputs:{}}},
 requirements:{classTypes:["SolidImage"]},
 ports:[{id:"image",label:"Image",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:"1",outputIndex:0},
  capture:{kind:"image",adapterId:"SaveImage"}}]
} as ComfyWorkflowTemplate;
const expectedJob:BackendJobView={id:"new-job",projectId:"p1",executionMode:"poll",
 status:"queued",createdAt:1,updatedAt:1,upstreamTaskId:null,
 attemptId:null,submitMarker:null,submissionStartedAt:null};
const copy=<T,>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;
describe("backend save fence + frozen Comfy submission",()=>{
 it("browser source fingerprint matches SQLite server across transitive ancestors",async()=>{
  const nodes=[{id:"scalar",type:"text",title:"txt",width:300,height:220,position:{x:0,y:0},metadata:{content:"seed"}},
   {id:"ref",type:"image",title:"reference",width:300,height:220,position:{x:350,y:0},metadata:{content:"abc"}},workflow];
  const connections=[
   {id:"one",fromNodeId:"scalar",toNodeId:"ref"},
   {id:"two",fromNodeId:"ref",fromPortId:"image",toNodeId:"wf-1",toPortId:"in"}
  ];
  const graph={nodes,connections} as {nodes:CanvasNodeData[];connections:CanvasConnection[]};
  const hash=await fingerprintBackendSource(graph,"wf-1");
  expect(hash).toBe(fingerprintSource(copy(graph),"wf-1"));
  expect(hash).toBe(await fingerprintBackendSource({nodes:[...graph.nodes].reverse(),connections:[...connections].reverse()},"wf-1"));
  expect(hash).toBe(await fingerprintBackendSource({...graph,nodes:graph.nodes.map(n=>n.id==="scalar"?{...n,title:"new"}:n)},"wf-1"));
  expect(hash).not.toBe(await fingerprintBackendSource({...graph,nodes:graph.nodes.map(n=>n.id==="scalar"?{...n,metadata:{...n.metadata,content:"new input"}}:n)},"wf-1"));
  expect(canonicalBackendGraph(graph)).toContain('"nodes"');
  await expect(fingerprintBackendSource({...graph,connections:[...connections,{id:"three",fromNodeId:"wf-1",toNodeId:"scalar"}]},"wf-1"))
   .rejects.toThrow("cyclic_generation_source");
 });
 it("text-only workflow freezes graph and saves project before POST; no legacy gateway",async()=>{
  const calls:string[]=[];
  const bridge={
   state:{status:"connected"},
   assertNoActiveJob:vi.fn(async()=>{}),
   assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>{calls.push("save");return {projectId:"p1",revision:4,
    sourceNodeFingerprint:"fence-4"}}),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("unexpected asset")}),
   submitFrozenJob:vi.fn(async(payload:Record<string,unknown>)=>{
    calls.push("submit");
    expect(payload.expectedProjectRevision).toBe(4);
    expect(payload.sourceNodeFingerprint).toBe("fence-4");
    expect((payload.snapshot as any).comfyRequest.externalInputs).toEqual([]);
    expect(bridge.assertNoActiveJob).toHaveBeenCalledWith("wf-1");
    return expectedJob;
   })
  };
  const result=await startBackendComfyWorkflowRun({
   bridge,projectId:"p1",workflowNode:workflow,
   nodes:[workflow],connections:[],template,instanceId:"comfy-local",
   outputPortIds:["image"],newKey:()=> "immutable-click"
  });
  expect(result.id).toBe("new-job");
  expect(calls).toEqual(["save","submit"]);

  expect(bridge.submitFrozenJob).toHaveBeenCalledTimes(1);
 });
 it("media preset freezes selected slot assets as request-only edges and independent Comfy overrides",async()=>{
  const mediaNode:CanvasNodeData={id:"media-target",type:"image",title:"Image",width:360,height:280,position:{x:0,y:0},
   metadata:{comfyMediaPreset:{templateId:"media-demo",templateRevision:"rev-media",overrides:{steps:0,enabled:false},
    slots:{reference:{nodeId:"reference",imageId:"still-1"}}}}};
  const reference:CanvasNodeData={id:"reference",type:"image",title:"Reference",width:360,height:280,position:{x:400,y:0},
   metadata:{content:"blob:reference-image",storageKey:"reference-blob",mimeType:"image/png",images:[{id:"still-1",status:"success",content:"blob:reference-image",storageKey:"reference-blob",naturalWidth:1,naturalHeight:1,bytes:5,mimeType:"image/png"}]}};
  const mediaTemplate:ComfyWorkflowTemplate={...template,id:"media-demo",revision:"rev-media",
   apiGraph:{"1":{class_type:"LoadImage",inputs:{image:"example.png"}},"2":{class_type:"Prompt",inputs:{text:""}},"3":{class_type:"Output",inputs:{}}},
   requirements:{classTypes:["LoadImage","Output","Prompt"]},
   ports:[{id:"reference",label:"Reference",direction:"target",valueKind:"IMAGE",inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId:"1",inputName:"image"}]}},
    {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"2",inputName:"text"}]}},
    {id:"image",label:"Image",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:"3",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}],
   mediaUseCase:{channel:"image",primaryOutputKind:"image",promptPortId:"prompt",slots:[{id:"reference",label:"Reference",valueKind:"IMAGE"}],primaryOutputPortId:"image"}};
  const context:CanvasNodeData={id:"context-text",type:"text",title:"Context",width:300,height:220,position:{x:-400,y:0},metadata:{content:"visual only"}};
  const graph={nodes:[reference,mediaNode,context],connections:[{id:"legacy-context",fromNodeId:context.id,toNodeId:mediaNode.id}]};let frozen:any;
  const bridge={state:{status:"connected"},assertNoActiveJob:vi.fn(async()=>{}),assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>({projectId:"p1",revision:9,sourceNodeFingerprint:"media-fence"})),
   uploadFrozenBlob:vi.fn(async(blob:Blob)=>({blobId:"a".repeat(64),sha256:"a".repeat(64),byteSize:blob.size} as BlobUploadResponse)),
   submitFrozenJob:vi.fn(async(payload:Record<string,unknown>)=>{frozen=payload;return expectedJob})};
  const result=await startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:mediaNode,...graph,template:mediaTemplate,
   instanceId:"comfy-local",outputPortIds:["image"],mediaSlots:mediaNode.metadata!.comfyMediaPreset!.slots,prompt:"frozen prompt",
   readBlob:async()=>new Blob(["image"],{type:"image/png"}),beforeSubmit:vi.fn()});
  expect(result).toEqual(expectedJob);
  const request=(frozen.snapshot as any).comfyRequest;
  expect(request.nodes[0].inputOverrides).toEqual({steps:0,enabled:false,prompt:"frozen prompt"});
  expect(request.edges).toEqual([{fromNodeId:"reference",fromPortId:"image",toNodeId:"media-target",toPortId:"reference"}]);
  expect(request.externalInputs).toMatchObject([{kind:"asset",sourceNodeId:"reference",sourcePortId:"image",valueKind:"IMAGE",sha256:"a".repeat(64)}]);
  expect(graph.connections).toEqual([{id:"legacy-context",fromNodeId:"context-text",toNodeId:"media-target"}]);
 });
 it("AI workflow port override reaches frozen Comfy submission and does not overwrite source media",async()=>{
  const mediaTemplate:ComfyWorkflowTemplate={...template,id:"assistant-media",revision:"r-ai",
   apiGraph:{"1":{class_type:"Sampler",inputs:{steps:20,prompt:""}},"2":{class_type:"Output",inputs:{}}},
   requirements:{classTypes:["Sampler","Output"]},
   ports:[
    {id:"steps",label:"Steps",direction:"target",valueKind:"INT",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"steps"}]}},
    {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"prompt"}]}},
    {id:"image",label:"Image",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:"2",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}],
   mediaUseCase:{channel:"image",primaryOutputKind:"image",promptPortId:"prompt",slots:[],primaryOutputPortId:"image"}};
  const mediaNode:CanvasNodeData={id:"img-1",type:"image",title:"Image",width:400,height:300,position:{x:0,y:0},
   metadata:{content:"/api/v1/blobs/existing",prompt:"dragon",
    comfyMediaPreset:{templateId:"assistant-media",templateRevision:"r-ai",overrides:{steps:18},slots:{}}}};
  const edited=setAssistantWorkflowParameter(mediaNode,"steps",42,defaultConfig,mediaTemplate);
  expect(mediaNode.metadata?.comfyMediaPreset?.overrides).toEqual({steps:18});
  expect(edited.metadata?.comfyMediaPreset?.overrides).toEqual({steps:42});
  let frozen:any;
  const bridge={state:{status:"connected"},assertNoActiveJob:vi.fn(async()=>{}),assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>({projectId:"p1",revision:13,sourceNodeFingerprint:"preset-fence"})),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("unexpected upload")}),
   submitFrozenJob:vi.fn(async(payload:Record<string,unknown>)=>{frozen=payload;return expectedJob})};
  await expect(startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:edited,nodes:[edited],
   connections:[],template:mediaTemplate,instanceId:"comfy-local",outputPortIds:["image"],
   mediaBinding:edited.metadata!.comfyMediaPreset!,prompt:"dragon reimagined"})).resolves.toEqual(expectedJob);
  expect(frozen.snapshot.comfyRequest.nodes[0].inputOverrides).toEqual({steps:42,prompt:"dragon reimagined"});
  expect(edited.metadata?.content).toBe("/api/v1/blobs/existing");
 });
 it("config producer submits through the frozen Comfy workflow route with a binding fingerprint",async()=>{  const binding={templateId:"config-flow",templateRevision:"config-rev",overrides:{steps:3},slots:{}};
  const configNode:CanvasNodeData={id:"config-target",type:"config",title:"Config",width:360,height:280,
   position:{x:0,y:0},metadata:{comfyWorkflowSelections:{image:binding}}};
  const mediaTemplate:ComfyWorkflowTemplate={...template,id:"config-flow",revision:"config-rev",
   apiGraph:{"1":{class_type:"Prompt",inputs:{text:""}},"2":{class_type:"Output",inputs:{}}},
   requirements:{classTypes:["Prompt","Output"]},
   ports:[{id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"text"}]}},
    {id:"image",label:"Image",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:"2",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}],
   mediaUseCase:{channel:"image",primaryOutputKind:"image",promptPortId:"prompt",slots:[],primaryOutputPortId:"image"}};
  let frozen:any;
  const bridge={state:{status:"connected"},assertNoActiveJob:vi.fn(async()=>{}),assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>({projectId:"p1",revision:11,sourceNodeFingerprint:"graph-fence"})),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("unexpected upload")}),
   submitFrozenJob:vi.fn(async(payload:Record<string,unknown>)=>{frozen=payload;return expectedJob})};
  await expect(startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:configNode,nodes:[configNode],connections:[],
   template:mediaTemplate,instanceId:"comfy-local",outputPortIds:["image"],mediaBinding:binding,workflowMode:"image",prompt:"upstream prompt"}))
   .resolves.toEqual(expectedJob);
  expect(frozen.snapshot.comfyTargetBinding).toEqual({mode:"image",binding});
  expect(frozen.sourceNodeFingerprint).toMatch(/^v2c:/);
  expect(bridge.submitFrozenJob).toHaveBeenCalledOnce();
 });
 it("does not require media slot picker data when a regular workflow node runs a template that advertises media use",async()=>{
  const workflowWithUseCase:ComfyWorkflowTemplate={...template,ports:[
   {id:"first_frame",label:"First frame",direction:"target",required:true,valueKind:"IMAGE",
    inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId:"2",inputName:"image"}]}},...template.ports],
   mediaUseCase:{channel:"image",primaryOutputKind:"image",promptPortId:"prompt",slots:[{id:"first_frame",label:"First",valueKind:"IMAGE",required:true}],primaryOutputPortId:"image"}};
  const graph={nodes:[workflow,{id:"ref-node",type:"image",title:"Reference",width:320,height:320,position:{x:0,y:0},
   metadata:{content:"blob:ref",storageKey:"reference",mimeType:"image/png"}} as CanvasNodeData],
   connections:[{id:"typed-input",fromNodeId:"ref-node",fromPortId:"image",toNodeId:"wf-1",toPortId:"first_frame"}]};
  const bridge={state:{status:"connected"},assertNoActiveJob:vi.fn(async()=>{}),assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>({projectId:"p1",revision:10,sourceNodeFingerprint:"workflow-fence"})),
   uploadFrozenBlob:vi.fn(async()=>({blobId:"b".repeat(64),sha256:"b".repeat(64),byteSize:4} as BlobUploadResponse)),
   submitFrozenJob:vi.fn(async(payload:Record<string,unknown>)=>{const request=(payload.snapshot as any).comfyRequest;
    expect(request.edges).toEqual([{fromNodeId:"ref-node",fromPortId:"image",toNodeId:"wf-1",toPortId:"first_frame"}]);return expectedJob;})};
  await expect(startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:workflow,...graph,template:workflowWithUseCase,
   instanceId:"comfy-local",outputPortIds:["image"],readBlob:async()=>new Blob(["test"],{type:"image/png"}),
   getBlob:async()=>new Blob(["test"],{type:"image/png"})})).resolves.toEqual(expectedJob);
 });
 it("lets optional first frame be absent and submits the frozen prompt-only workflow",async()=>{
  const templateWithOptionalMedia:ComfyWorkflowTemplate={...template,ports:[
   {id:"first_frame",label:"首帧图片",direction:"target",required:false,valueKind:"IMAGE",
    inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId:"2",inputName:"image"}]},
    absentPolicy:{mode:"auto-prune"}},
   ...template.ports
  ]};
  const bridge={
   state:{status:"connected"},
   assertNoActiveJob:vi.fn(async()=>{}),
   assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>({projectId:"p1",revision:8,sourceNodeFingerprint:"fence"})),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("no media should be uploaded")}),
   submitFrozenJob:vi.fn(async(payload:Record<string,unknown>)=>{
    const snapshot=(payload.snapshot as {comfyRequest:{
     externalInputs:unknown[];edges:unknown[];nodes:Array<{inputOverrides:unknown}>
    }})?.comfyRequest;
    expect(snapshot.externalInputs).toEqual([]);
    expect(snapshot.edges).toEqual([]);
    return expectedJob;
   })
  };
  await expect(startBackendComfyWorkflowRun({
   bridge,projectId:"p1",workflowNode:workflow,nodes:[workflow],connections:[],
   template:templateWithOptionalMedia,instanceId:"comfy-local",outputPortIds:["image"]
  })).resolves.toEqual(expectedJob);
  expect(bridge.saveProjectNow).toHaveBeenCalledOnce();
  expect(bridge.submitFrozenJob).toHaveBeenCalledOnce();
 });
 it("blocks only an explicitly required media port before saving the graph",async()=>{
  const required:ComfyWorkflowTemplate={...template,ports:[
   {id:"first_frame",label:"首帧图片",direction:"target",required:true,valueKind:"IMAGE",
    inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId:"2",inputName:"image"}]}},
   ...template.ports
  ]};
  const bridge={
   state:{status:"connected"},
   assertNoActiveJob:vi.fn(async()=>{}),
   assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>{throw Error("must not save")}),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("must not upload")}),
   submitFrozenJob:vi.fn(async()=>{throw Error("must not submit")})
  };
  await expect(startBackendComfyWorkflowRun({
   bridge,projectId:"p1",workflowNode:workflow,nodes:[workflow],connections:[],
   template:required,instanceId:"comfy-local",outputPortIds:["image"]
  })).rejects.toThrow(/必填媒体输入：首帧图片/);
  expect(bridge.saveProjectNow).not.toHaveBeenCalled();
  expect(bridge.submitFrozenJob).not.toHaveBeenCalled();
 });
 it("stages image bytes before save then uses digest-backed frozen reference",async()=>{
  registerCanvasPortResolver("comfy:workflow",node=>node.metadata?.comfyPorts??[]);
  const photo:CanvasNodeData={id:"photo",type:"image",title:"Photo",width:240,height:240,
   position:{x:0,y:0},metadata:{storageKey:"image-1",mimeType:"image/png",content:"blob:img"}};
  const inputTemplate:ComfyWorkflowTemplate={...template,ports:[
   {id:"source",label:"Reference",direction:"target",valueKind:"IMAGE",
    inputBinding:{mode:"socket",replaceInternalLink:true,targets:[{nodeId:"1",inputName:"image"}]}},
   ...template.ports
  ]};
  const order:string[]=[];
  const uploaded:BlobUploadResponse={blobId:"abcdef",sha256:"abcdef",mimeType:"image/png",byteSize:4,existing:false};
  const bridge={
   state:{status:"connected"},
   assertNoActiveJob:vi.fn(async()=>{}),
   assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>{order.push("save");return {projectId:"p1",revision:2,sourceNodeFingerprint:"hash"}}),
   uploadFrozenBlob:vi.fn(async()=>{order.push("upload");return uploaded}),
   submitFrozenJob:vi.fn(async(payload:Record<string,unknown>)=>{
    order.push("post");
    expect((payload.snapshot as any).comfyRequest.externalInputs[0]).toMatchObject({
     kind:"asset",assetId:"abcdef",sha256:"abcdef"
    });
    return expectedJob;
   })
  };

  await startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:workflow,
   nodes:[photo,workflow],connections:[{id:"edge",fromNodeId:"photo",fromPortId:"image",toNodeId:"wf-1",toPortId:"source"}],
   template:inputTemplate,instanceId:"comfy-local",outputPortIds:["image"],
   readBlob:async()=>new Blob(["DATA"],{type:"image/png"}),newKey:()=> "immutable-click"
  });
  expect(order).toEqual(["upload","save","post"]);
  expect(bridge.uploadFrozenBlob).toHaveBeenCalledTimes(1);
  registerCanvasPortResolver("comfy:workflow");
 });
 it("freezes typed VIDEO and AUDIO Canvas assets before SQLite /jobs submission",async()=>{
  registerCanvasPortResolver("comfy:workflow",node=>node.metadata?.comfyPorts??[]);
  const clip:CanvasNodeData={id:"clip",type:"video",title:"Clip",width:420,height:260,
   position:{x:0,y:0},metadata:{storageKey:"cas:clip",mimeType:"video/mp4",content:"/api/v1/blobs/clip"}};
  const sound:CanvasNodeData={id:"sound",type:"audio",title:"Sound",width:420,height:160,
   position:{x:0,y:300},metadata:{storageKey:"cas:sound",mimeType:"audio/wav",content:"/api/v1/blobs/sound"}};
  const target={...workflow,metadata:{...workflow.metadata,comfyPorts:[
   {id:"clip_input",label:"Video",direction:"target" as const,valueKind:"VIDEO" as const},
   {id:"sound_input",label:"Audio",direction:"target" as const,valueKind:"AUDIO" as const},
   {id:"image",label:"Image",direction:"source" as const,valueKind:"IMAGE" as const}
  ]}};
  const connected:ComfyWorkflowTemplate={...template,ports:[
   {id:"clip_input",label:"Video",direction:"target",valueKind:"VIDEO",required:true,
    inputBinding:{mode:"media-file",mediaKind:"VIDEO",targets:[{nodeId:"1",inputName:"video"}]}},
   {id:"sound_input",label:"Audio",direction:"target",valueKind:"AUDIO",required:true,
    inputBinding:{mode:"media-file",mediaKind:"AUDIO",targets:[{nodeId:"1",inputName:"audio"}]}},
   ...template.ports
  ]};
  const edges:CanvasConnection[]=[
   {id:"v",fromNodeId:"clip",fromPortId:"video",toNodeId:"wf-1",toPortId:"clip_input"},
   {id:"a",fromNodeId:"sound",fromPortId:"audio",toNodeId:"wf-1",toPortId:"sound_input"}
  ];
  const trace:string[]=[];
  const uploaded=vi.fn(async(_blob:Blob,mime:string)=>{
   trace.push("upload:"+mime);
   const blobId=mime==="video/mp4"?"a".repeat(64):"b".repeat(64);
   return {blobId,sha256:blobId,mimeType:mime,byteSize:17,existing:false};
  });
  const bridge={
   state:{status:"connected"},
   assertNoActiveJob:vi.fn(async()=>{}),
   assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>{trace.push("save");return {projectId:"p1",revision:5,sourceNodeFingerprint:"fence"}}),
   uploadFrozenBlob:uploaded,
   submitFrozenJob:vi.fn(async(payload:Record<string,unknown>)=>{
    trace.push("post");
    expect((payload.snapshot as any).comfyRequest.externalInputs).toEqual([
     {kind:"asset",sourceNodeId:"clip",sourcePortId:"video",valueKind:"VIDEO",
      assetId:"a".repeat(64),sha256:"a".repeat(64)},
     {kind:"asset",sourceNodeId:"sound",sourcePortId:"audio",valueKind:"AUDIO",
      assetId:"b".repeat(64),sha256:"b".repeat(64)}
    ]);
    return expectedJob;
   })
  };
  try{
   await startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:target,
    nodes:[target,clip,sound],connections:edges,template:connected,instanceId:"comfy-local",
    outputPortIds:["image"],newKey:()=>"media-frozen",
    readBlob:async key=>key==="cas:clip"?new Blob(["clip"],{type:"video/mp4"}):
     key==="cas:sound"?new Blob(["sound"],{type:"audio/wav"}):null
   });
   expect(trace).toEqual(["upload:video/mp4","upload:audio/wav","save","post"]);
   expect(uploaded).toHaveBeenCalledTimes(2);
   await expect(startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:target,
    nodes:[target,clip,sound],connections:edges,template:connected,instanceId:"comfy-local",
    outputPortIds:["image"],
    readBlob:async()=>new Blob(["bad"],{type:"image/png"})
   })).rejects.toThrow("格式与端口类型不匹配");
  }finally{registerCanvasPortResolver("comfy:workflow")}
 });
 it("reuses an existing video CAS hash after HEAD without loading or reuploading the media",async()=>{
  registerCanvasPortResolver("comfy:workflow",node=>node.metadata?.comfyPorts??[]);
  const sha="c".repeat(64);
  const source:CanvasNodeData={id:"cached-video",type:"video",title:"Cached",
   width:320,height:200,position:{x:0,y:0},
   metadata:{storageKey:"cas:"+sha,mimeType:"video/mp4",content:"/api/v1/blobs/"+sha}};
  const target:CanvasNodeData={...workflow,metadata:{...workflow.metadata,
   comfyPorts:[{id:"video_input",label:"Video",direction:"target",valueKind:"VIDEO"},{
    id:"image",label:"Image",direction:"source",valueKind:"IMAGE"}]}};
  const connected:ComfyWorkflowTemplate={...template,ports:[{
   id:"video_input",label:"Video",direction:"target",valueKind:"VIDEO",required:true,
   inputBinding:{mode:"media-file",mediaKind:"VIDEO",targets:[{nodeId:"1",inputName:"video"}]}
  },...template.ports]};
  const readBlob=vi.fn(async()=>{throw Error("should not read cached video bytes")});
  const head=vi.fn(async(url:string,options:RequestInit)=>{
   expect(url).toBe("/api/v1/blobs/"+sha);
   expect(options.method).toBe("HEAD");
   return new Response(null,{status:200,headers:{
    "content-type":"video/mp4","content-length":"134217728"
   }});
  });
  vi.stubGlobal("fetch",head);
  const bridge={
   state:{status:"connected"},
   assertNoActiveJob:vi.fn(async()=>{}),
   assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>({projectId:"p1",revision:17,sourceNodeFingerprint:"fence"})),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("CAS must not re-upload")}),
   submitFrozenJob:vi.fn(async(payload:Record<string,unknown>)=>{
    expect((payload.snapshot as any).comfyRequest.externalInputs).toMatchObject([
     {kind:"asset",valueKind:"VIDEO",assetId:sha,sha256:sha}
    ]);
    return expectedJob;
   })
  };
  try{
   await startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:target,
    nodes:[target,source],connections:[{
     id:"v",fromNodeId:"cached-video",fromPortId:"video",toNodeId:"wf-1",toPortId:"video_input"
    }],template:connected,instanceId:"comfy-local",outputPortIds:["image"],
    readBlob,newKey:()=>"cas-pinned"
   });
   expect(head).toHaveBeenCalledOnce();
   expect(readBlob).not.toHaveBeenCalled();
   expect(bridge.uploadFrozenBlob).not.toHaveBeenCalled();
   expect(bridge.submitFrozenJob).toHaveBeenCalledOnce();
  }finally{registerCanvasPortResolver("comfy:workflow");vi.unstubAllGlobals()}
 });
 it("lost job reply never persists a browser payload or silently replays",async()=>{
  const guard=vi.fn(async()=>{});
  const submit=vi.fn(async()=>{throw Error("network lost after server acceptance")});
  const bridge={state:{status:"connected"},assertNoActiveJob:guard,
   assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>({projectId:"p1",revision:1,sourceNodeFingerprint:"fence"})),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("unexpected")}),
   submitFrozenJob:submit};
  const storage={getItem:vi.fn(()=>{throw Error("browser storage touched")}),
   setItem:vi.fn(()=>{throw Error("browser storage touched")}),
   removeItem:vi.fn(()=>{throw Error("browser storage touched")})};
  vi.stubGlobal("localStorage",storage);
  try{
   const args={bridge,projectId:"p1",workflowNode:workflow,nodes:[workflow],
    connections:[],template,instanceId:"comfy-local",outputPortIds:["image"],newKey:()=>"stable-click"};
   await expect(startBackendComfyWorkflowRun(args)).rejects.toThrow("network lost");
   expect(submit).toHaveBeenCalledTimes(1);
   expect(guard).toHaveBeenCalledWith("wf-1");
   expect(storage.getItem).not.toHaveBeenCalled();
   expect(storage.setItem).not.toHaveBeenCalled();
   guard.mockRejectedValueOnce(Error("backend_prior_job_not_terminal"));
   await expect(startBackendComfyWorkflowRun(args)).rejects.toThrow("backend_prior_job_not_terminal");
   expect(submit).toHaveBeenCalledTimes(1);
  }finally{vi.unstubAllGlobals()}
 });
 it("requires backend active-job guard before saving or submitting",async()=>{
  const bridge={state:{status:"connected"},assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>{throw Error("unexpected save")}),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("unexpected upload")}),
   submitFrozenJob:vi.fn(async()=>expectedJob)};
  await expect(startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:workflow,
   nodes:[workflow],connections:[],template,instanceId:"comfy-local",
   outputPortIds:["image"]})).rejects.toThrow("backend_sqlite_job_guard_missing");
  expect(bridge.saveProjectNow).not.toHaveBeenCalled();
  expect(bridge.submitFrozenJob).not.toHaveBeenCalled();
 });
 it("save barrier failure never sends GPU job and never records pending request",async()=>{

  const bridge={
   state:{status:"connected"},
   assertNoActiveJob:vi.fn(async()=>{}),
   assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>{throw Error("generation_save_barrier_required")}),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("unexpected")}),
   submitFrozenJob:vi.fn(async()=>expectedJob)
  };
  await expect(startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:workflow,
   nodes:[workflow],connections:[],template,instanceId:"comfy-local",
   outputPortIds:["image"]})).rejects.toThrow("generation_save_barrier_required");
  expect(bridge.submitFrozenJob).not.toHaveBeenCalled();

 });
});
