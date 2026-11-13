/** P3c: read-only, backend-verified materialized output references.
 * An artifact is reusable only when the original Job, Task Step, CAS blob,
 * materialization, graph node, and immutable receipts all agree.
 * Never expose original prompt, credentials, file-system paths or media bytes.
 */
const validId=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const unpack=value=>{try{return JSON.parse(value)}catch{return null}};
const trusted=row=>row?.status==="succeeded"&&row?.receipt_trust==="server_committed"&&row?.superseded_at===null;
const stepIndex=(step)=>{const n=unpack(step.preconditions_json)?.runIndex;return Number.isInteger(n)&&n>=0?n:null};
export function trustedAssistantTaskOutputs(db,{projectId,taskId,planVersion}){
 if(!validId(projectId)||!validId(taskId)||!Number.isSafeInteger(planVersion)||planVersion<1)
  return [];
 const project=db.prepare("SELECT document_json FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId);
 const task=db.prepare("SELECT active_plan_version,project_id FROM assistant_tasks WHERE id=? AND project_id=?").get(taskId,projectId);
 if(!project||!task||planVersion!==task.active_plan_version)return [];
 const graph=unpack(project.document_json);
 if(!Array.isArray(graph?.nodes))return [];
 const nodeIds=new Set(graph.nodes.map(node=>node.id));
 const steps=db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL ORDER BY ordinal")
  .all(taskId,planVersion);
 const byId=new Map(steps.map(step=>[step.id,step])),results=[];
 for(const mat of steps){
  if(mat.kind!=="materialize"||!trusted(mat))continue;
  const pre=unpack(mat.preconditions_json),receipt=unpack(mat.receipt_json),
   action=unpack(mat.action_json),deps=unpack(mat.depends_on_json);
  if(!validId(pre?.sourceStepId)||!Array.isArray(deps)||!deps.includes(pre.sourceStepId)||
   !validId(action?.jobId)||receipt?.jobId!==action.jobId||
   !Array.isArray(action.artifactIds)||!Array.isArray(receipt?.bindings)||
   action.artifactIds.length===0||action.artifactIds.length!==receipt.bindings.length)
   continue;
  const source=byId.get(pre.sourceStepId);
  if(!trusted(source)||!["model_job","comfy_workflow"].includes(source.kind))continue;
  const sourceReceipt=unpack(source.receipt_json);
  if(sourceReceipt?.jobId!==action.jobId||!Array.isArray(sourceReceipt.artifactIds)||
   sourceReceipt.artifactIds.length!==action.artifactIds.length||
   new Set(sourceReceipt.artifactIds).size!==sourceReceipt.artifactIds.length||
   sourceReceipt.artifactIds.some(id=>!action.artifactIds.includes(id)))continue;
  const attempt=db.prepare("SELECT external_id,execution_key FROM assistant_task_attempts WHERE step_id=? AND external_kind='job' AND status='succeeded' ORDER BY attempt_no DESC LIMIT 1")
   .get(source.id);
  const job=db.prepare("SELECT status,idempotency_key FROM jobs WHERE id=? AND project_id=?").get(action.jobId,projectId);
  if(!attempt||attempt.external_id!==action.jobId||attempt.execution_key!==job?.idempotency_key||job.status!=="succeeded")continue;
  const bindings=new Map();
  let invalid=false;
  for(const binding of receipt.bindings){
   if(!validId(binding?.artifactId)||typeof binding?.nodeId!=="string"||!nodeIds.has(binding.nodeId)||
    bindings.has(binding.artifactId)){invalid=true;break}
   bindings.set(binding.artifactId,binding.nodeId);
  }
  if(invalid||bindings.size!==action.artifactIds.length||
   action.artifactIds.some(id=>!bindings.has(id)))continue;
  const artifacts=db.prepare("SELECT a.id,a.kind,a.port_id,a.sha256,a.blob_id,b.status AS blob_status,m.status AS materialization_status,m.node_id FROM artifacts a JOIN blobs b ON b.id=a.blob_id JOIN materializations m ON m.artifact_id=a.id AND m.project_id=? WHERE a.job_id=? ORDER BY a.id")
   .all(projectId,action.jobId);
  if(artifacts.length!==action.artifactIds.length||
   artifacts.some(row=>!bindings.has(row.id)||row.blob_status!=="ready"||
    row.materialization_status!=="materialized"||row.node_id!==bindings.get(row.id)))continue;
  for(const artifact of artifacts){
   results.push({sourceStepId:source.id,materialStepId:mat.id,
    runIndex:stepIndex(source),runSequenceId:unpack(source.preconditions_json)?.runSequenceId??null,
    jobId:action.jobId,artifactId:artifact.id,
    nodeId:artifact.node_id,kind:artifact.kind,portId:artifact.port_id??null,
    sha256:artifact.sha256});
  }
 }
 return results;
}
