import {readEpisodeDraft} from "../canvas-text-content.mjs";
import {normalizeEpisodeEvents,unresolvedEventRefs} from "../drama-episode-links.mjs";
import {stableJson} from "./repository.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const plain=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const id=value=>typeof value==="string"&&value.trim().length>0&&value.length<=256;
const ids=value=>Array.isArray(value)&&value.every(id)&&new Set(value).size===value.length;
const text=value=>typeof value==="string"&&value.length<=12000;
const refs=value=>Array.isArray(value)&&value.length<=500&&value.every(id);
const sequence=value=>plain(value)&&Object.keys(value).every(key=>["id","title","sourceRefs","eventRefs","replaces"].includes(key))&&
 id(value.id)&&text(value.title)&&["sourceRefs","eventRefs","replaces"].every(key=>value[key]===undefined||refs(value[key]));

export const episodeCandidateRevision=candidate=>candidate?.revision===undefined?0:candidate.revision;

// Older archives did not store a revision. A manually edited candidate must
// account for every originally generated ID, even if the current count shrank.
export function validEpisodeCandidate(candidate,input,episodeId){
 if(!plain(candidate)||!readEpisodeDraft(stableJson(candidate))||!candidate.episodes.length)return false;
 const target=input.targetEpisodes;
 const revision=episodeCandidateRevision(candidate);
 if(!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)return false;
 if(episodeId!=="*"&&candidate.episodes.some(episode=>episode.id!==episodeId))return false;
 const changes=candidate.manualChanges;
 if(revision===0)return changes===undefined&&candidate.episodes.length===target;
 if(!plain(changes)||!ids(changes.originalEpisodeIds)||!ids(changes.editedEpisodeIds)||!ids(changes.removedEpisodeIds)||
  typeof changes.updatedAt!=="string"||!Number.isFinite(Date.parse(changes.updatedAt)))return false;
 const current=candidate.episodes.map(episode=>episode.id);
 const currentSet=new Set(current),removed=new Set(changes.removedEpisodeIds);
 return changes.originalEpisodeIds.length===target&&
  current.length+removed.size===target&&
  changes.originalEpisodeIds.every(value=>currentSet.has(value)!==removed.has(value))&&
  stableJson(changes.originalEpisodeIds.filter(value=>!removed.has(value)))===stableJson(current)&&
  changes.editedEpisodeIds.every(value=>currentSet.has(value))&&
  revision>=Math.max(1,changes.editedEpisodeIds.length+removed.size)&&
  changes.editedEpisodeIds.length+removed.size>0;
}

export function assertEpisodeCandidateRevision(candidate,expectedRevision){
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw fail("drama_candidate_revision_required",422);
 if(episodeCandidateRevision(candidate)!==expectedRevision)throw fail("drama_candidate_revision_conflict");
}

export function patchEpisodeCandidateFields(episode,changes){
 if(!plain(changes)||!Object.keys(changes).length||Object.keys(changes).some(key=>
  !["title","synopsis","ending","targetDurationSec","events","sourceRefs","sequences"].includes(key)))
  throw fail("drama_candidate_edit_invalid",422);
 for(const key of ["title","synopsis","ending"]){
  if(Object.hasOwn(changes,key)&&(!text(changes[key])||key==="title"&&!changes[key].trim()))throw fail("drama_candidate_edit_invalid",422);
 }
 if(Object.hasOwn(changes,"targetDurationSec")&&changes.targetDurationSec!==null&&
  (!Number.isFinite(changes.targetDurationSec)||changes.targetDurationSec<=0))throw fail("drama_candidate_edit_invalid",422);
 if(Object.hasOwn(changes,"events")&&(!Array.isArray(changes.events)||changes.events.length>500||!changes.events.every(text)))
  throw fail("drama_candidate_edit_invalid",422);
 if(Object.hasOwn(changes,"sourceRefs")&&!refs(changes.sourceRefs))throw fail("drama_candidate_edit_invalid",422);
 if(Object.hasOwn(changes,"sequences")&&(!Array.isArray(changes.sequences)||changes.sequences.length>500||!changes.sequences.every(sequence)||
  new Set(changes.sequences.map(item=>item.id)).size!==changes.sequences.length))throw fail("drama_candidate_edit_invalid",422);
 let next={...episode,...changes};
 if(next.targetDurationSec===null)delete next.targetDurationSec;
 // IDs are never accepted as top-level changes. For changed event text the
 // shared reconciler retains unambiguous existing identities and marks ambiguity.
 if(Object.hasOwn(changes,"events")&&stableJson(changes.events)!==stableJson(episode.events)){
  delete next.eventItems;
  next=normalizeEpisodeEvents(next,episode);
 }else if(Object.hasOwn(changes,"sequences")){
  next=normalizeEpisodeEvents(next,episode);
 }
 if(!readEpisodeDraft(stableJson({episodes:[next]})))throw fail("drama_candidate_edit_invalid",422);
 return next;
}

