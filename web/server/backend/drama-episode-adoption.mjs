import {createHash} from "node:crypto";
import {stableJson} from "./repository.mjs";
import {readStoryboardDraft,readEpisodeDraft} from "../canvas-text-content.mjs";
import {unresolvedEventRefs} from "../drama-episode-links.mjs";
import {mergeEpisodeCandidateForAdoption,episodeCandidateRevision} from "./drama-episode-candidate.mjs";

const equal=(a,b)=>stableJson(a??null)===stableJson(b??null);
const hash=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const byId=items=>new Map(items.map(item=>[item.id,item]));
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const fields=["title","synopsis","events","ending","targetDurationSec","sourceRefs","eventItems","sequences"];

// Impact is deliberately conservative at episode granularity. No downstream
// content is modified until the existing explicit version confirmation flow.
function downstream(document,nodeId){
 const boardIds=new Set(document.connections.filter(edge=>edge.fromNodeId===nodeId).map(edge=>edge.toNodeId));
 const boards=document.nodes.filter(node=>node.type==="drama:storyboard"&&boardIds.has(node.id));
 const records=[];
 for(const board of boards){
  const shots=new Map();
  for(const text of [board.metadata?.dramaConfirmed,board.metadata?.dramaDraft]){
   if(!text)continue;
   const parsed=readStoryboardDraft(text);
   if(!parsed){records.push({boardId:board.id,unknown:true});continue;}
   for(const shot of parsed.shots)shots.set(stableJson([shot.id,shot.episodeId,shot.sequenceId??null]),shot);
  }
  const configs=document.nodes.filter(node=>node.type==="config"&&node.metadata?.dramaShotId&&
   (node.metadata.dramaVideoSource?.nodeId===board.id||document.connections.some(edge=>edge.fromNodeId===board.id&&edge.toNodeId===node.id)));
  records.push({boardId:board.id,shots:[...shots.values()].map(({id,episodeId,sequenceId})=>({id,episodeId,sequenceId:sequenceId??null})),
   configs:configs.map(node=>({id:node.id,shotId:node.metadata.dramaShotId}))});
 }
 return records;
}
function impactFor(records,id,after){
 const shots=new Set(),configs=new Set(),boards=new Set(),missingScenes=new Set(),missingEpisodes=new Set();
 const sequences=new Set(after?.sequences?.map(item=>item.id)??[]);
 for(const record of records){
  for(const shot of record.shots??[]){
   if(shot.episodeId!==id)continue;
   const key=record.boardId+"/"+shot.id;
   shots.add(key);boards.add(record.boardId);
   if(!after)missingEpisodes.add(key);
   else if(shot.sequenceId&&!sequences.has(shot.sequenceId))missingScenes.add(key);
   for(const config of record.configs)if(config.shotId===shot.id)configs.add(config.id);
  }
 }
 return {storyboards:boards.size,shots:shots.size,configs:configs.size,missingSceneShots:missingScenes.size,missingEpisodeShots:missingEpisodes.size};
}
function referenceIssues(after,before,paragraphs){
 if(!after)return [];
 const issues=[];
 const previousRefs=new Set(unresolvedEventRefs(before??{sequences:[]}).map(item=>stableJson(item)));
 const unresolved=unresolvedEventRefs(after);
 if(unresolved.some(item=>!previousRefs.has(stableJson(item))))issues.push("new_unresolved_event_refs");
 // Legacy unresolved refs already present on the draft are warnings, not a
 // new blocker; they are never silently repaired by adoption.
 if(unresolved.length&& !issues.length)issues.push("legacy_unresolved_event_refs");
 if(after.eventItems?.some(item=>item.status==="needs_review"))issues.push("event_needs_review");
 if(paragraphs.length){
  const valid=new Set(paragraphs.map(item=>item.id));
  const prior=new Set([...(before?.sourceRefs??[]),...(before?.sequences??[]).flatMap(item=>item.sourceRefs??[])]);
  const refs=[...after.sourceRefs,...(after.sequences??[]).flatMap(item=>item.sourceRefs??[])];
  if(refs.some(ref=>!valid.has(ref)&&!prior.has(ref)))issues.push("new_unresolved_source_refs");
  else if(refs.some(ref=>!valid.has(ref)))issues.push("legacy_unresolved_source_refs");
 }
 return issues;
}
const blocking=issues=>issues.some(issue=>issue.startsWith("new_"));

