/** Immutable, read-only diff of one frozen Drama Run against the *current* draft.
 * Items use stable shot IDs for updates, creations and deletions alike.
 * A selective adoption never merges unrelated entries or auto-discards edits.
 */
import {stableJson} from "./repository.mjs";

const equal=(a,b)=>stableJson(a??null)===stableJson(b??null);
const byId=items=>new Map(items.map(item=>[item.id,item]));
const brief=shot=>shot?{id:shot.id,episodeId:shot.episodeId,sequenceId:shot.sequenceId??null,
 order:shot.order,description:shot.description}:null;

export function planDramaShotDiff({baseline,current,candidate,adoptedShotIds=[],adoptedRemovedShotIds=[]}){
 const initial=byId(baseline),live=byId(current),after=byId(candidate);
 const adopted=new Set(adoptedShotIds),removed=new Set(adoptedRemovedShotIds);
 const ids=[...new Set([...candidate.map(item=>item.id),...baseline.map(item=>item.id)])];
 const items=ids.map(id=>{
  const before=initial.get(id)??null,proposed=after.get(id)??null;
  const actual=live.get(id)??null;
  const deletion=!!before&&!proposed;
  const alreadyAdopted=deletion?removed.has(id):adopted.has(id);
  const expected=alreadyAdopted?proposed:before;
  const conflict=!equal(actual,expected);
  const changed=!equal(before,proposed);
  const reordered=!!before&&!!proposed&&before.order!==proposed.order;
  const kind=!before?"added":!proposed?"deleted":
   !changed?"unchanged":reordered&&equal({...before,order:proposed.order},proposed)?"reordered":"replaced";
  return {id,kind,reordered,changed,conflict,adopted:alreadyAdopted,
   before:brief(before),after:brief(proposed),current:brief(actual)};
 });
 // A user may insert a shot while the model runs. Full replacement must never
 // silently discard it. A selected subset can still be applied safely.
 const known=new Set(ids);
 const manualExtraIds=current.filter(item=>!known.has(item.id)).map(item=>item.id);
 return {items,manualExtraIds,
  fullAdoptBlocked:manualExtraIds.length>0||items.some(item=>item.conflict),
  summary:{added:items.filter(item=>item.kind==="added").length,
   replaced:items.filter(item=>item.kind==="replaced").length,
   deleted:items.filter(item=>item.kind==="deleted").length,
   reordered:items.filter(item=>item.kind==="reordered").length,
   unchanged:items.filter(item=>item.kind==="unchanged").length,
   conflicts:items.filter(item=>item.conflict).length+manualExtraIds.length}};
}

/** Keep all unselected/manual rows at their original positions. Replace in
 * place; insert only genuinely new shots at their episode/order neighborhood.
 */
export function mergeDramaSelectedShots(allCurrent,selectedIds,candidateShots){
 const replacements=byId(candidateShots.filter(shot=>selectedIds.has(shot.id)));
 const original=new Set(allCurrent.map(shot=>shot.id));
 const result=allCurrent.flatMap(shot=>!selectedIds.has(shot.id)?[shot]:
  replacements.has(shot.id)?[replacements.get(shot.id)]:[]);
 const additions=candidateShots.filter(shot=>selectedIds.has(shot.id)&&!original.has(shot.id));
 for(const shot of additions){
  let insert=result.findIndex(item=>item.episodeId===shot.episodeId&&item.order>shot.order);
  if(insert<0){
   const last=result.findLastIndex(item=>item.episodeId===shot.episodeId);
   insert=last<0?result.length:last+1;
  }
  result.splice(insert,0,shot);
 }
 return result;
}
