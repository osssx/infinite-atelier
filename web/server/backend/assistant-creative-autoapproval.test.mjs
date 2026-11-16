import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {
 initP49E,inspectP49E,executeP49EStage,approveP49EStage,
 enableP49EAutoApproval,exportP49EReviewSource,recoverP49E,recheckP49EStageFromCache
} from "../../scripts/p49e-creative-stage.mjs";
import {P49B_CASE} from "./assistant-creative-consistency.mjs";
const config={mode:"mock",provider:"openai_compatible",model:"p49e-mock",
 baseUrl:"http://127.0.0.1:8188/v1"};
const start=t=>{const x=initP49E(config);t.after(()=>rmSync(x.directory,{recursive:true,force:true}));return x.directory};
const asResponse=actions=>new Response(JSON.stringify({choices:[{
 finish_reason:"stop",message:{content:JSON.stringify({answer:"未确认草案",actions})}
}]}),{status:200});

test("P4.9f enabling automatic draft continuation approves existing valid scenes, then future stages, without any extra POST",async t=>{
 const directory=start(t);
 const chars=await executeP49EStage(directory,config,"characters");
 assert.equal(chars.status.stages[0].status,"review_pending");
 const manual=approveP49EStage(directory,"characters",chars.status.stages[0].digest);
 assert.equal(manual.stages[0].status,"approved_for_continuation");
 const scenes=await executeP49EStage(directory,config,"scenes");
 assert.equal(scenes.status.stages[1].status,"review_pending");
 assert.equal(scenes.status.autoApproveDrafts,false);
 const before=new DatabaseSync(join(directory,"acceptance.sqlite"),{readOnly:true});
 let callCount;
 try{callCount=before.prepare("SELECT COUNT(*) n FROM assistant_model_calls").get().n}finally{before.close()}
 assert.equal(callCount,2);
 const enabled=enableP49EAutoApproval(directory);
 assert.deepEqual(enabled.approved,["scenes"]);
 assert.equal(enabled.status.autoApproveDrafts,true);
 assert.equal(enabled.status.stages[0].status,"approved_for_continuation");
 assert.equal(enabled.status.stages[1].status,"auto_approved_for_continuation");
 assert.equal(enabled.status.semanticVerdict,"human_review_required");
 assert.equal(enabled.status.graphUnchanged,true);
 assert.equal(enabled.status.jobs,0);
 assert.deepEqual(enableP49EAutoApproval(directory).approved,[]);
 for(const name of ["storyboard","revision"]){
  const outcome=await executeP49EStage(directory,config,name);
  assert.equal(outcome.providerPosts,1);
  assert.equal(outcome.status.stages.at(-1).status,"auto_approved_for_continuation");
  assert.equal(outcome.status.stages.at(-1).review.objectiveChecksPassed,true);
  assert.equal(outcome.status.semanticVerdict,"human_review_required");
 }
 const finish=inspectP49E(directory);
 assert.equal(finish.stages.length,4);
 assert.deepEqual(finish.stages.map(item=>item.review.actualCount),[3,3,6,6]);
 assert.equal(finish.graphUnchanged,true);
 assert.equal(finish.jobs,0);
 assert.equal(exportP49EReviewSource(directory).mode,"mock");
 const db=new DatabaseSync(join(directory,"acceptance.sqlite"),{readOnly:true});
 try{
  assert.equal(db.prepare("SELECT COUNT(*) n FROM assistant_model_calls").get().n,4);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM p49e_stages WHERE status='auto_approved_for_continuation'").get().n,3);
 }finally{db.close()}
});

test("P4.9f automatic approval never upgrades suspicious content or unconfirmed creative details into user facts",async t=>{
 const directory=start(t);
 const opt=enableP49EAutoApproval(directory);
 assert.equal(opt.status.autoApproveDrafts,true);
 const stage=P49B_CASE.stages[0];
 const result=await executeP49EStage(directory,config,"characters",{
  mockUpstreamCall:async()=>asResponse(stage.titles.map((title,i)=>({
   type:"create_text",ref:"c_"+i,title,
   content:title+" 小兔嘟嘟穿红色斗篷，兔妈妈穿棕色围裙，小龟慢慢与小兔嘟嘟是朋友，三个角色在森林小径发现星星。"
  })))
 });
 assert.equal(result.providerPosts,1);
 assert.equal(result.status.stages[0].review.objectiveChecksPassed,false);
 assert.ok(result.status.stages[0].review.flags.some(f=>f.code==="rabbit_costume_drift"));
 assert.equal(result.status.stages[0].status,"review_pending");
 assert.deepEqual(enableP49EAutoApproval(directory).approved,[]);
 await assert.rejects(executeP49EStage(directory,config,"scenes"),/p49e_prior_human_approval_required/);
});

