import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {rmSync} from "node:fs";
import {join} from "node:path";
import {initP49E,executeP49EStage,enableP49EAutoApproval,
 inspectP49ERevisionContinuity,exportP49EReviewSource,
 recheckP49EStageFromCache,recoverP49E}
 from "../../scripts/p49e-creative-stage.mjs";
import {P49B_CASE} from "./assistant-creative-consistency.mjs";

const config={mode:"mock",provider:"openai_compatible",model:"p49e-mock",
 baseUrl:"http://127.0.0.1:8188/v1"};
const respond=actions=>new Response(JSON.stringify({choices:[{
 finish_reason:"stop",message:{content:JSON.stringify({answer:"未确认草案",actions})}
}]}),{status:200});
const backdrop="小兔嘟嘟穿蓝色斗篷、雪白毛色，兔妈妈穿棕色围裙、米白毛色，小龟慢慢背橄榄绿色龟壳。三人从森林发现星星、穿过暴雨石桥救援迷路动物，最后在草地团聚。";
const originalBody=i=>"景别：中景。\n动作："+(i===5?
 "嘟嘟在观星草地中央把星星轻轻放回天空，大家抬头微笑":
 "小兔嘟嘟扶着小龟慢慢向石桥走去，兔妈妈在一旁鼓励大家")+
 "。\n出场人物：小兔嘟嘟、兔妈妈、小龟慢慢。\n地点：森林、石桥与草地。\n连续性："+backdrop;
const revisionBody=(i,kind)=>"景别：中景。\n动作："+(i===5?
 kind==="preserve"?"嘟嘟将那颗小星星送回天上，大家在草地团聚":"嘟嘟双手把星星举高，星光照亮所有同伴":
 "石桥上的暴雨骤然变大，嘟嘟和小龟慢慢帮助迷路小动物，兔妈妈守护在后方")+
 "。\n出场人物：小兔嘟嘟、兔妈妈、小龟慢慢。\n地点：暴雨中的石桥、森林和草地。\n连续性："+backdrop;
