import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({api:vi.fn(),flush:vi.fn(async()=>{})}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:mocks.api}));
vi.mock("@/stores/canvas/use-canvas-store",()=>({awaitCanvasStorePersistence:mocks.flush}));
import {freezeAssistantRunSequence,canLaunchAssistantRunSequenceStep} from "./canvas-assistant-task-run-sequences";

const actions=[{type:"run_node" as const,nodeId:"node-a",mode:"text" as const},
 {type:"run_node" as const,nodeId:"node-b",mode:"text" as const}];
const view={sequence:{id:"seq",taskId:"task",sourceMessageId:"m1",planVersion:1,
 actions,status:"active"},
 state:"ready",next:{index:0,action:actions[0],dependsOn:[],last:false}};
describe("P3b browser sequence capture",()=>{
 beforeEach(()=>{
  mocks.api.mockReset();mocks.flush.mockClear();
  mocks.api.mockImplementation(async(url:string,method:string,body?:Record<string,unknown>)=>{
   if(url==="/api/v1/projects/p"&&method==="GET")return {revision:10};
   if(url.endsWith("/task")&&method==="GET")return {task:{activePlanVersion:1}};
   if(url.endsWith("/run-sequences")&&method==="POST"){
    expect(body).toMatchObject({requestId:"m1-run-sequence",sourceMessageId:"m1",
     expectedPlanVersion:1,expectedProjectRevision:10});
    expect(body?.actions).toEqual([{type:"run_node",nodeId:"resolved-a",mode:"text"},actions[1]]);
    return {sequenceId:"seq",planVersion:1,count:2};
   }
   if(url.endsWith("/run-sequences")&&method==="GET")return {
    ...view,sequence:{...view.sequence,actions:[{...actions[0],nodeId:"resolved-a"},actions[1]]},
    next:{...view.next,action:{...actions[0],nodeId:"resolved-a"}}};
   throw Error("unexpected request "+url);
  });
 });
 it("flushes local edits, freezes resolved IDs, and does not call Job endpoints",async()=>{
  const result=await freezeAssistantRunSequence({projectId:"p",taskId:"task",
   messageId:"m1",actions,refs:new Map([["node-a","resolved-a"]]),
   signal:new AbortController().signal});
  expect(canLaunchAssistantRunSequenceStep(result)).toMatchObject({index:0,last:false});
  expect(mocks.flush).toHaveBeenCalledWith("p");
  expect(mocks.api.mock.calls.map(([url])=>url).every(url=>!url.includes("/jobs")&&!url.includes("/enqueue"))).toBe(true);
 });
 it("rejects duplicate targets and abort before recording any durable intent",async()=>{
  await expect(freezeAssistantRunSequence({projectId:"p",taskId:"task",messageId:"m1",
   actions:[actions[0],actions[0]],refs:new Map(),signal:new AbortController().signal}))
   .rejects.toThrow("assistant_task_run_invalid");
  expect(mocks.api).not.toHaveBeenCalled();
  const controller=new AbortController();controller.abort();
  await expect(freezeAssistantRunSequence({projectId:"p",taskId:"task",messageId:"m2",
   actions,refs:new Map(),signal:controller.signal})).rejects.toMatchObject({name:"AbortError"});
 });
 it("blocked or mismatched next action is never dispatched",()=>{
  expect(()=>canLaunchAssistantRunSequenceStep({...view,state:"waiting_external"})).toThrow("not_ready");
  expect(()=>canLaunchAssistantRunSequenceStep({...view,next:{...view.next,action:actions[1]}}))
   .toThrow("conflict");
 });
});