test("P4.9f cached successful result recovers auto-continuation after interrupted stage without another network call",async t=>{
 const directory=start(t);
 enableP49EAutoApproval(directory);
 const first=await executeP49EStage(directory,config,"characters",{
  mockUpstreamCall:async()=>asResponse([
   {type:"create_text",ref:"rabbit",title:"小兔嘟嘟",content:"小兔嘟嘟拥有雪白毛色，穿蓝色斗篷，乐观好奇，在森林发现星星时愿意照顾身边的伙伴。"},
   {type:"create_text",ref:"mother",title:"兔妈妈",content:"兔妈妈拥有米白毛色，穿棕色围裙，温柔耐心，鼓励孩子在森林冒险中独立思考。"},
   {type:"create_text",ref:"turtle",title:"小龟慢慢",content:"小龟慢慢背着橄榄绿色龟壳，沉稳细致，是小兔嘟嘟最可靠的朋友和冒险同行者。"}
  ])
 });
 assert.equal(first.status.stages[0].review.objectiveChecksPassed,true);
 assert.equal(first.status.stages[0].status,"auto_approved_for_continuation");
 const originalDigest=first.status.stages[0].digest;
 const db=new DatabaseSync(join(directory,"acceptance.sqlite"));
 try{
  db.prepare("UPDATE p49e_stages SET status='submitted',result_digest=NULL,review_json=NULL WHERE stage_index=0").run();
 }finally{db.close()}
 const recovered=recoverP49E(directory);
 assert.equal(recovered.stages[0].status,"auto_approved_for_continuation");
 assert.equal(recovered.stages[0].digest,originalDigest);
 assert.equal(recovered.stages[0].modelCalls.length,1);
 assert.equal(recovered.stages[0].modelCalls[0].status,"succeeded");
 assert.equal(recovered.graphUnchanged,true);
 const readonly=new DatabaseSync(join(directory,"acceptance.sqlite"),{readOnly:true});
 try{assert.equal(readonly.prepare("SELECT COUNT(*) n FROM assistant_model_calls").get().n,1)}
 finally{readonly.close()}
});


