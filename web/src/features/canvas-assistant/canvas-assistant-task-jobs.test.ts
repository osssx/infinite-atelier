import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock("@/features/backend-sync/canvas-api",()=>({
 canvasApi:(url:string,method="GET",body?:unknown)=>mocks.api(url,method,body)
}));
import {submitAssistantTaskFrozenJob,type AssistantTaskJobContext} from "./canvas-assistant-task-jobs";

const payload={projectId:"p",targetNodeId:"source",expectedProjectRevision:7,
 sourceNodeFingerprint:"v2:source-hash",idempotencyKey:"ordinary-job-identity",
 requestFingerprint:"ordinary-fingerprint",executionMode:"immediate",
 snapshot:{adapterKind:"model",provider:"openai_compatible",channelId:"model-channel",
  secretVersionRef:"credential-v3",task:{kind:"image",model:"image-model",prompt:"foggy mountains"}}};
const frozen={stepId:"frozen-step",planVersion:2,kind:"model_job",actionDigest:"a".repeat(64),status:"waiting_approval"};
const job={id:"job-1",projectId:"p",targetNodeId:"source",status:"queued",executionMode:"immediate",
 createdAt:1,updatedAt:1,upstreamTaskId:null,attemptId:null,submitMarker:null,submissionStartedAt:null};
const makeContext=(confirm:AssistantTaskJobContext["confirm"]=vi.fn(async()=>true))=>
 ({taskId:"task",messageId:"user-message",confirm});
beforeEach(()=>mocks.api.mockReset());

