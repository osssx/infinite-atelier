/** P4.9g compatibility adapter, now backed by the general P4.9h Story Event IR.
 * Keep prior report fields and code names stable; only the underlying
 * recognizer/catalog is generalized. AI draft evidence is NEVER confirmed.
 */
import {defineStoryEventCatalog,
 extractStoryEventIR,compareStoryEventIR,STORY_EVENT_IR_VERSION}
 from "./assistant-story-event-ir.mjs";

const catalog=defineStoryEventCatalog();
const known=new Map(catalog.map(d=>[d.id,d]));
export const P49G_ACTION_ANCHORS=Object.freeze([{
 id:"star_returns_to_sky",label:"把已找到的星星放回天空",
 origin:"previous_ai_storyboard_draft",stage:"storyboard"
}]);
const safeHash=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x)?x:"";
const safeExcerpt=x=>typeof x==="string"?x.replace(/[\r\n]/g," ").slice(0,100):"";
function toLegacy(e){
 return {
  id:e.id,label:e.label,provenance:"previous_ai_storyboard_draft_unconfirmed",
  sourceShotIndex:e.source.shotIndex,sourceTitle:e.source.shotTitle,
  sourceBodyDigest:e.source.bodyDigest,
  evidenceDigest:e.source.evidenceDigest,
  evidenceExcerpt:e.source.evidenceExcerpt,
  actor:e.actor,target:e.target,action:e.action,
  transition:e.transition,temporal:e.temporal,
  irVersion:STORY_EVENT_IR_VERSION,
  eventIR:e,userConfirmed:false
 };
}
function fromLegacy(candidate){
 if(!candidate||!known.has(candidate.id))return null;
 if(candidate.eventIR?.version)return null; // source event nodes don't carry version
 if(candidate.eventIR&&candidate.eventIR.id===candidate.id&&
  candidate.eventIR.source?.userConfirmed===false)return candidate.eventIR;
 // Old P4.9g reports have only event label/excerpt/digest, not state IR.
 const d=known.get(candidate.id);
 if(!safeHash(candidate.sourceBodyDigest)||!safeHash(candidate.evidenceDigest)||
  !Number.isInteger(candidate.sourceShotIndex)||candidate.sourceShotIndex<1)return null;
 return {
  id:d.id,label:d.label,
  actor:{...d.actor,verification:"catalog_expectation"},
  target:{...d.target},action:d.action,
  transition:{...d.transition,verification:"expected_not_directly_proven"},
  temporal:{phase:d.temporal.phase,after:[...d.temporal.after]},
  source:{origin:"previous_ai_storyboard_draft_unconfirmed",
   shotIndex:candidate.sourceShotIndex,shotTitle:String(candidate.sourceTitle??"").slice(0,90),
   bodyDigest:candidate.sourceBodyDigest,evidenceDigest:candidate.evidenceDigest,
   evidenceExcerpt:safeExcerpt(candidate.evidenceExcerpt),userConfirmed:false}
 };
}
export function extractP49GActionEvidence(actions){
 return extractStoryEventIR(actions,{catalog}).events.map(toLegacy);
}
export function buildP49GRevisionGuidance(sourceEvidence){
 if(!Array.isArray(sourceEvidence))throw Error("p49g_evidence_invalid");
 const sources=sourceEvidence.map(fromLegacy).filter(Boolean);
 if(!sources.length)return "";
 return "\n\n【前轮 AI 草案关键动作续写提醒（未由用户确认）】"+
  sources.map(e=>"\n- 来源：镜头"+e.source.shotIndex+
   "（内容摘要 "+e.source.bodyDigest.slice(0,16)+"）："+
   "应保留“"+e.label+"”；前轮动作证据：“"+
   safeExcerpt(e.source.evidenceExcerpt)+"”。"+
   "剧情事件 "+e.id+
   "，涉及 "+e.actor.entityId+" / "+e.target.entityId+
   "，道具或角色状态 "+e.transition.from+" → "+e.transition.to+
   "，相对顺序 "+(e.temporal.after.join("、")||"起始")+"。").join("")+
  "\n本轮增强石桥暴雨与协作，原则上保留上述已发生的情节动作；若需要改变请明确说明原因。"+
  "若保留，请在实际【动作】段落中演出这些动作，不要只写在标题、计划或连续性备注。"+
  "前轮模型草案不是用户确认设定；所有事件匹配都仅供编辑审核。";
}
export function reviewP49GRevisionContinuity(sourceEvidence,revisionActions){
 if(!Array.isArray(sourceEvidence)||!Array.isArray(revisionActions))
  throw Error("p49g_review_input_invalid");
 const original={version:STORY_EVENT_IR_VERSION,
  events:sourceEvidence.map(fromLegacy).filter(Boolean)};
 const revised=extractStoryEventIR(revisionActions,{catalog});
 const comparison=compareStoryEventIR(original,revised,{catalog});
 return {
  version:1,sourceType:"unconfirmed_ai_storyboard",
  sourceCandidates:sourceEvidence,
  evidenceStatus:comparison.evidenceStatus,
  revisionEvidence:revised.events.slice(0,12).map(e=>({
   id:e.id,sourceShotIndex:e.source.shotIndex,
   sourceBodyDigest:e.source.bodyDigest,
   evidenceDigest:e.source.evidenceDigest,
   evidenceExcerpt:e.source.evidenceExcerpt
  })),
  warnings:comparison.warnings,
  eventIR:comparison,
  userConfirmed:false,semanticReview:"pending",taskCompletionAuthorized:false
 };
}
