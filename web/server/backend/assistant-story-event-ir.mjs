/** P4.9h: versioned, declarative Story Event IR.
 *
 * The catalog is authored by trusted app code, never compiled from a model
 * response. Model text can supply only cited candidate evidence, not schema
 * fields, confirmation, precedence, or permissions.
 *
 * This lexical recognizer is an editorial heuristic, NOT semantic validation.
 */
import {createHash} from "node:crypto";

export const STORY_EVENT_IR_VERSION=1;
const sha=value=>createHash("sha256").update(value).digest("hex");
const idOk=value=>typeof value==="string"&&/^[a-z][a-z0-9_]{0,63}$/.test(value);
const labelOk=value=>typeof value==="string"&&value.length>0&&value.length<=90&&
 !/[\r\n{}<>]/.test(value);
const safeToken=value=>typeof value==="string"&&value.length>0&&value.length<=20&&
 /^[\p{L}\p{N}_]+$/u.test(value);
const plain=o=>o!==null&&typeof o==="object"&&Object.getPrototypeOf(o)===Object.prototype;
const reject=()=>{throw Error("story_event_ir_definition_invalid")};
const deepFreeze=value=>{
 if(!value||typeof value!=="object"||Object.isFrozen(value))return value;
 for(const nested of Object.values(value))deepFreeze(nested);
 return Object.freeze(value);
};

export const P49H_RABBIT_STORY_CATALOG=deepFreeze([
 {
  id:"star_found_in_forest",label:"在森林发现遗失星星",
  actor:{entityId:"rabbit_dudu",role:"discoverer"},
  target:{entityId:"lost_star",kind:"prop"},
  action:"discover",
  transition:{entityId:"lost_star",property:"discovery",from:"unlocated",to:"found"},
  temporal:{phase:"setup",after:[]},
  recognition:{sequences:[
   [["发现","找到","拾起","捡到"],["星星","星屑","那颗星"]]
  ],maxGap:24}
 },{
  id:"lost_animal_rescued_at_bridge",label:"在暴雨石桥营救迷路小动物",
  actor:{entityId:"rabbit_dudu",role:"helper"},
  target:{entityId:"lost_animal",kind:"character"},
  action:"rescue",
  transition:{entityId:"lost_animal",property:"safety",from:"stranded",to:"rescued"},
  temporal:{phase:"rescue",after:["star_found_in_forest"]},
  recognition:{sequences:[
   [["帮助","救出","救助","救援","救起"],["迷路","小动物","受困","幼崽"]],
   [["迷路","受困"],["小动物","幼崽"],["获救","救出","带离"]]
  ],maxGap:26}
 },{
  id:"star_returns_to_sky",label:"把已找到的星星放回天空",
  actor:{entityId:"rabbit_dudu",role:"returner"},
  target:{entityId:"lost_star",kind:"prop"},
  action:"return",
  transition:{entityId:"lost_star",property:"location",from:"carried",to:"night_sky"},
  temporal:{phase:"resolution",after:["star_found_in_forest","lost_animal_rescued_at_bridge"]},
  recognition:{sequences:[
   [["星星","小星星","那颗星"],["放回","送回","归还","送还","放归"],["天空","天上","星空"]],
   [["星星","小星星","那颗星"],["升回","飞回","返回","回到"],["天空","天上","星空"]]
  ],maxGap:28}
 }
]);

