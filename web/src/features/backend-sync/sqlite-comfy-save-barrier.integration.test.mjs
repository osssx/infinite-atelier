// @vitest-environment happy-dom
import {test,expect,vi} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "../../../server/backend/schema.mjs";
import {createProject,getProject,saveSingleUserCanvas} from "../../../server/backend/projects.mjs";
import {fingerprintSource,submitJob} from "../../../server/backend/repository.mjs";
import {fingerprintBackendSource} from "./backend-source-fingerprint";
const store=vi.hoisted(()=>({project:null,patch:null,flush:vi.fn(async()=>{})}));
vi.mock("@/stores/canvas/use-canvas-store",()=>({
 awaitCanvasStorePersistence:store.flush,
 useCanvasStore:{getState:()=>({
  openProject:()=>store.project,
  updateProject:(_id,patch)=>{store.patch=patch}
 })}
}));
import {createSqliteComfyBridge} from "./sqlite-comfy-bridge";
import {startBackendComfyWorkflowRun} from "./backend-comfy-run";
import {minimaxH3Ref2VBundledTemplate,MINIMAX_H3_REF2V_TEMPLATE_ID} from "@/features/comfy-workflow/minimax-h3-ref2v-preset";
import {createComfyTemplate} from "@/features/comfy-workflow/template-schema";

const item=(id,type,metadata)=>({id,type,title:id,position:{x:0,y:0},width:200,height:150,metadata});
test("real SQLite lazy creative canvas saves and accepts an H3 video job with exact user prompt",async()=>{
 const db=new DatabaseSync(":memory:");
 try{
  initializeSchema(db);
  const template=await createComfyTemplate(MINIMAX_H3_REF2V_TEMPLATE_ID,minimaxH3Ref2VBundledTemplate());
  const prompt="我的原创提示词。\nA slow pan.";
  const story=item("story","drama:source",{dramaDraft:"A story",dramaConfirmed:"A story",content:"A story"});
  const creative=item("assets","drama:assets",{dramaDraft:"opened asset body"});
  const target=item("wf","comfy:workflow",{comfyWorkflow:{templateId:template.id,templateRevision:template.revision,bindingState:"bound",inputOverrides:{prompt}},
   comfyPorts:template.ports.map(({id,label,direction,valueKind})=>({id,label,direction,valueKind})),mediaMode:"text_to_video"});
  // An independent creative pipeline and a video workflow share one canvas.
  const initial=createProject(db,{id:"p1",document:{nodes:[story,creative,target],connections:[{id:"story-assets",fromNodeId:"story",toNodeId:"assets"}]}});
  const compact=getProject(db,"p1",{compact:true});
  expect(compact.document.nodes[0].metadata.creativePayloadRef).toBeDefined();
  const local={nodes:[compact.document.nodes[0],initial.document.nodes[1],target],connections:compact.document.connections};
  store.project=local;
  store.flush.mockImplementation(async()=>{
   saveSingleUserCanvas(db,{id:"p1",expectedRevision:getProject(db,"p1").revision,document:{...store.patch}});
  });
  let payload;
  const api=vi.fn(async(path,method="GET",body)=>{
   if(path==="/api/v1/projects/p1")return getProject(db,"p1");
   if(path==="/api/v1/projects/p1?creative=summary")return getProject(db,"p1",{compact:true});
   if(path==="/api/v1/execution/capabilities")return {autoDispatch:true,comfyInstanceIds:["comfy-local"]};
   if(path==="/api/v1/jobs/snapshot")return {jobs:[]};
   if(path==="/api/v1/jobs"&&method==="POST"){
    payload=body;
    return {id:submitJob(db,body).jobId,status:"queued",projectId:"p1"};
   }
   throw Error("unexpected "+path);
  });
  const bridge=createSqliteComfyBridge({projectId:"p1",getLocalGraph:()=>local,api});
  const run=await startBackendComfyWorkflowRun({bridge,projectId:"p1",workflowNode:target,...local,template,
   instanceId:"comfy-local",outputPortIds:["video"],newKey:()=>"video-click"});
  const saved=getProject(db,"p1");
  expect(run.status).toBe("queued");
  expect(payload.expectedProjectRevision).toBe(saved.revision);
  expect(payload.sourceNodeFingerprint).toBe(fingerprintSource(saved.document,target.id));
  expect(payload.snapshot.comfyRequest.nodes[0].inputOverrides.prompt).toBe(prompt);
  expect(payload.snapshot.comfyRequest.runOptions.mediaMode).toBe("text_to_video");
  expect(saved.document.nodes[0].metadata.dramaDraft).toBe("A story");
  expect(saved.document.nodes[1].metadata.dramaDraft).toBe("opened asset body");
  // The original bug also blocks a creative ancestor on a generation source.
  // Use the same authoritative SQLite snapshot to ensure hydration is used for
  // the source hash, not the compact node representation.
  const fence=await bridge.saveProjectNow(local,"assets");
  const hydrated=getProject(db,"p1");
  expect(fence.sourceNodeFingerprint).toBe(fingerprintSource(hydrated.document,"assets"));
  expect(fence.sourceNodeFingerprint).not.toBe(await fingerprintBackendSource(local,"assets"));
 }finally{db.close();store.patch=null;store.project=null;vi.clearAllMocks()}
});
