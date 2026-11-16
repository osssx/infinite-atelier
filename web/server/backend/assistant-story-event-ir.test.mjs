import test from "node:test";
import assert from "node:assert/strict";
import {
 STORY_EVENT_IR_VERSION,P49H_RABBIT_STORY_CATALOG,
 defineStoryEventCatalog,extractStoryEventIR,compareStoryEventIR
} from "./assistant-story-event-ir.mjs";

const create=(title,action,note="")=>({
 type:"create_text",title,ref:title,
 content:"【"+title+"】\n景别：中景。\n动作："+action+"。\n出场人物：小兔嘟嘟，兔妈妈，小龟慢慢。\n连续性："+note
});
const original=[
 create("镜头1","小兔嘟嘟在晨光森林发现遗失的星星"),
 create("镜头2","小龟慢慢检查石桥的雨水"),
 create("镜头3","小兔嘟嘟帮助迷路小动物走出暴雨中的石桥"),
 create("镜头4","兔妈妈招呼大家继续前进"),
 create("镜头5","伙伴们在观星草地团聚"),
 create("镜头6","小兔嘟嘟把星星轻轻放回天空")
];
test("P4.9h catalog validates versioned declarative actor/target/transition/time references",()=>{
 assert.equal(STORY_EVENT_IR_VERSION,1);
 const defs=defineStoryEventCatalog();
 assert.equal(defs.length,3);
 assert.deepEqual(defs[2].temporal.after,["star_found_in_forest","lost_animal_rescued_at_bridge"]);
 assert.equal(defs[2].transition.from,"carried");
 assert.equal(defs[2].transition.to,"night_sky");
 assert.equal(defs[0].actor.entityId,"rabbit_dudu");
 assert.equal(defs[1].target.entityId,"lost_animal");
 assert.equal(Object.isFrozen(defs[2].recognition.sequences[0][0]),true);
 assert.equal(Object.isFrozen(P49H_RABBIT_STORY_CATALOG[2].transition),true);
 assert.throws(()=>{defs[2].transition.to="elsewhere"},TypeError);
 assert.doesNotMatch(JSON.stringify(defs),/function|RegExp|eval\(/);
 const invalid=(mutator)=>{
  const d=structuredClone(P49H_RABBIT_STORY_CATALOG);
  mutator(d);
  assert.throws(()=>defineStoryEventCatalog(d),/story_event_ir_definition_invalid/);
 };
 invalid(d=>d[0].id="Bad ID");
 invalid(d=>d.push({...d[0]}));
 invalid(d=>d[0].recognition.sequences[0][0][0]=".*(a+)+");
 invalid(d=>d[0].temporal.after=["imaginary_event"]);
 invalid(d=>d[0].temporal.after=["star_found_in_forest"]);
 invalid(d=>{d[0].temporal.after=["star_returns_to_sky"]});
});
test("P4.9h IR extraction has actor, prop state transitions, temporal links and immutable source provenance",()=>{
 const ir=extractStoryEventIR(original);
 assert.equal(ir.version,1);
 assert.equal(ir.kind,"story_event_candidates");
 assert.deepEqual(ir.events.map(x=>x.id),[
  "star_found_in_forest","lost_animal_rescued_at_bridge","star_returns_to_sky"
 ]);
 assert.deepEqual(ir.events.map(x=>x.source.shotIndex),[1,3,6]);
 assert.equal(ir.events[2].source.bodyDigest.length,64);
 assert.equal(ir.events[2].source.evidenceDigest.length,64);
 assert.match(ir.events[2].source.evidenceExcerpt,/把星星轻轻放回天空/);
 assert.deepEqual(ir.events[2].temporal.after,[
  "star_found_in_forest","lost_animal_rescued_at_bridge"
 ]);
 assert.equal(ir.events[2].transition.property,"location");
 assert.equal(ir.events[2].transition.verification,"expected_not_directly_proven");
 assert.equal(ir.events[2].actor.verification,"catalog_expectation");
 assert.equal(ir.events[2].source.userConfirmed,false);
 assert.equal(ir.userConfirmed,false);
 assert.equal(ir.semanticReview,"pending");
 assert.equal(ir.taskCompletionAuthorized,false);
 assert.doesNotMatch(JSON.stringify(ir),/PRIVATE_SECRET|api_key/i);
});
test("P4.9h missing event only yields editorial candidate warnings, not a semantic or task completion result",()=>{
 const source=extractStoryEventIR(original);
 const revised=extractStoryEventIR([
  create("修订分镜1","小兔嘟嘟在森林发现星星"),
  create("修订分镜2","小龟慢慢在暴雨石桥救援迷路动物"),
  create("修订分镜3","小兔嘟嘟举高星星，灯光照亮夜空")
 ]);
 const result=compareStoryEventIR(source,revised);
 assert.equal(result.evidenceStatus,"requires_editor_review");
 assert.equal(result.warnings.length,1);
 assert.equal(result.warnings[0].id,"star_returns_to_sky");
 assert.equal(result.warnings[0].code,"prior_story_action_not_observed");
 assert.equal(result.warnings[0].scope,"ai_draft_editorial_warning");
 assert.equal(result.semanticReview,"pending");
 assert.equal(result.userConfirmed,false);
 assert.equal(result.taskCompletionAuthorized,false);
});
test("P4.9h in-order story events are candidates, but reversing scene event order flags a separate warning",()=>{
 const source=extractStoryEventIR(original);
 const ordered=extractStoryEventIR([
  create("修订分镜1","在晨光森林找到星星"),
  create("修订分镜2","三人在暴雨石桥救助迷路小动物"),
  create("修订分镜3","小兔嘟嘟将星星送回天上")
 ]);
 const ok=compareStoryEventIR(source,ordered);
 assert.equal(ok.evidenceStatus,"candidate_observed_in_revision");
 assert.equal(ok.warnings.length,0);
 assert.equal(ok.taskCompletionAuthorized,false);
 const reversed=extractStoryEventIR([
  create("修订分镜1","小兔嘟嘟将星星送回天上"),
  create("修订分镜2","三人在暴雨石桥救助迷路小动物"),
  create("修订分镜3","在晨光森林找到星星")
 ]);
 const wrong=compareStoryEventIR(source,reversed);
 assert.equal(wrong.evidenceStatus,"requires_editor_review");
 assert.ok(wrong.warnings.some(x=>x.code==="prior_story_event_order_changed"&&
  x.id==="star_returns_to_sky"));
});
test("P4.9h headings, dialogue/negated/conditional intent, notes and arbitrary model JSON cannot fabricate performed actions",()=>{
 const source=extractStoryEventIR(original);
 for(const text of [
  create("镜头6：小兔嘟嘟把星星放回天空","小兔嘟嘟举高星星","连续性：星星送回天空"),
  create("镜头6","小兔嘟嘟说不要把星星放回天空"),
  create("镜头6","小兔嘟嘟计划把星星放回天空"),
  create("镜头6","如果把星星放回天空，大家会开心"),
  create("镜头6","小兔嘟嘟说要把星星放回天空"),
  {type:"create_text",title:"镜头6",content:"备注：把星星放回天空",userConfirmed:true,
   fakeEvent:{id:"star_returns_to_sky",userConfirmed:true}}
 ]){
  const ir=extractStoryEventIR([text]);
  assert.equal(ir.events.length,0,text.content);
  assert.ok(compareStoryEventIR(source,ir).warnings.some(x=>x.id==="star_returns_to_sky"));
 }
});
test("P4.9h code-owned catalogs compose without hardcoded star logic or unsafe model-supplied regex",()=>{
 const defs=defineStoryEventCatalog([{
  id:"key_handed_to_friend",label:"将钥匙交给朋友",
  actor:{entityId:"hero",role:"giver"},target:{entityId:"key",kind:"prop"},
  action:"transfer",
  transition:{entityId:"key",property:"owner",from:"hero",to:"friend"},
  temporal:{phase:"handoff",after:[]},
  recognition:{sequences:[[[ "钥匙" ],[ "交给","递给" ],[ "朋友" ]]],maxGap:18}
 }]);
 const old=extractStoryEventIR([create("镜头1","英雄把钥匙递给朋友")],{catalog:defs});
 assert.equal(old.events.length,1);
 assert.equal(old.events[0].id,"key_handed_to_friend");
 assert.deepEqual(old.events[0].transition,{entityId:"key",property:"owner",
  from:"hero",to:"friend",verification:"expected_not_directly_proven"});
 const omitted=extractStoryEventIR([create("镜头1","英雄把钥匙放在桌上")],{catalog:defs});
 assert.equal(compareStoryEventIR(old,omitted,{catalog:defs}).warnings[0].id,"key_handed_to_friend");
});
test("P4.9h absent source evidence never fabricates obligations",()=>{
 const empty=extractStoryEventIR([create("镜头1","三人结伴走过草地")]);
 const same=extractStoryEventIR([create("修订镜头1","草地上大家聊天")]);
 const r=compareStoryEventIR(empty,same);
 assert.equal(r.evidenceStatus,"no_source_candidate");
 assert.deepEqual(r.warnings,[]);
});
