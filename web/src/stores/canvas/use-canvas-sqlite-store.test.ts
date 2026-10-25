import {describe,expect,it,vi} from "vitest";
import {CanvasApiError} from "@/features/backend-sync/canvas-api";
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
const fake=vi.hoisted(()=>({
 projects:new Map<string,{id:string;revision:number;document:Record<string,unknown>}>(),
 methods:[] as string[],
 rejectPatch:false
}));
vi.mock("@/features/backend-sync/canvas-api",async importOriginal=>{
 const actual=await importOriginal<typeof import("@/features/backend-sync/canvas-api")>();
 return {...actual,canvasApi:vi.fn(async(path:string,method="GET",payload?:any)=>{
  fake.methods.push(method+" "+path);
  if(path==="/api/v1/projects"&&method==="GET")return {projects:[...fake.projects.values()].map(project=>({
   id:project.id,title:project.document.title,revision:project.revision,nodeCount:(project.document.nodes as any[]).length,
   connectionCount:(project.document.connections as any[]).length
  }))};
  if(path==="/api/v1/projects"&&method==="POST"){
   const row={id:payload.id,revision:1,document:payload.document};
   fake.projects.set(row.id,row);return row;
  }
  const id=decodeURIComponent(path.split("/").at(-1)!);
  const current=fake.projects.get(id);
  if(!current)throw new actual.CanvasApiError("project_not_found",404);
  if(method==="GET")return current;
  if(method==="DELETE"){fake.projects.delete(id);return {deleted:true}};
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
