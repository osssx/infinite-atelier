// @vitest-environment happy-dom
import {describe,it,expect,vi} from "vitest";
const mock=vi.hoisted(()=>({api:vi.fn()}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:mock.api}));
vi.mock("@/features/backend-sync/canvas-state-persistence",()=>({
 createCanvasStatePersistence:()=>({
  hasPending:()=>false,flush:async()=>{},initialize:()=>{},discard:()=>{},
  updateViewport:()=>{},updateChats:()=>{},
  load:async()=>({viewport:{x:0,y:0,k:1},sessions:[],activeChatId:null})
 }),
 preserveValidCanvasViewport:(value:unknown)=>value
}));
import {useCanvasStore,awaitCanvasStorePersistence,commitAssistantCanvasGraphWithSaveBarrier} from "./use-canvas-sqlite-store";

describe("P1a browser autosave conflict safety",()=>{
 it("preserves the local unsaved graph, does not advance the cached revision, and prevents silent reload",async()=>{
  const remote:{id:string;revision:number;document:{title:string;nodes:{id:string;type:string;title:string}[];connections:unknown[]}}={id:"autosave-p1a",revision:1,document:{title:"任务项目",nodes:[],connections:[]}};
  const submissions:unknown[]=[];
  mock.api.mockImplementation(async(path:string,method="GET",payload?:{id?:string;document?:unknown;expectedRevision?:number})=>{
   if(method==="POST"&&path==="/api/v1/projects"){
    remote.id=payload!.id!;remote.revision=1;remote.document=payload!.document as typeof remote.document;
    return {...remote};
   }
   if(method==="PATCH"){
    submissions.push(payload);
    if(payload?.expectedRevision!==remote.revision)throw Error("project_revision_conflict");
    remote.document=payload.document as typeof remote.document;
    remote.revision++;return {...remote};
   }
   if(method==="GET")return {...remote};
   throw Error("unexpected route "+method+" "+path);
  });
  const id=await useCanvasStore.getState().createProject("任务项目");
  const graph=[{id:"local-draft",type:"text",title:"本地未保存的新节点",
   position:{x:0,y:0},width:320,height:200,metadata:{content:"请勿丢弃"}}];
  useCanvasStore.getState().updateProject(id,{nodes:graph as never});
  // The server advances independently while this tab keeps a draft at r1.
  remote.document={...remote.document,nodes:[{id:"server-task-node",type:"text",title:"后端新建节点"}] as never};
  remote.revision=2;
  expect(useCanvasStore.getState().openProject(id)?.nodes.map(node=>node.id)).toEqual(["local-draft"]);
  const result=await awaitCanvasStorePersistence(id).then(()=>({ok:true}),error=>({ok:false,message:String(error)}));
  expect(result.ok).toBe(false);
  const cached=useCanvasStore.getState().openProject(id)!;
  expect(cached.nodes.map(node=>node.id)).toEqual(["local-draft"]);
  expect(cached.nodes[0].metadata?.content).toBe("请勿丢弃");
  expect(useCanvasStore.getState().error).toContain("project_revision_conflict");
  expect(remote.revision).toBe(2);
  expect(remote.document.nodes.map(node=>node.id)).toEqual(["server-task-node"]);
  expect(submissions).toHaveLength(1);
  expect((submissions[0] as {expectedRevision:number}).expectedRevision).toBe(1);
  await expect(useCanvasStore.getState().loadProject(id)).rejects.toThrow("project_unsaved_local_edits");
 });
 it("drains autosaves before freezing a Task mutation and applies the returned authoritative graph",async()=>{
  const remote:{id:string;revision:number;document:{title:string;nodes:{id:string;type:string;title:string}[];connections:unknown[]}}={
   id:"",revision:1,document:{title:"屏障测试",nodes:[],connections:[]}};
  let autosaves=0;
  mock.api.mockImplementation(async(_path:string,method="GET",payload?:{id?:string;document?:typeof remote.document;expectedRevision?:number})=>{
   if(method==="POST"){remote.id=payload!.id!;remote.document=payload!.document!;return {...remote};}
   if(method==="PATCH"){
    autosaves++;
    expect(payload!.expectedRevision).toBe(remote.revision);
    remote.document=payload!.document!;remote.revision++;
    return {...remote};
   }
   throw Error("unexpected");
  });
  const id=await useCanvasStore.getState().createProject("屏障测试");
  useCanvasStore.getState().updateProject(id,{nodes:[{id:"local-before",type:"text",title:"先前编辑"}] as never});
  const committed=await commitAssistantCanvasGraphWithSaveBarrier(id,async frozen=>{
   expect(frozen.expectedRevision).toBe(2);
   expect(frozen.document.nodes.map(node=>node.id)).toEqual(["local-before"]);
   remote.document={...remote.document,nodes:[...remote.document.nodes,{id:"task-added",type:"text",title:"新建任务节点"}]};
   remote.revision=3;
   return {...remote};
  });
  expect(committed.revision).toBe(3);
  expect(autosaves).toBe(1);
  expect(useCanvasStore.getState().openProject(id)?.nodes.map(node=>node.id))
   .toEqual(["local-before","task-added"]);
 });
 it("retains local edits made during the Task barrier instead of submitting a stale PATCH",async()=>{
  const remote:{id:string;revision:number;document:{title:string;nodes:{id:string;type:string;title:string}[];connections:unknown[]}}={
   id:"",revision:1,document:{title:"并发修改",nodes:[],connections:[]}};
  let patches=0;
  mock.api.mockImplementation(async(_path:string,method="GET",payload?:{id?:string;document?:typeof remote.document})=>{
   if(method==="POST"){remote.id=payload!.id!;remote.document=payload!.document!;return {...remote};}
   if(method==="PATCH"){patches++;throw Error("unexpected concurrent autosave");}
   throw Error("unexpected");
  });
  const id=await useCanvasStore.getState().createProject("并发修改");
  await expect(commitAssistantCanvasGraphWithSaveBarrier(id,async frozen=>{
   expect(frozen.expectedRevision).toBe(1);
   useCanvasStore.getState().updateProject(id,{nodes:[{id:"local-during",type:"text",title:"新草稿"}] as never});
   remote.document={...remote.document,nodes:[{id:"task-authoritative",type:"text",title:"服务端"}]};
   remote.revision=2;
   return {...remote};
  })).rejects.toThrow("project_revision_conflict");
  expect(patches).toBe(0);
  expect(useCanvasStore.getState().openProject(id)?.nodes.map(node=>node.id)).toEqual(["local-during"]);
  await expect(useCanvasStore.getState().loadProject(id)).rejects.toThrow("project_unsaved_local_edits");
 });
});
