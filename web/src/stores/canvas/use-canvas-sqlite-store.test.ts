import {describe,expect,it,vi} from "vitest";
import {CanvasApiError} from "@/features/backend-sync/canvas-api";
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
const fake=vi.hoisted(()=>({
 projects:new Map<string,{id:string;revision:number;document:Record<string,unknown>}>(),
 views:new Map<string,{viewport:{x:number;y:number;k:number};revision:number}>(),
 chats:new Map<string,{sessions:any[];activeChatId:string|null;revision:number}>(),
 methods:[] as string[],
 rejectPatch:false,
 pauseNextPatch:null as Promise<void>|null,
 patchStarted:null as (()=>void)|null
}));
vi.mock("@/features/backend-sync/canvas-api",async importOriginal=>{
 const actual=await importOriginal<typeof import("@/features/backend-sync/canvas-api")>();
 return {...actual,canvasApi:vi.fn(async(path:string,method="GET",payload?:any)=>{
  fake.methods.push(method+" "+path);
  const match=path.match(/^\/api\/v1\/projects\/([^/]+)\/(viewport|chats)$/);
  if(match){
   const id=decodeURIComponent(match[1]),kind=match[2];
   const store=kind==="viewport"?fake.views:fake.chats;
   const current=store.get(id);
   if(!current)throw new actual.CanvasApiError("project_not_found",404);
   if(method==="GET")return current;
   if(method==="PUT"){
    if(payload.expectedRevision!==current.revision)throw new actual.CanvasApiError(kind+"_revision_conflict",409);
    const next={...current,...payload,revision:current.revision+1};
    store.set(id,next as never);return next;
   }
  }

  if(path==="/api/v1/projects"&&method==="GET")return {projects:[...fake.projects.values()].map(project=>({
   id:project.id,title:project.document.title,revision:project.revision,nodeCount:(project.document.nodes as any[]).length,
   connectionCount:(project.document.connections as any[]).length
  }))};
  if(path==="/api/v1/projects"&&method==="POST"){
   const row={id:payload.id,revision:1,document:payload.document};
   fake.projects.set(row.id,row);
   fake.views.set(row.id,{viewport:payload.document.viewport??{x:0,y:0,k:1},revision:1});
   fake.chats.set(row.id,{sessions:payload.document.chatSessions??[],activeChatId:payload.document.activeChatId??null,revision:1});
   return row;

  }
  const id=decodeURIComponent(path.split("/").at(-1)!);
  const current=fake.projects.get(id);
  if(!current)throw new actual.CanvasApiError("project_not_found",404);
  if(method==="GET")return current;
  if(method==="DELETE"){fake.projects.delete(id);fake.views.delete(id);fake.chats.delete(id);return {deleted:true}};
  if(method==="PATCH"){
   const pause=fake.pauseNextPatch;
   if(pause){fake.pauseNextPatch=null;fake.patchStarted?.();await pause;}
   if(fake.rejectPatch)throw new actual.CanvasApiError("save_failed",503);
   const next={...payload.document,nodes:[...payload.document.nodes],
    connections:[...payload.document.connections]};
   if(payload.expectedRevision<current.revision){
    const known=new Set(next.nodes.map((node:any)=>node.id));
    const edges=new Set(next.connections.map((edge:any)=>edge.id));
    const restored=new Set<string>();
    for(const node of current.document.nodes as any[]){
     if(!node.metadata?.comfyArtifact&&!node.metadata?.modelArtifact)continue;
     if(known.has(node.id))continue;
     next.nodes.push(node);known.add(node.id);restored.add(node.id);
    }
    for(const edge of current.document.connections as any[]){
     if(!restored.has(edge.toNodeId)||!known.has(edge.fromNodeId)||edges.has(edge.id))continue;
     next.connections.push(edge);edges.add(edge.id);
    }
   }
   const updated={...current,document:next,revision:current.revision+1};
   fake.projects.set(id,updated);return updated;
  }
  throw Error("unexpected api "+method+" "+path);
 })}
});
import {useCanvasStore,awaitCanvasStorePersistence} from "./use-canvas-store";

