/** P4.7 bounded job history for a single Canvas project. Only public
 * progress metadata is returned: never snapshot_json, prompts, credentials,
 * remote task secrets or raw materialization payloads.
 */
const invalid=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const validId=id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
// Only allow coordinator-owned outcome codes into the public task history.
const outcomes=new Set(["prepare_failed","not_accepted","remote_failed","submission_unknown","blocked_credential","process_restarted","poll_failed","collect_pending","remote_pending","interrupted","succeeded"]);
export function listProjectJobs(db,{projectId,limit=20,before}={}){
 if(!validId(projectId)||!Number.isSafeInteger(limit)||limit<1||limit>50||
  before!==undefined&&!validId(before))throw invalid("invalid_project_job_history_request");
 const exists=db.prepare("SELECT id FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId);
 if(!exists)throw invalid("project_not_found",404);
 let cursor=null;
 if(before!==undefined){
  cursor=db.prepare("SELECT created_at,id FROM jobs WHERE id=? AND project_id=?").get(before,projectId);
  if(!cursor)throw invalid("invalid_project_job_history_cursor");
 }
 const rows=cursor?
  db.prepare(`SELECT * FROM jobs WHERE project_id=? AND
   (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`)
   .all(projectId,cursor.created_at,cursor.created_at,cursor.id,limit+1):
  db.prepare("SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?")
   .all(projectId,limit+1);
 const hasMore=rows.length>limit;
 const jobs=rows.slice(0,limit).map(job=>{
  // Do not expose task prompt, reference URLs, encrypted credential
  // versions, or arbitrary adapter-specific snapshots in history.
  const snapshot=JSON.parse(job.snapshot_json);
  const items=db.prepare(`SELECT a.id AS artifact_id,a.kind,
    COALESCE(m.status,'pending') AS status,m.reason,m.node_id
    FROM artifacts a LEFT JOIN materializations m
     ON m.job_id=a.job_id AND m.artifact_id=a.id AND m.project_id=?
    WHERE a.job_id=? ORDER BY a.port_id,a.item_key,a.id LIMIT 101`)
   .all(projectId,job.id);
  const truncated=items.length>100;
  const artifacts=items.slice(0,100).map(row=>({
   artifactId:row.artifact_id,kind:row.kind,status:row.status,
   reason:row.reason??null,nodeId:row.node_id??null
  }));
  const attempt=db.prepare("SELECT outcome FROM job_attempts WHERE job_id=? AND outcome IS NOT NULL ORDER BY started_at DESC,id DESC LIMIT 1").get(job.id);
  const lastOutcome=outcomes.has(attempt?.outcome)?attempt.outcome:null;
  const reconciliationEligible=job.status==="submission_unknown"&&
   snapshot.adapterKind==="comfy"&&job.execution_mode==="poll"&&
   typeof job.submit_marker==="string"&&!!job.submit_marker&&
   job.submission_started_at!==null&&job.lease_owner===null&&
   !!db.prepare("SELECT 1 FROM comfy_job_preparations WHERE job_id=?").get(job.id);
  return {id:job.id,projectId,sourceNodeId:job.target_node_id,
   createdAt:job.created_at,updatedAt:job.updated_at,status:job.status,lastOutcome,
   executionMode:job.execution_mode,reconciliationEligible,
   kind:snapshot.adapterKind==="model"?"model":
    snapshot.adapterKind==="comfy"?"comfy":"other",
   modelKind:snapshot.adapterKind==="model"?
    (["image","video","audio","text"].includes(snapshot.task?.kind)?snapshot.task.kind:null):null,
   hasSkillSnapshot:snapshot.adapterKind==="model"&&snapshot.provider==="openai"&&
    snapshot.task?.kind==="text"&&typeof snapshot.task?.skills?.blobId==="string",
   artifacts,artifactsTruncated:truncated};
 });
 return {jobs,nextBefore:hasMore?jobs.at(-1).id:null};
}
