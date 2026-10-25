import {describe,expect,it,vi} from "vitest";
import type {CanvasNodeData,CanvasConnection} from "@/types/canvas";
import type {ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";
import {startBackendComfyWorkflowRun,backendPendingKey,backendLastJobKey,assertNoActiveBackendComfyJob} from "./backend-comfy-run";
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
function pendingStorage(){
 const values=new Map<string,string>();
 return {
  values,
  getItem:(key:string)=>values.get(key)??null,
  setItem:(key:string,value:string)=>{values.set(key,value)},
  removeItem:(key:string)=>{values.delete(key)}
 };
}
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
  expect(hash).not.toBe(await fingerprintBackendSource({...graph,nodes:graph.nodes.map(n=>n.id==="scalar"?{...n,title:"new"}:n)},"wf-1"));
  expect(canonicalBackendGraph(graph)).toContain('"nodes"');
  await expect(fingerprintBackendSource({...graph,connections:[...connections,{id:"three",fromNodeId:"wf-1",toNodeId:"scalar"}]},"wf-1"))
   .rejects.toThrow("cyclic_generation_source");
 });
 it("text-only workflow freezes graph and saves project before POST; no legacy gateway",async()=>{
  const calls:string[]=[];const pending=pendingStorage();
  const bridge={
   state:{status:"connected"},
   assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>{calls.push("save");return {projectId:"p1",revision:4,
    sourceNodeFingerprint:"fence-4"}}),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("unexpected asset")}),
   submitFrozenJob:vi.fn(async(payload:Record<string,unknown>)=>{
    calls.push("submit");
    expect(payload.expectedProjectRevision).toBe(4);
    expect(payload.sourceNodeFingerprint).toBe("fence-4");
    expect((payload.snapshot as any).comfyRequest.externalInputs).toEqual([]);
    expect(pending.values.size).toBe(1);
    return expectedJob;
   })
  };
  const result=await startBackendComfyWorkflowRun({
   bridge,projectId:"p1",workflowNode:workflow,
   nodes:[workflow],connections:[],template,instanceId:"comfy-local",
   outputPortIds:["image"],pending,newKey:()=> "immutable-click"
  });
  expect(result.id).toBe("new-job");
  expect(calls).toEqual(["save","submit"]);
  expect(pending.getItem(backendPendingKey("p1","wf-1"))).toBeNull();
  expect(bridge.submitFrozenJob).toHaveBeenCalledTimes(1);
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
  const pending=pendingStorage();
  await startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:workflow,
   nodes:[photo,workflow],connections:[{id:"edge",fromNodeId:"photo",fromPortId:"image",toNodeId:"wf-1",toPortId:"source"}],
   template:inputTemplate,instanceId:"comfy-local",outputPortIds:["image"],pending,
   readBlob:async()=>new Blob(["DATA"],{type:"image/png"}),newKey:()=> "immutable-click"
  });
  expect(order).toEqual(["upload","save","post"]);
  expect(bridge.uploadFrozenBlob).toHaveBeenCalledTimes(1);
  registerCanvasPortResolver("comfy:workflow");
 });
 it("lost POST response preserves exact payload and replays same idempotency key without new staging",async()=>{
  const pending=pendingStorage();let calls=0;
  const bridge={
   state:{status:"connected"},
   assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>({projectId:"p1",revision:1,sourceNodeFingerprint:"fence"})),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("unexpected")}),
   submitFrozenJob:vi.fn(async(payload:Record<string,unknown>)=>{
    calls++;
    if(calls===1)throw Error("network lost after server accepted POST");
    expect(payload.idempotencyKey).toBe("stable-click");
    expect(payload.requestFingerprint).toBe("stable-click");
    return expectedJob;
   })
  };
  const args={bridge,projectId:"p1",workflowNode:workflow,nodes:[workflow],
   connections:[],template,instanceId:"comfy-local",outputPortIds:["image"],pending,
   newKey:()=> "stable-click"};
  await expect(startBackendComfyWorkflowRun(args)).rejects.toThrow("network lost");
  const frozen=pending.getItem(backendPendingKey("p1","wf-1"));
  expect(frozen).toContain("stable-click");
  await startBackendComfyWorkflowRun(args);
  expect(bridge.submitFrozenJob.mock.calls[0][0]).toEqual(bridge.submitFrozenJob.mock.calls[1][0]);
  expect(bridge.saveProjectNow).toHaveBeenCalledTimes(1);
  expect(pending.getItem(backendPendingKey("p1","wf-1"))).toBeNull();
 });

 it("cross-executor guard blocks known active, ambiguous or unreadable backend jobs",async()=>{
  const storage=pendingStorage();
  const id="active-1";storage.setItem(backendLastJobKey("p1","wf-1"),id);
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({status:"running"})));
  await expect(assertNoActiveBackendComfyJob("p1","wf-1",{storage,fetcher}))
   .rejects.toThrow("backend_prior_job_not_terminal");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const terminal=vi.fn(async()=>new Response(JSON.stringify({status:"succeeded"})));
  await expect(assertNoActiveBackendComfyJob("p1","wf-1",{storage,fetcher:terminal}))
   .resolves.toBeUndefined();
  const missing=vi.fn(async()=>new Response("",{status:404}));
  await expect(assertNoActiveBackendComfyJob("p1","wf-1",{storage,fetcher:missing}))
   .rejects.toThrow("backend_prior_job_status_unknown");
  const lost=vi.fn(async():Promise<Response>=>{throw Error("network down")});
  await expect(assertNoActiveBackendComfyJob("p1","wf-1",{storage,fetcher:lost}))
   .rejects.toThrow("backend_prior_job_status_unknown");
  storage.removeItem(backendLastJobKey("p1","wf-1"));
  await assertNoActiveBackendComfyJob("p1","wf-1",{storage,fetcher});
  storage.setItem(backendPendingKey("p1","wf-1"),'{"idempotencyKey":"uncertain"}');
  await expect(assertNoActiveBackendComfyJob("p1","wf-1",{storage,fetcher}))
   .rejects.toThrow("backend_submission_pending_unknown");
  storage.removeItem(backendPendingKey("p1","wf-1"));
  await assertNoActiveBackendComfyJob("p1","wf-1",{storage,fetcher});
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it("save barrier failure never sends GPU job and never records pending request",async()=>{
  const pending=pendingStorage();
  const bridge={
   state:{status:"connected"},
   assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>{throw Error("generation_save_barrier_required")}),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("unexpected")}),
   submitFrozenJob:vi.fn(async()=>expectedJob)
  };
  await expect(startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:workflow,
   nodes:[workflow],connections:[],template,instanceId:"comfy-local",
   outputPortIds:["image"],pending})).rejects.toThrow("generation_save_barrier_required");
  expect(bridge.submitFrozenJob).not.toHaveBeenCalled();
  expect(pending.values.size).toBe(0);
 });
});
