import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

const page=readFileSync(new URL("../../pages/canvas/project.tsx",import.meta.url),"utf8");
const panel=readFileSync(new URL("../comfy-workflow/comfy-workflow-instance-panel.tsx",import.meta.url),"utf8");

describe("P4.2 SQLite-only Canvas execution boundary",()=>{
 it("routes the ordinary Canvas producer exclusively through JobCoordinator",()=>{
  expect(page).toContain("startBackendComfyWorkflowRun({");
  expect(page).toContain("serverAuthoritative:true");
  expect(page).toContain("monitorSqliteJob(job.id)");
  expect(page).not.toContain("startComfyWorkflowRun(");
  expect(page).not.toContain("recoverPendingComfyRun(");
  expect(page).not.toContain("getComfyRun(");
  expect(page).not.toContain("createCanvasBackendSync(");
  expect(page).not.toContain("backendSyncRef");
  expect(page).toContain("不会回退旧 V2");
 });
 it("keeps run state in SQLite, not a browser-local pending payload",()=>{
  expect(panel).toContain('"/api/v1/jobs/snapshot"');
  expect(panel).not.toMatch(/localStorage\s*\.|sessionStorage\s*\.|indexedDB\s*\./);
  expect(panel).not.toContain("hasPendingComfyRun");
  expect(panel).not.toContain("recoverPendingComfyRun");
  expect(panel).not.toContain("getComfyRun");
 });
});
