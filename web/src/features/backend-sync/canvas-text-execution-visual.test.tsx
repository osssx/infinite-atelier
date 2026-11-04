import {readFileSync} from "node:fs";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {
 beginCanvasTextSubmission,finishCanvasTextJob,finishCanvasTextSubmission,
 canvasModelExecutionPhase,getCanvasTextExecution,setCanvasTextExecutionScope,subscribeCanvasTextExecution,
 textExecutionLabel,trackCanvasTextJob,updateCanvasTextJob
} from "./canvas-text-execution-visual";
import {CanvasExecutionHalo} from "@/components/canvas/canvas-execution-halo";
import {CanvasNodeType, type CanvasNodeData} from "@/types/canvas";
import {CanvasTextExecutionIndicator} from "@/components/canvas/canvas-text-execution-indicator";

describe("Canvas text generation transition",()=>{
 beforeEach(()=>setCanvasTextExecutionScope("p1"));
 afterEach(()=>setCanvasTextExecutionScope(null));

 it.each(["image","text","video","audio"] as const)("tracks %s from click through all phases and renders the shared halo",kind=>{
  const node:CanvasNodeData={id:"config",type:CanvasNodeType.Config,title:"Config",position:{x:0,y:0},width:320,height:240};
  const halo=()=>renderToStaticMarkup(createElement(CanvasExecutionHalo,{node}));
  const button=()=>renderToStaticMarkup(createElement(CanvasTextExecutionIndicator,{nodeId:node.id,inline:true}));
  expect(halo()).toBe("");
  beginCanvasTextSubmission("p1",node.id,"click",kind);
  expect(getCanvasTextExecution(node.id)).toEqual({status:"submitting",modelKind:kind,activeCount:1});
  expect(halo()).toContain("canvas-execution-halo");
  expect(button()).toContain(textExecutionLabel("submitting",kind));
  trackCanvasTextJob("p1",node.id,"job","queued","click");
  finishCanvasTextSubmission("p1",node.id,"click");
  for(const status of ["queued","preparing","running","collecting"]){
   updateCanvasTextJob("p1","job",status);
   expect(getCanvasTextExecution(node.id)?.modelKind).toBe(kind);
   expect(button()).toContain(textExecutionLabel(status,kind));
   expect(button()).toContain("animate-spin");
   expect(halo()).toContain("canvas-execution-halo");
  }
  updateCanvasTextJob("p1","job","succeeded");
  expect(button()).toBe("");
  expect(halo()).toBe("");
  // Snapshot recovery needs no pending click and must retain the model kind.
  trackCanvasTextJob("p1",node.id,"restored","running",undefined,kind);
  expect(button()).toContain(textExecutionLabel("running",kind));
  updateCanvasTextJob("p1","restored","unavailable");
  expect(halo()).toBe("");
 });

 it("keeps concurrent model kinds and independent nodes isolated",()=>{
  trackCanvasTextJob("p1","source","image-job","running",undefined,"image");
  trackCanvasTextJob("p1","source","audio-job","queued",undefined,"audio");
  trackCanvasTextJob("p1","other","video-job","running",undefined,"video");
  finishCanvasTextJob("p1","audio-job");
  expect(getCanvasTextExecution("source")).toEqual({status:"running",modelKind:"image",activeCount:1});
  expect(getCanvasTextExecution("other")?.modelKind).toBe("video");
  finishCanvasTextJob("p1","image-job");
  expect(getCanvasTextExecution("source")).toBeUndefined();
  expect(getCanvasTextExecution("other")?.status).toBe("running");
 });

 it("uses each image source's shared execution state and routes prompt-panel stop through node cancellation",()=>{
  const panel=readFileSync(new URL("../../components/canvas/canvas-node-prompt-panel.tsx",import.meta.url),"utf8");
  const page=readFileSync(new URL("../../pages/canvas/project.tsx",import.meta.url),"utf8");
  expect(panel).toContain("useCanvasTextExecution(node.id)");
  expect(panel).toContain("const active = isRunning || Boolean(execution)");
  expect(panel).toContain("disabled={Boolean(execution?.stopping) || (!active && !prompt.trim())}");
  expect(panel).toContain("onClick={() => (active ? onStop(node.id) : submit())}");
  expect(page).toContain("onStop={stopConfigGeneration}");
  expect(page).toContain("cancelCanvasNodeExecution(projectId,nodeId");
 });

 it("keeps image execution active through succeeded until artifact refresh completes",()=>{
  trackCanvasTextJob("p1","image-source","image-job","running",undefined,"image");
  updateCanvasTextJob("p1","image-job",canvasModelExecutionPhase("succeeded","image"));
  expect(getCanvasTextExecution("image-source")).toEqual({status:"collecting",modelKind:"image",activeCount:1});
  updateCanvasTextJob("p1","image-job",canvasModelExecutionPhase("materialized","image"));
  expect(getCanvasTextExecution("image-source")).toBeUndefined();
  expect(canvasModelExecutionPhase("succeeded","video")).toBe("collecting");
  expect(canvasModelExecutionPhase("succeeded","audio")).toBe("collecting");
  expect(canvasModelExecutionPhase("succeeded","text")).toBe("succeeded");
 });

 it("begins animating immediately, hands off to the durable job, and clears on success",()=>{
  const changed=vi.fn(),unsubscribe=subscribeCanvasTextExecution("text-1",changed);
  expect(getCanvasTextExecution("text-1")).toBeUndefined();
  beginCanvasTextSubmission("p1","text-1","click-a");
  expect(getCanvasTextExecution("text-1")).toEqual({status:"submitting",modelKind:"text",activeCount:1});
  trackCanvasTextJob("p1","text-1","job-a","queued","click-a");
  finishCanvasTextSubmission("p1","text-1","click-a");
  expect(getCanvasTextExecution("text-1")).toEqual({status:"queued",modelKind:"text",activeCount:1});
  for(const status of ["preparing","running","collecting"]){
   updateCanvasTextJob("p1","job-a",status);
   expect(getCanvasTextExecution("text-1")?.status).toBe(status);
  }
  updateCanvasTextJob("p1","job-a","succeeded");
  expect(getCanvasTextExecution("text-1")).toBeUndefined();
  const count=changed.mock.calls.length;
  unsubscribe();
  beginCanvasTextSubmission("p1","text-1","next-click");
  expect(changed).toHaveBeenCalledTimes(count);
 });

 it("removes pending submission when preparation fails and terminal/unknown jobs when observed",()=>{
  beginCanvasTextSubmission("p1","source","pending");
  finishCanvasTextSubmission("p1","source","pending");
  expect(getCanvasTextExecution("source")).toBeUndefined();
  for(const status of ["failed","cancelled","submission_unknown","blocked_credential","unavailable"]){
   trackCanvasTextJob("p1","source","job-"+status,"running");
   updateCanvasTextJob("p1","job-"+status,status);
   expect(getCanvasTextExecution("source")).toBeUndefined();
  }
  // watcher disconnect/stop always cleans up regardless of its last phase.
  trackCanvasTextJob("p1","source","job-lost","running");
  finishCanvasTextJob("p1","job-lost");
  expect(getCanvasTextExecution("source")).toBeUndefined();
 });

 it("preserves one spinner when concurrent explicit text requests complete out of order",()=>{
  trackCanvasTextJob("p1","text","job-1","running");
  beginCanvasTextSubmission("p1","text","click-2");
  expect(getCanvasTextExecution("text")).toEqual({status:"submitting",modelKind:"text",activeCount:2});
  trackCanvasTextJob("p1","text","job-2","queued","click-2");
  finishCanvasTextSubmission("p1","text","click-2");
  expect(getCanvasTextExecution("text")).toEqual({status:"queued",modelKind:"text",activeCount:2});
  updateCanvasTextJob("p1","job-1","succeeded");
  expect(getCanvasTextExecution("text")).toEqual({status:"queued",modelKind:"text",activeCount:1});
  updateCanvasTextJob("p1","job-2","running");
  expect(getCanvasTextExecution("text")?.status).toBe("running");
  updateCanvasTextJob("p1","job-2","failed");
  expect(getCanvasTextExecution("text")).toBeUndefined();
 });

 it("resets on project change and ignores late responses from a previous project",()=>{
  trackCanvasTextJob("p1","same-id","old","running");
  const changed=vi.fn(),unsubscribe=subscribeCanvasTextExecution("same-id",changed);
  setCanvasTextExecutionScope("p2");
  expect(changed).toHaveBeenCalled();
  expect(getCanvasTextExecution("same-id")).toBeUndefined();
  trackCanvasTextJob("p1","same-id","late","queued");
  updateCanvasTextJob("p1","old","succeeded");
  beginCanvasTextSubmission("p1","same-id","late-click");
  expect(getCanvasTextExecution("same-id")).toBeUndefined();
  trackCanvasTextJob("p2","same-id","new","queued");
  updateCanvasTextJob("p1","old","failed");
  finishCanvasTextJob("p1","old");
  expect(getCanvasTextExecution("same-id")?.status).toBe("queued");
  unsubscribe();
 });

 it("renders CSS-only spinner for full and compact source nodes, without hiding editable text",()=>{
  beginCanvasTextSubmission("p1","text-1","click");
  const full=renderToStaticMarkup(createElement(CanvasTextExecutionIndicator,{nodeId:"text-1"}));
  const compact=renderToStaticMarkup(createElement(CanvasTextExecutionIndicator,{nodeId:"text-1",compact:true}));
  expect(full).toContain('data-canvas-text-generation-status="submitting"');
  expect(full).toContain("正在提交文本请求");
  expect(full).toContain("animate-spin");
  expect(full).toContain("pointer-events-none");
  expect(compact).toContain("animate-spin");
  expect(compact).not.toContain("backdrop-blur-sm");
  expect(renderToStaticMarkup(createElement(CanvasTextExecutionIndicator,{nodeId:"idle"}))).toBe("");
  expect(textExecutionLabel("running")).toBe("文本生成中…");
  expect(textExecutionLabel("collecting")).toBe("正在保存文本结果…");
  const fullNode=readFileSync(new URL("../../components/canvas/canvas-node.tsx",import.meta.url),"utf8");
  const smallNode=readFileSync(new URL("../../components/canvas/canvas-node-compact.tsx",import.meta.url),"utf8");
  expect(fullNode).toContain("<CanvasTextExecutionIndicator nodeId={data.id}/>");
  expect(smallNode).toContain("<CanvasTextExecutionIndicator nodeId={data.id} compact/>");
 });

 it("keeps Config-node text progress inside the generate button, never over its controls",()=>{
  beginCanvasTextSubmission("p1","config-1","click");
  const inline=renderToStaticMarkup(createElement(CanvasTextExecutionIndicator,{
   nodeId:"config-1",inline:true,idle:"开始生成"
  }));
  expect(inline).toContain('data-canvas-text-generation-status="submitting"');
  expect(inline).toContain("正在提交文本请求");
  expect(inline).toContain("animate-spin");
  expect(inline).toContain("inline-flex");
  expect(inline).not.toContain("absolute");
  expect(inline).not.toContain("bottom-3");
  expect(inline).not.toContain("bg-black");
  finishCanvasTextSubmission("p1","config-1","click");
  const idle=renderToStaticMarkup(createElement(CanvasTextExecutionIndicator,{
   nodeId:"config-1",inline:true,idle:"开始生成"
  }));
  expect(idle).toBe("开始生成");
  trackCanvasTextJob("p1","config-1","first","running");
  trackCanvasTextJob("p1","config-1","second","queued");
  expect(renderToStaticMarkup(createElement(CanvasTextExecutionIndicator,{
   nodeId:"config-1",inline:true
  }))).toContain("×2");
  const config=readFileSync(new URL("../../components/canvas/canvas-config-node-panel.tsx",import.meta.url),"utf8");
  const node=readFileSync(new URL("../../components/canvas/canvas-node.tsx",import.meta.url),"utf8");
  const compact=readFileSync(new URL("../../components/canvas/canvas-node-compact.tsx",import.meta.url),"utf8");
  expect(config).toContain('<CanvasConfigGenerateButton');
  expect(config).not.toContain('CanvasTextExecutionIndicator');
  expect(node).toContain('data.type===CanvasNodeType.Text||data.type===CanvasNodeType.Image||');
  expect(node).toContain('data.type===CanvasNodeType.Video||data.type===CanvasNodeType.Audio');
  expect(compact).toContain('data.type===CanvasNodeType.Text||data.type===CanvasNodeType.Image||');
  expect(compact).toContain('data.type===CanvasNodeType.Video||data.type===CanvasNodeType.Audio');
 });
 it("wires submission before the first await and recovers active text jobs via SQLite snapshot",()=>{
  const page=readFileSync(new URL("../../pages/canvas/project.tsx",import.meta.url),"utf8");
  const start=page.indexOf("const textSubmissionToken=nanoid()");
  const firstAwait=page.indexOf("await ensureSqliteModelChannelForExecution",start);
  expect(start).toBeGreaterThan(0);
  expect(page.indexOf("beginCanvasTextSubmission(projectId,nodeId,textSubmissionToken,mode)",start))
   .toBeLessThan(firstAwait);
  expect(page).toContain("trackCanvasTextJob(projectId,nodeId,job.id,job.status,textSubmissionToken,kind)");
  expect(page).toContain("finishCanvasTextSubmission(projectId,nodeId,textSubmissionToken)");
  expect(page).toContain("updateCanvasTextJob(projectId,jobId,canvasModelExecutionPhase(status,sourceKind))");
  expect(page).toContain('updateCanvasTextJob(projectId,jobId,"running")');
  expect(page).toContain("finishCanvasTextJob(projectId,jobId)");
  expect(page).toContain('["image","text","video","audio"].includes(job.modelKind');
  expect(page).toContain("setCanvasTextExecutionScope(null)");
 });
});
