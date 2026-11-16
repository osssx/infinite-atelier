/** P4.9g: evidence-led story action continuity for isolated creative revisions.
 * These are editorial hints derived from prior AI-generated drafts, NOT user
 * confirmed facts and NOT a deterministic semantic proof of story quality.
 */
import {createHash} from "node:crypto";

const digest=value=>createHash("sha256").update(String(value)).digest("hex");
const nonCommitted=/不要|不得|不能|不应|不会|尚未|未曾|没有|尚不|未能|无法|没把|别把|禁止|如果|假设|计划|打算|希望|准备|可能|仅仅|只是提到|提议|讨论|尚待|说要|打算要/;
const STAR_RETURN=/((?:把|将)(?:那颗|那枚|小|遗失的|找到的|温暖的|发光的|迷路的|失落的|一颗|这颗|那颗小)?星星.{0,24}(?:放回|送回|归还|送还|放归).{0,18}(?:天空|天上|星空))|((?:星星|那颗星).{0,20}(?:升回|飞回|返回|回到).{0,18}(?:天空|天上|星空))/;
const ACTION_LABEL=/^\s*(?:动作|动作描述|角色动作|表演动作)\s*[:：]/;
const nextField=/^\s*(?:出场人物|地点|连续性|连续性提示|景别|摄影机运动|镜头运动|提示词|备注|构图|镜头语言)\s*[:：]/;
const textContent=action=>typeof action?.content==="string"?action.content:"";
const isTextNode=a=>a?.type==="create_text"||(a?.type==="create_node"&&a?.nodeType==="text");
const clip=str=>str.slice(0,180);

export const P49G_ACTION_ANCHORS=Object.freeze([{
 id:"star_returns_to_sky",label:"把已找到的星星放回天空",
 origin:"previous_ai_storyboard_draft",stage:"storyboard"
}]);
function actionClauses(text){
 const lines=text.split(/\r?\n/);
 let reading=false;
 const segments=[];
 for(const line of lines){
  if(ACTION_LABEL.test(line)){
   reading=true;
   segments.push(line.replace(ACTION_LABEL,""));
   continue;
  }
  if(nextField.test(line)||/^\s*【?(?:镜头|分镜)\d/.test(line)){
   reading=false;continue;
  }
  if(reading)segments.push(line);
 }
 return segments.join(" ").split(/[。！!；;\n]/).map(x=>x.trim()).filter(Boolean);
}
function positiveEvidence(text){
 // Keep only the matched performed action span, never a free-form upstream
 // sentence that might contain unrelated instructions or private tokens.
 for(const clause of actionClauses(text)){
  if(nonCommitted.test(clause))continue;
  const matched=clause.match(STAR_RETURN);
  if(matched)return matched[0];
 }
 return null;
}
export function extractP49GActionEvidence(actions){
 if(!Array.isArray(actions))throw Error("p49g_actions_invalid");
 const originals=actions.filter(isTextNode);
 const candidates=[];
 for(const [index,action] of originals.entries()){
  const body=textContent(action);
  const clause=positiveEvidence(body);
  if(!clause)continue;
  candidates.push({id:"star_returns_to_sky",label:P49G_ACTION_ANCHORS[0].label,
   provenance:"previous_ai_storyboard_draft_unconfirmed",
   sourceShotIndex:index+1,
   sourceTitle:String(action.title??"").slice(0,90),
   sourceBodyDigest:digest(body),
   evidenceDigest:digest(clause),evidenceExcerpt:clip(clause),
   userConfirmed:false});
 }
 return candidates.slice(0,1);
}
export function buildP49GRevisionGuidance(sourceEvidence){
 if(!Array.isArray(sourceEvidence))throw Error("p49g_evidence_invalid");
 if(!sourceEvidence.length)return "";
 // The original quote comes from the immutable, previously completed
 // storyboard. Limit length and insist it is clearly tagged AI draft.
 return "\n\n【前轮 AI 草案关键动作续写提醒（未由用户确认）】"+
  sourceEvidence.map(x=>"\n- 来源：镜头"+x.sourceShotIndex+
   "（内容摘要 "+x.sourceBodyDigest.slice(0,16)+"）："+
   "“"+x.evidenceExcerpt+"”。").join("")+
  "\n本轮增强石桥暴雨与协作，原则上保留上述已发生的情节动作；若需要改变请明确说明原因。"+
  "若保留，请在最后的实际【动作】描述中演出该动作，而不是只把文字抄到标题、提示或连续性备注。"+
  "上列为前轮模型草案，不可提升为用户已确认事实。";
}
export function reviewP49GRevisionContinuity(sourceEvidence,revisionActions){
 if(!Array.isArray(sourceEvidence)||!Array.isArray(revisionActions))
  throw Error("p49g_review_input_invalid");
 const candidates=revisionActions.filter(isTextNode);
 const sourceIds=[...new Set(sourceEvidence.map(x=>x.id))];
 const found=candidates.flatMap((action,i)=>{
  const hit=positiveEvidence(textContent(action));
  return hit?[{sourceShotIndex:i+1,sourceBodyDigest:digest(textContent(action)),
   evidenceDigest:digest(hit),evidenceExcerpt:clip(hit)}]:[];
 });
 const missing=sourceIds.includes("star_returns_to_sky")&&found.length===0?
  [{id:"star_returns_to_sky",code:"prior_story_action_not_observed",
   description:"上轮草案的星星放回天空动作未在修订动作段落中观察到"}]:[];
 return {
  version:1,sourceType:"unconfirmed_ai_storyboard",sourceCandidates:sourceEvidence,
  evidenceStatus:sourceIds.length===0?"no_source_candidate":
   missing.length?"requires_editor_review":"candidate_observed_in_revision",
  revisionEvidence:found.slice(0,3),warnings:missing,
  userConfirmed:false,semanticReview:"pending",
  taskCompletionAuthorized:false
 };
}
