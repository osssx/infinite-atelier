import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {assertCanvasSubmissionActive,beginCanvasTextSubmission,cancelCanvasNodeExecution,canvasSubmissionStopped,
 finishCanvasTextSubmission,getCanvasTextExecution,setCanvasTextExecutionScope,trackCanvasTextJob,
 updateCanvasTextJob,waitForCanvasNodeCancellation} from "./canvas-text-execution-visual";

describe("Config generation direct cancellation",()=>{
 beforeEach(()=>setCanvasTextExecutionScope("p"));
 afterEach(()=>setCanvasTextExecutionScope(null));
 it("stops preparation without a backend request and prevents subsequent submit",async()=>{
  beginCanvasTextSubmission("p","node","click","image");
  const api=vi.fn(),report=vi.fn();
  await cancelCanvasNodeExecution("p","node",api,report);
  expect(api).not.toHaveBeenCalled();
  expect(canvasSubmissionStopped("p","click")).toBe(true);
  expect(()=>assertCanvasSubmissionActive("p","click")).toThrow("canvas_submission_stopped");
  expect(getCanvasTextExecution("node")?.stopping).toBe(true);
  finishCanvasTextSubmission("p","node","click");
  expect(getCanvasTextExecution("node")).toBeUndefined();
 });
 it("cancels a created job after a stop issued while POST was in flight",async()=>{
  beginCanvasTextSubmission("p","node","click","audio");
  const api=vi.fn(async()=>({cancelled:true}));
  const pending=cancelCanvasNodeExecution("p","node",api,vi.fn());
  trackCanvasTextJob("p","node","created","queued","click","audio");
  await waitForCanvasNodeCancellation("p","node");
  await cancelCanvasNodeExecution("p","node",api,vi.fn());
  await pending;
  finishCanvasTextSubmission("p","node","click");
  expect(api).toHaveBeenCalledExactlyOnceWith("created");
  expect(getCanvasTextExecution("node")).toBeUndefined();
 });
 it("serializes all jobs, disables duplicate stops, and retains unsupported jobs",async()=>{
  trackCanvasTextJob("p","node","one","queued",undefined,"image");
  trackCanvasTextJob("p","node","two","running",undefined,"text");
  trackCanvasTextJob("p","other","three","running",undefined,"video");
  let resolve!:(value:{cancelled:boolean})=>void;
  const api=vi.fn((id:string)=>id==="one"?new Promise<{cancelled:boolean}>(r=>resolve=r):Promise.resolve({cancelled:false,reason:"not_supported"}));
  const report=vi.fn();
  const stop=cancelCanvasNodeExecution("p","node",api,report);
  expect(cancelCanvasNodeExecution("p","node",api,report)).toBe(stop);
  expect(getCanvasTextExecution("node")?.stopping).toBe(true);
  await Promise.resolve();
  resolve({cancelled:true});
  await stop;
  expect(api.mock.calls.map(c=>c[0])).toEqual(["one","two"]);
  expect(report).toHaveBeenCalledTimes(1);
  expect(getCanvasTextExecution("node")).toMatchObject({activeCount:1,modelKind:"text"});
  expect(getCanvasTextExecution("node")?.stopping).toBeUndefined();
  expect(getCanvasTextExecution("other")?.activeCount).toBe(1);
 });
 it("keeps failed cancellations active and tolerates completion during cancel",async()=>{
  trackCanvasTextJob("p","node","job","running",undefined,"audio");
  const report=vi.fn();
  await cancelCanvasNodeExecution("p","node",async()=>{throw Error("network_error")},report);
  expect(report).toHaveBeenCalledWith("network_error");
  expect(getCanvasTextExecution("node")?.activeCount).toBe(1);
  await cancelCanvasNodeExecution("p","node",async()=>{
   updateCanvasTextJob("p","job","succeeded");return {cancelled:false};
  },report);
  expect(getCanvasTextExecution("node")).toBeUndefined();
  expect(report).toHaveBeenCalledTimes(1);
 });
 it("handoff cancels only the new job without retrying an unsupported earlier job",async()=>{
  trackCanvasTextJob("p","node","old","running");
  beginCanvasTextSubmission("p","node","click","text");
  const api=vi.fn(async(id:string)=>({cancelled:id!=="old"}));
  await cancelCanvasNodeExecution("p","node",api,vi.fn());
  trackCanvasTextJob("p","node","new","queued","click","text");
  await waitForCanvasNodeCancellation("p","node");
  await cancelCanvasNodeExecution("p","node",api,vi.fn(),["new"]);
  finishCanvasTextSubmission("p","node","click");
  expect(api.mock.calls.map(c=>c[0])).toEqual(["old","new"]);
  expect(getCanvasTextExecution("node")?.activeCount).toBe(1);
 });
 it("ignores late cancellation results after switching projects",async()=>{
  trackCanvasTextJob("p","node","job","running");
  let resolve!:(value:{cancelled:boolean})=>void;
  const report=vi.fn();
  const stop=cancelCanvasNodeExecution("p","node",()=>new Promise(r=>resolve=r),report);
  await Promise.resolve();
  setCanvasTextExecutionScope("other");
  trackCanvasTextJob("other","node","job","running");
  resolve({cancelled:true});await stop;
  expect(getCanvasTextExecution("node")?.activeCount).toBe(1);
  expect(report).not.toHaveBeenCalled();
 });
});
