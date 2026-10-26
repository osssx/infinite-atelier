import {describe,it,expect,vi,beforeEach} from "vitest";
const api=vi.hoisted(()=>vi.fn());
vi.mock("./canvas-api",()=>({canvasApi:api}));
import {canRetryCanvasMaterialization,getCanvasJobHistory,retryCanvasMaterialization,recoverCanvasPendingMaterialization,
 type CanvasJobHistoryItem,type CanvasJobArtifact} from "./canvas-job-history";

const job:CanvasJobHistoryItem={
 id:"job-1",projectId:"p1",sourceNodeId:"node-1",
 createdAt:1,updatedAt:2,status:"succeeded",lastOutcome:null,executionMode:"poll",
 kind:"model",modelKind:"image",artifacts:[],artifactsTruncated:false
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