test("P4.9f storyboard title-only alias findings are safely rechecked using the cached model response and no new POST",async t=>{
 const directory=start(t);
 const chars=await executeP49EStage(directory,config,"characters");
 approveP49EStage(directory,"characters",chars.status.stages[0].digest);
 const scenes=await executeP49EStage(directory,config,"scenes");
 approveP49EStage(directory,"scenes",scenes.status.stages[1].digest);
 enableP49EAutoApproval(directory);
 const story=P49B_CASE.stages[2];
 const content="小兔嘟嘟穿蓝色斗篷，和兔妈妈及小龟慢慢从森林发现星星，来到石桥救援迷路动物，最后在草地团聚。摄影机推进，画面清晰，人物关系保持一致。";
 const actual=await executeP49EStage(directory,config,"storyboard",{
  mockUpstreamCall:async()=>asResponse(story.titles.map((t,i)=>({
   type:"create_text",ref:"shot"+i,title:"分镜"+(i+1)+"·镜头动作",
   content
  })))
 });
 assert.equal(actual.providerPosts,1);
 assert.equal(actual.status.stages[2].status,"auto_approved_for_continuation");
 const originalDigest=actual.status.stages[2].digest;
 const db=new DatabaseSync(join(directory,"acceptance.sqlite"));
 try{
  const row=db.prepare("SELECT review_json FROM p49e_stages WHERE stage_index=2").get();
  const old=JSON.parse(row.review_json);
  old.flags=story.titles.map(title=>({code:"expected_title_missing",title}));
  old.objectiveChecksPassed=false;
  db.prepare("UPDATE p49e_stages SET status='review_pending',review_json=? WHERE stage_index=2")
   .run(JSON.stringify(old));
 }finally{db.close()}
 const rechecked=recheckP49EStageFromCache(directory,"storyboard");
 assert.equal(rechecked.resolvedTitleFlags,6);
 assert.equal(rechecked.autoApproved,true);
 assert.equal(rechecked.status.stages[2].status,"auto_approved_for_continuation");
 assert.equal(rechecked.status.stages[2].digest,originalDigest);
 assert.equal(rechecked.status.stages[2].review.flags.length,0);
 assert.equal(rechecked.status.stages[2].modelCalls.length,1);
 assert.throws(()=>recheckP49EStageFromCache(directory,"storyboard"),/p49e_recheck_stage_not_pending/);
 const after=new DatabaseSync(join(directory,"acceptance.sqlite"),{readOnly:true});
 try{assert.equal(after.prepare("SELECT COUNT(*) n FROM assistant_model_calls").get().n,3)}
 finally{after.close()}
});
test("P4.9f cached recheck blocks non-title findings, stale success and altered content digest",async t=>{
 const directory=start(t);
 enableP49EAutoApproval(directory);
 const first=await executeP49EStage(directory,config,"characters",{
  mockUpstreamCall:async()=>asResponse([
   {type:"create_text",ref:"c0",title:"小兔嘟嘟",content:"小兔嘟嘟：雪白毛色，身穿蓝色斗篷，乐观好奇，在晨光森林发现星星，始终和朋友一起前进。"},
   {type:"create_text",ref:"c1",title:"兔妈妈",content:"兔妈妈：米白毛色，身穿棕色围裙，温柔耐心，为孩子的森林冒险提供鼓励和温暖的支持。"},
   {type:"create_text",ref:"c2",title:"小龟慢慢",content:"小龟慢慢：背着橄榄绿色龟壳，沉稳细致，是小兔嘟嘟可靠的朋友，一起完成森林旅行。"}
  ])
 });
 assert.equal(first.status.stages[0].status,"auto_approved_for_continuation");
 const db=new DatabaseSync(join(directory,"acceptance.sqlite"));
 try{
  const row=db.prepare("SELECT review_json FROM p49e_stages WHERE stage_index=0").get();
  const old=JSON.parse(row.review_json);
  old.objectiveChecksPassed=false;
  old.flags=[{code:"rabbit_costume_drift"}];
  db.prepare("UPDATE p49e_stages SET status='review_pending',review_json=? WHERE stage_index=0")
   .run(JSON.stringify(old));
 }finally{db.close()}
 assert.throws(()=>recheckP49EStageFromCache(directory,"characters"),/p49e_recheck_requires_title_only_flags/);
 const db2=new DatabaseSync(join(directory,"acceptance.sqlite"));
 try{
  const old=JSON.parse(db2.prepare("SELECT review_json FROM p49e_stages WHERE stage_index=0").get().review_json);
  old.flags=[{code:"expected_title_missing",title:"小兔嘟嘟"}];
  db2.prepare("UPDATE p49e_stages SET review_json=?,result_digest=? WHERE stage_index=0")
   .run(JSON.stringify(old),"0".repeat(64));
 }finally{db2.close()}
 assert.throws(()=>recheckP49EStageFromCache(directory,"characters"),/p49e_recheck_digest_mismatch/);
});
test("P4.9f automatic approval never promotes unknown remote replies or triggers their replay",async t=>{
 const directory=start(t);let submitted=0;
 enableP49EAutoApproval(directory);
 const failed=await executeP49EStage(directory,config,"characters",{
  mockUpstreamCall:async()=>{submitted++;throw Object.assign(Error("private network interruption"),{code:"ECONNRESET"})}
 });
 assert.equal(submitted,1);
 assert.equal(failed.status.stages[0].status,"needs_reconcile");
 assert.deepEqual(enableP49EAutoApproval(directory).approved,[]);
 await assert.rejects(executeP49EStage(directory,config,"characters"),/p49e_stage_already_reserved_no_replay/);
 await assert.rejects(executeP49EStage(directory,config,"scenes"),/p49e_prior_human_approval_required/);
 assert.equal(submitted,1);
});
