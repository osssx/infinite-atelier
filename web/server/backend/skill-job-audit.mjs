import {submitJob,fingerprintSource} from "./repository.mjs";
import {loadFrozenSkillCatalog} from "./sqlite-skill-agent.mjs";
const bad=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const valid=id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
function mustFind(db,projectId,jobId){
 if(!valid(projectId)||!valid(jobId))throw bad("skill_job_invalid_request",400);
 const job=db.prepare("SELECT * FROM jobs WHERE id=? AND project_id=?").get(jobId,projectId);
 if(!job)throw bad("skill_job_not_found",404);
 const snapshot=JSON.parse(job.snapshot_json);
 if(snapshot.adapterKind!=="model"||snapshot.provider!=="openai"||
  snapshot.task?.kind!=="text"||!snapshot.task.skills?.blobId)
  throw bad("skill_job_not_supported");
 return {job,snapshot};
}
export async function getProjectSkillAudit(db,blobStore,{projectId,jobId}){
 const {job,snapshot}=mustFind(db,projectId,jobId);
 const skills=await loadFrozenSkillCatalog(blobStore,snapshot.task.skills);
 const events=db.prepare("SELECT seq,kind,payload_json,created_at FROM job_events WHERE job_id=? AND kind IN ('skill_tool','skill_run_completed') ORDER BY seq LIMIT 129").all(jobId);
 const toolEvents=events.filter(item=>item.kind==="skill_tool").slice(0,96).map(item=>{
  const payload=JSON.parse(item.payload_json);
  return {eventId:item.seq,at:item.created_at,status:payload.status,round:payload.round,
   callId:payload.callId,name:payload.name,skillId:payload.skillId??null};
 }).filter(item=>["started","completed"].includes(item.status)&&
   ["search_skills","activate_skill","read_skill_resource"].includes(item.name));
 const completion=events.find(item=>item.kind==="skill_run_completed");
 const versionPins=[...skills.values()].map(s=>({skillId:s.id,version:s.version,name:s.name.slice(0,100)}));
 return {jobId,sourceNodeId:job.target_node_id,status:job.status,
  canReplay:job.status==="succeeded",versionPins,toolEvents,
  ...(completion?{summary:JSON.parse(completion.payload_json)}:{})};
}
/** Explicit paid NEW job. Same project, unchanged source fingerprint and
 * immutable prior snapshot. No retries of unknown/failed submissions.
 */
export function replayProjectSkillJob(db,{
 projectId,jobId,expectedProjectRevision,idempotencyKey,requestFingerprint
}){
 const {job,snapshot}=mustFind(db,projectId,jobId);
 if(job.status!=="succeeded"||job.execution_mode!=="immediate"||
   !valid(job.target_node_id))throw bad("skill_replay_source_not_succeeded");
 if(!Number.isSafeInteger(expectedProjectRevision)||expectedProjectRevision<1||
   !valid(idempotencyKey)||!valid(requestFingerprint))
  throw bad("skill_replay_invalid_request",400);
 // The task remains identical to the prior successful generation, including
 // frozen catalog, model, prompt, system messages and credential-version fence.
 const project=db.prepare("SELECT document_json,revision,deleted_at FROM projects WHERE id=?").get(projectId);
 if(!project||project.deleted_at!==null||project.revision!==expectedProjectRevision)
  throw bad("skill_replay_source_changed");
 const currentFingerprint=fingerprintSource(JSON.parse(project.document_json),job.target_node_id);
 if(currentFingerprint!==job.source_fingerprint)
  throw bad("skill_replay_source_changed");
 return submitJob(db,{projectId,targetNodeId:job.target_node_id,
  expectedProjectRevision,sourceNodeFingerprint:job.source_fingerprint,
  idempotencyKey,requestFingerprint,executionMode:"immediate",snapshot});
}
