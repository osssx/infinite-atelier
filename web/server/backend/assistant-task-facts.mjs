/** P3 durable Task fact projection.
 * Data authority: SQLite Task/Step receipts, not model text, client observations,
 * or claimed Job IDs in the user's prompt. The source rows remain authoritative.
 * The projection is a bounded provider hint, never a Step execution receipt.
 */
import {stableJson} from "./repository.mjs";

const KINDS=["canvas_mutation","model_job","comfy_workflow","skill_script","materialize"];
const STAGES=["pending","ready","waiting_approval","submitting","running","waiting_external",
 "needs_reconcile","failed","blocked","skipped","succeeded"];
const fresh=()=>Object.fromEntries(STAGES.map(key=>[key,0]));
const bounded=(value,n)=>typeof value==="string"?value.slice(0,n):"";
function recentTurn(row){
 let data;
 try{data=JSON.parse(row.payload_json)}catch{return null}
 if(!data||typeof data!=="object"||!data.contextPolicy||typeof data.contextPolicy.includeContext!=="boolean"||
  !["selection","overview"].includes(data.contextPolicy.scope))return null;
 const policy=data.contextPolicy;
 return {messageId:bounded(data.messageId,128),preview:bounded(data.preview,160),
  requestDigest:bounded(data.requestDigest,64),
  contextPolicy:{includeContext:policy.includeContext,scope:policy.scope,
   includedIds:Array.isArray(policy.includedIds)?policy.includedIds.filter(v=>typeof v==="string").slice(0,12):[]}};
}
export function deriveAssistantTaskFacts(db,task){
 const taskId=task.id,planVersion=task.active_plan_version;
 const steps=db.prepare("SELECT kind,status,receipt_trust,plan_version,superseded_at,result_json FROM assistant_task_steps WHERE task_id=? ORDER BY plan_version,ordinal").all(taskId);
 const active=steps.filter(row=>row.plan_version===planVersion&&row.superseded_at===null);
 const stages=fresh(),trusted=Object.fromEntries(KINDS.map(kind=>[kind,0]));
 let trustedSteps=0,unverifiedSuccess=0,materializedBindings=0,confirmedArtifacts=0,appliedCanvasActions=0;
 for(const row of active){
  if(Object.hasOwn(stages,row.status))stages[row.status]++;
  if(row.status!=="succeeded")continue;
  if(row.receipt_trust!=="server_committed"){unverifiedSuccess++;continue}
  trustedSteps++;
  if(Object.hasOwn(trusted,row.kind))trusted[row.kind]++;
  let result;
  try{result=JSON.parse(row.result_json)}catch{continue}
  if(row.kind==="materialize"&&Array.isArray(result?.bindings))
   materializedBindings+=result.bindings.length;
  if(["model_job","comfy_workflow"].includes(row.kind)&&Array.isArray(result?.artifactIds))
   confirmedArtifacts+=result.artifactIds.length;
  if(row.kind==="canvas_mutation"&&Number.isInteger(result?.applied)&&result.applied>=0)
   appliedCanvasActions+=result.applied;
 }
 const turns=db.prepare("SELECT payload_json FROM assistant_task_events WHERE task_id=? AND kind='user_turn' ORDER BY seq DESC LIMIT 20").all(taskId)
  .map(recentTurn).filter(Boolean).reverse();
 const totalTurns=db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE task_id=? AND kind='user_turn'").get(taskId).n;
 const lastSeq=db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM assistant_task_events WHERE task_id=?").get(taskId).n;
 const calls=db.prepare("SELECT status,COUNT(*) AS n FROM assistant_model_calls WHERE task_id=? GROUP BY status").all(taskId);
 const modelCalls={total:0,needsReconcile:0,succeeded:0};
 for(const call of calls){
  modelCalls.total+=call.n;
  if(["submitting","needs_reconcile"].includes(call.status))modelCalls.needsReconcile+=call.n;
  if(call.status==="succeeded")modelCalls.succeeded+=call.n;
 }
 const historicalTrusted=steps.filter(row=>row.status==="succeeded"&&
  row.receipt_trust==="server_committed"&&
  (row.plan_version!==planVersion||row.superseded_at!==null)).length;
 const facts={version:1,source:"server_derived",sourceLastSeq:lastSeq,
  status:task.status,activePlanVersion:planVersion,
  userTurns:{total:totalTurns,recent:turns},
  modelCalls,
  execution:{allPlanStepCount:steps.length,historicalTrustedReceipts:historicalTrusted,
    currentPlan:{stepCount:active.length,stages,trustedSteps,unverifiedSuccess,
    trustedByKind:trusted,confirmedArtifacts,materializedBindings,appliedCanvasActions}}};
 // Valid large node-selection policies can exceed a fixed prompt budget.
 // Discard the oldest previews, never a source Step fact or an authorization proof.
 while(Buffer.byteLength(stableJson(facts),"utf8")>12000&&facts.userTurns.recent.length)
  facts.userTurns.recent.shift();
 return facts;
}
/** Called inside a write transaction. Refresh by re-deriving from source
 * before a Task snapshot is returned; no updated_at/planVersion/event mutation.
 * An imported read-only Task keeps the frozen historical summary unchanged.
 */
export function refreshAssistantTaskFacts(db,task){
 if(task.read_only)return JSON.parse(task.summary_json);
 const facts=deriveAssistantTaskFacts(db,task),encoded=stableJson(facts);
 if(Buffer.byteLength(encoded,"utf8")>12000)throw Error("assistant_task_summary_overflow");
 if(encoded!==stableJson(JSON.parse(task.summary_json))){
  db.prepare("UPDATE assistant_tasks SET summary_json=? WHERE id=? AND project_id=?")
   .run(encoded,task.id,task.project_id);
 }
 return facts;
}