function validateDefinition(d){
 if(!plain(d)||!idOk(d.id)||!labelOk(d.label)||!idOk(d.action))reject();
 if(!plain(d.actor)||!idOk(d.actor.entityId)||!idOk(d.actor.role)||
  !plain(d.target)||!idOk(d.target.entityId)||!["prop","character","location"].includes(d.target.kind))reject();
 if(!plain(d.transition)||!idOk(d.transition.entityId)||!idOk(d.transition.property)||
  !idOk(d.transition.from)||!idOk(d.transition.to)||
  !plain(d.temporal)||!idOk(d.temporal.phase)||!Array.isArray(d.temporal.after)||
  d.temporal.after.length>8||!d.temporal.after.every(idOk))reject();
 if(!plain(d.recognition)||!Number.isInteger(d.recognition.maxGap)||
  d.recognition.maxGap<0||d.recognition.maxGap>48||
  !Array.isArray(d.recognition.sequences)||!d.recognition.sequences.length||
  d.recognition.sequences.length>6)reject();
 for(const seq of d.recognition.sequences){
  if(!Array.isArray(seq)||seq.length<2||seq.length>4)reject();
  for(const alternatives of seq){
   if(!Array.isArray(alternatives)||!alternatives.length||alternatives.length>12||
    !alternatives.every(safeToken))reject();
  }
 }
}
export function defineStoryEventCatalog(definitions=P49H_RABBIT_STORY_CATALOG){
 if(!Array.isArray(definitions)||definitions.length>24)reject();
 const ids=new Set();
 for(const d of definitions){
  validateDefinition(d);
  if(ids.has(d.id))reject();
  ids.add(d.id);
 }
 for(const d of definitions)
  for(const prerequisite of d.temporal.after)
   if(!ids.has(prerequisite)||prerequisite===d.id)reject();
 const visiting=new Set(),visited=new Set();
 const dfs=id=>{
  if(visited.has(id))return;
  if(visiting.has(id))reject();
  visiting.add(id);
  const d=definitions.find(item=>item.id===id);
  for(const prerequisite of d.temporal.after)dfs(prerequisite);
  visiting.delete(id);visited.add(id);
 };
 for(const id of ids)dfs(id);
 // Copy definitions as JSON-only immutable descriptors. Never persist RegExp
 // or executable callbacks from model data.
 return deepFreeze(definitions.map(d=>structuredClone(d)));
}

const NON_COMMITTED=/不要|不得|不能|不应|不会|尚未|未曾|没有|尚不|未能|无法|没把|别把|禁止|如果|假设|计划|打算|希望|准备|可能|仅仅|只是提到|提议|讨论|尚待|说要|打算要|未发现|未找到|没找到/;
const ACTION_START=/^\s*(?:动作|动作描述|角色动作|表演动作)\s*[:：]/;
const FIELD_END=/^\s*(?:出场人物|地点|连续性|连续性提示|景别|摄影机运动|镜头运动|提示词|备注|构图|镜头语言|灯光|音效|色彩|时长)\s*[:：]/;
const TITLE_START=/^\s*【?(?:修订)?(?:镜头|分镜)\s*\d/;
const isTextNode=x=>x?.type==="create_text"||(x?.type==="create_node"&&x?.nodeType==="text");
const textContent=x=>typeof x?.content==="string"?x.content:"";
function actionClauses(text){
 const lines=text.split(/\r?\n/);
 let active=false;
 const acc=[];
 for(const line of lines){
  if(ACTION_START.test(line)){active=true;acc.push(line.replace(ACTION_START,""));continue}
  if(FIELD_END.test(line)||TITLE_START.test(line)){active=false;continue}
  if(active)acc.push(line);
 }
 return acc.join(" ").split(/[。！？!；;\n]/).map(s=>s.trim()).filter(Boolean);
}
function sequenceMatch(clause,definition){
 for(const seq of definition.recognition.sequences){
  for(const initial of seq[0]){
   let cursor=0,attempts=0;
   while(attempts++<24){
    const start=clause.indexOf(initial,cursor);
    if(start<0)break;
    cursor=start+initial.length;
    let position=cursor,failed=false;
    const matched=[initial];
    for(const alternatives of seq.slice(1)){
     let best=null;
     for(const word of alternatives){
      const at=clause.indexOf(word,position);
      if(at>=0&&at-position<=definition.recognition.maxGap&&
       (!best||at<best.at))best={word,at};
     }
     if(!best){failed=true;break}
     position=best.at+best.word.length;
     matched.push(best.word);
    }
    if(!failed){
     const prefix=start>0&&/[把将]/.test(clause[start-1])?clause[start-1]:"";
     return {excerpt:prefix+clause.slice(start,position),start,tokens:matched};
    }
   }
  }
 }
 return null;
}
function recognizedClause(text,definition){
 for(const clause of actionClauses(text)){
  if(NON_COMMITTED.test(clause))continue;
  const match=sequenceMatch(clause,definition);
  if(match)return match;
 }
 return null;
}
function eventSchema(d){
 return {
  id:d.id,label:d.label,
  actor:{entityId:d.actor.entityId,role:d.actor.role,verification:"catalog_expectation"},
  target:{entityId:d.target.entityId,kind:d.target.kind},
  action:d.action,
  transition:{...d.transition,verification:"expected_not_directly_proven"},
  temporal:{phase:d.temporal.phase,after:[...d.temporal.after]},
 };
}
/** Extract evidence candidates from model TEXT node action clauses only.
 * No inferred state can be written back to the Task's confirmed facts.
 */
