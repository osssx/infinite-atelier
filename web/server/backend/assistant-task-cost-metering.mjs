/** P4.4d: strict, durable provider-reported token metering for Task jobs.
 * Provider usage is NOT an invoice or a proven price. No monetary authorization
 * can be derived from these records; ambiguous completion always stays unknown.
 */
import {stableJson,writeTransaction} from "./repository.mjs";
const id=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const TOKEN_LIMIT=1_000_000_000;
const token=n=>Number.isSafeInteger(n)&&n>=0&&n<=TOKEN_LIMIT;
export function normalizeAssistantTokenUsage(raw){
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 // Only the Chat Completions token counters have a known interoperable shape.
 // Refuse strings, negative values, overflow, and inconsistent totals.
 const {prompt_tokens:input,completion_tokens:output,total_tokens:total}=raw;
 if(!token(input)||!token(output)||!token(total)||total===0||input+output!==total)
  return null;
 return {inputTokens:input,outputTokens:output,totalTokens:total};
}
const kinds=["model_usage_reported","model_usage_unusable"];
export function recordAssistantModelUsage(db,{jobId,usage}={}){
 if(!id(jobId))throw fail("assistant_usage_invalid",400);
 // Called ONLY by the model adapter with the parsed upstream response.
 return writeTransaction(db,()=>{
  const row=db.prepare("SELECT id,snapshot_json FROM jobs WHERE id=?").get(jobId);
  if(!row)throw fail("job_not_found",404);
  const snap=JSON.parse(row.snapshot_json);
  if(snap.adapterKind!=="model"||snap.task?.kind!=="text"||
   !["openai","openai_compatible"].includes(snap.provider))
   throw fail("assistant_usage_source_unsupported",400);
  const normalized=normalizeAssistantTokenUsage(usage);
  const eventType=normalized?"model_usage_reported":"model_usage_unusable";
  const body=normalized?{version:1,source:"upstream_response",...normalized}:{
   version:1,source:"upstream_response",reason:"invalid_token_counters"};
  const old=db.prepare("SELECT kind,payload_json FROM job_events WHERE job_id=? "+
   "AND kind IN ('model_usage_reported','model_usage_unusable') ORDER BY seq LIMIT 1").get(jobId);
  if(old){
   if(old.kind!==eventType||old.payload_json!==stableJson(body))
    throw fail("assistant_usage_conflicting_receipt");
   return {status:normalized?"reported":"unusable",existing:true};
  }
  db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
   .run(jobId,eventType,stableJson(body),Date.now());
  return {status:normalized?"reported":"unusable",existing:false};
 });
}
const invoiceCapability={
 // No provider-verified price version, preflight upper bound or billing invoice:
 // there cannot be a trustworthy monetary reservation or settlement.
 currency:null,rateCardVersion:null,preflightMaxChargeMicros:null,
 reservationSupported:false,settlementSupported:false,hardCapSupported:false,
 settledAmountMicros:null,
 reason:"verified_provider_invoice_and_bounded_preflight_quote_unavailable"
};
const tokensZero=()=>({inputTokens:0,outputTokens:0,totalTokens:0});
export function getAssistantTaskCostReport(db,{projectId,taskId}={}){
 if(!id(projectId)||!id(taskId))throw fail("assistant_usage_invalid",400);
 const task=db.prepare("SELECT id FROM assistant_tasks WHERE id=? AND project_id=?").get(taskId,projectId);
 if(!task)throw fail("assistant_task_not_found",404);
 const attempts=db.prepare("SELECT DISTINCT external_id FROM assistant_task_attempts "+
  "WHERE project_id=? AND task_id=? AND external_kind='job' AND external_id IS NOT NULL "+
  "ORDER BY external_id").all(projectId,taskId);
 const rows=[],known=tokensZero();
 for(const {external_id:jobId} of attempts){
  const job=db.prepare("SELECT id,project_id,status,snapshot_json,submission_started_at,submit_marker FROM jobs WHERE id=? AND project_id=?")
   .get(jobId,projectId);
  if(!job)continue;
  const snap=JSON.parse(job.snapshot_json);
  const events=db.prepare("SELECT kind,payload_json FROM job_events WHERE job_id=? "+
   "AND kind IN ('model_usage_reported','model_usage_unusable') ORDER BY seq").all(jobId);
  const single=events.length===1?events[0]:null;
  let usage=null;
  if(single?.kind==="model_usage_reported"){
   const data=JSON.parse(single.payload_json);
   if(data?.version===1&&data?.source==="upstream_response"&&
    token(data.inputTokens)&&token(data.outputTokens)&&
    token(data.totalTokens)&&data.inputTokens+data.outputTokens===data.totalTokens)
    usage={inputTokens:data.inputTokens,outputTokens:data.outputTokens,
     totalTokens:data.totalTokens};
  }
  // A successful Job with upstream counters is still NOT proof of charge.
  // Failed/submission_unknown/cancelled jobs may have been billed; never
  // imply that 0 reported tokens means 0 cost.
  const metering=job.status==="succeeded"?
   usage?"upstream_reported":"usage_unavailable":
   job.submission_started_at!==null||job.submit_marker!==null?
    "billing_unverified":"not_submitted";
  if(metering==="upstream_reported"){
   known.inputTokens+=usage.inputTokens;known.outputTokens+=usage.outputTokens;
   known.totalTokens+=usage.totalTokens;
  }
  rows.push({jobId:job.id,status:job.status,adapterKind:snap.adapterKind??null,
   provider:snap.adapterKind==="model"?snap.provider??null:null,
   model:snap.adapterKind==="model"?snap.task?.model??null:null,
   metering,usage:metering==="upstream_reported"?usage:null,
   amountMicros:null,amountAuthority:"unavailable"});
 }
 // AI Assistant chat/completion calls live outside the Job queue and currently
 // have no consumption receipt. Count them explicitly to prevent a falsely
 // comprehensive "Task total cost" reading.
 const assistantModelCalls=db.prepare("SELECT status,COUNT(*) n FROM assistant_model_calls "+
  "WHERE project_id=? AND task_id=? GROUP BY status").all(projectId,taskId);
 const inferenceCount=assistantModelCalls.reduce((n,row)=>n+row.n,0);
 const summary={jobCount:rows.length,reportedJobCount:rows.filter(x=>x.metering==="upstream_reported").length,
  unavailableJobCount:rows.filter(x=>x.metering==="usage_unavailable").length,
  billingUnverifiedJobCount:rows.filter(x=>x.metering==="billing_unverified").length,
  notSubmittedJobCount:rows.filter(x=>x.metering==="not_submitted").length,
  assistantInferenceCallCount:inferenceCount,
  assistantInferenceUsageUnavailableCount:inferenceCount,
  upstreamReportedTokens:known,
  totalSettledAmountMicros:null};
 return {taskId,projectId,summary,jobs:rows,monetary:invoiceCapability,
  // This version provides read-only evidence. There is no authoritative rate
  // catalog, actual billing receipt, or safe dollar reservation mechanism.
  capabilities:{textTokenUsage:"provider_reported_when_present",
   otherMediaUsage:"unavailable",assistantInferenceUsage:"unavailable",
   hardAmountBudget:false}};
}
