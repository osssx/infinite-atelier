import {afterEach,describe,expect,it,vi} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {canvasThemes} from "@/lib/canvas-theme";
import type {CanvasNodeData} from "@/types/canvas";
import {ComfyWorkflowNodeVisual} from "./comfy-workflow-node-visual";
import comfyLogoLight from "@/assets/comfyui-logo.svg";
import comfyLogoDark from "@/assets/comfyui-logo-dark.svg";
import {
 setCanvasComfyExecutionScope,setCanvasComfyExecution,observeCanvasComfyExecution,
 getCanvasComfyExecution,subscribeCanvasComfyExecution,markCanvasComfyRunUnobservable,observeCanvasComfyLive
} from "./canvas-execution-visual";

const node:CanvasNodeData={id:"wf",type:"comfy:workflow",title:"Comfy",
 position:{x:0,y:0},width:320,height:210,metadata:{
 comfyWorkflow:{templateId:"preset",templateRevision:"sha",bindingState:"bound",inputOverrides:{}}
}};
const render=(mode:"light"|"dark"="light")=>renderToStaticMarkup(createElement(ComfyWorkflowNodeVisual,{node,theme:canvasThemes[mode]}));
afterEach(()=>{setCanvasComfyExecutionScope(null);vi.useRealTimers()});

