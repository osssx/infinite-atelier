import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({api:vi.fn(),barrier:vi.fn()}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:mocks.api}));
vi.mock("@/stores/canvas/use-canvas-store",()=>({commitAssistantCanvasGraphWithSaveBarrier:mocks.barrier}));
import {planAndExecuteAssistantCanvasActions,executeFrozenAssistantCanvasTaskStep} from "./canvas-assistant-task-execution";

const step={taskId:"task",stepId:"step",planVersion:2,actionDigest:"a".repeat(64),status:"waiting_approval"};
const doc={nodes:[{id:"task-node",type:"text"}],connections:[]};
const project={id:"p",revision:6,document:doc};
const committed={status:"succeeded",project,receipt:{attemptId:"a1",projectRevision:6,
 refs:{nodes:{chapter:"task-node"},connections:{}},applied:1},existing:false};

beforeEach(()=>{
 mocks.api.mockReset();mocks.barrier.mockReset();
 mocks.barrier.mockImplementation(async(_projectId,callback)=>callback({
  expectedRevision:5,document:{title:"before",nodes:[],connections:[]}
 }));
});
describe("P1b browser Task canvas protocol",()=>{
 it("freezes project revision, asks approval, then posts only Step execution identity",async()=>{
  const trace:string[]=[];
  mocks.api.mockImplementation(async(url:string,method:string,payload:Record<string,unknown>)=>{
   if(method==="GET"){trace.push("snapshot");return {task:{activePlanVersion:2}};}
   if(url.endsWith("/canvas-steps")){
    trace.push("plan");
    expect(payload.expectedProjectRevision).toBe(5);
    expect(payload.expectedPlanVersion).toBe(2);
    expect(payload.center).toEqual({x:12,y:34});
    return step;
   }
   if(url.endsWith("/approval")){
    trace.push("approval");expect(payload.actionDigest).toBe(step.actionDigest);
    expect(payload.decision).toBe("approve");return {status:"ready"};
   }
   if(url.endsWith("/execute")){
    trace.push("execute");
    expect(payload).toEqual({requestId:"m1-canvas-execute",
     expectedPlanVersion:2,actionDigest:step.actionDigest});
    expect(payload).not.toHaveProperty("actions");
    return committed;
   }
   throw Error("unexpected call");
  });
  const result=await planAndExecuteAssistantCanvasActions({
   projectId:"p",taskId:"task",messageId:"m1",
   actions:[{type:"create_text",ref:"chapter",title:"Chapter",content:"hello"}],
   center:{x:12,y:34},signal:new AbortController().signal,
   confirm:async frozen=>{trace.push("user_confirm");expect(frozen).toEqual(step);return true;}
  });
  expect(result).toEqual({applied:1,stepId:"step",revision:6});
  expect(trace).toEqual(["snapshot","plan","user_confirm","approval","execute"]);
  expect(mocks.barrier).toHaveBeenCalledTimes(1);
 });
 it("a rejection creates durable denied approval but cannot submit graph",async()=>{
  let executes=0;
  mocks.api.mockImplementation(async(url:string)=>{
   if(url.endsWith("/task"))return {task:{activePlanVersion:2}};
   if(url.endsWith("/canvas-steps"))return step;
   if(url.endsWith("/approval"))return {status:"blocked"};
   if(url.endsWith("/execute"))executes++;
   throw Error("unexpected execution");
  });
  await expect(planAndExecuteAssistantCanvasActions({
   projectId:"p",taskId:"task",messageId:"m2",actions:[{type:"set_text",nodeId:"old",content:"x"}],
   center:{x:0,y:0},signal:new AbortController().signal,confirm:async()=>false
  })).rejects.toThrow("assistant_task_canvas_rejected");
  expect(mocks.api.mock.calls.some(call=>String(call[0]).endsWith("/execute"))).toBe(false);
  expect(executes).toBe(0);
 });
 it("after refresh, an already approved frozen Step runs without replanning or reapproving",async()=>{
  mocks.api.mockImplementation(async(url:string)=>{
   if(url.endsWith("/execute"))return committed;
   throw Error("unexpected new plan or approval");
  });
  const result=await executeFrozenAssistantCanvasTaskStep({
   projectId:"p",taskId:"task",step,signal:new AbortController().signal
  });
  expect(result?.receipt.applied).toBe(1);
  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(String(mocks.api.mock.calls[0][0])).toContain("/step/execute");
 });
 it("an aborted browser Task call never plans, approves or executes",async()=>{
  const controller=new AbortController();controller.abort();
  await expect(planAndExecuteAssistantCanvasActions({
   projectId:"p",taskId:"task",messageId:"aborted",actions:[],
   center:{x:0,y:0},signal:controller.signal,confirm:async()=>true
  })).rejects.toMatchObject({name:"AbortError"});
  expect(mocks.api).not.toHaveBeenCalled();
  expect(mocks.barrier).not.toHaveBeenCalled();
 });
});
