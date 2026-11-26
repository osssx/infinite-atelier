// @vitest-environment happy-dom
import {describe,it,expect} from "vitest";
import {createCanvasNode} from "@/lib/canvas/canvas-node-factory";
import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import {buildDramaVideoConfigGraph} from "./drama-video-config";
import {applyDramaVideoConfigReview,reviewDramaVideoConfig} from "./drama-video-config-review";
import {dramaProductionSettingFingerprint} from "./drama-video-production-resolver";
import type {DramaShotProduction,DramaVideoInput} from "./drama-pipeline-media";

const shot={id:"shot",episodeId:"ep",order:1,description:"Forest",durationSec:5,characterVariantIds:[],propIds:[],keyPropIds:[]};
const key=(c:string)=>"cas:"+c.repeat(64);
const sourceFor=(setting:DramaShotProduction)=>createCanvasNode("drama:storyboard",{x:0,y:0},{dramaConfirmed:JSON.stringify({shots:[shot]}),dramaConfirmedVersionId:"v1",dramaShotProduction:{shot:setting}});
const inputFor=(setting:DramaShotProduction,prompt="Old prompt",duration=5,aspectRatio="16:9"):DramaVideoInput=>{
 const target=setting.target;
 if(!target||target.kind==="inherit")throw Error("fixture target");
 const keys=setting.mode==="first_frame"?[setting.firstFrame!]:setting.mode==="first_last_frame"?[setting.firstFrame!,setting.lastFrame!]:[];
 const referenceImages=keys.map((storageKey,index)=>({id:"ref"+index,name:index?"尾帧":"首帧",type:"image/png",dataUrl:"",storageKey}));
 return {shot,prompt,referenceImages,mode:setting.mode,productionSnapshot:{target,prompt,durationSec:duration,aspectRatio,sourceRevisionId:"v1",settingFingerprint:dramaProductionSettingFingerprint(setting),promptSourceFingerprint:"source",manualPrompt:!!setting.promptOverride},
 ...(target.kind==="comfy"?{comfyBinding:{templateId:target.templateId,templateRevision:target.templateRevision,mediaMode:setting.mode,
 overrides:{duration,ratio:aspectRatio},slots:Object.fromEntries(referenceImages.map((ref,i)=>[i?"closing":"opening",{nodeId:ref.id}]))},comfyParameterPorts:{duration_seconds:"duration",aspect_ratio:"ratio"}}:{})};
};
const comfy:DramaShotProduction={mode:"first_frame",firstFrame:key("a"),target:{kind:"comfy",templateId:"wf",templateRevision:"r1"}};
const online:DramaShotProduction={mode:"text_to_video",target:{kind:"online",modelOption:"channel::video"}};
const fixture=(setting=comfy)=>{
 const source=sourceFor(setting),input=inputFor(setting);
 const graph=buildDramaVideoConfigGraph(source,[input],[source],[]);
 const id=graph.configIds[0],config=graph.nodes.find(n=>n.id===id)!;
 return {source,graph,id,config};
};
const find=(nodes:CanvasNodeData[],id:string)=>nodes.find(n=>n.id===id)!;
const update=(f:ReturnType<typeof fixture>,setting:DramaShotProduction,input:DramaVideoInput,fields:Partial<{prompt:boolean;duration:boolean;aspect:boolean;references:boolean;overwrite:boolean}>={},nodes=f.graph.nodes,edges=f.graph.connections)=>{
 const source={...f.source,metadata:{...f.source.metadata,dramaShotProduction:{shot:setting}}};
 const live=nodes.map(n=>n.id===source.id?source:n);
 const review=reviewDramaVideoConfig(find(live,f.id),input,live,edges);
 return applyDramaVideoConfigReview(source,input,f.id,live,edges,{prompt:false,duration:false,overwrite:false,...fields,expectedReview:review.token});
};
describe("P5 reviewed video config updates",()=>{
 it("updates only the audited manual prompt, preserving existing binding, node identity and media references",()=>{
  const f=fixture(),setting={...comfy,promptOverride:{text:"New manual",sourceFingerprint:"source"}},input=inputFor(setting,"New manual");
  const before=structuredClone(f.config.metadata);
  const result=update(f,setting,input,{prompt:true});
  const m=find(result.nodes,f.id).metadata!;
  expect(m.prompt).toBe("New manual"+before!.prompt!.slice("Old prompt".length));
  expect(m.composerContent).toBe(m.prompt);
  expect(m.comfyWorkflowSelections).toEqual(before!.comfyWorkflowSelections);
  expect(result.connections).toEqual(f.graph.connections);
  expect(m.dramaVideoSource?.productionSnapshot).toMatchObject({prompt:"New manual",manualPrompt:true,settingFingerprint:""});
  expect(m.dramaVideoSource?.productionSnapshot?.sourceRevisionId).toBeUndefined();
  expect(f.config.metadata).toEqual(before);
 });
 it("updates independent mapped duration and aspect, preserving unselected fields and workflow slots",()=>{
  const f=fixture(),setting={...comfy,durationSec:8,aspectRatio:"9:16"},input=inputFor(setting,"New prompt",8,"9:16");
  const result=update(f,setting,input,{duration:true});
  const m=find(result.nodes,f.id).metadata!;
  expect(m.seconds).toBe("8");expect(m.videoRatio).toBe("16:9");
  expect(m.comfyWorkflowSelections?.video?.overrides).toEqual({duration:8,ratio:"16:9"});
  expect(m.prompt).toBe(f.config.metadata?.prompt);
  expect(m.comfyWorkflowSelections?.video?.slots).toEqual(f.config.metadata?.comfyWorkflowSelections?.video?.slots);
  expect(reviewDramaVideoConfig(find(result.nodes,f.id),input,result.nodes,result.connections)).toMatchObject({executionManual:false,durationChanged:false,aspectChanged:true,promptChanged:true});
 });
 it("switches Comfy to online atomically, preserves downstream and media nodes, removes only managed input edges",()=>{
  const f=fixture(),out=createCanvasNode("video",{x:0,y:0});
  const edges=[...f.graph.connections,{id:"out",fromNodeId:f.id,toNodeId:out.id}];
  const nodes=[...f.graph.nodes,out];
  const input=inputFor(online,"Online prompt");
  expect(()=>update(f,online,input,{prompt:true},nodes,edges)).toThrow("同时更新");
  const result=update(f,online,input,{prompt:true,duration:true,aspect:true,references:true},nodes,edges);
  const m=find(result.nodes,f.id).metadata!;
  expect(m.model).toBe("channel::video");expect(m.comfyWorkflowSelections?.video).toBeUndefined();
  expect(m.videoReferences).toEqual([]);expect(m.prompt).toBe("Online prompt");
  expect(result.connections).toEqual([f.graph.connections[0],edges[edges.length-1]]);
  expect(nodes.every(n=>result.nodes.some(o=>o.id===n.id))).toBe(true);
  expect(reviewDramaVideoConfig(find(result.nodes,f.id),input,result.nodes,result.connections)).toMatchObject({routeChanged:false,promptChanged:false,executionManual:false});
 });
 it("switches online to pinned Comfy and validates typed input mapping without duplicating config",()=>{
  const f=fixture(online),input=inputFor(comfy);
  const result=update(f,comfy,input,{prompt:true,duration:true,aspect:true,references:true});
  const m=find(result.nodes,f.id).metadata!;
  expect(m.model).toBeUndefined();expect(m.comfyWorkflowSelections?.video?.templateRevision).toBe("r1");
  const imageId=m.videoReferences![0].id;
  expect(result.connections).toContainEqual(expect.objectContaining({fromNodeId:imageId,toNodeId:f.id,fromPortId:"image",toPortId:"opening"}));
  expect(result.nodes.filter(n=>n.metadata?.dramaShotId===shot.id)).toHaveLength(1);
 });
 it("rejects manual overwrite without confirmation, stale review and extra manual edges even with overwrite",()=>{
  const f=fixture(),input=inputFor(comfy,"Updated");
  const edited={...f.config,metadata:{...f.config.metadata,prompt:"Human",composerContent:"Human"}};
  const nodes=f.graph.nodes.map(n=>n.id===f.id?edited:n);
  expect(()=>update(f,comfy,input,{prompt:true},nodes)).toThrow("人工修改");
  const ok=update(f,comfy,input,{prompt:true,overwrite:true},nodes);
  expect(find(ok.nodes,f.id).metadata?.prompt).toContain("Updated");
  const review=reviewDramaVideoConfig(f.config,input,f.graph.nodes,f.graph.connections);
  expect(()=>applyDramaVideoConfigReview(f.source,input,f.id,nodes,f.graph.connections,{prompt:true,duration:false,overwrite:true,expectedReview:review.token})).toThrow("重新审核");
  const extra:CanvasConnection={id:"extra",fromNodeId:f.graph.connections[1].fromNodeId,toNodeId:f.id,fromPortId:"image",toPortId:"manual"};
  expect(()=>update(f,online,inputFor(online),{prompt:true,duration:true,aspect:true,references:true,overwrite:true},nodes,[...f.graph.connections,extra])).toThrow("额外人工");
 });
 it("rejects cyclic reference adoption and stale shot production settings, preserves old graph",()=>{
  const f=fixture(online),image=createCanvasNode("image",{x:0,y:0},{storageKey:key("a")});
  const nodes=[...f.graph.nodes,image],edges=[...f.graph.connections,{id:"out",fromNodeId:f.id,toNodeId:image.id}];
  expect(()=>update(f,comfy,inputFor(comfy),{prompt:true,duration:true,aspect:true,references:true,overwrite:true},nodes,edges)).toThrow("循环");
  const input=inputFor(online,"Updated"),review=reviewDramaVideoConfig(f.config,input,f.graph.nodes,f.graph.connections);
  const changed={...f.source,metadata:{...f.source.metadata,dramaShotProduction:{shot:{...online,durationSec:9}}}};
  expect(()=>applyDramaVideoConfigReview(changed,input,f.id,f.graph.nodes,f.graph.connections,{prompt:true,duration:false,overwrite:false,expectedReview:review.token})).toThrow("重新预检");
 });
 it("preserves legacy baseline compatibility and does not infer an unknown workflow",()=>{
  const f=fixture();
  const legacy={...f.config,metadata:{...f.config.metadata,dramaVideoSource:{...f.config.metadata!.dramaVideoSource!,productionBaseline:undefined}}};
  expect(reviewDramaVideoConfig(legacy,inputFor(comfy),f.graph.nodes,f.graph.connections).executionManual).toBe(false);
  const unknown={...legacy,metadata:{...legacy.metadata,dramaVideoSource:{...legacy.metadata.dramaVideoSource,productionSnapshot:undefined}}};
  expect(reviewDramaVideoConfig(unknown,inputFor(comfy),f.graph.nodes,f.graph.connections)).toMatchObject({executionManual:true,routeChanged:true});
 });
});
