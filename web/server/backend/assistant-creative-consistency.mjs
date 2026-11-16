/** P4.9b reproducible *review aid*, never the Task completion verifier.
 * Fictional user-confirmed facts are supplied to an isolated Task. Never use
 * findings to auto-approve canvas edits or claim semantic quality is proven.
 */
import {createHash} from "node:crypto";
import {isPopulatedCreativeBody} from "./assistant-creative-content.mjs";

export const P49B_CASE={
 id:"rabbit-short-animation-v1",
 title:"《小兔嘟嘟的星星》儿童动画连续创作",
 originalRequest:"制作儿童动画《小兔嘟嘟的星星》。人物固定：小兔嘟嘟是雪白毛色，穿蓝色斗篷，乐观好奇；兔妈妈是米白毛色，穿棕色围裙，温柔耐心；小龟慢慢背橄榄绿色龟壳，沉稳细致。主线：森林发现遗失星星，经石桥冒雨帮迷路的小动物回家，在观星草地团聚。已确认事实不因后续草案改变。",
 confirmedGoal:"制作一组角色卡、场景设定和六个分镜文本节点，保持儿童动画的人物外貌、关系、场景顺序和事件连续性。",
 confirmedNotes:[
  "用户确认人物：小兔嘟嘟雪白毛色、蓝色斗篷、乐观好奇；兔妈妈米白毛色、棕色围裙、温柔耐心；小龟慢慢橄榄绿色龟壳、沉稳细致。",
  "用户确认场景顺序：晨光森林小径 → 石桥（暴雨） → 观星草地；星星在森林中被找到，迷路的小动物从石桥获救后在草地团聚。",
  "用户确认稳定关系：小兔嘟嘟是主角，兔妈妈给出鼓励，小龟慢慢是陪伴小兔冒险的朋友；续写不得将朋友改写成反派。"
 ],
 stages:[
  {id:"characters",kind:"角色卡",count:3,
   request:"根据用户已确认的人设，为小兔嘟嘟、兔妈妈、小龟慢慢各创建一份完整的角色卡文本节点（共3个），写清毛色、服饰、性格、关系及供绘图使用的描述，不要空白模板。",
   titles:["小兔嘟嘟","兔妈妈","小龟慢慢"],required:["小兔嘟嘟","兔妈妈","小龟慢慢"]},
  {id:"scenes",kind:"场景设定",count:3,
   request:"继续此前同一个儿童动画 Task，依照已确认的人物和故事顺序，创建3个具体的场景设定文本节点：晨光森林小径、暴雨石桥、观星草地。注意角色服饰和空间位置一致。",
   titles:["晨光森林小径","暴雨石桥","观星草地"],required:["森林","石桥","草地","小兔嘟嘟","小龟慢慢"]},
  {id:"storyboard",kind:"分镜提示词",count:6,
   request:"继续创作，创建6个分镜提示词文本节点，每个镜头给出景别、摄影机运动、动作、出场人物、地点。分镜必须按森林发现星星、石桥帮助迷路动物、观星草地团聚的故事顺序，不改角色外貌和关系。",
   titles:["镜头1","镜头2","镜头3","镜头4","镜头5","镜头6"],
   required:["小兔嘟嘟","小龟慢慢","兔妈妈","森林","石桥","草地"]},
  {id:"revision",kind:"雨天修订分镜",count:6,
   request:"继续上一轮分镜，将石桥的冒雨营救情节加强为明显的暴雨与互相协作，再创建6个修订版分镜提示词文本节点。必须保留小兔嘟嘟的蓝色斗篷、兔妈妈的棕色围裙、小龟慢慢的橄榄绿龟壳和既定人物关系；这只是新的草案，不能覆盖已有画布内容。",
   titles:["修订镜头1","修订镜头2","修订镜头3","修订镜头4","修订镜头5","修订镜头6"],
   required:["小兔嘟嘟","小龟慢慢","兔妈妈","暴雨","石桥"]}
 ]
};

// These strings are *review triggers*, not a semantic model. Contexts such as
// "不要穿红色斗篷" are possible false positives and need human judgement.
const suspicious=[
 {code:"rabbit_costume_drift",pattern:/红色斗篷|粉色斗篷|黄色斗篷/g},
 {code:"mother_costume_drift",pattern:/兔妈妈.{0,18}(?:黑色长裙|蓝色斗篷)/g},
 {code:"turtle_shell_drift",pattern:/小龟慢慢.{0,18}(?:金色龟壳|红色龟壳)/g},
 {code:"friend_relationship_drift",pattern:/小龟慢慢.{0,24}(?:反派|敌人|背叛)/g}
];
const sha=value=>createHash("sha256").update(value).digest("hex");
const sanitize=value=>String(value??"").replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S{12,})\b/gi,"[redacted]")
 .replace(/(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi,"[redacted]");
const bodyOf=action=>typeof action?.content==="string"?action.content:"";
export function reviewP49BCreativeActions(stage,actions){
 if(!stage||!Array.isArray(stage.titles)||!Array.isArray(actions))throw Error("p49b_review_input_invalid");
 const cards=actions.filter(a=>a?.type==="create_text"||a?.type==="create_node"&&a?.nodeType==="text");
 const flags=[],body=cards.map(a=>bodyOf(a)).join("\n");
 if(cards.length!==stage.count)flags.push({code:"node_count_mismatch",expected:stage.count,actual:cards.length});
 for(const title of stage.titles)
  if(!cards.some(a=>typeof a.title==="string"&&a.title.includes(title)))
   flags.push({code:"expected_title_missing",title});
 for(const [index,card] of cards.entries()){
  if(!isPopulatedCreativeBody(bodyOf(card)))flags.push({code:"body_incomplete",index,title:sanitize(card.title).slice(0,80)});
 }
 for(const term of stage.required)
  if(!body.includes(term))flags.push({code:"fact_not_mentioned",term});
 for(const {code,pattern} of suspicious){
  const hit=[...body.matchAll(new RegExp(pattern.source,pattern.flags))];
  if(hit.length)flags.push({code,occurrences:hit.length});
 }
 return {
  stageId:stage.id,expectedCount:stage.count,actualCount:cards.length,
  objectiveChecksPassed:flags.length===0,flags,
  cards:cards.slice(0,8).map(a=>({
   title:sanitize(a.title).slice(0,100),length:bodyOf(a).length,
   digest:sha(bodyOf(a)),
   // Never silently treat a truncated excerpt as full human-review evidence.
   truncated:bodyOf(a).length>8000,
   text:sanitize(bodyOf(a)).slice(0,8000)
  })),
  // Never default to "passed" based on keywords, even if no flags exist.
  humanReview:{characterIdentity:"pending",characterAppearance:"pending",
   relationships:"pending",sceneContinuity:"pending",
   eventChronology:"pending",shotLanguage:"pending",revisionPreservesFacts:"pending"},
  conclusion:"human_review_required"
 };
}