export function planEpisodeAdoption({document,nodeId,scope,current,baseline,candidate,sourceChanged,paragraphs=[],inputFence}){
 const initial=byId(baseline),live=byId(current),excluded=new Set(candidate.manualChanges?.removedEpisodeIds??[]);
 const full=scope==="*"?mergeEpisodeCandidateForAdoption(candidate,baseline):current.map(item=>candidate.episodes.find(e=>e.id===item.id)??item);
 const fullById=byId(full),candidateIds=new Set(candidate.episodes.map(item=>item.id));
 const ids=[...new Set([...full.filter(item=>scope==="*"||item.id===scope).map(item=>item.id),...baseline.map(item=>item.id),...excluded])];
 const records=downstream(document,nodeId);
 const baselineChanged=!equal(current.filter(item=>scope==="*"||item.id===scope),baseline);
 const identityConflict=scope!=="*"&&candidate.episodes.some(item=>item.id!==scope)||candidate.episodes.some(item=>live.has(item.id)&&!initial.has(item.id));
 const items=ids.map(id=>{
  const before=live.get(id)??null,after=fullById.get(id)??null;
  const beforeIndex=current.findIndex(item=>item.id===id),afterIndex=full.findIndex(item=>item.id===id);
  const changed=!equal(before,after);
  const reordered=!!before&&!!after&&beforeIndex!==afterIndex;
  const kind=excluded.has(id)?"preserved":!before&&after?"added":before&&!after?"deleted":changed?"replaced":reordered?"reordered":"unchanged";
  const issues=changed?referenceIssues(after,before,paragraphs):[];
  return {id,kind,changed,reordered,beforeIndex,afterIndex,before,after,
   fields:changed&&before&&after?fields.filter(field=>!equal(before[field],after[field])):[],
   issues,blocked:blocking(issues),selectable:changed&&!excluded.has(id)&&(candidateIds.has(id)||kind==="deleted"),
   impact:changed?impactFor(records,id,after):{storyboards:0,shots:0,configs:0,missingSceneShots:0,missingEpisodeShots:0}};
 });
 const globalBlocked=sourceChanged||baselineChanged||identityConflict;
 const summary=Object.fromEntries(["added","replaced","deleted","reordered","unchanged","preserved"].map(kind=>[kind,items.filter(item=>item.kind===kind).length]));
 const token=hash({nodeId,scope,current,baseline,candidate,inputFence,records,sourceChanged});
 return {revision:episodeCandidateRevision(candidate),reviewToken:token,sourceChanged,baselineChanged,identityConflict,
  globalBlocked,fullAdoptBlocked:globalBlocked||items.some(item=>item.blocked)||!full.length,
  impactUnknown:records.some(item=>item.unknown),summary,items,full};
}

// Selected operations preserve unselected existing order. New rows insert
// before the next surviving candidate neighbor, else after the last neighbor.
export function selectEpisodeAdoption(plan,current,episodeIds){
 if(plan.globalBlocked)throw fail("drama_candidate_conflict");
 if(episodeIds===undefined){
  if(plan.fullAdoptBlocked)throw fail("drama_episode_adoption_invalid");
  return plan.full;
 }
 if(!Array.isArray(episodeIds))throw fail("drama_episode_adoption_invalid",422);
 const selected=new Set(episodeIds);
 if(!selected.size||selected.size!==episodeIds.length||
  [...selected].some(id=>!plan.items.some(item=>item.id===id&&item.selectable&&!item.blocked)))
  throw fail("drama_episode_adoption_invalid",422);
 const proposed=byId(plan.full),existing=new Set(current.map(item=>item.id));
 const result=current.flatMap(item=>!selected.has(item.id)?[item]:proposed.has(item.id)?[proposed.get(item.id)]:[]);
 for(const item of plan.full.filter(item=>selected.has(item.id)&&!existing.has(item.id))){
  const index=plan.full.findIndex(entry=>entry.id===item.id);
  const following=plan.full.slice(index+1).find(entry=>result.some(value=>value.id===entry.id));
  const preceding=plan.full.slice(0,index).findLast(entry=>result.some(value=>value.id===entry.id));
  const offset=following?result.findIndex(entry=>entry.id===following.id):preceding?result.findIndex(entry=>entry.id===preceding.id)+1:result.length;
  result.splice(offset,0,item);
 }
 if(!result.length||!readEpisodeDraft(stableJson({episodes:result})))throw fail("drama_episode_adoption_invalid",422);
 return result;
}

export function validEpisodeAdoptionRecord(record,candidate,baseline,state){
 if(record===undefined)return true;
 if(state!=="adopted"||!Array.isArray(baseline)||!record||record.reviewToken!==undefined&&!/^[a-f0-9]{64}$/.test(record.reviewToken)||!["all","selected"].includes(record.mode)||!Array.isArray(record.episodeIds)||
  new Set(record.episodeIds).size!==record.episodeIds.length||!record.episodeIds.every(id=>typeof id==="string"&&
   [...candidate.episodes,...baseline].some(item=>item?.id===id))||!Array.isArray(record.appliedEpisodeIds)||
  new Set(record.appliedEpisodeIds).size!==record.appliedEpisodeIds.length||!record.appliedEpisodeIds.every(id=>record.episodeIds.includes(id)))return false;
 return record.mode==="all"||record.episodeIds.length>0;
}
