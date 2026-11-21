/** Sequence editing helpers. Ids remain stable for renames; split and merge
 * use new ids and explicit replaces lineage, not an implicit shot rewrite. */
const makeId=()=>`sequence_${crypto.randomUUID()}`;
const unique=values=>[...new Set(values)];
export function splitEpisodeSequence(episode,id){
 const index=episode.sequences?.findIndex(item=>item.id===id)??-1;
 if(index<0)throw Error("drama_sequence_not_found");
 const old=episode.sequences[index],events=old.eventRefs??[],middle=Math.ceil(events.length/2);
 const replacements=[old.id,...old.replaces??[]];
 const halves=[1,2].map((n,i)=>({...old,id:makeId(),title:old.title+` · ${n}`,
  replaces:replacements,eventRefs:i===0?events.slice(0,middle):events.slice(middle)}));
 return {...episode,sequences:[...episode.sequences.slice(0,index),...halves,...episode.sequences.slice(index+1)]};
}
export function mergeEpisodeSequences(episode,firstId,secondId){
 const sequences=episode.sequences??[],a=sequences.findIndex(item=>item.id===firstId);
 if(a<0||a+1>=sequences.length||sequences[a+1].id!==secondId)
  throw Error("drama_sequence_merge_requires_adjacent");
 const first=sequences[a],second=sequences[a+1];
 const merged={...first,id:makeId(),title:first.title+" + "+second.title,
  sourceRefs:unique([...(first.sourceRefs??[]),...(second.sourceRefs??[])]),
  eventRefs:unique([...(first.eventRefs??[]),...(second.eventRefs??[])]),
  replaces:unique([first.id,second.id,...first.replaces??[],...second.replaces??[]])};
 return {...episode,sequences:[...sequences.slice(0,a),merged,...sequences.slice(a+2)]};
}
/** Traces lineage across multiple editing rounds; explicit decisions are
 * mandatory for 1:N split, and existing configs are never rewritten. */
export function sequenceTargets(episode,sequenceId){
 const current=episode.sequences??[];
 if(current.some(item=>item.id===sequenceId))return [sequenceId];
 return current.filter(item=>item.replaces?.includes(sequenceId)).map(item=>item.id);
}