describe("canvas ComfyUI execution visual state",()=>{
 it("uses the bundled ComfyUI logo matching canvas theme, without duplicating SVG paths in DOM",()=>{
    setCanvasComfyExecutionScope("project");
    const light=render("light");
    const dark=render("dark");
    expect(light).toContain('alt="ComfyUI"');
    expect(light).toContain('src="'+comfyLogoLight+'"');
    expect(light).not.toContain('src="'+comfyLogoDark+'"');
    expect(dark).toContain('src="'+comfyLogoDark+'"');
    expect(dark).not.toContain('src="'+comfyLogoLight+'"');
    expect(light).not.toContain("lucide-puzzle");
    expect(dark).not.toContain("lucide-puzzle");
    expect(light).not.toContain('aria-label="ComfyUI 工作流运行中"');
    setCanvasComfyExecution("project","wf",{status:"running",runId:"job"});
    const active=render("dark");
    expect(active).toContain('src="'+comfyLogoDark+'"');
    expect(active).toContain('aria-label="ComfyUI 工作流运行中"');
    expect(active).toContain("animate-spin");
    // The active spinner belongs beside the status label, never to the logo.
    expect(active).toContain("data-comfy-status-line");
    expect(active.indexOf("animate-spin")).toBeGreaterThan(active.indexOf("data-comfy-status-line"));
    expect(active).not.toContain("ComfyUI Workflow");
    expect(active).not.toContain("absolute -right-1");
    expect(active).not.toContain("absolute -top-0.5");
   });
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
 it("renders the timer only while an active run is visible",()=>{
  setCanvasComfyExecutionScope("project");
  setCanvasComfyExecution("project","wf",{status:"running",runId:"job",startedAt:Date.now()});
  expect(render()).toContain('role="timer"');
  setCanvasComfyExecution("project","wf",{status:"succeeded",runId:"job"});
  expect(render()).not.toContain('role="timer"');
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
  it("renders scoped sampler progress and ephemeral preview without touching saved canvas data",()=>{
   setCanvasComfyExecutionScope("project");
   setCanvasComfyExecution("project","wf",{status:"running",runId:"job-1"});
   const preview={kind:"preview" as const,mime:"image/png" as const,version:1};
   observeCanvasComfyLive("project","wf","other-job",preview);
   expect(getCanvasComfyExecution("wf")?.preview).toBeUndefined();
   observeCanvasComfyLive("other-project","wf","job-1",preview);
   expect(getCanvasComfyExecution("wf")?.preview).toBeUndefined();
   observeCanvasComfyLive("project","wf","job-1",preview);
   observeCanvasComfyLive("project","wf","job-1",{kind:"progress",currentNode:"w_wf__12",step:6,steps:20,value:.3});
   const html=render();
   expect(getCanvasComfyExecution("wf")?.preview?.version).toBe(1);
   expect(html).toContain("执行节点 12");
   expect(html).toContain("采样 6/20");
   expect(html).toContain("30%");
   expect(node.metadata?.comfyExecution).toBeUndefined();
   observeCanvasComfyExecution("project","wf",{status:"succeeded",runId:"job-1"});
   expect(getCanvasComfyExecution("wf")?.preview).toBeUndefined();
   expect(getCanvasComfyExecution("wf")?.progress).toBeUndefined();
  });
  it("retains run-scoped preview permission across poll status updates and applies the first preview",()=>{
   setCanvasComfyExecutionScope("project");
   setCanvasComfyExecution("project","wf",{runId:"job-2",status:"queued",previewEnabled:true});
   observeCanvasComfyExecution("project","wf",{runId:"job-2",status:"running"});
   expect(getCanvasComfyExecution("wf")?.previewEnabled).toBe(true);
   observeCanvasComfyLive("project","wf","job-2",{kind:"preview",mime:"video/mp4",version:8,step:1,steps:6});
   expect(getCanvasComfyExecution("wf")?.preview?.version).toBe(8);
   observeCanvasComfyExecution("project","wf",{runId:"job-1",status:"running"});
   expect(getCanvasComfyExecution("wf")?.runId).toBe("job-2");
  });
 it("keeps one run anchor across phases, corrects pending fallback from createdAt, and resets for a new or recovered run",()=>{
  vi.useFakeTimers();vi.setSystemTime(5000);
  setCanvasComfyExecutionScope("project");
  setCanvasComfyExecution("project","wf",{status:"submitting"});
  expect(getCanvasComfyExecution("wf")?.startedAt).toBe(5000);
  setCanvasComfyExecution("project","wf",{status:"queued",runId:"job-1",startedAt:3200});
  expect(getCanvasComfyExecution("wf")?.startedAt).toBe(3200);
  observeCanvasComfyExecution("project","wf",{status:"running",runId:"job-1"});
  expect(getCanvasComfyExecution("wf")?.startedAt).toBe(3200);
  observeCanvasComfyExecution("project","wf",{status:"collecting",runId:"job-1"});
  expect(getCanvasComfyExecution("wf")?.startedAt).toBe(3200);
  setCanvasComfyExecution("project","wf",{status:"failed",runId:"job-1"});
  expect(render()).not.toContain('role="timer"');
  setCanvasComfyExecution("project","wf",{status:"submitting"});
  expect(getCanvasComfyExecution("wf")?.startedAt).toBe(5000);
  setCanvasComfyExecutionScope(null);
  setCanvasComfyExecutionScope("project");
  setCanvasComfyExecution("project","wf",{status:"running",runId:"restored",startedAt:2100});
  expect(getCanvasComfyExecution("wf")?.startedAt).toBe(2100);
 });
  it("shows a workflow node title instead of just the numeric identifier",()=>{
   setCanvasComfyExecutionScope("project");
   setCanvasComfyExecution("project","wf",{status:"running",runId:"job-1"});
   observeCanvasComfyLive("project","wf","job-1",{
    kind:"progress",currentNode:"w_wf__105_14",nodeName:"自定义采样器（高级）",step:2,steps:6,value:2/6
   });
   const html=render();
   expect(html).toContain("执行节点 自定义采样器（高级）");
   expect(html).toContain("ID: 105_14");
   expect(html).not.toContain(">执行节点 105_14</span>");
  });
  it("keeps the structured node failure through terminal polling and drops stale live events",()=>{
   setCanvasComfyExecutionScope("project");
   setCanvasComfyExecution("project","wf",{status:"running",runId:"job-1"});
   const detail={nodeId:"w_wf__19",classType:"ResolutionSelector",type:"value_not_in_list",message:"value_not_in_list"};
   observeCanvasComfyLive("project","wf","job-1",{kind:"error",error:detail});
   observeCanvasComfyExecution("project","wf",{status:"failed",runId:"job-1"});
   expect(getCanvasComfyExecution("wf")?.errorDetail).toEqual(detail);
   expect(getCanvasComfyExecution("wf")?.error).toBe("value_not_in_list");
   observeCanvasComfyLive("project","wf","job-1",{kind:"progress",currentNode:"w_wf__19",step:10,steps:20,value:.5});
   expect(getCanvasComfyExecution("wf")?.progress).toBeUndefined();
   expect(render()).toContain("value_not_in_list");
  });
});
