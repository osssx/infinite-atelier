/** P4.4b post-commit hints only: SQLite remains the authority.
 * Never enqueue a Job, spawn a Skill, call a Provider, or mutate the graph.
 */
import {createHash} from "node:crypto";
import {stableJson,writeTransaction} from "./repository.mjs";
import {continueAssistantTaskSafely} from "./assistant-task-safe-continuation.mjs";

const validId=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const hash=x=>createHash("sha256").update(stableJson(x)).digest("hex");
const FINAL_JOB=new Set(["succeeded","failed","cancelled","submission_unknown"]);
const FINAL_MATERIAL=new Set(["materialized","blocked"]);
const FINAL_SKILL=new Set(["completed","failed","cancelled","needs_reconcile"]);
const MAX_QUEUE=1024;
function lookupTasks(db,{kind,sourceId,projectId,taskId}){
 if(kind==="job"){
  const job=db.prepare("SELECT id,project_id,status FROM jobs WHERE id=?").get(sourceId);
  if(!job||!FINAL_JOB.has(job.status))return [];
  return db.prepare(`SELECT DISTINCT t.id AS taskId,t.project_id AS projectId,
     t.active_plan_version AS planVersion,? AS evidenceStatus
    FROM assistant_task_attempts a
    JOIN assistant_task_steps s ON s.id=a.step_id AND s.task_id=a.task_id
    JOIN assistant_tasks t ON t.id=a.task_id AND t.project_id=a.project_id
    WHERE a.external_kind='job' AND a.external_id=?
      AND s.plan_version=t.active_plan_version AND s.superseded_at IS NULL
      AND t.read_only=0 AND t.cancel_requested_at IS NULL`)
   .all(job.status,job.id).filter(row=>row.projectId===job.project_id);
 }
 if(kind==="materialization"){
  const material=db.prepare(`SELECT a.job_id AS jobId,m.status
   FROM artifacts a JOIN jobs j ON j.id=a.job_id
   JOIN materializations m ON m.artifact_id=a.id AND m.project_id=j.project_id
   WHERE a.id=? ORDER BY m.rowid DESC LIMIT 1`).get(sourceId);
  if(!material||!FINAL_MATERIAL.has(material.status))return [];
  return lookupTasks(db,{kind:"job",sourceId:material.jobId})
   .map(row=>({...row,evidenceStatus:material.status}));
 }
 if(kind==="skill"){
  const run=db.prepare("SELECT status,project_id FROM skill_script_runs WHERE id=?").get(sourceId);
  if(!run||!FINAL_SKILL.has(run.status))return [];
  return db.prepare(`SELECT DISTINCT t.id AS taskId,t.project_id AS projectId,
   t.active_plan_version AS planVersion,? AS evidenceStatus
   FROM assistant_task_attempts a
   JOIN assistant_task_steps s ON s.id=a.step_id AND s.task_id=a.task_id
   JOIN assistant_tasks t ON t.id=a.task_id AND t.project_id=a.project_id
   WHERE a.external_kind='skill_run' AND a.external_id=?
     AND s.plan_version=t.active_plan_version AND s.superseded_at IS NULL
     AND t.read_only=0 AND t.cancel_requested_at IS NULL`)
   .all(run.status,sourceId).filter(row=>row.projectId===run.project_id);
 }
 if(kind==="startup"){
  const row=db.prepare(`SELECT t.id AS taskId,t.project_id AS projectId,
    t.active_plan_version AS planVersion,t.status AS evidenceStatus,p.revision AS projectRevision
    FROM assistant_tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL
    WHERE t.id=? AND t.project_id=? AND t.read_only=0
     AND t.cancel_requested_at IS NULL`).get(taskId,projectId);
  if(!row)return [];
  // Catch-up request identity must include durable external evidence. A
  // materialization committed after an earlier startup can have the same Task
  // status; the next boot still needs to process that new receipt.
  const steps=db.prepare(`SELECT id,status,receipt_trust,attempt_count
   FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL
   ORDER BY ordinal`).all(taskId,row.planVersion);
  const jobs=db.prepare(`SELECT j.id,j.status,j.updated_at
   FROM jobs j JOIN assistant_task_attempts a ON a.external_id=j.id AND a.external_kind='job'
   JOIN assistant_task_steps s ON s.id=a.step_id AND s.plan_version=?
   WHERE a.task_id=? ORDER BY j.id`).all(row.planVersion,taskId);
  const mats=db.prepare(`SELECT m.artifact_id,m.status,m.node_id
   FROM materializations m JOIN assistant_task_attempts a
    ON a.external_id=m.job_id AND a.external_kind='job'
   JOIN assistant_task_steps s ON s.id=a.step_id AND s.plan_version=?
   WHERE a.task_id=? AND m.project_id=? ORDER BY m.artifact_id`)
   .all(row.planVersion,taskId,row.projectId);
  const skills=db.prepare(`SELECT r.id,r.status,r.updated_at
   FROM skill_script_runs r JOIN assistant_task_attempts a ON a.external_id=r.id
   JOIN assistant_task_steps s ON s.id=a.step_id AND s.plan_version=?
   WHERE a.task_id=? AND a.external_kind='skill_run' ORDER BY r.id`)
   .all(row.planVersion,taskId);
  const blobs=db.prepare(`SELECT ar.id,ar.sha256,b.id AS blobId,b.sha256 AS blobSha256,b.status
   FROM artifacts ar JOIN blobs b ON b.id=ar.blob_id
   JOIN assistant_task_attempts a ON a.external_id=ar.job_id AND a.external_kind='job'
   JOIN assistant_task_steps s ON s.id=a.step_id AND s.plan_version=? AND s.superseded_at IS NULL
   WHERE a.task_id=? ORDER BY ar.id`).all(row.planVersion,taskId);
  return [{...row,evidenceStatus:hash({projectRevision:row.projectRevision,steps,jobs,mats,skills,blobs})}];
 }
 return [];
}
const actionable=(db,row)=>{
 const task=db.prepare("SELECT status,read_only,cancel_requested_at,active_plan_version FROM assistant_tasks WHERE id=? AND project_id=?").get(row.taskId,row.projectId);
 return !!task&&!task.read_only&&task.cancel_requested_at===null&&
  task.active_plan_version===row.planVersion&&
  ["ready","planning","waiting_external","needs_reconcile","blocked","waiting_approval"].includes(task.status);
};
/** Event identities are hints only; every claimed status is re-read from SQLite. */
export function createAssistantTaskContinuationEvents({db,onError=()=>{}}={}){
 if(!db)throw Error("assistant_continuation_db_required");
 const pending=new Map();
 function notify(kind,sourceId){
  if(!["job","materialization","skill"].includes(kind)||!validId(sourceId))return false;
  const key=kind+":"+sourceId;
  if(pending.has(key))return false;
  if(pending.size>=MAX_QUEUE)throw Error("assistant_continuation_queue_full");
  pending.set(key,{kind,sourceId});return true;
 }
 const notifyJob=jobId=>notify("job",jobId);
 const notifyMaterialization=artifactId=>notify("materialization",artifactId);
 const notifySkill=runId=>notify("skill",runId);
 function progress(row,kind,sourceId,result){
  if(!result.checkpoints?.length&&!result.reconciledJobs)return;
  writeTransaction(db,()=>{
   db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,'external_continuation_progress',?,?)")
    .run(row.taskId,stableJson({sourceKind:kind,sourceId,
     planVersion:row.planVersion,taskStatus:result.taskStatus,
     checkpoints:result.checkpoints.map(c=>({kind:c.kind,index:c.index})),
     reconciledJobs:result.reconciledJobs,executionStarted:false}),Date.now());
  });
 }
 function apply(kind,sourceId,{projectId,taskId}={}){
  const rows=lookupTasks(db,{kind,sourceId,projectId,taskId}),out=[];
  for(const row of rows){
   if(!actionable(db,row))continue;
   const requestId="ae_"+hash({kind,sourceId,taskId:row.taskId,
    plan:row.planVersion,status:row.evidenceStatus}).slice(0,38);
   try{
    const result=continueAssistantTaskSafely(db,{
     projectId:row.projectId,taskId:row.taskId,requestId,expectedPlanVersion:row.planVersion});
    if(!result.existing)progress(row,kind,sourceId,result);
    out.push({taskId:row.taskId,planVersion:row.planVersion,
     taskStatus:result.taskStatus,checkpoints:result.checkpoints?.length??0,
     nextNeedsApproval:result.requiresApproval===true,reason:result.reason??null});
   }catch(error){
    try{onError({kind,sourceId,taskId:row.taskId,code:error?.code??"assistant_event_continuation_failed"})}catch{}
    // Never roll back the original Job/Skill result. Startup replays persisted receipts.
   }
  }
  return out;
 }
 function drain({maxSignals=128}={}){
  if(!Number.isSafeInteger(maxSignals)||maxSignals<1||maxSignals>MAX_QUEUE)
   throw Error("assistant_continuation_limit_invalid");
  const handled=[],errors=[],signals=[...pending.entries()].slice(0,maxSignals);
  for(const [key,signal] of signals){
   pending.delete(key);
   try{handled.push(...apply(signal.kind,signal.sourceId))}
   catch(error){
    errors.push(error?.code??"assistant_event_continuation_failed");
    try{onError({kind:signal.kind,sourceId:signal.sourceId,code:errors.at(-1)})}catch{}
   }
  }
  return {signals:signals.length,handled,errors,pending:pending.size};
 }
 /** Boot reconciliation is one bounded pass; no upstream status polling or POST. */
 function catchUp({limit=256}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>10000)
   throw Error("assistant_continuation_limit_invalid");
  const rows=db.prepare(`SELECT DISTINCT t.project_id AS projectId,t.id AS taskId
   FROM assistant_tasks t JOIN assistant_task_steps s ON s.task_id=t.id
   WHERE t.read_only=0 AND t.cancel_requested_at IS NULL
    AND t.status IN ('ready','planning','waiting_external','needs_reconcile','blocked')
    AND s.plan_version=t.active_plan_version AND s.superseded_at IS NULL
    AND s.kind IN ('model_job','comfy_workflow','materialize','skill_script')
    AND s.status IN ('waiting_external','succeeded','needs_reconcile','blocked')
   ORDER BY t.updated_at DESC,t.id LIMIT ?`).all(limit);
  const handled=[];
  for(const row of rows)handled.push(...apply("startup",row.taskId,row));
  return {scanned:rows.length,handled};
 }
 return {notifyJob,notifyMaterialization,notifySkill,drain,catchUp,
  pending:()=>pending.size};
}