export function extractStoryEventIR(actions,{catalog=defineStoryEventCatalog()}={}){
 if(!Array.isArray(actions)||actions.length>200)throw Error("story_event_ir_input_invalid");
 const events=[],cards=actions.filter(isTextNode);
 for(const [index,card] of cards.entries()){
  const body=textContent(card);
  if(body.length>40000)continue;
  for(const d of catalog){
   const hit=recognizedClause(body,d);
   if(!hit)continue;
   // sourceTitle is for editorial display only; it is never interpolated into
   // the next Provider prompt.
   events.push({...eventSchema(d),source:{
    origin:"previous_ai_storyboard_draft_unconfirmed",
    shotIndex:index+1,shotTitle:String(card.title??"").slice(0,90),
    bodyDigest:sha(body),evidenceDigest:sha(hit.excerpt),
    evidenceExcerpt:hit.excerpt.slice(0,100),
    userConfirmed:false
   }});
  }
 }
 // Keep first occurrence per event type to avoid unbounded repeated hints.
 const unique=new Map();
 for(const event of events)if(!unique.has(event.id))unique.set(event.id,event);
 return {version:STORY_EVENT_IR_VERSION,kind:"story_event_candidates",
  sourceType:"unconfirmed_ai_storyboard",events:[...unique.values()],
  userConfirmed:false,semanticReview:"pending",taskCompletionAuthorized:false};
}
function ordinal(a){return a?.source?.shotIndex??0}
export function compareStoryEventIR(source,revision,{catalog=defineStoryEventCatalog()}={}){
 if(source?.version!==STORY_EVENT_IR_VERSION||revision?.version!==STORY_EVENT_IR_VERSION||
  !Array.isArray(source.events)||!Array.isArray(revision.events))throw Error("story_event_ir_compare_invalid");
 const allowed=new Set(catalog.map(x=>x.id));
 const before=source.events.filter(x=>allowed.has(x.id));
 const after=new Map(revision.events.filter(x=>allowed.has(x.id)).map(x=>[x.id,x]));
 const warnings=[];
 for(const candidate of before){
  if(!after.has(candidate.id))warnings.push({
   id:candidate.id,code:"prior_story_action_not_observed",
   description:"前一版 AI 草案的关键动作未在修订版动作段落中观察到",
   scope:"ai_draft_editorial_warning",
   sourceShotIndex:ordinal(candidate),
   sourceBodyDigest:candidate.source?.bodyDigest??null
  });
 }
 for(const candidate of before){
  const revisionEvent=after.get(candidate.id);
  if(!revisionEvent)continue;
  const def=catalog.find(x=>x.id===candidate.id);
  for(const prerequisite of def.temporal.after){
   const previousSource=before.find(x=>x.id===prerequisite);
   const precedingRevision=after.get(prerequisite);
   if(!previousSource||!precedingRevision)continue;
   if(ordinal(previousSource)<ordinal(candidate)&&
    ordinal(precedingRevision)>ordinal(revisionEvent))
    warnings.push({id:candidate.id,afterEventId:prerequisite,
     code:"prior_story_event_order_changed",scope:"ai_draft_editorial_warning",
     description:"修订后的剧情关键动作与原草案的先后顺序相反"});
  }
 }
 return {
  version:STORY_EVENT_IR_VERSION,
  kind:"story_event_continuity_review",
  sourceEvents:before,
  revisionEvents:[...after.values()],
  warnings,
  evidenceStatus:before.length===0?"no_source_candidate":
   warnings.length?"requires_editor_review":"candidate_observed_in_revision",
  userConfirmed:false,semanticReview:"pending",taskCompletionAuthorized:false
 };
}