describe("SQLite-only Canvas store",()=>{
 it("never loads legacy browser projects and creates, edits, reloads and deletes through backend",async()=>{
  expect(useCanvasStore.getState().hydrated).toBe(false);
  fake.projects.clear();fake.methods.length=0;fake.rejectPatch=false;
  await useCanvasStore.getState().loadProjects();
  expect(useCanvasStore.getState().hydrated).toBe(true);
  expect(useCanvasStore.getState().projects).toEqual([]);
  const id=await useCanvasStore.getState().createProject("SQLite demo");
  expect(fake.projects.get(id)?.document.title).toBe("SQLite demo");
  useCanvasStore.getState().updateProject(id,{nodes:[{
   id:"text-1",type:"text",title:"Text",position:{x:10,y:20},width:250,height:180,metadata:{content:"hello"}
  }]});
  await awaitCanvasStorePersistence();
  expect((fake.projects.get(id)?.document.nodes as any[])[0].metadata.content).toBe("hello");
  expect(fake.projects.get(id)?.revision).toBe(2);
  await useCanvasStore.getState().loadProjects();
  const restored=await useCanvasStore.getState().loadProject(id);
  expect(restored.nodes).toHaveLength(1);
  await useCanvasStore.getState().renameProject(id,"Renamed");
  expect(fake.projects.get(id)?.document.title).toBe("Renamed");
  expect(fake.methods.filter(method=>method==="PATCH /api/v1/projects/"+id)).toHaveLength(2);
  expect(()=>useCanvasStore.getState().replaceProjects([])).toThrow("canvas_legacy_browser_restore_not_supported");
  await useCanvasStore.getState().deleteProjects([id]);
  expect(fake.projects.has(id)).toBe(false);
  expect(useCanvasStore.getState().projects.some(project=>project.id===id)).toBe(false);
 });

 it("does not PUT chats when Canvas hydration replays the unchanged empty []/null selection",async()=>{
  fake.rejectPatch=false;
  const id=await useCanvasStore.getState().createProject("No assistant chat yet");
  fake.methods.length=0;
  useCanvasStore.getState().updateProject(id,{chatSessions:[],activeChatId:null});
  await awaitCanvasStorePersistence(id);
  expect(fake.methods.filter(method=>method==="PUT /api/v1/projects/"+id+"/chats")).toHaveLength(0);
  expect(fake.chats.get(id)).toMatchObject({revision:1,sessions:[],activeChatId:null});
  useCanvasStore.getState().updateProject(id,{chatSessions:[
   {id:"c1",title:"Hello",messages:[],createdAt:"today",updatedAt:"today"}
  ],activeChatId:"c1"});
  await awaitCanvasStorePersistence(id);
  expect(fake.chats.get(id)?.revision).toBe(2);
  fake.methods.length=0;
  const unchanged=useCanvasStore.getState().openProject(id)!;
  useCanvasStore.getState().updateProject(id,{chatSessions:
   JSON.parse(JSON.stringify(unchanged.chatSessions)),activeChatId:unchanged.activeChatId});
  await awaitCanvasStorePersistence(id);
  expect(fake.methods.filter(method=>method==="PUT /api/v1/projects/"+id+"/chats")).toHaveLength(0);
 });
 it("persists rapid viewport and chat edits without graph PATCH or graph revision increments",async()=>{
  fake.rejectPatch=false;fake.methods.length=0;
  const id=await useCanvasStore.getState().createProject("Independent state");
  fake.methods.length=0;
  const chat={id:"c1",title:"Chat",messages:[],createdAt:"today",updatedAt:"today"};
  useCanvasStore.getState().updateProject(id,{viewport:{x:10,y:22,k:1.5}});
  useCanvasStore.getState().updateProject(id,{viewport:{x:20,y:45,k:2}});
  useCanvasStore.getState().updateProject(id,{chatSessions:[chat],activeChatId:"c1"});
  await awaitCanvasStorePersistence();
  expect(fake.views.get(id)).toMatchObject({revision:2,viewport:{x:20,y:45,k:2}});
  expect(fake.chats.get(id)).toMatchObject({revision:2,activeChatId:"c1"});
  expect(fake.projects.get(id)?.revision).toBe(1);
  expect(fake.methods.filter(method=>method==="PATCH /api/v1/projects/"+id)).toHaveLength(0);
  expect(fake.methods.filter(method=>method==="PUT /api/v1/projects/"+id+"/viewport")).toHaveLength(1);
  expect(fake.methods.filter(method=>method==="PUT /api/v1/projects/"+id+"/chats")).toHaveLength(1);
  const reloaded=await useCanvasStore.getState().loadProject(id);
  expect(reloaded.viewport).toEqual({x:20,y:45,k:2});
  expect(reloaded.chatSessions).toHaveLength(1);
  expect(reloaded.activeChatId).toBe("c1");
 });
 it("adopts typed server artifacts without a redundant graph PATCH and preserves local edits on conflict",async()=>{
  fake.rejectPatch=false;fake.methods.length=0;
  const id=await useCanvasStore.getState().createProject("Materialized result");
  const wf={id:"wf",type:"comfy:workflow",title:"Workflow",
   position:{x:0,y:0},width:450,height:220,
   metadata:{comfyPorts:[{id:"output",label:"Output",direction:"source" as const,valueKind:"IMAGE" as const}]}};
  useCanvasStore.getState().updateProject(id,{nodes:[wf]});
  await awaitCanvasStorePersistence();
  const before=useCanvasStore.getState().openProject(id)!;
  const artifact={id:"artifact-one",type:"image",title:"Produced",position:{x:500,y:0},width:420,height:420,
   metadata:{comfyArtifact:{artifactId:"a1",workflowNodeId:"wf",portId:"output",kind:"image"}}};
  const connection={id:"link",fromNodeId:"wf",fromPortId:"output",toNodeId:"artifact-one",toPortId:"comfy-artifact"};
  const current=fake.projects.get(id)!;
  const remote={...current,revision:current.revision+1,
   document:{...current.document,nodes:[wf,artifact],connections:[connection]}};
  fake.projects.set(id,remote);
  fake.methods.length=0;
  const adopted=useCanvasStore.getState().adoptMaterializedGraph(id,
   {nodes:before.nodes,connections:before.connections},remote);
  expect(adopted).toBe(true);
  const after=useCanvasStore.getState().openProject(id)!;
  expect(after.nodes).toHaveLength(2);
  useCanvasStore.getState().updateProject(id,{nodes:after.nodes,connections:after.connections});
  await awaitCanvasStorePersistence();
  expect(fake.methods.filter(path=>path==="PATCH /api/v1/projects/"+id)).toHaveLength(0);
  const changed={...after.nodes[0],title:"Local edit"};
  useCanvasStore.getState().updateProject(id,{nodes:[changed,...after.nodes.slice(1)]});
  const next={...remote,revision:remote.revision+1};
  expect(useCanvasStore.getState().adoptMaterializedGraph(id,
   {nodes:after.nodes,connections:after.connections},next)).toBe(false);
  await awaitCanvasStorePersistence();
  expect(useCanvasStore.getState().openProject(id)?.nodes[0].title).toBe("Local edit");
 });
 it("rebases a locally edited Comfy prompt onto a newly materialized video and saves both",async()=>{
  fake.rejectPatch=false;
  const id=await useCanvasStore.getState().createProject("Concurrent materialization");
  const source={id:"wf",type:"comfy:workflow",title:"Workflow",position:{x:0,y:0},
   width:400,height:260,metadata:{prompt:"original"}};
  useCanvasStore.getState().updateProject(id,{nodes:[source]});
  await awaitCanvasStorePersistence(id);
  const base=fake.projects.get(id)!;
  const artifact={id:"artifact-a1",type:"video",title:"Generated",position:{x:500,y:0},
   width:420,height:236,metadata:{storageKey:"cas:"+"a".repeat(64),
    comfyArtifact:{runId:"job1",artifactId:"a1",workflowNodeId:"wf",portId:"video",kind:"video",index:0}}};
  const edge={id:"artifact-edge-a1",fromNodeId:"wf",fromPortId:"video",
   toNodeId:artifact.id,toPortId:"comfy-artifact"};
  fake.projects.set(id,{...base,revision:base.revision+1,
   document:{...base.document,nodes:[source,artifact],connections:[edge]}});
  useCanvasStore.getState().updateProject(id,{nodes:[{...source,metadata:{prompt:"new prompt"}}]});
  fake.methods.length=0;
  await expect(awaitCanvasStorePersistence(id)).resolves.toBeUndefined();
  const saved=fake.projects.get(id)!;
  expect(saved.revision).toBe(base.revision+2);
  expect((saved.document.nodes as any[])).toHaveLength(2);
  expect((saved.document.nodes as any[])[0].metadata.prompt).toBe("new prompt");
  expect((saved.document.nodes as any[])[1].metadata.comfyArtifact.artifactId).toBe("a1");
  expect(saved.document.connections).toEqual([edge]);
  expect(useCanvasStore.getState().openProject(id)?.nodes).toHaveLength(2);
  expect(fake.methods.filter(call=>call==="PATCH /api/v1/projects/"+id)).toHaveLength(1);
  expect(useCanvasStore.getState().error).toBeNull();
 });
 it("keeps a completed video while a second prompt edit happens during PATCH",async()=>{
  fake.rejectPatch=false;
  const id=await useCanvasStore.getState().createProject("Keep writing while saving");
  const source={id:"source",type:"comfy:workflow",title:"Original",
   position:{x:0,y:0},width:300,height:200,
   metadata:{comfyPorts:[{id:"video",label:"Video",direction:"source" as const,valueKind:"VIDEO" as const}]}};
  useCanvasStore.getState().updateProject(id,{nodes:[source]});
  await awaitCanvasStorePersistence(id);
  const old=fake.projects.get(id)!;
  const output={id:"artifact-new",type:"video",title:"Video",
   position:{x:350,y:0},width:400,height:220,
   metadata:{comfyArtifact:{artifactId:"new",workflowNodeId:"source",
    portId:"video",runId:"job",kind:"video",index:0}}};
  const edge={id:"artifact-edge-new",fromNodeId:"source",fromPortId:"video",
   toNodeId:"artifact-new",toPortId:"comfy-artifact"};
  fake.projects.set(id,{...old,revision:old.revision+1,
   document:{...old.document,nodes:[source,output],connections:[edge]}});
  let release!:()=>void,started!:()=>void;
  fake.pauseNextPatch=new Promise<void>(resolve=>{release=resolve});
  const began=new Promise<void>(resolve=>{started=resolve});
  fake.patchStarted=started;
  useCanvasStore.getState().updateProject(id,{nodes:[{...source,title:"First edit"}]});
  const saving=awaitCanvasStorePersistence(id);
  await began;
  useCanvasStore.getState().updateProject(id,{nodes:[{...source,title:"Second edit"}]});
  release();
  await saving;
  await awaitCanvasStorePersistence(id);
  fake.patchStarted=null;
  const saved=fake.projects.get(id)!.document;
  expect((saved.nodes as any[]).map(node=>node.id)).toEqual(["source","artifact-new"]);
  expect((saved.nodes as any[])[0].title).toBe("Second edit");
  expect(saved.connections).toEqual([edge]);
  expect(useCanvasStore.getState().openProject(id)?.nodes).toHaveLength(2);
 });
 it("preserves a remote detached artifact if its source is locally deleted",async()=>{
  fake.rejectPatch=false;
  const id=await useCanvasStore.getState().createProject("Source removed during generation");
  const source={id:"wf2",type:"comfy:workflow",title:"Workflow",position:{x:0,y:0},width:300,height:200};
  useCanvasStore.getState().updateProject(id,{nodes:[source]});
  await awaitCanvasStorePersistence(id);
  const old=fake.projects.get(id)!;
  const artifact={id:"artifact-a2",type:"image",title:"Generated",
   position:{x:300,y:0},width:400,height:400,metadata:{
    comfyArtifact:{runId:"job2",artifactId:"a2",workflowNodeId:"wf2",portId:"image",kind:"image",index:0}}};
  const link={id:"artifact-edge-a2",fromNodeId:"wf2",fromPortId:"image",
   toNodeId:"artifact-a2",toPortId:"comfy-artifact"};
  fake.projects.set(id,{...old,revision:old.revision+1,
   document:{...old.document,nodes:[source,artifact],connections:[link]}});
  useCanvasStore.getState().updateProject(id,{nodes:[],connections:[]});
  await awaitCanvasStorePersistence(id);
  expect((fake.projects.get(id)!.document.nodes as any[]).map(n=>n.id)).toEqual(["artifact-a2"]);
  expect(fake.projects.get(id)!.document.connections).toEqual([]);
  expect(useCanvasStore.getState().openProject(id)?.nodes.map(n=>n.id)).toEqual(["artifact-a2"]);
 });
 it("single-user saves use the latest local edit without a multi-writer conflict flow",async()=>{
  fake.rejectPatch=false;
  const id=await useCanvasStore.getState().createProject("True concurrent edit");
  const node={id:"txt",type:"text",title:"Base",position:{x:0,y:0},width:300,height:200};
  useCanvasStore.getState().updateProject(id,{nodes:[node]});
  await awaitCanvasStorePersistence(id);
  const previous=fake.projects.get(id)!;
  fake.projects.set(id,{...previous,revision:previous.revision+1,
   document:{...previous.document,nodes:[{...node,title:"Other editor"}]}});
  useCanvasStore.getState().updateProject(id,{nodes:[{...node,title:"My unsaved draft"}]});
  await expect(awaitCanvasStorePersistence(id)).resolves.toBeUndefined();
  expect(useCanvasStore.getState().openProject(id)?.nodes[0].title).toBe("My unsaved draft");
  expect((fake.projects.get(id)!.document.nodes as any[])[0].title).toBe("My unsaved draft");
 });
 it("keeps a valid saved viewport when a zoom calculation produces NaN or Infinity",async()=>{
  fake.rejectPatch=false;
  const id=await useCanvasStore.getState().createProject("Viewport error");
  fake.methods.length=0;
  useCanvasStore.getState().updateProject(id,{viewport:{x:NaN,y:Infinity,k:NaN}});
  await awaitCanvasStorePersistence(id);
  expect(useCanvasStore.getState().openProject(id)?.viewport).toEqual({x:0,y:0,k:1});
  expect(fake.methods.filter(path=>path==="PUT /api/v1/projects/"+id+"/viewport")).toHaveLength(0);
  useCanvasStore.getState().updateProject(id,{viewport:{x:45,y:-13,k:2}});
  await awaitCanvasStorePersistence(id);
  expect(fake.views.get(id)?.viewport).toEqual({x:45,y:-13,k:2});
 });
 it("does not let another project's failed save block this Canvas navigation fence",async()=>{
  fake.rejectPatch=false;
  const old=await useCanvasStore.getState().createProject("Old project");
  useCanvasStore.getState().updateProject(old,{nodes:[{
   id:"old-draft",type:"text",title:"draft",width:200,height:100,position:{x:0,y:0}
  }]});
  fake.rejectPatch=true;
  await expect(awaitCanvasStorePersistence(old)).rejects.toThrow("save_failed");
  fake.rejectPatch=false;
  const current=await useCanvasStore.getState().createProject("Current project");
  useCanvasStore.getState().updateProject(current,{nodes:[{
   id:"saved-current",type:"text",title:"current",width:100,height:100,position:{x:0,y:0}
  }]});
  await expect(awaitCanvasStorePersistence(current)).resolves.toBeUndefined();
  expect((fake.projects.get(current)?.document.nodes as any[])[0].id).toBe("saved-current");
  expect(useCanvasStore.getState().openProject(old)?.nodes[0].id).toBe("old-draft");
  await expect(awaitCanvasStorePersistence(old)).resolves.toBeUndefined();
 });
 it("preserves in-memory dirty draft and reports stale SQLite revision",async()=>{
  fake.rejectPatch=false;
  const id=await useCanvasStore.getState().createProject("Revision check");
  useCanvasStore.getState().updateProject(id,{nodes:[{id:"image-1",type:"image",title:"Local",position:{x:1,y:2},width:200,height:200}]});
  fake.rejectPatch=true;
  await expect(awaitCanvasStorePersistence()).rejects.toThrow("save_failed");
  expect(useCanvasStore.getState().openProject(id)?.nodes[0].title).toBe("Local");
  await expect(useCanvasStore.getState().loadProject(id)).rejects.toThrow("project_unsaved_local_edits");
  expect(fake.projects.get(id)?.document.nodes).toEqual([]);
 });
});