// Whole-episode proposals use positional scene plans rather than model-created
// IDs. Existing scene identity, source refs and lineage are kept verbatim.
// Event IDs are reconciled exactly once per saved snapshot; indices resolve
// against that snapshot, including newly created events.
export const wholeEpisodeFields=["title","synopsis","events","ending","targetDurationSec","scenePlans"];
export function patchWholeEpisodeCandidateFields(episode,changes){
 if(!plain(changes)||!Object.keys(changes).length||Object.keys(changes).some(key=>!wholeEpisodeFields.includes(key)))
  throw fail("drama_candidate_edit_invalid",422);
 const {scenePlans,...fields}=changes;
 let next=Object.keys(fields).length?patchEpisodeCandidateFields(episode,fields):episode;
 if(Object.hasOwn(changes,"scenePlans")){
  const sequences=episode.sequences??[];
  if(!Array.isArray(scenePlans)||!sequences.length||scenePlans.length!==sequences.length||
   !scenePlans.every(plan=>plain(plan)&&Object.keys(plan).length===2&&text(plan.title)&&plan.title.trim()&&
    !/[\r\n]/.test(plan.title)&&Array.isArray(plan.eventIndices)&&plan.eventIndices.length<=500&&
    new Set(plan.eventIndices).size===plan.eventIndices.length&&plan.eventIndices.every(index=>Number.isSafeInteger(index)&&index>=0&&index<next.events.length)))
   throw fail("drama_candidate_edit_invalid",422);
  // Legacy events may not yet have IDs. Resolve indices after normalization.
  next=normalizeEpisodeEvents(next,next);
  next={...next,sequences:sequences.map((sequence,index)=>({...sequence,title:scenePlans[index].title,
   eventRefs:scenePlans[index].eventIndices.map(eventIndex=>next.eventItems[eventIndex].id)}))};
 }
 if(Object.hasOwn(fields,"events")||Object.hasOwn(changes,"scenePlans")){
  if(unresolvedEventRefs(next).length)throw fail("drama_episode_optimize_relation_conflict",422);
 }
 if(!readEpisodeDraft(stableJson({episodes:[next]})))throw fail("drama_candidate_edit_invalid",422);
 return next;
}

export function editEpisodeCandidate(candidate,episodeId,changes,wholeEpisode=false){
 const previous=candidate.episodes.find(episode=>episode.id===episodeId);
 if(!previous)throw fail("drama_episode_candidate_not_found",404);
 const next=wholeEpisode?patchWholeEpisodeCandidateFields(previous,changes):patchEpisodeCandidateFields(previous,changes);
 if(stableJson(previous)===stableJson(next))return candidate;
 return recordChange(candidate,candidate.episodes.map(episode=>episode.id===episodeId?next:episode),episodeId,false);
}

export function removeEpisodeCandidate(candidate,episodeId){
 if(!candidate.episodes.some(episode=>episode.id===episodeId))throw fail("drama_episode_candidate_not_found",404);
 if(candidate.episodes.length===1)throw fail("drama_candidate_last_episode");
 return recordChange(candidate,candidate.episodes.filter(episode=>episode.id!==episodeId),episodeId,true);
}

function recordChange(candidate,episodes,episodeId,removed){
 const previous=candidate.manualChanges??{originalEpisodeIds:candidate.episodes.map(item=>item.id),editedEpisodeIds:[],removedEpisodeIds:[]};
 const edited=new Set(previous.editedEpisodeIds),excluded=new Set(previous.removedEpisodeIds);
 if(removed){edited.delete(episodeId);excluded.add(episodeId);}
 else edited.add(episodeId);
 return {...candidate,episodes,revision:episodeCandidateRevision(candidate)+1,
  manualChanges:{originalEpisodeIds:previous.originalEpisodeIds,editedEpisodeIds:[...edited],removedEpisodeIds:[...excluded],updatedAt:new Date().toISOString()}};
}

// Full generation keeps the original replacement semantics for IDs omitted by
// the model itself. Only explicit human exclusions mean "keep the existing
// draft entry", not "delete it". Restore those entries at their original
// candidate positions, skipping exclusions that were newly generated.
export function mergeEpisodeCandidateForAdoption(candidate,baseline){
 if(!candidate.manualChanges?.removedEpisodeIds.length)return candidate.episodes;
 const current=new Map(candidate.episodes.map(item=>[item.id,item]));
 const existing=new Map(baseline.map(item=>[item.id,item]));
 return candidate.manualChanges.originalEpisodeIds.flatMap(id=>{
  const episode=current.get(id)??existing.get(id);
  return episode?[episode]:[];
 });
}
