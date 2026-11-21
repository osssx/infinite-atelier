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
import {useCanvasStore,awaitCanvasStorePersistence,commitAssistantCanvasGraphWithSaveBarrier,ensureCreativeNodesLoaded} from "./use-canvas-sqlite-store";

describe("P1a browser autosave conflict safety",()=>{
 it("loads selected creative bodies and their ancestors while preserving unopened payload pointers",async()=>{
  const id="lazy-creative";
  const nodes=["source","assets","other"].map((name,index)=>({id:name,type:"drama:"+(index===0?"source":"assets"),
   title:name,position:{x:index*400,y:0},width:340,height:400,
   metadata:{creativePayloadRef:{nodeId:name,schemaVersion:1 as const}}}));
  let revision=1;
  const paths:string[]=[];
  const document={title:"Lazy",nodes,connections:[{id:"edge",fromNodeId:"source",toNodeId:"assets"}]};
  mock.api.mockImplementation(async(path:string,method="GET")=>{
   if(path.includes("/payload?")){
    paths.push(path);
    const nodeId=new URL(path,"http://localhost").searchParams.get("nodeId");
    return {projectRevision:revision,payload:{dramaDraft:nodeId==="source"?"Story":'{"assets":[]}',content:null}};
   }
   if(method==="PATCH")revision++;
   return {id,revision,document:structuredClone(document)};
  });
  await useCanvasStore.getState().loadProject(id);
  await ensureCreativeNodesLoaded(id,["assets"]);
  const loaded=useCanvasStore.getState().openProject(id)!;
  expect(paths).toHaveLength(2);
  expect(loaded.nodes[0].metadata?.dramaDraft).toBe("Story");
  expect(loaded.nodes[1].metadata?.creativePayloadRef).toBeUndefined();
  expect(loaded.nodes[2].metadata?.creativePayloadRef?.nodeId).toBe("other");
  useCanvasStore.getState().updateProject(id,{nodes:loaded.nodes.map(node=>({...node,position:{...node.position,y:10}}))});
  await awaitCanvasStorePersistence(id);
  expect(useCanvasStore.getState().openProject(id)!.nodes[0].metadata?.dramaDraft).toBe("Story");
  expect(useCanvasStore.getState().openProject(id)!.nodes[2].metadata?.creativePayloadRef?.nodeId).toBe("other");
 });
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
 it("replays an identical Step graph at the same revision without overwriting divergent snapshots",async()=>{
  const remote:{id:string;revision:number;document:{title:string;nodes:{id:string;type:string;title:string}[];connections:unknown[]}}={
   id:"",revision:1,document:{title:"回执重放",nodes:[],connections:[]}};
  mock.api.mockImplementation(async(_path:string,method="GET",payload?:{id?:string;document?:typeof remote.document})=>{
   if(method==="POST"){remote.id=payload!.id!;remote.document=payload!.document!;return {...remote};}
   throw Error("unexpected autosave");
  });
  const id=await useCanvasStore.getState().createProject("回执重放");
  const first=await commitAssistantCanvasGraphWithSaveBarrier(id,async()=>({
   ...remote,revision:2,document:{...remote.document,nodes:[{id:"committed",type:"text",title:"已提交"}]}
  }));
  expect(first.revision).toBe(2);
  const replay=await commitAssistantCanvasGraphWithSaveBarrier(id,async()=>({...first}));
  expect(replay.revision).toBe(2);
  await expect(commitAssistantCanvasGraphWithSaveBarrier(id,async()=>({
   ...first,document:{...first.document,nodes:[]}
  }))).rejects.toThrow("assistant_task_graph_response_invalid");
  expect(useCanvasStore.getState().openProject(id)?.nodes.map(node=>node.id)).toEqual(["committed"]);
 });
});

it("rebases a text confirmation over edits made during the save barrier",async()=>{
 type Graph = {title:string;nodes:import("@/types/canvas").CanvasNodeData[];connections:[]};
 let remote={id:"",revision:1,document:{title:"History",nodes:[],connections:[]} as Graph};
 mock.api.mockImplementation(async(_path:string,method="GET",payload?:{id?:string;document?:Graph;expectedRevision?:number})=>{
  if(method==="POST"){remote={id:payload!.id!,revision:1,document:payload!.document!};return remote;}
  if(method==="PATCH"){
   expect(payload!.expectedRevision).toBe(remote.revision);
   remote={...remote,revision:remote.revision+1,document:payload!.document!};
   return remote;
  }
  throw Error("unexpected "+method);
 });
 const id=await useCanvasStore.getState().createProject("History");
 const story={id:"story",type:"drama:source" as const,title:"Story",position:{x:0,y:0},width:300,height:200,
  metadata:{content:"first",dramaDraft:"first"}};
 useCanvasStore.getState().updateProject(id,{nodes:[story]});
 await commitAssistantCanvasGraphWithSaveBarrier(id,async frozen=>{
  const newer={...story,metadata:{content:"second",dramaDraft:"second",dramaFilmStyle:"ink"}};
  useCanvasStore.getState().updateProject(id,{nodes:[newer]});
  remote={...remote,revision:frozen.expectedRevision+1,document:{...remote.document,
   nodes:[{...story,metadata:{...story.metadata,dramaConfirmed:"first",dramaStage:"source"}}]}};
  return remote;
 },{textVersionNodeId:"story"});
 await awaitCanvasStorePersistence(id);
 expect(remote.document.nodes[0].metadata).toEqual({
  content:"second",dramaDraft:"second",dramaFilmStyle:"ink",dramaConfirmed:"first",dramaStage:"source"
 });
});
