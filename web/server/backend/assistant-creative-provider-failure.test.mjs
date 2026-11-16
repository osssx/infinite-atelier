import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {parseP49BArgs,runP49BAcceptance} from "../../scripts/p49b-creative-quality.mjs";
import {createP49CReviewSheet,evaluateP49CReviewSheet} from "../../scripts/p49c-human-review.mjs";

const mock=parseP49BArgs(["--mock"],{});
async function perform(t,handler){
 const dir=mkdtempSync(join(tmpdir(),"p49c-failure-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const result=await runP49BAcceptance(mock,{outDir:dir,mockUpstreamCall:handler});
 return {...result,saved:JSON.parse(readFileSync(result.reportPath,"utf8"))};
}
const response=(actions)=>new Response(JSON.stringify({
 choices:[{finish_reason:"stop",message:{content:JSON.stringify({
 answer:"待审批草案",actions})}}]
}),{status:200});
test("P4.9c response lost after provider POST never retries same model command",async t=>{
 let received=0;
 const result=await perform(t,async()=>{
  received++;
  throw Error("simulated network timeout after upstream accepted request");
 });
 assert.equal(received,1);
 assert.equal(result.success,false);
 assert.equal(result.report.providerPosts,1);
 assert.equal(result.report.stages.length,1);
 assert.ok(["needs_reconcile","provider_or_validation_error"].includes(result.report.executionStatus));
 assert.equal(result.saved.executionStatus,result.report.executionStatus);
 // The isolated project never progressed to a canvas transaction.
 assert.equal(result.report.graphUnchanged,true);
 assert.equal(result.report.jobCount,0);
 assert.ok(result.report.stages[0].modelCalls.length>=1);
 assert.equal(result.report.semanticVerdict,"human_review_required");
});
test("P4.9c upstream HTTP 503 cannot automatically call again, cannot advance stage",async t=>{
 let received=0;
 const result=await perform(t,async()=>{
  received++;
  return new Response("service unavailable",{status:503});
 });
 assert.equal(received,1);
 assert.equal(result.report.providerPosts,1);
 assert.equal(result.report.stages.length,1);
 assert.equal(result.success,false);
 assert.equal(result.report.graphUnchanged,true);
});
test("P4.9c persistent empty text creates at most one separately audited format repair",async t=>{
 let received=0;
 const result=await perform(t,async()=>{
  received++;
  return response([{
   type:"create_text",ref:"blank",title:"小兔嘟嘟",content:"姓名：\n外貌：\n性格："
  }]);
 });
 assert.equal(received,2);
 assert.equal(result.report.providerPosts,2);
 assert.equal(result.report.stages.length,1);
 assert.equal(result.report.stages[0].modelCalls.length,2);
 assert.deepEqual(result.report.stages[0].modelCalls.map(x=>x.call_kind),["initial","format_repair"]);
 assert.equal(result.report.graphUnchanged,true);
 assert.equal(result.report.semanticVerdict,"human_review_required");
});
test("P4.9c a mocked network exception at the second stage prevents all later stage submissions",async t=>{
 let received=0;
 const result=await perform(t,async({stage,stageIndex})=>{
  received++;
  if(stageIndex>0)throw Error("ambiguous response");
  const cards=stage.titles.map((title,index)=>({
   type:"create_text",ref:"p49c_"+index,title,
   content:title+"：人物毛色与服饰保持一致，兔妈妈鼓励小兔嘟嘟，小龟慢慢帮助她在森林发现星星、经过石桥并最终抵达草地。"
  }));
  return response(cards);
 });
 assert.equal(received,2);
 assert.equal(result.report.stages.length,2);
 assert.equal(result.report.providerPosts,2);
 assert.equal(result.report.stages[0].status,200);
 assert.notEqual(result.report.stages[1].status,200);
 assert.equal(result.report.graphUnchanged,true);
});
test("P4.9c a failed/partial response cannot be elevated by filled human review fields",async t=>{
 const result=await perform(t,async()=>new Response("bad upstream",{status:503}));
 const sheet=createP49CReviewSheet(result.report,"a".repeat(64));
 sheet.reviewStatus="final";
 sheet.reviewedAt=new Date().toISOString();
 sheet.reviewerStatement="已检查这一轮失败结果，没有完整角色草案可供评价。";
 for(const stage of sheet.stages)for(const dimension of Object.keys(stage.assessments))
  stage.assessments[dimension]={rating:"needs_revision",note:"缺少模型有效输出，应重新安排人工验收。"};
 const evalResult=evaluateP49CReviewSheet(result.report,sheet.sourceDigest,sheet);
 assert.equal(evalResult.qualityStatus,"incomplete_provider_evidence");
 assert.equal(evalResult.taskCompletionAuthorized,false);
});
test("P4.9c live mode rejects test response injection even if ackCost is true",async()=>{
 await assert.rejects(runP49BAcceptance({
  mode:"live",ackCost:true,provider:"openai_compatible",
  baseUrl:"http://127.0.0.1:9999/v1",model:"live",secret:"test"
 },{mockUpstreamCall:async()=>response([])}),/p49b_mock_injection_forbidden_in_live_mode/);
});
