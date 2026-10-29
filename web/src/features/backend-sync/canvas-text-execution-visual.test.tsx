import {readFileSync} from "node:fs";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {
 beginCanvasTextSubmission,finishCanvasTextJob,finishCanvasTextSubmission,
 getCanvasTextExecution,setCanvasTextExecutionScope,subscribeCanvasTextExecution,
 textExecutionLabel,trackCanvasTextJob,updateCanvasTextJob
} from "./canvas-text-execution-visual";
import {CanvasTextExecutionIndicator} from "@/components/canvas/canvas-text-execution-indicator";

describe("Canvas text generation transition",()=>{
 beforeEach(()=>setCanvasTextExecutionScope("p1"));
 afterEach(()=>setCanvasTextExecutionScope(null));

 it("begins animating immediately, hands off to the durable job, and clears on success",()=>{
  const changed=vi.fn(),unsubscribe=subscribeCanvasTextExecution("text-1",changed);
  expect(getCanvasTextExecution("text-1")).toBeUndefined();
  beginCanvasTextSubmission("p1","text-1","click-a");
  expect(getCanvasTextExecution("text-1")).toEqual({status:"submitting",activeCount:1});
  trackCanvasTextJob("p1","text-1","job-a","queued","click-a");
  finishCanvasTextSubmission("p1","text-1","click-a");
  expect(getCanvasTextExecution("text-1")).toEqual({status:"queued",activeCount:1});
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
  expect(getCanvasTextExecution("text")).toEqual({status:"submitting",activeCount:2});
  trackCanvasTextJob("p1","text","job-2","queued","click-2");
  finishCanvasTextSubmission("p1","text","click-2");
  expect(getCanvasTextExecution("text")).toEqual({status:"queued",activeCount:2});
  updateCanvasTextJob("p1","job-1","succeeded");
  expect(getCanvasTextExecution("text")).toEqual({status:"queued",activeCount:1});
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

 it("wires submission before the first await and recovers active text jobs via SQLite snapshot",()=>{
  const page=readFileSync(new URL("../../pages/canvas/project.tsx",import.meta.url),"utf8");
  const start=page.indexOf("const textSubmissionToken=mode");
  const firstAwait=page.indexOf("await ensureSqliteModelChannelForExecution",start);
  expect(start).toBeGreaterThan(0);
  expect(page.indexOf("beginCanvasTextSubmission(projectId,nodeId,textSubmissionToken)",start))
   .toBeLessThan(firstAwait);
  expect(page).toContain("trackCanvasTextJob(projectId,nodeId,job.id,job.status,textSubmissionToken)");
  expect(page).toContain("finishCanvasTextSubmission(projectId,nodeId,textSubmissionToken)");
  expect(page).toContain("updateCanvasTextJob(projectId,jobId,status)");
  expect(page).toContain('updateCanvasTextJob(projectId,jobId,"running")');
  expect(page).toContain("finishCanvasTextJob(projectId,jobId)");
  expect(page).toContain('if(job.modelKind!=="text"||!job.targetNodeId||');
  expect(page).toContain("setCanvasTextExecutionScope(null)");
 });
});
