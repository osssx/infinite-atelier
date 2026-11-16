import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {parseP49BArgs,runP49BAcceptance} from "../../scripts/p49b-creative-quality.mjs";

test("P4.9b requires explicit paid provider opt-in and env-only credentials",()=>{
 assert.equal(parseP49BArgs(["--mock"],{}).mode,"mock");
 for(const args of [["--live"],["--live","--ack-cost"],["--ack-cost"],
  ["--mock","--live"],["--live","--not-supported"]])
  assert.throws(()=>parseP49BArgs(args,{}));
 const parsed=parseP49BArgs(["--live","--ack-cost"],{
  P49B_API_KEY:"secret-for-tests",P49B_BASE_URL:"http://127.0.0.1:7777/v1",
  P49B_MODEL:"test-model"});
 assert.equal(parsed.mode,"live");
 assert.equal(parsed.ackCost,true);
 assert.equal(parsed.model,"test-model");
 assert.equal(parsed.secret,"secret-for-tests");
 assert.throws(()=>parseP49BArgs(["--live","--ack-cost"],{
  P49B_API_KEY:"a",P49B_BASE_URL:"http://127.0.0.1:7777/v1",
  P49B_MODEL:"m",P49B_PROVIDER:"unsupported"}));
});

test("P4.9b isolated four-turn Task, two linked chats, no graph writes, no Job, every provider payload contains confirmed facts",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"p49b-test-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const result=await runP49BAcceptance(parseP49BArgs(["--mock"],{}),{outDir:dir});
 assert.equal(result.success,true);
 assert.equal(result.report.mode,"mock");
 assert.equal(result.report.executionStatus,"completed_pending_human_review");
 assert.equal(result.report.semanticVerdict,"human_review_required");
 assert.equal(result.report.providerPosts,4);
 assert.equal(result.report.totalTaskModelCalls,4);
 assert.equal(result.report.userTurnCount,4);
 assert.equal(result.report.linkedChatCount,2);
 assert.equal(result.report.graphUnchanged,true);
 assert.equal(result.report.jobCount,0);
 assert.deepEqual(result.report.stages.map(stage=>stage.actualCount),[3,3,6,6]);
 assert.deepEqual(result.report.stages.map(stage=>stage.objectiveChecksPassed),[true,true,true,true]);
 assert.ok(result.report.stages.every(stage=>stage.humanReview.characterIdentity==="pending"&&
  stage.conclusion==="human_review_required"));
 assert.equal(result.report.providerContextChecks.length,4);
 assert.ok(result.report.providerContextChecks.every(check=>check.goalIncluded&&
  check.constraintsIncluded&&check.unapprovedCanvasAbsent));
 assert.equal(result.report.providerContextChecks[0].priorDraftIncluded,null);
 assert.ok(result.report.providerContextChecks.slice(1).every(check=>check.priorDraftIncluded===true));
 const saved=readFileSync(result.reportPath,"utf8");
 assert.equal(saved,JSON.stringify(result.report,null,2));
 assert.doesNotMatch(saved,/PRIVATE_CANVAS_NOT_AUTHORIZED|p49b-mock-only|api[_-]?key\s*:/i);
 assert.match(saved,/human_review_required/);
});

test("P4.9b exported runner cannot call live provider without its own opt-in",async()=>{
 await assert.rejects(
  runP49BAcceptance({mode:"live",model:"test",baseUrl:"http://127.0.0.1:5555/v1",
   secret:"fixture",provider:"openai_compatible"}),
  /p49b_explicit_live_authorization_required/
 );
});
