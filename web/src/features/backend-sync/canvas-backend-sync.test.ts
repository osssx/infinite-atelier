import {describe,expect,it,vi} from "vitest";
import type {CanvasNodeData} from "@/types/canvas";
import {createCanvasBackendSync,explainBackendSyncError,safeRemoteCanvasMerge,type BackendCanvasGraph} from "./canvas-backend-sync";

const original:BackendCanvasGraph={
 nodes:[{id:"wf-1",type:"comfy:workflow",title:"Workflow",position:{x:0,y:0},width:360,height:260,
  metadata:{comfyPorts:[{id:"generated",label:"Generated",direction:"source",valueKind:"IMAGE"}]}}],
 connections:[]
};
const generated:CanvasNodeData={id:"artifact-1",type:"image",title:"Generated image",
 position:{x:400,y:0},width:420,height:420,
 metadata:{content:"/api/v1/blobs/abcd",status:"success",
 comfyArtifact:{runId:"job-1",artifactId:"artifact-1",workflowNodeId:"wf-1",
  portId:"generated",kind:"image",index:0}}};
const withOutput:BackendCanvasGraph={
 nodes:[...original.nodes,generated],
 connections:[{id:"edge-1",fromNodeId:"wf-1",fromPortId:"generated",
  toNodeId:"artifact-1",toPortId:"comfy-artifact"}]
};
const copy=<T,>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;
type FetchCall={path:string;init?:RequestInit};
class FakeStream {
 readonly listeners:Record<string,((event:MessageEvent<string>)=>void)[]>={};
 onerror:((event:Event)=>void)|null=null;
 closed=false;
 addEventListener(type:string,callback:(event:MessageEvent<string>)=>void){
  (this.listeners[type]??=[]).push(callback);
 }
 close(){this.closed=true}
 send(data:unknown,type="job"){
  this.listeners[type]?.forEach(fn=>fn({data:JSON.stringify(data)} as MessageEvent<string>));
 }
}
function mockBackend({existing=true}={}){
 let project: {id:string;revision:number;document:BackendCanvasGraph&{title?:string}}|null =
  existing?{id:"p1",revision:1,document:copy(original)}:null;
 let cursor=7,replayStatus=200,patches=0,creates=0,authorized=true;
 const calls:FetchCall[]=[];
 const streams:FakeStream[]=[];
 const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,
  headers:{"content-type":"application/json"}});
 const fetcher=vi.fn(async(path:string,init?:RequestInit)=>{
  calls.push({path,init});
  if(path==="/api/v1/session"){
   if(init?.method==="POST"){
    const token=new Headers(init.headers).get("authorization");
    if(token!=="Bearer one-time-token")return json({code:"invalid_bootstrap_token"},401);
    authorized=true;return json({csrfToken:"csrf-local"},201);
   }
   return authorized?json({csrfToken:"csrf-local"}):json({code:"unauthorized"},401);
  }
  if(path==="/api/v1/jobs/snapshot")return json({jobs:[],eventCursor:cursor});
  if(path==="/api/v1/projects"&&(!init?.method||init.method==="GET"))
   return json({projects:project?[{id:project.id,revision:project.revision,
    title:project.id,nodeCount:project.document.nodes.length,
    connectionCount:project.document.connections.length}]:[],eventCursor:cursor});
  if(path.startsWith("/api/v1/events?")||path.startsWith("/api/v1/projects/events?")){
   if(replayStatus===409)return json({code:"event_cursor_expired"},409);
   return new Response("",{status:200,headers:{"content-type":"text/event-stream"}});
  }
  if(path==="/api/v1/projects/p1"&&(!init?.method||init.method==="GET"))
   return project?json(copy(project)):json({code:"project_not_found"},404);
  if(path==="/api/v1/projects"&&init?.method==="POST"){
   creates++;
   if(project)return json({code:"project_id_conflict"},409);
   const value=JSON.parse(init.body as string) as {id:string;document:BackendCanvasGraph};
   project={id:value.id,revision:1,document:copy(value.document)};
   return json(copy(project),201);
  }
  if(path==="/api/v1/projects/p1"&&init?.method==="PATCH"){
   patches++;
   const body=JSON.parse(init.body as string) as {expectedRevision:number;document:BackendCanvasGraph};
   expect(new Headers(init.headers).get("x-atelier-csrf")).toBe("csrf-local");
   if(!project||body.expectedRevision!==project.revision)return json({code:"project_revision_conflict"},409);
   project={id:"p1",revision:project.revision+1,document:copy(body.document)};
   return json(copy(project));
  }
  throw Error("Unexpected API "+path+" "+init?.method);
 });
 const openEventStream=vi.fn((url:string)=>{
  expect(url).toMatch(/^\/api\/v1\/(events|projects\/events)\?after=/);
  const stream=new FakeStream();streams.push(stream);return stream;
 });
 return {
  fetcher,openEventStream,calls,streams,
  get project(){return project},
  set project(value:{id:string;revision:number;document:BackendCanvasGraph&{title?:string}}|null){project=value},
  set cursor(v:number){cursor=v},set replayStatus(v:number){replayStatus=v},
  set authorized(v:boolean){authorized=v},
  get patches(){return patches},get creates(){return creates}
 };
}
const stateWait=async(fn:()=>boolean)=>{
 for(let i=0;i<30;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,2))}
 throw Error("expected async synchronization did not settle");
};
describe("backend canvas sync opt-in, revisions and events",()=>{
 it("shows safe project validation details without exposing node IDs",async()=>{
  const local=copy(original);
  const bridge=createCanvasBackendSync({
   projectId:"p1",getLocalGraph:()=>local,applyRemoteGraph:()=>{},
   fetcher:async(path)=>{
    const response=(status:number,body:unknown)=>new Response(JSON.stringify(body),{
     status,headers:{"content-type":"application/json"}
    });
    if(path==="/api/v1/session")return response(200,{csrfToken:"csrf"});
    if(path==="/api/v1/jobs/snapshot")return response(200,{jobs:[],eventCursor:0});
    if(path==="/api/v1/projects/p1")return response(404,{code:"project_not_found"});
    return response(400,{code:"invalid_project_document",details:{reason:"dangling_connection",connectionIndex:2}});
   }
  });
  await bridge.connect();
  expect(bridge.state.status).toBe("error");
  expect(bridge.state.message).toBe("invalid_project_document:dangling_connection:2");
  expect(explainBackendSyncError(bridge.state.message??"")).toContain("第 3 条连接");
  bridge.disconnect();
 });

 it("invalid or expired bootstrap token explains safe local-terminal renewal",async()=>{
  const local=copy(original);
  const bridge=createCanvasBackendSync({
   projectId:"p1",getLocalGraph:()=>local,applyRemoteGraph:()=>{},
   requestBootstrap:async()=> "expired",
   fetcher:async(_url,init)=>{
    if(init?.method==="POST")return new Response(JSON.stringify({
     code:"invalid_bootstrap_token",message:"invalid_bootstrap_token"
    }),{status:401,headers:{"content-type":"application/json"}});
    return new Response(JSON.stringify({code:"unauthorized"}),{
     status:401,headers:{"content-type":"application/json"}
    });
   }
  });
  await bridge.connect();
  expect(bridge.state.status).toBe("error");
  expect(bridge.state.message).toBe("invalid_bootstrap_token");
  expect(explainBackendSyncError(bridge.state.message??"")).toContain("r");
  expect(explainBackendSyncError(bridge.state.message??"")).toContain("5 分钟");
  bridge.disconnect();
 });

 it("identifies the HTML Vite SPA fallback as a missing backend proxy, not invalid project JSON",async()=>{
  const local=copy(original);
  let bootstrapRequested=false;
  const bridge=createCanvasBackendSync({
   projectId:"p1",getLocalGraph:()=>local,applyRemoteGraph:()=>{},
   fetcher:async()=>new Response("<!doctype html><html><body>Canvas UI</body></html>",{
    status:200,headers:{"content-type":"text/html; charset=utf-8"}
   }),
   requestBootstrap:async()=>{bootstrapRequested=true;return "should-not-be-used"}
  });
  await bridge.connect();
  expect(bridge.state.status).toBe("error");
  expect(bridge.state.message).toBe("backend_proxy_not_configured");
  expect(explainBackendSyncError(bridge.state.message??"")).toContain("ATELIER_BACKEND_URL");
  expect(bootstrapRequested).toBe(false);
  bridge.disconnect();
 });
 it("displays the explicit JSON diagnostic when the Vite proxy is disabled",async()=>{
  const local=copy(original);
  const bridge=createCanvasBackendSync({
   projectId:"p1",getLocalGraph:()=>local,applyRemoteGraph:()=>{},
   fetcher:async()=>new Response(JSON.stringify({code:"backend_proxy_not_configured",
    message:"Set ATELIER_BACKEND_URL"}),{
    status:503,headers:{"content-type":"application/json; charset=utf-8"}
   })
  });
  await bridge.connect();
  expect(bridge.state.status).toBe("error");
  expect(bridge.state.message).toBe("backend_proxy_not_configured");
  bridge.disconnect();
 });

 it("accepts a canonicalized project graph independent of JSON property ordering",()=>{
  const remote=JSON.parse(JSON.stringify(original)) as BackendCanvasGraph;
  const node=remote.nodes[0];
  remote.nodes[0]={width:node.width,position:node.position,metadata:node.metadata,
   id:node.id,type:node.type,title:node.title,height:node.height};
  expect(safeRemoteCanvasMerge(original,remote)).not.toBeNull();
 });
 it("only appends typed artifact outputs; rejects changed source and unrelated edges",()=>{
  expect(safeRemoteCanvasMerge(original,withOutput)?.nodes).toHaveLength(2);
  expect(safeRemoteCanvasMerge(original,{nodes:[{...original.nodes[0],title:"MUTATED"},generated],
   connections:withOutput.connections})).toBeNull();
  expect(safeRemoteCanvasMerge(original,{...withOutput,connections:[]})).toBeNull();
  const unrelated={...withOutput,connections:[...withOutput.connections,{id:"bad",fromNodeId:"wf-1",toNodeId:"wf-1"}]};
  expect(safeRemoteCanvasMerge(original,unrelated)).toBeNull();
 });
 it("requires explicit connect, creates missing project once and PATCHes with If-Match",async()=>{
  const server=mockBackend({existing:false});
  let local=copy(original);
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},
   fetcher:server.fetcher,openEventStream:server.openEventStream,debounceMs:5});
  expect(server.calls).toHaveLength(0);
  await bridge.connect();
  expect(server.creates).toBe(1);
  expect(bridge.state.status).toBe("connected");
  local={...local,nodes:[{...local.nodes[0],title:"Edited"}]};
  bridge.scheduleSave();await bridge.flush();
  expect(server.patches).toBe(1);
  expect(server.project?.revision).toBe(2);
  expect(new Headers(server.calls.find(c=>c.init?.method==="PATCH")?.init?.headers).get("if-match")).toBe('"1"');
  bridge.disconnect();expect(server.streams[0].closed).toBe(true);
 });

 it("one-use browser bootstrap exchanges token once without persisting in project state",async()=>{
  const server=mockBackend();server.authorized=false;
  let local=copy(original);let prompts=0;
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},
   fetcher:server.fetcher,openEventStream:server.openEventStream,
   requestBootstrap:async()=>{prompts++;return "one-time-token"}});
  await bridge.connect();
  expect(bridge.state.status).toBe("connected");
  expect(prompts).toBe(1);
  expect(server.calls.filter(c=>c.path==="/api/v1/session"&&c.init?.method==="POST")).toHaveLength(1);
  expect(JSON.stringify(server.project)).not.toContain("one-time-token");
  bridge.disconnect();
 });
 it("preserves unrelated backend project document properties on PATCH",async()=>{
  const server=mockBackend();
  if(!server.project)throw Error("missing fixture");
  server.project={...server.project,document:Object.assign(copy(original),{settings:{color:"azure"}})};
  let local=copy(original);
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},fetcher:server.fetcher,
   openEventStream:server.openEventStream});
  await bridge.connect();
  local={...local,nodes:[{...local.nodes[0],title:"After"}]};
  bridge.scheduleSave();await bridge.flush();
  expect((server.project?.document as BackendCanvasGraph&{settings:{color:string}}).settings.color).toBe("azure");
  bridge.disconnect();
 });
 it("materialization SSE refreshes remote only for this project, replay deduplicates and preserves user nodes",async()=>{
  const server=mockBackend();
  let local=copy(original),applied=0;
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{applied++;local=copy(graph)},
   fetcher:server.fetcher,openEventStream:server.openEventStream});
  await bridge.connect();
  expect(bridge.state.cursor).toBe(7);
  server.project={id:"p1",revision:2,document:copy(withOutput)};
  server.streams[0].send({eventId:8,jobId:"job-1",kind:"artifact_materialized",
   payload:{projectId:"other"},timestamp:0});
  await Promise.resolve();expect(applied).toBe(0);
  server.streams[0].send({eventId:9,jobId:"job-1",kind:"artifact_materialized",
   payload:{projectId:"p1"},timestamp:0});
  await stateWait(()=>applied===1);
  expect(local.nodes).toHaveLength(2);
  expect(local.connections[0].toPortId).toBe("comfy-artifact");
  expect(bridge.state.revision).toBe(2);
  server.streams[0].send({eventId:9,jobId:"job-1",kind:"artifact_materialized",
   payload:{projectId:"p1"},timestamp:0});
  expect(applied).toBe(1);
  bridge.disconnect();
 });

 it("applies ordinary remote text and node movement on project SSE when local draft is clean",async()=>{
  const server=mockBackend();
  let local=copy(original),applied=0;
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph);applied++},
   fetcher:server.fetcher,openEventStream:server.openEventStream});
  await bridge.connect();
  expect(server.streams).toHaveLength(2);
  const modified=copy(original);
  modified.nodes[0].title="remote user typed this";
  modified.nodes[0].position={x:255,y:190};
  server.project={id:"p1",revision:2,document:modified};
  server.streams[1].send({eventId:8,projectId:"p1",revision:2,kind:"updated",timestamp:0},"project");
  await stateWait(()=>applied===1);
  expect(local.nodes[0].position.x).toBe(255);
  expect(local.nodes[0].title).toBe("remote user typed this");
  expect(bridge.state.revision).toBe(2);
  bridge.disconnect();
 });

 it("syncs project rename and guards a competing local title draft",async()=>{
  const server=mockBackend();
  server.project={id:"p1",revision:1,document:{...copy(original),title:"First"}};
  let title="First",local=copy(original);
  const bridge=createCanvasBackendSync({projectId:"p1",
   getLocalGraph:()=>local,applyRemoteGraph:graph=>{local=copy(graph)},
   getLocalMetadata:()=>({title}),applyRemoteTitle:next=>{title=next},
   fetcher:server.fetcher,openEventStream:server.openEventStream,debounceMs:10000});
  await bridge.connect();
  title="Local rename";
  bridge.scheduleSave();await bridge.flush();
  expect(server.project?.document.title).toBe("Local rename");
  expect(server.project?.revision).toBe(2);
  server.project={id:"p1",revision:3,document:{...copy(original),title:"Other origin rename"}};
  server.streams[1].send({eventId:9,projectId:"p1",revision:3,kind:"updated",timestamp:0},"project");
  await stateWait(()=>title==="Other origin rename");
  expect(bridge.state.revision).toBe(3);
  title="Local unsaved rename";
  server.project={id:"p1",revision:4,document:{...copy(original),title:"Remote again"}};
  server.streams[1].send({eventId:10,projectId:"p1",revision:4,kind:"updated",timestamp:0},"project");
  await stateWait(()=>bridge.state.status==="conflict");
  expect(title).toBe("Local unsaved rename");
  bridge.disconnect();
 });
 it("incoming project edit preserves a dirty local draft with explicit revision conflict",async()=>{
  const server=mockBackend();
  let local=copy(original);
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},fetcher:server.fetcher,
   openEventStream:server.openEventStream,debounceMs:10000});
  await bridge.connect();
  local.nodes[0]={...local.nodes[0],title:"my offline edit"};
  const remote=copy(original);
  remote.nodes[0].title="other origin edit";
  server.project={id:"p1",revision:2,document:remote};
  server.streams[1].send({eventId:8,projectId:"p1",revision:2,kind:"updated",timestamp:0},"project");
  await stateWait(()=>bridge.state.status==="conflict");
  expect(local.nodes[0].title).toBe("my offline edit");
  expect(server.project.document.nodes[0].title).toBe("other origin edit");
  expect(server.patches).toBe(0);
  bridge.disconnect();
 });
 it("does not overwrite dirty local edits when materialization arrives",async()=>{
  const server=mockBackend();
  let local=copy(original);
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},
   fetcher:server.fetcher,openEventStream:server.openEventStream,debounceMs:10000});
  await bridge.connect();
  local={...local,nodes:[{...local.nodes[0],title:"Locally edited"}]};
  server.project={id:"p1",revision:2,document:copy(withOutput)};
  server.streams[0].send({eventId:8,jobId:"job-1",kind:"artifact_materialized",
   payload:{projectId:"p1"},timestamp:0});
  await stateWait(()=>bridge.state.status==="conflict");
  expect(local.nodes).toHaveLength(1);
  expect(local.nodes[0].title).toBe("Locally edited");
  expect(server.patches).toBe(0);
  await bridge.flush();expect(server.patches).toBe(0);
  bridge.disconnect();
 });
 it("409 optimistic edit conflict does not retry or overwrite remote",async()=>{
  const server=mockBackend();
  let local=copy(original);
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},fetcher:server.fetcher,openEventStream:server.openEventStream});
  await bridge.connect();
  server.project={id:"p1",revision:2,document:copy(withOutput)};
  local={...local,nodes:[{...local.nodes[0],title:"User draft"}]};
  bridge.scheduleSave();await bridge.flush();
  expect(bridge.state.status).toBe("conflict");
  expect(local.nodes[0].title).toBe("User draft");
  expect(server.project.document.nodes).toHaveLength(2);
  expect(server.patches).toBe(1);
  await bridge.flush();expect(server.patches).toBe(1);
  bridge.disconnect();
 });
 it("SSE cursor expiry resnapshots and does not lose appended materializations",async()=>{
  const server=mockBackend();
  let local=copy(original);
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},fetcher:server.fetcher,openEventStream:server.openEventStream});
  await bridge.connect();
  server.project={id:"p1",revision:2,document:copy(withOutput)};
  server.cursor=14;server.replayStatus=409;
  await bridge.replay();
  expect(local.nodes).toHaveLength(2);
  expect(bridge.state.cursor).toBe(14);
  expect(bridge.state.status).toBe("connected");
  bridge.disconnect();
 });

 it("explicit conflict resolution preserves independent user edits and appends only trusted output",async()=>{
  const server=mockBackend();
  let local=copy(original);
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},fetcher:server.fetcher,
   openEventStream:server.openEventStream});
  await bridge.connect();
  local.nodes.push({id:"user-note",type:"text",title:"Independent user note",
   position:{x:800,y:0},width:300,height:200,metadata:{content:"my draft"}});
  server.project={id:"p1",revision:2,document:copy(withOutput)};
  server.streams[0].send({eventId:8,jobId:"job-1",kind:"artifact_materialized",
   payload:{projectId:"p1"},timestamp:0});
  await stateWait(()=>bridge.state.status==="conflict");
  const resolved=await bridge.reconcileConflict();
  expect(resolved).toBe(true);
  expect(bridge.state.status).toBe("connected");
  expect(local.nodes.map(n=>n.id)).toEqual(["wf-1","user-note","artifact-1"]);
  expect(local.nodes[1].metadata?.content).toBe("my draft");
  expect(server.project?.revision).toBe(3);
  expect(server.project?.document.connections).toHaveLength(1);
  bridge.disconnect();
 });
 it("reconcile refuses a changed local source and does not overwrite it",async()=>{
  const server=mockBackend();
  let local=copy(original);
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},fetcher:server.fetcher,
   openEventStream:server.openEventStream});
  await bridge.connect();
  local.nodes[0]={...local.nodes[0],title:"Edited workflow"};
  server.project={id:"p1",revision:2,document:copy(withOutput)};
  server.streams[0].send({eventId:8,jobId:"job-1",kind:"artifact_materialized",
   payload:{projectId:"p1"},timestamp:0});
  await stateWait(()=>bridge.state.status==="conflict");
  expect(await bridge.reconcileConflict()).toBe(false);
  expect(server.patches).toBe(0);
  expect(local.nodes[0].title).toBe("Edited workflow");
  bridge.disconnect();
 });

 it("saveProjectNow fences a frozen dirty source with durable revision before generation",async()=>{
  const server=mockBackend();let local=copy(original);
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},fetcher:server.fetcher,openEventStream:server.openEventStream});
  await bridge.connect();
  local={...local,nodes:[{...local.nodes[0],title:"Updated prompt"}]};
  const frozen=copy(local);
  const result=await bridge.saveProjectNow(frozen,"wf-1");
  expect(result.projectId).toBe("p1");
  expect(result.revision).toBe(2);
  expect(result.sourceNodeFingerprint).toHaveLength(64);
  expect(server.project?.document.nodes[0].title).toBe("Updated prompt");
  expect(server.patches).toBe(1);
  bridge.disconnect();
 });
 it("concurrent local changes during asynchronous save block generation",async()=>{
  const server=mockBackend();let local=copy(original);
  let allowPatch:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{allowPatch=resolve});
  const fetcher=async(path:string,init?:RequestInit)=>{
   if(init?.method==="PATCH")await gate;
   return server.fetcher(path,init);
  };
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},fetcher,openEventStream:server.openEventStream});
  await bridge.connect();
  local={...local,nodes:[{...local.nodes[0],title:"First draft"}]};
  const first=copy(local);
  const saving=bridge.saveProjectNow(first,"wf-1");
  await Promise.resolve();
  local={...local,nodes:[{...local.nodes[0],title:"Second draft"}]};
  allowPatch();
  await expect(saving).rejects.toThrow("generation_save_barrier_required");
  expect(local.nodes[0].title).toBe("Second draft");
  expect(server.project?.document.nodes[0].title).toBe("First draft");
  bridge.disconnect();
 });
 it("capabilities reject unconfigured or non-dispatching Comfy instances",async()=>{
  const server=mockBackend();let local=copy(original),ready=false;
  const fetcher=async(path:string,init?:RequestInit)=>{
   if(path==="/api/v1/execution/capabilities")
    return new Response(JSON.stringify({autoDispatch:ready,comfyInstanceIds:["comfy-local"]}),{
     headers:{"content-type":"application/json"}
    });
   return server.fetcher(path,init);
  };
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},fetcher,openEventStream:server.openEventStream});
  await bridge.connect();
  await expect(bridge.assertComfyReady("comfy-local")).rejects.toThrow("backend_comfy_instance_not_ready");
  ready=true;
  await expect(bridge.assertComfyReady("different")).rejects.toThrow("backend_comfy_instance_not_ready");
  await expect(bridge.assertComfyReady("comfy-local")).resolves.toBeUndefined();
  bridge.disconnect();
 });
 it("existing remote mismatches remain untouched and never create a second project",async()=>{
  const server=mockBackend();
  let local=copy(original);
  local.nodes[0].title="local different";
  const bridge=createCanvasBackendSync({projectId:"p1",getLocalGraph:()=>local,
   applyRemoteGraph:graph=>{local=copy(graph)},fetcher:server.fetcher,openEventStream:server.openEventStream});
  await bridge.connect();
  expect(bridge.state.status).toBe("conflict");
  expect(server.patches).toBe(0);
  expect(server.creates).toBe(0);
  expect(server.streams).toHaveLength(0);
  bridge.disconnect();
 });
});
