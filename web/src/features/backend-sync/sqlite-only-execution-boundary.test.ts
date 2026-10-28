import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

const page=readFileSync(new URL("../../pages/canvas/project.tsx",import.meta.url),"utf8");
const panel=readFileSync(new URL("../comfy-workflow/comfy-workflow-instance-panel.tsx",import.meta.url),"utf8");
const runTypes=readFileSync(new URL("../comfy-workflow/run-types.ts",import.meta.url),"utf8");

describe("P4.2 SQLite-only Canvas execution boundary",()=>{
 it("routes the ordinary Canvas producer exclusively through JobCoordinator",()=>{
  expect(page).toContain("startBackendComfyWorkflowRun({");
  expect(page).not.toContain("serverAuthoritative:true");
  const comfyRun=readFileSync(new URL("./backend-comfy-run.ts",import.meta.url),"utf8");
  expect(comfyRun).not.toMatch(/backendPendingKey|backendLastJobKey|localStorage|args\.pending|serverAuthoritative/);
  expect(comfyRun).toContain("await bridge.assertNoActiveJob(workflowNode.id)");
  expect(page).toContain("monitorSqliteJob(job.id)");
  expect(page).not.toContain("startComfyWorkflowRun(");
  expect(page).not.toContain("recoverPendingComfyRun(");
  expect(page).not.toContain("getComfyRun(");
  expect(page).not.toContain("createCanvasBackendSync(");
  expect(page).not.toContain("backendSyncRef");
  expect(page).toContain("不会回退旧 V2");
 });
 it("P4.6 official retry cannot fall into the legacy browser generation branch",()=>{
  const retry=page.slice(page.indexOf("const handleRetryNode = useCallback("),
   page.indexOf("const deleteBatchImage = useCallback("));
  const sqliteRoute=retry.indexOf("if(modelChannelProvider(retryChannel,retryMode))");
  const durableSubmit=retry.indexOf("await handleGenerateNode(sqliteSource.id,retryMode,retryPrompt,generationConfig)");
  const legacyVideo=retry.indexOf("await requestVideoGeneration(");
  const legacyAudio=retry.indexOf("await requestAudioGeneration(");
  const legacyImage=retry.indexOf("await requestGeneration(");
  expect(sqliteRoute).toBeGreaterThan(0);
  expect(durableSubmit).toBeGreaterThan(sqliteRoute);
  expect(legacyVideo).toBeGreaterThan(durableSubmit);
  expect(legacyAudio).toBeGreaterThan(durableSubmit);
  expect(legacyImage).toBeGreaterThan(durableSubmit);
  expect(retry.slice(durableSubmit,legacyVideo)).toMatch(/return;\s*}\s*if \(!isAiConfigReady/);
  expect(page).toContain("sqliteModelSubmitLocksRef.current.add(submissionKey)");
  expect(page).toContain("finally{sqliteModelSubmitLocksRef.current.delete(submissionKey)}");
 });
 it("does not leave a browser Gateway Runner or duplicate submission and input store",()=>{
  expect(runTypes).not.toMatch(/\/api\/comfy|\/runs|\/inputs|localStorage|fetch\(/);
  expect(panel).toContain('from "./run-types"');
  expect(page).toContain('from "@/features/comfy-workflow/run-types"');
 });
 it("does not revive retired browser Ark video polling, cancellation or media retries",()=>{
  expect(page).not.toMatch(/\bpollVideoGenerationTask\b|\bretrySeedanceDownload\b|\bcancelVideoGenerationTask\b/);
  expect(page).not.toContain("resumedArkTasksRef");
  expect(page).not.toContain("Unable to resume Ark video task");
  expect(page).toContain("resetInterruptedGeneration(project.nodes)");
  const retry=page.slice(page.indexOf("const handleRetryNode = useCallback("),
   page.indexOf("const deleteBatchImage = useCallback("));
  expect(retry).toContain("旧 Ark 视频任务无法从浏览器重新下载");
 });
 it("keeps run state in SQLite, not a browser-local pending payload",()=>{
  expect(panel).toContain('"/api/v1/jobs/snapshot"');
  expect(panel).not.toMatch(/localStorage\s*\.|sessionStorage\s*\.|indexedDB\s*\./);
  expect(panel).not.toContain("hasPendingComfyRun");
  expect(panel).not.toContain("recoverPendingComfyRun");
  expect(panel).not.toContain("getComfyRun");
 });
});
