import {describe,expect,it,vi} from "vitest";
import type {CanvasNodeData} from "@/types/canvas";
import {createCanvasBackendSync,safeRemoteCanvasMerge,type BackendCanvasGraph} from "./canvas-backend-sync";

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
 send(data:unknown){
  this.listeners.job?.forEach(fn=>fn({data:JSON.stringify(data)} as MessageEvent<string>));
 }
}
function mockBackend({existing=true}={}){
 let project: {id:string;revision:number;document:BackendCanvasGraph}|null =
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
  if(path.startsWith("/api/v1/events?")){
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
  expect(url).toContain("/api/v1/events?after=");
  const stream=new FakeStream();streams.push(stream);return stream;
 });
 return {
  fetcher,openEventStream,calls,streams,
  get project(){return project},
  set project(value:{id:string;revision:number;document:BackendCanvasGraph}|null){project=value},
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
