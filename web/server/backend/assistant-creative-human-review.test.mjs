import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {runP49BAcceptance,parseP49BArgs} from "../../scripts/p49b-creative-quality.mjs";
import {createP49CReviewSheet,evaluateP49CReviewSheet,
 initP49CReview,verifyP49CReview} from "../../scripts/p49c-human-review.mjs";

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"p49c-test-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const run=await runP49BAcceptance(parseP49BArgs(["--mock"],{}),{outDir:dir});
 assert.equal(run.success,true);
 const init=initP49CReview(run.reportPath);
 const sheet=JSON.parse(readFileSync(init.reviewPath,"utf8"));
 return {dir,run,init,sheet};
}
function completed(sheet,{rating="pass",text="已人工对照固定人物、场景和事件的顺序，并核实本轮文本没有修改人物身份或服饰。"}={}){
 for(const stage of sheet.stages){
  for(const axis of Object.keys(stage.assessments)){
   stage.assessments[axis]={rating,note:text};
  }
  if(stage.flaggedFindings.length)
   stage.overrideReason="已审阅所有自动标记，确认是文本中的否定语境，不构成真实事实偏移。";
 }
 sheet.reviewStatus="final";
 sheet.reviewerStatement="已手动核查每轮文本，并审阅所有需要复核的跨轮人物和事件语义一致性。";
 sheet.reviewedAt="2026-11-16T12:00:00.000Z";
 return sheet;
}
test("P4.9c report-bound review template defaults to pending and cannot authorize Task",async t=>{
 const fx=await fixture(t);
 const reviewed=verifyP49CReview(fx.run.reportPath,fx.init.reviewPath);
 assert.equal(reviewed.qualityStatus,"draft");
 assert.equal(reviewed.taskCompletionAuthorized,false);
 assert.equal(reviewed.modelQualityProvenByAutomation,false);
 assert.equal(fx.sheet.stages.length,4);
 assert.equal(fx.sheet.sourceMode,"mock");
 for(const st of fx.sheet.stages){
  assert.equal(st.reviewStatus,undefined);
  assert.equal(st.assessments.characterIdentity.rating,"pending");
  assert.ok(st.cardDigests.length===3||st.cardDigests.length===6);
 }
 assert.throws(()=>initP49CReview(fx.run.reportPath),error=>error.code==="EEXIST");
});
test("P4.9c forged source evidence and changed card digest fail before any verdict",async t=>{
 const fx=await fixture(t);
 const t1=structuredClone(fx.sheet);t1.sourceDigest="0".repeat(64);
 assert.throws(()=>evaluateP49CReviewSheet(fx.run.report,fx.sheet.sourceDigest,t1),
  /p49c_review_evidence_mismatch/);
 const t2=structuredClone(fx.sheet);t2.stages[0].cardDigests[0]="0".repeat(64);
 assert.throws(()=>evaluateP49CReviewSheet(fx.run.report,fx.sheet.sourceDigest,t2),
  /p49c_review_evidence_mismatch/);
 const altered=JSON.parse(readFileSync(fx.run.reportPath,"utf8"));
 altered.stages[0].cards[0].text="tampered content";
 writeFileSync(fx.run.reportPath,JSON.stringify(altered,null,2),"utf8");
 assert.throws(()=>verifyP49CReview(fx.run.reportPath,fx.init.reviewPath),
  /p49c_review_evidence_mismatch/);
});
test("P4.9c even a fully human-approved Mock response can only be marked mock_review_only",async t=>{
 const fx=await fixture(t);
 const sheet=completed(fx.sheet);
 writeFileSync(fx.init.reviewPath,JSON.stringify(sheet,null,2),"utf8");
 const reviewed=verifyP49CReview(fx.run.reportPath,fx.init.reviewPath);
 assert.equal(reviewed.qualityStatus,"mock_review_only");
 assert.equal(reviewed.taskCompletionAuthorized,false);
});
test("P4.9c negative rating and not-applicable require explanatory notes",async t=>{
 const fx=await fixture(t);
 const sheet=completed(fx.sheet);
 sheet.stages[0].assessments.characterAppearance={rating:"needs_revision",note:""};
 assert.throws(()=>evaluateP49CReviewSheet(fx.run.report,fx.sheet.sourceDigest,sheet),
  /p49c_negative_rating_requires_reason/);
 sheet.stages[0].assessments.characterAppearance={rating:"needs_revision",note:"蓝色斗篷错误地被替换为红色"};
 const summary=evaluateP49CReviewSheet(fx.run.report,fx.sheet.sourceDigest,sheet);
 assert.equal(summary.qualityStatus,"mock_review_only");
 assert.equal(summary.findings[0].issues,1);
 sheet.stages[0].assessments.characterAppearance={rating:"not_applicable",note:""};
 assert.throws(()=>evaluateP49CReviewSheet(fx.run.report,fx.sheet.sourceDigest,sheet),
  /p49c_not_applicable_requires_reason/);
});
test("P4.9c incomplete reviews and suspicious evidence require human override or revision",async t=>{
 const fx=await fixture(t);
 const sheet=completed(fx.sheet);
 sheet.stages[0].assessments.characterIdentity.rating="pending";
 assert.throws(()=>evaluateP49CReviewSheet(fx.run.report,fx.sheet.sourceDigest,sheet),
  /p49c_review_incomplete/);
 const changed=structuredClone(fx.run.report);
 changed.stages[0].flags=[{code:"rabbit_costume_drift"}];
 const changedSheet=createP49CReviewSheet(changed,fx.sheet.sourceDigest);
 completed(changedSheet);
 changedSheet.stages[0].overrideReason="";
 assert.throws(()=>evaluateP49CReviewSheet(changed,fx.sheet.sourceDigest,changedSheet),
  /p49c_flags_require_override_or_revision/);
 changedSheet.stages[0].overrideReason="原文表示禁止变为红色，并不是事实上穿红色斗篷。";
 assert.equal(evaluateP49CReviewSheet(changed,fx.sheet.sourceDigest,changedSheet).qualityStatus,
  "mock_review_only");
});
test("P4.9c partial provider results can never be marked consistent",async t=>{
 const fx=await fixture(t);
 const incomplete=structuredClone(fx.run.report);
 incomplete.executionStatus="provider_or_validation_error";
 const sheet=completed(createP49CReviewSheet(incomplete,fx.sheet.sourceDigest));
 const evaluated=evaluateP49CReviewSheet(incomplete,fx.sheet.sourceDigest,sheet);
 assert.equal(evaluated.qualityStatus,"incomplete_provider_evidence");
 assert.equal(evaluated.taskCompletionAuthorized,false);
});
test("P4.9c truncated source excerpts cannot be called fully human-reviewed",async t=>{
 const fx=await fixture(t);
 const partial=structuredClone(fx.run.report);
 partial.stages[0].cards[0].truncated=true;
 const sheet=completed(createP49CReviewSheet(partial,fx.sheet.sourceDigest));
 const result=evaluateP49CReviewSheet(partial,fx.sheet.sourceDigest,sheet);
 assert.equal(result.qualityStatus,"source_excerpt_incomplete");
 assert.equal(result.taskCompletionAuthorized,false);
});
test("P4.9c human review inputs reject credential patterns without exposing the key",async t=>{
 const fx=await fixture(t);
 const sheet=completed(fx.sheet);
 sheet.reviewerStatement="已全面审核，密钥 sk-abcdefghijklmnopqrstuvxyz12345 被泄漏";
 assert.throws(()=>evaluateP49CReviewSheet(fx.run.report,fx.sheet.sourceDigest,sheet),
  /p49c_review_statement_required/);
});