function storyboard(){
 return P49B_CASE.stages[2].titles.map((title,i)=>({
  type:"create_text",ref:"old"+i,title,content:originalBody(i)
 }));
}
function revision(kind){
 return P49B_CASE.stages[3].titles.map((title,i)=>({
  type:"create_text",ref:"new"+i,title,content:revisionBody(i,kind)
 }));
}
async function prepared(t){
 const dir=initP49E(config).directory;
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 enableP49EAutoApproval(dir);
 for(const name of ["characters","scenes"]){
  const stage=P49B_CASE.stages.find(item=>item.id===name);
  const done=await executeP49EStage(dir,config,name,{
   mockUpstreamCall:async()=>respond(stage.titles.map((title,i)=>({
    type:"create_text",ref:name+i,title,
    content:backdrop+" 请保持人物样貌与服饰一致，记录叙事地点与镜头动作细节，用于后续场景与分镜创作。"
   })))
  });
  assert.equal(done.status.stages.at(-1).status,"auto_approved_for_continuation",name+JSON.stringify(done.status.stages.at(-1).review?.flags));
 }
 const done=await executeP49EStage(dir,config,"storyboard",{
  mockUpstreamCall:async()=>respond(storyboard())
 });
 assert.equal(done.providerPosts,1);
 assert.equal(done.status.stages[2].status,"auto_approved_for_continuation");
 return dir;
}
test("P4.9g missing prior key action blocks auto-continuation but keeps 4 successful model calls and permits human review",async t=>{
 const dir=await prepared(t);
 let submitted=0, requestSeen="";
 const done=await executeP49EStage(dir,config,"revision",{
  mockUpstreamCall:async({requestText})=>{
   submitted++;requestSeen=requestText;return respond(revision("omit"));
  }
 });
 assert.equal(submitted,1);
 assert.equal(done.providerPosts,1);
 assert.match(requestSeen,/前轮 AI 草案关键动作续写提醒/);
 assert.match(requestSeen,/把星星轻轻放回天空/);
 assert.match(requestSeen,/未由用户确认/);
 assert.doesNotMatch(requestSeen,/PRIVATE_P49E_NOT_AUTHORIZED/);
 const report=done.status.stages[3].review;
 assert.equal(report.actualCount,6);
 assert.equal(report.continuity.evidenceStatus,"requires_editor_review");
 assert.equal(report.continuity.sourceCandidates[0].userConfirmed,false);
 assert.equal(report.continuity.semanticReview,"pending");
 assert.ok(report.flags.some(f=>f.code==="prior_story_action_not_observed"&&
  f.scope==="ai_draft_editorial_warning"));
 assert.equal(report.objectiveChecksPassed,false);
 assert.equal(done.status.stages[3].status,"review_pending");
 assert.equal(done.status.graphUnchanged,true);
 assert.equal(done.status.jobs,0);
 assert.equal(exportP49EReviewSource(dir).mode,"mock");
 const legacy=inspectP49ERevisionContinuity(dir);
 assert.equal(legacy.continuity.evidenceStatus,"requires_editor_review");
 assert.equal(legacy.modelPosts,0);
 const db=new DatabaseSync(join(dir,"acceptance.sqlite"),{readOnly:true});
 try{assert.equal(db.prepare("SELECT COUNT(*) n FROM assistant_model_calls").get().n,4)}
 finally{db.close()}
});
test("P4.9g completed return-to-sky action in revision is a candidate observed, but not semantic proof",async t=>{
 const dir=await prepared(t);
 const done=await executeP49EStage(dir,config,"revision",{
  mockUpstreamCall:async()=>respond(revision("preserve"))
 });
 assert.equal(done.status.stages[3].status,"auto_approved_for_continuation");
 assert.equal(done.status.stages[3].review.flags.length,0);
 assert.equal(done.status.stages[3].review.continuity.evidenceStatus,
  "candidate_observed_in_revision");
 assert.equal(done.status.semanticVerdict,"human_review_required");
 assert.equal(done.status.stages[3].review.continuity.taskCompletionAuthorized,false);
 assert.equal(inspectP49ERevisionContinuity(dir).continuity.warnings.length,0);
});
test("P4.9g crashed completed revision recovers editorial warning instead of auto-approval",async t=>{
 const dir=await prepared(t);
 const done=await executeP49EStage(dir,config,"revision",{
  mockUpstreamCall:async()=>respond(revision("omit"))
 });
 assert.equal(done.status.stages[3].status,"review_pending");
 const oldDigest=done.status.stages[3].digest;
 const db=new DatabaseSync(join(dir,"acceptance.sqlite"));
 try{db.prepare("UPDATE p49e_stages SET status='submitted',result_digest=NULL,review_json=NULL WHERE stage_index=3").run()}
 finally{db.close()}
 const recovered=recoverP49E(dir);
 assert.equal(recovered.stages[3].status,"review_pending");
 assert.equal(recovered.stages[3].digest,oldDigest);
 assert.equal(recovered.stages[3].review.continuity.evidenceStatus,"requires_editor_review");
 assert.ok(recovered.stages[3].review.flags.some(x=>x.code==="prior_story_action_not_observed"));
 assert.equal(recovered.stages[3].modelCalls.length,1);
 assert.equal(recovered.stages[3].modelCalls[0].status,"succeeded");
 const readonly=new DatabaseSync(join(dir,"acceptance.sqlite"),{readOnly:true});
 try{assert.equal(readonly.prepare("SELECT COUNT(*) n FROM assistant_model_calls").get().n,4)}
 finally{readonly.close()}
});
test("P4.9g title-only cached recheck cannot bypass newly detected narrative action warning",async t=>{
 const dir=await prepared(t);
 const done=await executeP49EStage(dir,config,"revision",{
  mockUpstreamCall:async()=>respond(revision("omit"))
 });
 assert.equal(done.status.stages[3].status,"review_pending");
 const db=new DatabaseSync(join(dir,"acceptance.sqlite"));
 try{
  const original=JSON.parse(db.prepare("SELECT review_json FROM p49e_stages WHERE stage_index=3").get().review_json);
  original.flags=[{code:"expected_title_missing",title:"修订镜头1"}];
  original.objectiveChecksPassed=false;
  delete original.continuity;
  db.prepare("UPDATE p49e_stages SET review_json=? WHERE stage_index=3").run(JSON.stringify(original));
 }finally{db.close()}
 const rechecked=recheckP49EStageFromCache(dir,"revision");
 assert.equal(rechecked.autoApproved,false);
 assert.equal(rechecked.status.stages[3].status,"review_pending");
 assert.equal(rechecked.status.stages[3].review.continuity.evidenceStatus,"requires_editor_review");
 assert.ok(rechecked.status.stages[3].review.flags.some(x=>x.code==="prior_story_action_not_observed"));
 assert.equal(rechecked.status.stages[3].modelCalls.length,1);
});
test("P4.9g prior storyboard response tampering is rejected before any revision stage reservation or model POST",async t=>{
 const dir=await prepared(t);
 const db=new DatabaseSync(join(dir,"acceptance.sqlite"));
 try{
  db.prepare("UPDATE assistant_task_commands SET response_json=? WHERE request_id='provider-storyboard'")
   .run('{"actions":[{"type":"create_text","title":"fake","content":"return star"}]}');
 }finally{db.close()}
 let posts=0;
 await assert.rejects(executeP49EStage(dir,config,"revision",{
  mockUpstreamCall:async()=>{posts++;return respond(revision("preserve"))}
 }),/p49g_storyboard_digest_mismatch/);
 assert.equal(posts,0);
 const verify=new DatabaseSync(join(dir,"acceptance.sqlite"),{readOnly:true});
 try{
  assert.equal(verify.prepare("SELECT COUNT(*) n FROM p49e_stages").get().n,3);
  assert.equal(verify.prepare("SELECT COUNT(*) n FROM assistant_model_calls").get().n,3);
 }finally{verify.close()}
});
