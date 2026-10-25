import {describe,expect,it,vi} from "vitest";
import {CanvasApiError} from "@/features/backend-sync/canvas-api";
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
const fake=vi.hoisted(()=>({
 projects:new Map<string,{id:string;revision:number;document:Record<string,unknown>}>(),
 views:new Map<string,{viewport:{x:number;y:number;k:number};revision:number}>(),
 chats:new Map<string,{sessions:any[];activeChatId:string|null;revision:number}>(),
 methods:[] as string[],
 rejectPatch:false
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
   if(fake.rejectPatch||payload.expectedRevision!==current.revision)
    throw new actual.CanvasApiError("project_revision_conflict",409);
   const updated={...current,document:payload.document,revision:current.revision+1};
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
 it("preserves in-memory dirty draft and reports stale SQLite revision",async()=>{
  fake.rejectPatch=false;
  const id=await useCanvasStore.getState().createProject("Revision check");
  useCanvasStore.getState().updateProject(id,{nodes:[{id:"image-1",type:"image",title:"Local",position:{x:1,y:2},width:200,height:200}]});
  fake.rejectPatch=true;
  await expect(awaitCanvasStorePersistence()).rejects.toThrow("project_revision_conflict");
  expect(useCanvasStore.getState().openProject(id)?.nodes[0].title).toBe("Local");
  await expect(useCanvasStore.getState().loadProject(id)).rejects.toThrow("project_unsaved_local_edits");
  expect(fake.projects.get(id)?.document.nodes).toEqual([]);
 });
});