describe("P2c Task job submission boundary",()=>{
 it("keeps model credentials/version/source fingerprint and uses only frozen Task API",async()=>{
  const seen:string[]=[];
  mocks.api.mockImplementation(async(url:string,method:string,body?:Record<string,unknown>)=>{
   if(!url)return undefined;
   if(method==="GET"&&url.endsWith("/task")){seen.push("task");return {task:{activePlanVersion:2}};}
   if(url.endsWith("/external-jobs")){
    seen.push("plan");
    expect(body).toMatchObject({
     requestId:"user-message-job-0-plan",kind:"model_job",
     expectedPlanVersion:2,expectedProjectRevision:7,
     job:{targetNodeId:"source",sourceNodeFingerprint:"v2:source-hash",
      executionMode:"immediate",snapshot:payload.snapshot}});
    expect(body?.job).not.toHaveProperty("idempotencyKey");
    return frozen;
   }
   if(url.endsWith("/approval")){
    seen.push("approval");expect(body).toEqual({requestId:"user-message-job-0-decision",
     expectedPlanVersion:2,actionDigest:frozen.actionDigest,decision:"approve"});
    return {decision:"approved"};
   }
   if(url.endsWith("/enqueue")){
    seen.push("enqueue");expect(body).toEqual({requestId:"user-message-job-0-enqueue",
     expectedPlanVersion:2,actionDigest:frozen.actionDigest});
    return {jobId:job.id,status:"waiting_external"};
   }
   if(method==="GET"&&url.endsWith("/jobs/job-1")){seen.push("lookup");return job;}
   throw Error("unexpected direct job submit: "+method+" "+url);
  });
  const confirm=vi.fn(async(step,request)=>{
   seen.push("consent");expect(step).toEqual(frozen);expect(request).toEqual(payload);return true;
  });
  const result=await submitAssistantTaskFrozenJob({
   projectId:"p",context:makeContext(confirm),actionIndex:0,payload,
   signal:new AbortController().signal});
  expect(result).toEqual(job);
  expect(seen).toEqual(["task","plan","consent","approval","enqueue","lookup"]);
 });
 it("rejection durably rejects frozen Step and never queues Job",async()=>{
  mocks.api.mockImplementation(async(url:string,method:string,body?:Record<string,unknown>)=>{
   if(!url)return undefined;
   if(method==="GET")return {task:{activePlanVersion:2}};
   if(url.endsWith("/external-jobs"))return frozen;
   if(url.endsWith("/approval")){expect(body?.decision).toBe("reject");return {};}
   throw Error("no enqueue permitted");
  });
  await expect(submitAssistantTaskFrozenJob({projectId:"p",context:makeContext(vi.fn(async()=>false)),
   actionIndex:0,payload,signal:new AbortController().signal})).rejects.toThrow("assistant_task_job_rejected");
 });
 it("network failure before approval preserves frozen Step; a later run cannot bypass approval",async()=>{
  mocks.api.mockImplementation(async(url:string,method:string)=>{
   if(!url)return undefined;
   if(method==="GET")return {task:{activePlanVersion:2}};
   if(url.endsWith("/external-jobs"))return frozen;
   throw Error("network_down");
  });
  await expect(submitAssistantTaskFrozenJob({projectId:"p",context:makeContext(
   vi.fn(async()=>{throw Error("consent_interrupted")})
  ),actionIndex:0,payload,signal:new AbortController().signal})).rejects.toThrow("consent_interrupted");
 });
 it("abort after freeze prohibits approval and enqueue, allows later Task-panel resume",async()=>{
  const controller=new AbortController();
  mocks.api.mockImplementation(async(url:string,method:string)=>{
   if(!url)return undefined;
   if(method==="GET")return {task:{activePlanVersion:2}};
   if(url.endsWith("/external-jobs")){controller.abort();return frozen;}
   throw Error("unexpected submit after abort");
  });
  await expect(submitAssistantTaskFrozenJob({projectId:"p",context:makeContext(),
   actionIndex:0,payload,signal:controller.signal})).rejects.toMatchObject({name:"AbortError"});
  expect(controller.signal.aborted).toBe(true); });
 it("once backend enqueues, a lost read-only GET is not a reason to enqueue twice",async()=>{
  let submitted=0;
  mocks.api.mockImplementation(async(url:string,method:string)=>{
   if(!url)return undefined;
   if(method==="GET"&&url.endsWith("/task"))return {task:{activePlanVersion:2}};
   if(url.endsWith("/external-jobs"))return frozen;
   if(url.endsWith("/approval"))return {};
   if(url.endsWith("/enqueue")){submitted++;return {jobId:"job-survived",status:"waiting_external"};}
   if(url.endsWith("/jobs/job-survived"))throw Error("network_down_after_commit");
   throw Error("unexpected");
  });
  const value=await submitAssistantTaskFrozenJob({projectId:"p",context:makeContext(),
   actionIndex:0,payload,signal:new AbortController().signal});
  expect(value.id).toBe("job-survived");
  expect(value.status).toBe("queued");
  expect(submitted).toBe(1);
 });
 it("Comfy has its own frozen Step kind, including full template and pinned graph",async()=>{
  const comfy={...payload,executionMode:"poll",snapshot:{adapterKind:"comfy",instanceId:"local",
   comfyRequest:{schemaVersion:2,nodes:[{id:"source",templateId:"wf",templateRevision:"rev"}]},
   comfyTemplate:{id:"wf",revision:"rev",apiGraph:{"1":{class_type:"KSampler",inputs:{seed:3}}}}}};
  mocks.api.mockImplementation(async(url:string,method:string,body?:Record<string,unknown>)=>{
   if(!url)return undefined;
   if(method==="GET"&&url.endsWith("/task"))return {task:{activePlanVersion:1}};
   if(url.endsWith("/external-jobs")){expect(body?.kind).toBe("comfy_workflow");
    expect(body?.job).toMatchObject({snapshot:comfy.snapshot});return {...frozen,kind:"comfy_workflow"};}
   if(url.endsWith("/approval"))return {};
   if(url.endsWith("/enqueue"))return {jobId:"comfy-job",status:"waiting_external"};
   if(url.endsWith("/jobs/comfy-job"))return {...job,id:"comfy-job",executionMode:"poll"};
   throw Error("unexpected route "+url);
  });
  const result=await submitAssistantTaskFrozenJob({projectId:"p",context:makeContext(),
   actionIndex:0,payload:comfy,signal:new AbortController().signal});
  expect(result.id).toBe("comfy-job");
 });
 it("rejects wrong project, nonexistent adapter, bad revision without sending anything",async()=>{
  for(const wrong of [{...payload,projectId:"other"},
   {...payload,snapshot:{adapterKind:"unsupported"}},
   {...payload,expectedProjectRevision:0}]){
   await expect(submitAssistantTaskFrozenJob({projectId:"p",context:makeContext(),
    actionIndex:0,payload:wrong,signal:new AbortController().signal})).rejects.toThrow("assistant_task_job_snapshot_invalid");
  }
 });
});
