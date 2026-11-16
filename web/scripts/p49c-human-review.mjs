/** P4.9c: evidence-bound human review, never a Task completion receipt.
 * Separate review sheet is tied to one immutable provider result digest.
 * A mock response must never be represented as real model quality evidence.
 */
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import {resolve,join,dirname,basename} from "node:path";
import {fileURLToPath} from "node:url";

const axes=["characterIdentity","characterAppearance","relationships",
 "sceneContinuity","eventChronology","shotLanguage","revisionPreservesFacts"];
const statuses=new Set(["pending","pass","needs_revision","not_applicable"]);
const hash=raw=>createHash("sha256").update(raw).digest("hex");
const validNote=x=>typeof x==="string"&&x.length<=2000&&
 !/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S{12,})\b/i.test(x)&&
 !/(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*[^\s,;]+/i.test(x);
const bad=code=>Object.assign(Error(code),{code});
function checkReport(raw){
 const report=JSON.parse(raw);
 if(report.schemaVersion!==1||!["mock","live"].includes(report.mode)||
  report.semanticVerdict!=="human_review_required"||
  !["completed_pending_human_review","provider_or_validation_error","needs_reconcile"].includes(report.executionStatus)||
  !Array.isArray(report.stages)||report.stages.length<1||report.stages.length>4)
  throw bad("p49c_report_not_reviewable");
 for(const item of report.stages){
  if(typeof item.stageId!=="string"||item.stageId.length>60)throw bad("p49c_report_not_reviewable");
  if(item.cards!==undefined&&!Array.isArray(item.cards))throw bad("p49c_report_not_reviewable");
 }
 return report;
}
export function createP49CReviewSheet(report,sourceDigest){
 if(typeof sourceDigest!=="string"||!/^[a-f0-9]{64}$/.test(sourceDigest))
  throw bad("p49c_evidence_digest_invalid");
 return {schemaVersion:1,kind:"p49c_human_quality_review",
  sourceDigest,sourceMode:report.mode,scenario:report.scenario,
  // The reviewer can modify only assessments, never the evidence identity.
  stages:report.stages.map(item=>({
   stageId:item.stageId,cardDigests:(item.cards??[]).map(c=>c.digest),
   assessments:Object.fromEntries(axes.map(axis=>[axis,{rating:"pending",note:""}])),
   flaggedFindings:(item.flags??[]).map(f=>f.code),
   overrideReason:""
  })),
  reviewStatus:"draft",reviewerStatement:"",reviewedAt:null,
  boundary:"manual_quality_review_only_not_task_completion"
 };
}
export function evaluateP49CReviewSheet(report,sourceDigest,sheet){
 const baseline=createP49CReviewSheet(report,sourceDigest);
 if(sheet?.schemaVersion!==1||sheet.kind!==baseline.kind||
  sheet.sourceDigest!==sourceDigest||sheet.sourceMode!==report.mode||
  sheet.scenario!==report.scenario||!Array.isArray(sheet.stages)||
  sheet.stages.length!==baseline.stages.length||
  sheet.boundary!==baseline.boundary)throw bad("p49c_review_evidence_mismatch");
 const findings=[],stageSummary=[];
 for(let i=0;i<sheet.stages.length;i++){
  const row=sheet.stages[i],ref=baseline.stages[i];
  if(row.stageId!==ref.stageId||JSON.stringify(row.cardDigests)!==JSON.stringify(ref.cardDigests)||
   JSON.stringify(row.flaggedFindings)!==JSON.stringify(ref.flaggedFindings)||
   !row.assessments||typeof row.assessments!=="object"||
   Object.keys(row.assessments).sort().join(",")!==axes.slice().sort().join(",")||
   !validNote(row.overrideReason))
   throw bad("p49c_review_evidence_mismatch");
  let pending=0,issues=0;
  for(const axis of axes){
   const score=row.assessments[axis];
   if(!score||!statuses.has(score.rating)||!validNote(score.note))
    throw bad("p49c_review_assessment_invalid");
   if(score.rating==="pending")pending++;
   if(score.rating==="needs_revision"){
    issues++;
    if(score.note.trim().length<8)throw bad("p49c_negative_rating_requires_reason");
   }
   if(score.rating==="not_applicable"&&score.note.trim().length<8)
    throw bad("p49c_not_applicable_requires_reason");
  }
  if(ref.flaggedFindings.length&&!row.overrideReason.trim()&&issues===0&&pending===0)
   throw bad("p49c_flags_require_override_or_revision");
  if(ref.flaggedFindings.length&&row.overrideReason.trim().length<12&&issues===0&&pending===0)
   throw bad("p49c_flags_require_override_or_revision");
  stageSummary.push({stageId:row.stageId,pending,issues,flagged:ref.flaggedFindings.length});
  if(issues)findings.push({stageId:row.stageId,issues});
 }
 const allReviewed=stageSummary.every(row=>row.pending===0);
 const anyIssue=findings.length>0;
 // Only this separate review artifact can report a human decision, never the
 // source report, a Task step, Canvas approval or verifier state.
 const completeEvidence=report.executionStatus==="completed_pending_human_review"&&
  report.stages.length===4&&report.graphUnchanged===true&&report.jobCount===0;
 const fullTextsVisible=report.stages.every(stage=>
  Array.isArray(stage.cards)&&stage.cards.every(card=>card.truncated===false));
 const qualityStatus=!completeEvidence?"incomplete_provider_evidence":
  !fullTextsVisible?"source_excerpt_incomplete":
  !allReviewed?"pending_human_review":report.mode!=="live"?
  "mock_review_only":anyIssue?"human_found_issues":"human_reviewed_consistent";
 if(sheet.reviewStatus==="final"){
  if(!allReviewed)throw bad("p49c_review_incomplete");
  if(!validNote(sheet.reviewerStatement)||sheet.reviewerStatement.trim().length<16)
   throw bad("p49c_review_statement_required");
  if(typeof sheet.reviewedAt!=="string"||!/^\d{4}-\d\d-\d\dT/.test(sheet.reviewedAt))
   throw bad("p49c_review_date_invalid");
 }else if(sheet.reviewStatus!=="draft")throw bad("p49c_review_status_invalid");
 return {qualityStatus:sheet.reviewStatus==="final"?qualityStatus:"draft",
  evidenceDigest:sourceDigest,sourceMode:report.mode,stageSummary,findings,
  taskCompletionAuthorized:false,modelQualityProvenByAutomation:false};
}

export function initP49CReview(reportPath,{reviewPath}={}){
 const raw=readFileSync(reportPath);
 const report=checkReport(raw.toString("utf8"));
 const destination=reviewPath??join(dirname(resolve(reportPath)),basename(reportPath,".json")+".review.json");
 const review=createP49CReviewSheet(report,hash(raw));
 writeFileSync(destination,JSON.stringify(review,null,2),{flag:"wx",encoding:"utf8"});
 return {reviewPath:destination,sourceMode:report.mode,stages:review.stages.length};
}
export function verifyP49CReview(reportPath,reviewPath){
 const raw=readFileSync(reportPath);
 const report=checkReport(raw.toString("utf8"));
 const sheet=JSON.parse(readFileSync(reviewPath,"utf8"));
 return evaluateP49CReviewSheet(report,hash(raw),sheet);
}
if(process.argv[1]&&fileURLToPath(import.meta.url).toLowerCase()===process.argv[1].toLowerCase()){
 const args=process.argv.slice(2);
 try{
  if(args.length===2&&args[0]==="--init"){
   const result=initP49CReview(args[1]);
   console.log("P49C_REVIEW_TEMPLATE",JSON.stringify(result));
  }else if(args.length===3&&args[0]==="--verify"){
   const result=verifyP49CReview(args[1],args[2]);
   console.log("P49C_REVIEW_RESULT",JSON.stringify(result));
   if(result.qualityStatus==="draft"||result.qualityStatus==="pending_human_review")
    process.exitCode=1;
  }else throw bad("p49c_usage_invalid");
 }catch(error){
  // Never print raw provider responses, credentials or arbitrary paths.
  console.error("P49C_REVIEW_ERROR",error.code==="EEXIST"?
   "p49c_review_already_exists":typeof error.code==="string"?
   error.code:"p49c_review_failed");
  process.exitCode=2;
 }
}
