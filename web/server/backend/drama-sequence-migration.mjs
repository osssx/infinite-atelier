import {createHash} from "node:crypto";
import {readEpisodeDraft,readStoryboardDraft,validStoryboardDraftReferences} from "../canvas-text-content.mjs";
import {sequenceTargets} from "../drama-sequence-relations.mjs";
import {writeTransaction,stableJson} from "./repository.mjs";

const digest=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const upstream=(doc,board)=>{
 const linked=doc.connections.filter(edge=>edge.toNodeId===board.id).flatMap(edge=>
  doc.nodes.filter(node=>node.id===edge.fromNodeId&&node.type==="drama:episodes"));
 if(linked.length!==1)throw fail("drama_upstream_ambiguous_or_missing");
 return linked[0];
};
function build(document,nodeId,episodeId){
 const board=document.nodes.find(node=>node.id===nodeId&&node.type==="drama:storyboard");
 if(!board)throw fail("drama_storyboard_not_found",404);
 const episodeNode=upstream(document,board);
 const episodes=readEpisodeDraft(episodeNode.metadata?.dramaConfirmed??"");
 const episode=episodes?.episodes.find(item=>item.id===episodeId);
 if(!episode)throw fail("drama_upstream_unconfirmed",409);
 const body=readStoryboardDraft(board.metadata?.dramaDraft??board.metadata?.dramaConfirmed??"");
 if(!body)throw fail("drama_draft_invalid",422);
 const targets=episode.sequences??[];
 const rows=body.shots.filter(shot=>shot.episodeId===episodeId).flatMap(shot=>{
  const available=shot.sequenceId?sequenceTargets(episode,shot.sequenceId):targets.map(item=>item.id);
  const current=targets.some(item=>item.id===shot.sequenceId);
  if(current)return [];
  return [{shotId:shot.id,episodeId,sourceSequenceId:shot.sequenceId??null,
   possibleSequenceIds:available,shotDigest:digest(shot),
   status:available.length===1?"single_target":available.length>1?"choice_required":"unresolved"}];
 });
 return {nodeId,episodeId,episodeRevisionId:episodeNode.metadata?.dramaConfirmedVersionId??null,
  episodeDigest:digest(episode),rows,board,body,episode};
}
export function previewDramaSequenceMigration(db,getProject,projectId,{nodeId,episodeId}){
 const project=getProject(db,projectId);
 const result=build(project.document,nodeId,episodeId);
 return {projectRevision:project.revision,nodeId,episodeId,episodeRevisionId:result.episodeRevisionId,
  episodeDigest:result.episodeDigest,rows:result.rows};
}
/** Explicit per-shot mapping, with a project revision and individual shot hashes.
 * Absolutely no implicit migration for a 1:N split or unknown orphan.
 */
export function applyDramaSequenceMigration({db,getProject,validateDocument,emitEvent},projectId,
 {nodeId,episodeId,expectedRevision,episodeDigest,changes}){
 return writeTransaction(db,()=>{
  const project=getProject(db,projectId);
  if(project.revision!==expectedRevision)throw fail("drama_sequence_migration_conflict",409);
  const result=build(project.document,nodeId,episodeId);
  if(result.episodeDigest!==episodeDigest)throw fail("drama_sequence_migration_conflict",409);
  if(!Array.isArray(changes)||!changes.length||changes.length>500)throw fail("drama_sequence_migration_invalid",422);
  const selected=new Set();
  const replacements=new Map();
  for(const change of changes){
   if(!change||typeof change.shotId!=="string"||typeof change.sequenceId!=="string"||
    typeof change.expectedShotDigest!=="string"||selected.has(change.shotId))
    throw fail("drama_sequence_migration_invalid",422);
   selected.add(change.shotId);
   const row=result.rows.find(row=>row.shotId===change.shotId);
   if(!row||row.shotDigest!==change.expectedShotDigest||
    !row.possibleSequenceIds.includes(change.sequenceId))
    throw fail("drama_sequence_migration_conflict",409);
   replacements.set(row.shotId,change.sequenceId);
  }
  const content=stableJson({...result.body,shots:result.body.shots.map(shot=>
   replacements.has(shot.id)?{...shot,sequenceId:replacements.get(shot.id)}:shot)});
  if(!readStoryboardDraft(content)||!validStoryboardDraftReferences(result.board,content,
   project.document.nodes,project.document.connections))throw fail("drama_sequence_migration_invalid",422);
  result.board.metadata={...result.board.metadata,dramaDraft:content};
  db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=?")
   .run(validateDocument(project.document),project.revision+1,projectId);
  emitEvent(db,{id:projectId,revision:project.revision+1,kind:"updated"});
  return {...project,revision:project.revision+1,migratedShotIds:[...selected]};
 });
}
