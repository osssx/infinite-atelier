import {afterEach,describe,expect,it,vi} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {canvasThemes} from "@/lib/canvas-theme";
import type {CanvasNodeData} from "@/types/canvas";
import {ComfyWorkflowNodeVisual} from "./comfy-workflow-node-visual";
import {
 setCanvasComfyExecutionScope,setCanvasComfyExecution,observeCanvasComfyExecution,
 getCanvasComfyExecution,subscribeCanvasComfyExecution,markCanvasComfyRunUnobservable
} from "./canvas-execution-visual";

const node:CanvasNodeData={id:"wf",type:"comfy:workflow",title:"Comfy",
 position:{x:0,y:0},width:320,height:210,metadata:{
 comfyWorkflow:{templateId:"preset",templateRevision:"sha",bindingState:"bound",inputOverrides:{}}
}};
const render=()=>renderToStaticMarkup(createElement(ComfyWorkflowNodeVisual,{node,theme:canvasThemes.light}));
afterEach(()=>setCanvasComfyExecutionScope(null));

describe("canvas ComfyUI execution visual state",()=>{
 it("spins instantly on submit and during queue, running and capture, never on terminal status",()=>{
  setCanvasComfyExecutionScope("project");
  for(const status of ["submitting","queued","preparing","running","collecting","importing"]){
   setCanvasComfyExecution("project","wf",{runId:status==="submitting"?undefined:"job-1",status});
   const html=render();
   expect(html).toContain('data-comfy-execution-status="'+status+'"');
   expect(html).toContain("animate-spin");
   expect(html).toContain("ComfyUI 工作流运行中");
  }
  for(const status of ["succeeded","failed","cancelled","submission_unknown"]){
   setCanvasComfyExecution("project","wf",{status,runId:"job-1"});
   const html=render();
   expect(html).not.toContain("animate-spin");
   expect(html).toContain('data-comfy-execution-status="'+status+'"');
  }
 });
 it("notifies only the changed node and skips identical phase updates",()=>{
  setCanvasComfyExecutionScope("project");
  const wf=vi.fn(),other=vi.fn();
  const stopWf=subscribeCanvasComfyExecution("wf",wf);
  const stopOther=subscribeCanvasComfyExecution("other",other);
  setCanvasComfyExecution("project","wf",{status:"queued",runId:"one"});
  setCanvasComfyExecution("project","wf",{status:"queued",runId:"one"});
  expect(wf).toHaveBeenCalledTimes(1);
  expect(other).not.toHaveBeenCalled();
  stopWf();stopOther();
 });
 it("ignores stale job callbacks, scopes updates to one project, and clears on project switch",()=>{
  setCanvasComfyExecutionScope("alpha");
  setCanvasComfyExecution("alpha","wf",{status:"submitting"});
  observeCanvasComfyExecution("alpha","wf",{status:"failed",runId:"older"});
  expect(getCanvasComfyExecution("wf")?.status).toBe("submitting");
  setCanvasComfyExecution("alpha","wf",{status:"running",runId:"current"});
  observeCanvasComfyExecution("alpha","wf",{status:"succeeded",runId:"older"});
  expect(getCanvasComfyExecution("wf")?.status).toBe("running");
  observeCanvasComfyExecution("alpha","wf",{status:"succeeded",runId:"current"});
  expect(getCanvasComfyExecution("wf")?.status).toBe("succeeded");
  setCanvasComfyExecutionScope("beta");
  expect(getCanvasComfyExecution("wf")).toBeUndefined();
  setCanvasComfyExecution("alpha","wf",{status:"running",runId:"old-project"});
  expect(getCanvasComfyExecution("wf")).toBeUndefined();
 });
 it("stops an active spinner when the backend cannot be observed, without claiming success",()=>{
  setCanvasComfyExecutionScope("project");
  setCanvasComfyExecution("project","wf",{status:"running",runId:"job-1"});
  markCanvasComfyRunUnobservable("project","other-job","wrong job");
  expect(getCanvasComfyExecution("wf")?.status).toBe("running");
  markCanvasComfyRunUnobservable("project","job-1","backend offline");
  const html=render();
  expect(html).toContain('data-comfy-execution-status="unavailable"');
  expect(html).not.toContain("animate-spin");
  expect(html).toContain("backend offline");
 });
 it("makes recovered queued/running jobs visible without modifying saved node metadata",()=>{
  setCanvasComfyExecutionScope("project");
  setCanvasComfyExecution("project","wf",{status:"running",runId:"backend-recovered"});
  expect(render()).toContain('data-comfy-execution-status="running"');
  expect(node.metadata?.comfyExecution).toBeUndefined();
 });
});
