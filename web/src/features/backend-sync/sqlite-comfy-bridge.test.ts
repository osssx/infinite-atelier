import {afterEach,describe,expect,it,vi} from "vitest";
import {canonicalBackendGraph,fingerprintBackendSource} from "./backend-source-fingerprint";
import type {CanvasNodeData} from "@/types/canvas";
import type {BackendCanvasGraph} from "./canvas-backend-sync";
const h=vi.hoisted(()=>({
 flush:vi.fn(async()=>{}),
 updates:[] as unknown[],
 remote:null as unknown,
 project:{nodes:[],connections:[]} as {nodes:unknown[];connections:unknown[]},
 adopt:vi.fn(),
 api:vi.fn(),
 session:vi.fn(async()=>"csrf-test")
}));
vi.mock("@/stores/canvas/use-canvas-store",()=>({
 awaitCanvasStorePersistence:h.flush,
 useCanvasStore:{getState:()=>({
  openProject:()=>h.project,
  updateProject:(_id:string,patch:unknown)=>{h.updates.push(patch)},
  adoptMaterializedGraph:h.adopt
 })}
}));
import {createSqliteComfyBridge} from "./sqlite-comfy-bridge";
import {refreshSqliteComfyArtifacts,watchSqliteComfyJob} from "./sqlite-comfy-job-watch";
import {startBackendComfyWorkflowRun} from "./backend-comfy-run";
import type {ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";
const node:CanvasNodeData={id:"wf",type:"comfy:workflow",title:"Workflow",position:{x:0,y:0},width:350,height:200,
 metadata:{comfyPorts:[{id:"output",label:"Output",direction:"source",valueKind:"IMAGE"}]}};
const graph:BackendCanvasGraph={nodes:[node],connections:[]};
const imageSource:CanvasNodeData={id:"image-source",type:"image",title:"Reference image",
 position:{x:0,y:0},width:420,height:420,metadata:{status:"idle",content:""}};
const imageBase:BackendCanvasGraph={nodes:[imageSource],connections:[]};
const project=(revision:number,nodes:unknown[]=graph.nodes,connections:unknown[]=[])=>({
 id:"p1",revision,document:{title:"test",nodes,connections}
});
function materializedModelGraph(ids=["model-a","model-b","model-c"]):BackendCanvasGraph{
 const artifacts:CanvasNodeData[]=ids.map((artifactId,index)=>({
  id:"artifact-"+artifactId,type:"image",title:"Generated image "+index,
  position:{x:420,y:index*440},width:420,height:420,
  metadata:{content:"/api/v1/blobs/"+String(index+1).repeat(64),
   storageKey:"cas:"+String(index+1).repeat(64),mimeType:"image/png",status:"success",
   modelArtifact:{jobId:"job1",artifactId,sourceNodeId:imageSource.id,kind:"image",model:"gpt-image-2"}}
 }));
 return {nodes:[imageSource,...artifacts],connections:ids.map((artifactId,index)=>({
  id:"artifact-edge-"+artifactId,fromNodeId:imageSource.id,toNodeId:"artifact-"+artifactId
 }))};
}
describe("P4 SQLite-only Comfy generation bridge",()=>{
 afterEach(()=>{vi.clearAllMocks();h.project=graph;h.remote=null;h.updates.length=0;vi.unstubAllGlobals()});
 it("persists a frozen graph before submitting and verifies saved revision and source fingerprint",async()=>{
  const calls:string[]=[];
  h.api.mockImplementation(async(path:string,method="GET",payload?:unknown)=>{
   calls.push(method+" "+path);
   if(path==="/api/v1/projects/p1")return project(9);
   if(path==="/api/v1/jobs")return {id:"job1",status:"queued",projectId:"p1"};
   if(path==="/api/v1/execution/capabilities")
    return {autoDispatch:true,comfyInstanceIds:["local-comfy"]};
   throw Error("unexpected");
  });
  let local=graph;
  const bridge=createSqliteComfyBridge({projectId:"p1",getLocalGraph:()=>local,api:h.api,session:h.session});
  await bridge.assertComfyReady("local-comfy");
  const fence=await bridge.saveProjectNow(graph,"wf");
  expect(fence).toEqual({projectId:"p1",revision:9,
   sourceNodeFingerprint:await fingerprintBackendSource(graph,"wf")});
  expect(h.flush).toHaveBeenCalledOnce();
  expect(h.updates).toHaveLength(1);
  expect((h.updates[0] as any).nodes).toEqual(graph.nodes);
  expect(await bridge.submitFrozenJob({idempotencyKey:"unique",snapshot:{}}))
   .toMatchObject({id:"job1"});
  expect(calls).toEqual(["GET /api/v1/execution/capabilities",
   "GET /api/v1/projects/p1","POST /api/v1/jobs"]);
  local={nodes:[{...node,title:"changed"}],connections:[]};
  await expect(bridge.saveProjectNow(graph,"wf")).rejects.toThrow("generation_draft_changed");
 });
 it("connects the ordinary workflow producer directly to saved SQLite graph and /jobs",async()=>{
  const steps:string[]=[];
  let submitted:Record<string,unknown>|undefined;
  h.api.mockImplementation(async(path:string,method="GET",payload?:unknown)=>{
   steps.push(method+" "+path);
   if(path==="/api/v1/execution/capabilities")
    return {autoDispatch:true,comfyInstanceIds:["local-comfy"]};
   if(path==="/api/v1/jobs/snapshot")return {jobs:[]};
   if(path==="/api/v1/projects/p1")return project(12);
   if(path==="/api/v1/jobs"){
    submitted=payload as Record<string,unknown>;
    return {id:"accepted-task",status:"queued",projectId:"p1"};
   }
   throw Error("unexpected path "+path);
  });
  const template={
   id:"demo",revision:"r1",name:"demo",
   apiGraph:{"1":{class_type:"SolidImage",inputs:{}}},
   requirements:{classTypes:["SolidImage"]},
   ports:[{id:"output",label:"Output",direction:"source",valueKind:"IMAGE",
    outputBinding:{nodeId:"1",outputIndex:0},
    capture:{kind:"image",adapterId:"SaveImage"}}]
  } as ComfyWorkflowTemplate;
  const graphWithBinding:BackendCanvasGraph={nodes:[{
   ...node,metadata:{...node.metadata,
    comfyWorkflow:{templateId:"demo",templateRevision:"r1",bindingState:"bound",inputOverrides:{}}}
  }],connections:[]};
  h.api.mockImplementation(async(path:string,method="GET",payload?:unknown)=>{
   steps.push(method+" "+path);
   if(path==="/api/v1/execution/capabilities")
    return {autoDispatch:true,comfyInstanceIds:["local-comfy"]};
   if(path==="/api/v1/jobs/snapshot")return {jobs:[]};
   if(path==="/api/v1/projects/p1")return project(12,graphWithBinding.nodes);
   if(path==="/api/v1/jobs"){
    submitted=payload as Record<string,unknown>;
    return {id:"accepted-task",status:"queued",projectId:"p1"};
   }
   throw Error("unexpected "+path);
  });
  const bridge=createSqliteComfyBridge({
   projectId:"p1",getLocalGraph:()=>graphWithBinding,api:h.api,session:h.session
  });
  const run=await startBackendComfyWorkflowRun({
   bridge,projectId:"p1",workflowNode:graphWithBinding.nodes[0],
   ...graphWithBinding,template,instanceId:"local-comfy",
   outputPortIds:["output"],newKey:()=> "frozen-key"
  });
  expect(run.id).toBe("accepted-task");
  expect(submitted).toMatchObject({expectedProjectRevision:12,targetNodeId:"wf",
   idempotencyKey:"frozen-key",requestFingerprint:"frozen-key",
   sourceNodeFingerprint:await fingerprintBackendSource(graphWithBinding,"wf"),
   snapshot:{adapterKind:"comfy",comfyRequest:{canvasRevision:"12",instanceId:"local-comfy"}}
  });
  expect(steps).toEqual(["GET /api/v1/execution/capabilities",
   "GET /api/v1/jobs/snapshot","GET /api/v1/projects/p1","POST /api/v1/jobs"]);
  expect(submitted).toBeDefined();
 });
 it("refuses duplicate SQLite workflow while a prior accepted job is active",async()=>{
  h.api.mockImplementation(async(path:string)=>{
   if(path==="/api/v1/jobs/snapshot")return {jobs:[{
    id:"running",projectId:"p1",targetNodeId:"wf",status:"submission_unknown"
   }]};
   if(path==="/api/v1/execution/capabilities")
    return {autoDispatch:true,comfyInstanceIds:["local-comfy"]};
   throw Error("unexpected "+path);
  });
  const bridge=createSqliteComfyBridge({projectId:"p1",getLocalGraph:()=>graph,api:h.api});
  await expect(bridge.assertNoActiveJob("wf")).rejects.toThrow("backend_prior_job_not_terminal");
  expect(h.flush).not.toHaveBeenCalled();
  expect(h.updates).toHaveLength(0);
 });
 it("fails closed if local graph changes during the async SQLite flush",async()=>{
  let local={nodes:[node],connections:[]};
  h.flush.mockImplementationOnce(async()=>{
   local={nodes:[{...node,title:"edited during save"}],connections:[]};
  });
  const bridge=createSqliteComfyBridge({projectId:"p1",getLocalGraph:()=>local,api:h.api});
  await expect(bridge.saveProjectNow(graph,"wf")).rejects.toThrow("generation_draft_changed");
  expect(h.api).not.toHaveBeenCalled();
 });
 it("rejects unsaved/mismatched remote source snapshots",async()=>{
  h.api.mockResolvedValue(project(8,[{...node,title:"other"}]));
  const bridge=createSqliteComfyBridge({projectId:"p1",getLocalGraph:()=>graph,api:h.api});
  await expect(bridge.saveProjectNow(graph,"wf")).rejects.toThrow("generation_save_barrier_required");
 });
 it("uploads a frozen Blob with CSRF and refuses inconsistent digest responses",async()=>{
  const buf=new Blob(["blob"],{type:"image/png"});
  const digest="a".repeat(64);
  vi.stubGlobal("fetch",vi.fn(async(_path:string,options:RequestInit)=>{
   expect(options.headers).toMatchObject({"x-atelier-csrf":"csrf-test",
    "x-atelier-mime":"image/png"});
   return new Response(JSON.stringify({blobId:digest,sha256:digest,mimeType:"image/png",
    byteSize:buf.size,existing:false}),{status:201,headers:{"content-type":"application/json"}});
  }));
  const bridge=createSqliteComfyBridge({projectId:"p1",getLocalGraph:()=>graph,api:h.api,session:h.session});
  expect(await bridge.uploadFrozenBlob(buf,"image/png")).toMatchObject({blobId:digest});
  await expect(bridge.uploadFrozenBlob(buf,"image/gif")).rejects.toThrow("unsupported_blob_mime");
 });
 it("only accepts materialization if it can advance SQLite revision without clobbering local edits",async()=>{
  const artifact={id:"artifact-one",type:"image",title:"Generated image",metadata:{
   comfyArtifact:{artifactId:"a1",workflowNodeId:"wf",portId:"output",kind:"image"}}
  };
  const edge={id:"edge",fromNodeId:"wf",fromPortId:"output",toNodeId:"artifact-one",toPortId:"comfy-artifact"};
  const get=vi.fn(()=>graph),apply=vi.fn();
  h.adopt.mockImplementation((_id:string,_expected:unknown,value:ReturnType<typeof project>)=>{
   h.project={nodes:value.document.nodes,connections:value.document.connections};return true;
  });
  h.project={nodes:graph.nodes,connections:graph.connections};
  h.api.mockResolvedValue(project(2,[...graph.nodes,artifact],[edge]));
  expect(await refreshSqliteComfyArtifacts({projectId:"p1",getLocalGraph:get,applyGraph:apply,api:h.api})).toBe("changed");
  expect(apply).toHaveBeenCalledOnce();
  expect(h.adopt).toHaveBeenCalledOnce();
  h.adopt.mockReturnValue(false);h.project={nodes:graph.nodes,connections:graph.connections};apply.mockClear();
  expect(await refreshSqliteComfyArtifacts({projectId:"p1",getLocalGraph:get,applyGraph:apply,api:h.api})).toBe("conflict");
  expect(apply).not.toHaveBeenCalled();
 });
 it("accepts artifacts appended by the save flush and keeps the page graph already synchronized",async()=>{
  const outputs=materializedModelGraph();
  let pageGraph:BackendCanvasGraph=imageBase;
  h.project={nodes:imageBase.nodes,connections:imageBase.connections};
  h.flush.mockImplementationOnce(async()=>{
   // Mirrors saveProject → appendSavedOutputs → savedGraphListeners.
   pageGraph=outputs;
   h.project={nodes:outputs.nodes,connections:outputs.connections};
  });
  h.api.mockResolvedValue(project(12,outputs.nodes,outputs.connections));
  const apply=vi.fn((value:BackendCanvasGraph)=>{pageGraph=value});
  expect(await refreshSqliteComfyArtifacts({projectId:"p1",getLocalGraph:()=>pageGraph,
   applyGraph:apply,api:h.api})).toBe("unchanged");
  expect(pageGraph.nodes.filter(item=>item.metadata?.modelArtifact).map(item=>item.id))
   .toEqual(["artifact-model-a","artifact-model-b","artifact-model-c"]);
  expect(pageGraph.connections).toHaveLength(3);
  expect(apply).not.toHaveBeenCalled();
  expect(h.adopt).not.toHaveBeenCalled();
  expect(await refreshSqliteComfyArtifacts({projectId:"p1",getLocalGraph:()=>pageGraph,
   applyGraph:apply,api:h.api})).toBe("unchanged");
  expect(pageGraph.nodes.filter(item=>item.metadata?.modelArtifact)).toHaveLength(3);
 });
 it("applies an already-adopted Store graph when the React page ref is stale",async()=>{
  const outputs=materializedModelGraph();
  let pageGraph:BackendCanvasGraph=imageBase;
  h.project={nodes:outputs.nodes,connections:outputs.connections};
  h.api.mockResolvedValue(project(12,outputs.nodes,outputs.connections));
  const apply=vi.fn((value:BackendCanvasGraph)=>{pageGraph=value});
  expect(await refreshSqliteComfyArtifacts({projectId:"p1",getLocalGraph:()=>pageGraph,
   applyGraph:apply,api:h.api})).toBe("changed");
  expect(pageGraph.nodes.filter(item=>item.metadata?.modelArtifact)).toHaveLength(3);
  expect(pageGraph.connections).toHaveLength(3);
  expect(apply).toHaveBeenCalledOnce();
  expect(h.adopt).not.toHaveBeenCalled();
 });
 it("still conflicts if source metadata or position changes during persistence or the HTTP read",async()=>{
  const outputs=materializedModelGraph();
  let pageGraph:BackendCanvasGraph=graph;
  h.flush.mockImplementationOnce(async()=>{
   pageGraph={nodes:[{...node,title:"User edit"}],connections:[]};
  });
  h.api.mockResolvedValue(project(2,outputs.nodes,outputs.connections));
  const apply=vi.fn();
  expect(await refreshSqliteComfyArtifacts({projectId:"p1",getLocalGraph:()=>pageGraph,
   applyGraph:apply,api:h.api})).toBe("conflict");
  expect(h.api).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();

  pageGraph=imageBase;
  h.project={nodes:imageBase.nodes,connections:imageBase.connections};
  h.flush.mockImplementationOnce(async()=>{});
  h.api.mockImplementationOnce(async()=>{
   pageGraph={nodes:[{...imageSource,position:{x:10,y:0}}],connections:[]};
   return project(2,outputs.nodes,outputs.connections);
  });
  expect(await refreshSqliteComfyArtifacts({projectId:"p1",getLocalGraph:()=>pageGraph,
   applyGraph:apply,api:h.api})).toBe("conflict");
  expect(h.api).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
 });
 it("keeps an immutable baseline when the page mutates source objects in place",async()=>{
  const source:CanvasNodeData={...imageSource,position:{...imageSource.position},
   metadata:{...imageSource.metadata}};
  const pageGraph:BackendCanvasGraph={nodes:[source],connections:[]};
  h.project={nodes:[source],connections:[]};
  h.flush.mockImplementationOnce(async()=>{
   source.position.x=10;
   source.metadata!.status="loading";
  });
  const apply=vi.fn();
  expect(await refreshSqliteComfyArtifacts({projectId:"p1",getLocalGraph:()=>pageGraph,
   applyGraph:apply,api:h.api})).toBe("conflict");
  expect(h.api).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
 });
 it("does not treat a source status transition as an artifact-only save merge",async()=>{
  const initial:BackendCanvasGraph={nodes:[{...imageSource,metadata:{status:"loading",content:""}}],connections:[]};
  const outputs=materializedModelGraph();
  let pageGraph:BackendCanvasGraph=initial;
  h.flush.mockImplementationOnce(async()=>{pageGraph=outputs});
  h.api.mockResolvedValue(project(2,outputs.nodes,outputs.connections));
  const apply=vi.fn();
  expect(await refreshSqliteComfyArtifacts({projectId:"p1",getLocalGraph:()=>pageGraph,
   applyGraph:apply,api:h.api})).toBe("conflict");
  expect(h.api).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
 });
 it("rejects colliding materialized node IDs rather than replacing a source",async()=>{
  const collision={...node,id:"artifact-model-a"};
  const local={nodes:[imageSource,collision],connections:[]};
  const remote=materializedModelGraph();
  h.project={nodes:local.nodes,connections:local.connections};
  h.api.mockResolvedValue(project(2,remote.nodes,remote.connections));
  const apply=vi.fn();
  expect(await refreshSqliteComfyArtifacts({projectId:"p1",getLocalGraph:()=>local,
   applyGraph:apply,api:h.api})).toBe("conflict");
  expect(apply).not.toHaveBeenCalled();
  expect(h.adopt).not.toHaveBeenCalled();
 });
 it("treats materializations already present in SQLite Canvas as a successful no-op",async()=>{
  h.project={nodes:imageBase.nodes,connections:imageBase.connections};
  h.api.mockResolvedValue(project(5,imageBase.nodes,imageBase.connections));
  h.adopt.mockReturnValue(false);
  const apply=vi.fn();
  expect(await refreshSqliteComfyArtifacts({projectId:"p1",getLocalGraph:()=>imageBase,
   applyGraph:apply,api:h.api})).toBe("unchanged");
  expect(h.adopt).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
 });
 it("watches a succeeded backend job and invokes artifact refresh once",async()=>{
  const artifact:CanvasNodeData={id:"artifact-a1",type:"image",title:"Generated image",position:{x:400,y:0},width:420,height:420,
   metadata:{comfyArtifact:{runId:"job1",artifactId:"a1",workflowNodeId:"wf",portId:"output",kind:"image",index:0}}};
  const edge={id:"artifact-edge-a1",fromNodeId:"wf",fromPortId:"output",toNodeId:"artifact-a1",toPortId:"comfy-artifact"};
  h.api.mockImplementation(async(path:string)=>{
   if(path.endsWith("/materializations"))return {materializations:[{artifactId:"artifact-one",status:"materialized"}]};
   if(path.endsWith("/job1"))return {id:"job1",projectId:"p1",status:"succeeded"};
   if(path==="/api/v1/projects/p1")return project(2,[...graph.nodes,artifact],[edge]);
   throw Error("unexpected "+path);
  });
  h.adopt.mockImplementation((_id:string,_expected:unknown,value:ReturnType<typeof project>)=>{
   h.project={nodes:value.document.nodes,connections:value.document.connections};return true;
  });
  const status:string[]=[];
  const controller=new AbortController();
  await watchSqliteComfyJob({projectId:"p1",jobId:"job1",signal:controller.signal,
   getLocalGraph:()=>graph,applyGraph:vi.fn(),onStatus:s=>status.push(s),api:h.api,pollMs:1});
  expect(status).toContain("succeeded");
  expect(status).toContain("materialized");
 });
 it("silently observes already materialized history when refresh is unchanged",async()=>{
  h.api.mockImplementation(async(path:string)=>{
   if(path.endsWith("/materializations"))return {materializations:[{artifactId:"artifact-one",status:"materialized"}]};
   if(path.endsWith("/job1"))return {id:"job1",projectId:"p1",status:"succeeded"};
   if(path==="/api/v1/projects/p1")return project(2);
   throw Error("unexpected "+path);
  });
  const status:string[]=[];
  await watchSqliteComfyJob({projectId:"p1",jobId:"job1",signal:new AbortController().signal,
   getLocalGraph:()=>graph,applyGraph:vi.fn(),onStatus:s=>status.push(s),api:h.api,pollMs:1});
  expect(status).toContain("succeeded");
  expect(status).not.toContain("materialized");
  expect(status).not.toContain("needs_refresh");
 });
 it("does not announce a historical succeeded task without materialized artifacts",async()=>{
  const status:string[]=[];
  const controller=new AbortController();
  h.api.mockImplementation(async(path:string)=>{
   if(path.endsWith("/materializations"))return {materializations:[]};
   if(path.endsWith("/job1"))return {id:"job1",projectId:"p1",status:"succeeded"};
   throw Error("unexpected "+path);
  });
  await watchSqliteComfyJob({projectId:"p1",jobId:"job1",signal:controller.signal,
   getLocalGraph:()=>graph,applyGraph:vi.fn(),onStatus:s=>{status.push(s);if(s==="succeeded")controller.abort()},api:h.api,pollMs:1});
  expect(status).toEqual(["succeeded"]);
 });
 it("announces fresh materialization once even when the saved source graph is already synchronized",async()=>{
  let jobReads=0;
  h.api.mockImplementation(async(path:string)=>{
   if(path.endsWith("/materializations"))return {materializations:[{artifactId:"artifact-one",status:"materialized"}]};
   if(path.endsWith("/job1"))return {id:"job1",projectId:"p1",status:++jobReads===1?"running":"succeeded"};
   if(path==="/api/v1/projects/p1")return project(2);
   throw Error("unexpected "+path);
  });
  const status:string[]=[];
  await watchSqliteComfyJob({projectId:"p1",jobId:"job1",signal:new AbortController().signal,
   getLocalGraph:()=>graph,applyGraph:vi.fn(),notifyOnMaterialization:true,
   onStatus:s=>status.push(s),api:h.api,pollMs:1});
  expect(status).toContain("running");
  expect(status).toContain("succeeded");
  expect(status.filter(s=>s==="materialized")).toHaveLength(1);
 });
 it("preserves needs-refresh state without a success toast when local edits block adoption",async()=>{
  let local=graph;
  h.flush.mockImplementationOnce(async()=>{local={nodes:[{...node,title:"local edit"}],connections:[]};});
  h.api.mockImplementation(async(path:string)=>{
   if(path.endsWith("/materializations"))return {materializations:[{artifactId:"artifact-one",status:"materialized"}]};
   if(path.endsWith("/job1"))return {id:"job1",projectId:"p1",status:"succeeded"};
   throw Error("unexpected "+path);
  });
  const status:string[]=[];
  await watchSqliteComfyJob({projectId:"p1",jobId:"job1",signal:new AbortController().signal,
   getLocalGraph:()=>local,applyGraph:vi.fn(),notifyOnMaterialization:true,
   onStatus:s=>status.push(s),api:h.api,pollMs:1});
  expect(status).toContain("needs_refresh");
  expect(status).not.toContain("materialized");
 });
 it("keeps failed and blocked job outcomes observable without a materialization toast",async()=>{
  const failed:string[]=[];
  h.api.mockResolvedValueOnce({id:"job1",projectId:"p1",status:"failed"});
  await watchSqliteComfyJob({projectId:"p1",jobId:"job1",signal:new AbortController().signal,
   getLocalGraph:()=>graph,applyGraph:vi.fn(),onStatus:s=>failed.push(s),api:h.api,pollMs:1});
  expect(failed).toContain("failed");
  const blocked:string[]=[];
  h.api.mockImplementation(async(path:string)=>{
   if(path.endsWith("/materializations"))return {materializations:[{artifactId:"artifact-one",status:"blocked"}]};
   if(path.endsWith("/job1"))return {id:"job1",projectId:"p1",status:"succeeded"};
   throw Error("unexpected "+path);
  });
  await watchSqliteComfyJob({projectId:"p1",jobId:"job1",signal:new AbortController().signal,
   getLocalGraph:()=>graph,applyGraph:vi.fn(),onStatus:s=>blocked.push(s),api:h.api,pollMs:1});
  expect(blocked).toContain("blocked");
  expect(blocked).not.toContain("materialized");
 });
});
