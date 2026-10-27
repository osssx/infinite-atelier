import {describe,it,expect,vi,beforeEach} from "vitest";
const api=vi.hoisted(()=>vi.fn());
vi.mock("./canvas-api",()=>({canvasApi:api}));
import {canRetryCanvasMaterialization,canReconcileUnknownJob,getCanvasJobHistory,getCanvasSkillAudit,replayCanvasSkillJob,retryCanvasMaterialization,recoverCanvasPendingMaterialization,reconcileCanvasUnknownJob,
 type CanvasJobHistoryItem,type CanvasJobArtifact} from "./canvas-job-history";

const job:CanvasJobHistoryItem={
 id:"job-1",projectId:"p1",sourceNodeId:"node-1",
 createdAt:1,updatedAt:2,status:"succeeded",lastOutcome:null,executionMode:"poll",
 kind:"model",modelKind:"image",reconciliationEligible:false,artifacts:[],artifactsTruncated:false
};
const artifact:CanvasJobArtifact={artifactId:"artifact-1",kind:"image",
 status:"blocked",reason:"materialization_source_changed",nodeId:null};
describe("P4.7 Canvas job history and recovery boundary",()=>{
 beforeEach(()=>api.mockReset());
 it("only succeeded job with a blocked existing artifact can be requeued",()=>{
  expect(canRetryCanvasMaterialization(job,artifact)).toBe(true);
  for(const status of ["submission_unknown","blocked_credential","queued","failed","cancelled"]){
   expect(canRetryCanvasMaterialization({...job,status},artifact)).toBe(false);
  }
  for(const status of ["retry","pending","materialized"]){
   expect(canRetryCanvasMaterialization(job,{...artifact,status})).toBe(false);
  }
 });
 it("uses bounded per-project history and cursor without leaking into global snapshot",async()=>{
  api.mockResolvedValueOnce({jobs:[job],nextBefore:"job-1"});
  expect(await getCanvasJobHistory("p1")).toMatchObject({nextBefore:"job-1"});
  expect(api).toHaveBeenNthCalledWith(1,"/api/v1/projects/p1/jobs?limit=20");
  api.mockResolvedValueOnce({jobs:[],nextBefore:null});
  await getCanvasJobHistory("p1","job-1");
  expect(api).toHaveBeenNthCalledWith(2,"/api/v1/projects/p1/jobs?limit=20&before=job-1");
 });
 it("P4.8 only eligible unknown Comfy task offers human reconciliation",()=>{
  const ready={...job,status:"submission_unknown",kind:"comfy" as const,reconciliationEligible:true};
  expect(canReconcileUnknownJob(ready)).toBe(true);
  expect(canReconcileUnknownJob({...ready,kind:"model"})).toBe(false);
  expect(canReconcileUnknownJob({...ready,status:"blocked_credential"})).toBe(false);
  expect(canReconcileUnknownJob({...ready,reconciliationEligible:false})).toBe(false);
 });
 it("P4.8 reconciliation requests only the existing remote GET identity through backend",async()=>{
  api.mockResolvedValueOnce({verified:true,status:"running"});
  expect(await reconcileCanvasUnknownJob("p1","job-1","remote-1"))
   .toMatchObject({verified:true,status:"running"});
  expect(api).toHaveBeenCalledExactlyOnceWith(
   "/api/v1/projects/p1/jobs/job-1/reconcile","POST",{remoteTaskId:"remote-1"});
  expect(api.mock.calls.some(call=>call[0]==="/api/v1/jobs")).toBe(false);
 });
 it("P5.4g reads only project-scoped Skill audit and replays after current revision fence",async()=>{
  api.mockResolvedValueOnce({jobId:"job-1",status:"succeeded",
   canReplay:true,versionPins:[{skillId:"camera",version:"v1",name:"Camera"}],toolEvents:[]});
  const audit=await getCanvasSkillAudit("p1","job-1");
  expect(audit.versionPins[0].version).toBe("v1");
  expect(api).toHaveBeenNthCalledWith(1,
   "/api/v1/projects/p1/jobs/job-1/skill-audit");
  api.mockResolvedValueOnce({revision:3}).mockResolvedValueOnce({id:"replay-id"});
  const value=await replayCanvasSkillJob("p1","job-1");
  expect(value.id).toBe("replay-id");
  expect(api).toHaveBeenNthCalledWith(2,"/api/v1/projects/p1");
  expect(api).toHaveBeenNthCalledWith(3,"/api/v1/projects/p1/jobs/job-1/replay-skills",
   "POST",expect.objectContaining({
    expectedProjectRevision:3,
    idempotencyKey:expect.any(String),requestFingerprint:expect.any(String)
   }));
  const submitted=api.mock.calls[2][2] as {idempotencyKey:string;requestFingerprint:string};
  expect(submitted.requestFingerprint).toBe(submitted.idempotencyKey);
  expect(api.mock.calls.some(args=>args[0]==="/api/v1/jobs")).toBe(false);
 });
 it("pending artifact recovery only invokes the direct Materializer endpoint",async()=>{
  api.mockResolvedValueOnce({artifactId:"artifact-1",status:"materialized",reason:null});
  expect(await recoverCanvasPendingMaterialization("p1","artifact-1"))
   .toMatchObject({status:"materialized"});
  expect(api).toHaveBeenCalledExactlyOnceWith(
   "/api/v1/projects/p1/materializations/artifact-1/recover","POST",{});
  expect(api.mock.calls.some(args=>args[0]==="/api/v1/jobs")).toBe(false);
 });
 it("manual recovery only invokes materialization retry, never job submission",async()=>{
  api.mockResolvedValueOnce({requeued:true});
  await retryCanvasMaterialization("p1","artifact-1");
  expect(api).toHaveBeenCalledExactlyOnceWith(
   "/api/v1/projects/p1/materializations/artifact-1/retry","POST",{});
  expect(api.mock.calls.some(args=>args[0]==="/api/v1/jobs")).toBe(false);
 });
});
