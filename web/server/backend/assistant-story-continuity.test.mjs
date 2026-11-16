import test from "node:test";
import assert from "node:assert/strict";
import {extractP49GActionEvidence,buildP49GRevisionGuidance,
 reviewP49GRevisionContinuity} from "./assistant-story-continuity.mjs";

const shot=(title,action,extra="")=>({
 type:"create_text",ref:title,title,
 content:"【"+title+"】\n景别：中景。\n动作："+action+"。\n出场人物：小兔嘟嘟、兔妈妈、小龟慢慢。\n连续性："+extra
});
const old=[shot("分镜5","小龟慢慢陪获救动物抵达观星草地"),
 shot("分镜6","嘟嘟在草地中央把星星轻轻放回天空，星星重新发亮")];
test("P4.9g detects source event only from completed action sentence, carries provenance and never user confirmation",()=>{
 const found=extractP49GActionEvidence(old);
 assert.equal(found.length,1);
 assert.equal(found[0].id,"star_returns_to_sky");
 assert.equal(found[0].sourceShotIndex,2);
 assert.match(found[0].evidenceExcerpt,/放回天空/);
 assert.equal(found[0].userConfirmed,false);
 assert.equal(found[0].sourceBodyDigest.length,64);
 const prompt=buildP49GRevisionGuidance(found);
 assert.match(prompt,/前轮 AI 草案/);
 assert.match(prompt,/未由用户确认/);
 assert.match(prompt,/镜头2/);
 assert.match(prompt,/实际【动作】/);
});
test("P4.9g omission of star return from revision actions produces an editorial warning, not a factual or Task verdict",()=>{
 const found=extractP49GActionEvidence(old);
 const revision=[shot("修订分镜6","嘟嘟双手把星星举高，温暖的光照亮大家")];
 const report=reviewP49GRevisionContinuity(found,revision);
 assert.equal(report.evidenceStatus,"requires_editor_review");
 assert.equal(report.warnings[0].code,"prior_story_action_not_observed");
 assert.equal(report.semanticReview,"pending");
 assert.equal(report.userConfirmed,false);
 assert.equal(report.taskCompletionAuthorized,false);
});
test("P4.9g equivalent committed actions can satisfy candidate without copying exact original phrase",()=>{
 const found=extractP49GActionEvidence(old);
 const alternate=[shot("修订分镜6","雨后，小兔嘟嘟将那颗小星星送回天上，大家抬头微笑")];
 const report=reviewP49GRevisionContinuity(found,alternate);
 assert.equal(report.evidenceStatus,"candidate_observed_in_revision");
 assert.equal(report.warnings.length,0);
 assert.equal(report.revisionEvidence.length,1);
 assert.equal(report.semanticReview,"pending");
});
test("P4.9g action excerpt in title, continuity notes, negations, intention or dialogue is not treated as performed",()=>{
 const source=extractP49GActionEvidence(old);
 const cases=[
  shot("分镜6：把星星放回天空","嘟嘟把星星高高举起来","标题提到把星星放回天空"),
  shot("修订镜头6","嘟嘟说不要把星星放回天空","把星星放回天空"),
  shot("修订镜头6","嘟嘟计划把星星放回天空"),
  shot("修订镜头6","嘟嘟不能把星星放回天空"),
  shot("修订镜头6","如果嘟嘟把星星放回天空，就会再次明亮"),
  shot("修订镜头6","嘟嘟希望把星星放回天空"),
  shot("修订镜头6","嘟嘟说要把星星放回天空")
 ];
 for(const candidate of cases){
  assert.equal(extractP49GActionEvidence([candidate]).length,0,candidate.content);
  assert.equal(reviewP49GRevisionContinuity(source,[candidate]).warnings.length,1,candidate.content);
 }
});
test("P4.9g no source candidate means no hard-coded phantom obligation",()=>{
 const none=extractP49GActionEvidence([shot("分镜6","三人在观星草地团聚")]);
 assert.deepEqual(none,[]);
 assert.equal(buildP49GRevisionGuidance(none),"");
 const result=reviewP49GRevisionContinuity(none,[shot("修订镜头6","三人在雨后团聚")]);
 assert.equal(result.evidenceStatus,"no_source_candidate");
 assert.deepEqual(result.warnings,[]);
});
