import {describe,it,expect,vi,beforeEach,afterEach} from "vitest";
const api=vi.hoisted(()=>vi.fn());
vi.mock("./canvas-api",async(importOriginal)=>({
 ...(await importOriginal<typeof import("./canvas-api")>()),canvasApi:api
}));
import {canRetryCanvasMaterialization,canReconcileUnknownJob,getCanvasJobHistory,getCanvasSkillAudit,replayCanvasSkillJob,hasPendingSkillReplay,lookupPendingSkillReplay,retryCanvasMaterialization,recoverCanvasPendingMaterialization,reconcileCanvasUnknownJob,canRemoveCanvasJobHistory,removeCanvasJobHistory,getCanvasScriptAssets,reconcileCanvasScriptAsset,resumeCanvasScriptAssets,
 type CanvasJobHistoryItem,type CanvasJobArtifact} from "./canvas-job-history";

afterEach(()=>vi.unstubAllGlobals());
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
 it("only terminal tasks expose removal, pending/uncertain tasks remain protected",()=>{
  for(const status of ["succeeded","failed","cancelled"])
   expect(canRemoveCanvasJobHistory({...job,status})).toBe(true);
  for(const status of ["queued","preparing","submitting","running","collecting","submission_unknown","blocked_credential"])
   expect(canRemoveCanvasJobHistory({...job,status})).toBe(false);
 });
 it("history removal only sends scoped DELETE; no paid generation or artifact deletion",async()=>{
  api.mockResolvedValueOnce({hidden:true,jobId:"job-1"});
  await removeCanvasJobHistory("p1","job-1");
  expect(api).toHaveBeenCalledExactlyOnceWith("/api/v1/projects/p1/jobs/job-1/history","DELETE");
 });
 it("manual remote asset reconciliation only calls project-scoped endpoints without a second job POST",async()=>{
  api.mockResolvedValueOnce({jobId:"job-1",projectId:"p1",jobStatus:"failed",
   submissionNeverStarted:true,canResume:false,
   assets:[{referenceIndex:1,kind:"audio",role:"reference_audio",
    status:"uploading",updatedAt:12345}]});
  const audit=await getCanvasScriptAssets("p1","job-1");
  expect(audit.assets[0].status).toBe("uploading");
  expect(api).toHaveBeenNthCalledWith(1,"/api/v1/projects/p1/jobs/job-1/assets");
  api.mockResolvedValueOnce({status:"active"});
  await reconcileCanvasScriptAsset("p1","job-1",1,"confirm",12345,"verified-audio-1");
  expect(api).toHaveBeenNthCalledWith(2,
   "/api/v1/projects/p1/jobs/job-1/assets/1/reconcile","POST",{
    action:"confirm",expectedUpdatedAt:12345,operatorConfirmed:true,
    remoteAssetId:"verified-audio-1"});
  api.mockResolvedValueOnce({status:"rejected"});
  await reconcileCanvasScriptAsset("p1","job-1",1,"reject",12345);
  expect(api).toHaveBeenNthCalledWith(3,
   "/api/v1/projects/p1/jobs/job-1/assets/1/reconcile","POST",{
    action:"reject",expectedUpdatedAt:12345,operatorConfirmed:true});
  api.mockResolvedValueOnce({jobId:"job-1",status:"queued",resumed:true});
  const resumed=await resumeCanvasScriptAssets("p1","job-1");
  expect(resumed.status).toBe("queued");
  expect(api).toHaveBeenNthCalledWith(4,
   "/api/v1/projects/p1/jobs/job-1/resume-assets","POST",{});
  expect(api.mock.calls.some(([path])=>path==="/api/v1/jobs")).toBe(false);
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
 it("P5.4l resolves a lost paid replay reply with read-only lookup",async()=>{
  const project="p-lost",source="original-1";
  api.mockResolvedValueOnce({revision:8})
   .mockRejectedValueOnce(new Error("transport_closed"))
   .mockResolvedValueOnce({found:true,jobId:"accepted-123",status:"queued"});
  const started=await replayCanvasSkillJob(project,source);
  expect(started).toEqual({id:"accepted-123",existing:true,status:"queued"});
  expect(hasPendingSkillReplay(project,source)).toBe(false);
  expect(api.mock.calls.filter(args=>String(args[0]).includes("/replay-skills"))).toHaveLength(1);
  expect(api.mock.calls[2][0]).toContain("/replay-status?idempotencyKey=");
  const submitted=api.mock.calls[1][2] as {idempotencyKey:string};
  expect(api.mock.calls[2][0]).toContain(submitted.idempotencyKey);
 });
 it("P5.4l unknown replay stays pending across repeat clicks and never sends second POST",async()=>{
  const project="p-unknown",source="original-2";
  api.mockResolvedValueOnce({revision:9})
   .mockRejectedValueOnce(new Error("network_timeout"))
   .mockResolvedValueOnce({found:false});
  await expect(replayCanvasSkillJob(project,source))
   .rejects.toThrow("已保留原幂等键");
  expect(hasPendingSkillReplay(project,source)).toBe(true);
  api.mockResolvedValueOnce({found:false});
  await expect(replayCanvasSkillJob(project,source))
   .rejects.toThrow("不会重复提交");
  expect(api.mock.calls.filter(args=>String(args[0]).includes("/replay-skills"))).toHaveLength(1);
  const lookupUrls=api.mock.calls.filter(args=>String(args[0]).includes("/replay-status"));
  expect(lookupUrls).toHaveLength(2);
  expect(lookupUrls[0][0]).toBe(lookupUrls[1][0]);
  api.mockResolvedValueOnce({found:true,jobId:"confirmed",status:"running"});
  expect((await lookupPendingSkillReplay(project,source)).id).toBe("confirmed");
  expect(hasPendingSkillReplay(project,source)).toBe(false);
 });
 it("P5.4l definitive rejected replay with negative lookup can safely clear intent",async()=>{
  const project="p-rejected",source="original-3";
  const {CanvasApiError}=await import("./canvas-api");
  api.mockResolvedValueOnce({revision:3})
   .mockRejectedValueOnce(new CanvasApiError("skill_replay_source_changed",409))
   .mockResolvedValueOnce({found:false});
  await expect(replayCanvasSkillJob(project,source))
   .rejects.toMatchObject({code:"skill_replay_source_changed"});
  expect(hasPendingSkillReplay(project,source)).toBe(false);
 });
 it("P5.4l joins simultaneous clicks before a project GET can create two paid intents",async()=>{
  const project="p-same-tab",source="original-double";
  let resolveProject!:(value:{revision:number})=>void;
  const waiting=new Promise<{revision:number}>(resolve=>{resolveProject=resolve});
  api.mockImplementationOnce(()=>waiting).mockResolvedValueOnce({id:"only-one"});
  const first=replayCanvasSkillJob(project,source);
  const second=replayCanvasSkillJob(project,source);
  resolveProject({revision:5});
  expect(await first).toMatchObject({id:"only-one"});
  expect(await second).toMatchObject({id:"only-one"});
  expect(api.mock.calls.filter(call=>String(call[0]).includes("/replay-skills"))).toHaveLength(1);
  expect(api.mock.calls.filter(call=>call[0]==="/api/v1/projects/"+project)).toHaveLength(1);
 });
 it("P5.4l persists nonsecret replay UUID for reload and corrupt storage never triggers POST",async()=>{
  const saved=new Map<string,string>();
  vi.stubGlobal("localStorage",{
   getItem:(key:string)=>saved.get(key)??null,
   setItem:(key:string,value:string)=>{saved.set(key,value)},
   removeItem:(key:string)=>{saved.delete(key)}
  });
  const project="p-store",source="original-forever";
  api.mockResolvedValueOnce({revision:17})
   .mockRejectedValueOnce(new Error("connection lost"))
   .mockResolvedValueOnce({found:false});
  await expect(replayCanvasSkillJob(project,source)).rejects.toThrow("已保留原幂等键");
  expect(saved.size).toBe(1);
  const [key,intent]=[...saved.entries()][0];
  expect(JSON.parse(intent)).toEqual({
   idempotencyKey:expect.any(String),expectedProjectRevision:17
  });
  expect(intent).not.toContain("prompt");
  api.mockResolvedValueOnce({found:true,jobId:"recovered-job",status:"running"});
  expect((await lookupPendingSkillReplay(project,source)).id).toBe("recovered-job");
  expect(saved.size).toBe(0);
  saved.set(key,"corrupt JSON");
  expect(hasPendingSkillReplay(project,source)).toBe(true);
  await expect(replayCanvasSkillJob(project,source)).rejects.toThrow("skill_replay_intent_corrupt");
  expect(api.mock.calls.filter(call=>String(call[0]).includes("/replay-skills"))).toHaveLength(1);
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
