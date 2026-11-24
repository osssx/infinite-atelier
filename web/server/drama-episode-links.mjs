/** Shared episode event identity logic. Event text remains a legacy-compatible
 * projection; eventItems are the stable refs, and ambiguous changes are explicit.
 * No network, DB, or browser APIs other than crypto.randomUUID. */
const freshId=()=>`event_${crypto.randomUUID()}`;
const validItem=item=>item&&typeof item.id==="string"&&item.id.length>0&&typeof item.text==="string";
export const validEpisodeEventItems=(episode)=>{
 const items=episode.eventItems;
 return items===undefined||Array.isArray(items)&&items.length===episode.events.length&&
  items.every((item,index)=>validItem(item)&&item.text===episode.events[index]&&
   (item.replaces===undefined||Array.isArray(item.replaces)&&item.replaces.every(id=>typeof id==="string")))&&
  new Set(items.map(item=>item.id)).size===items.length;
};
/** preserve unique text anchors, then stable IDs for one-to-one text edits;
 * split/merge cannot silently choose an owner, so create IDs with replaces. */
export function reconcileEventItems(events,previous=[]){
 const old=previous.filter(validItem),used=new Set();
 const output=events.map(text=>{
  const matching=old.filter(item=>item.text===text&&!used.has(item.id));
  if(matching.length!==1)return null;
  used.add(matching[0].id);
  return {...matching[0],text};
 });
 const anchors=[{next:-1,old:-1},...output.flatMap((item,index)=>item?
  [{next:index,old:old.findIndex(entry=>entry.id===item.id)}]:[]),{next:events.length,old:old.length}];
 for(let i=1;i<anchors.length;i++){
  const before=anchors[i-1],after=anchors[i];
  if(after.old<=before.old)continue;
  const existing=old.slice(before.old+1,after.old).filter(item=>!used.has(item.id));
  const indices=Array.from({length:Math.max(0,after.next-before.next-1)},(_,index)=>before.next+index+1)
   .filter(index=>!output[index]);
  if(!indices.length)continue;
  if(existing.length===indices.length){
   indices.forEach((index,offset)=>{output[index]={...existing[offset],text:events[index]};used.add(existing[offset].id);});
  }else{
   for(const index of indices)output[index]={
    id:freshId(),text:events[index],status:"needs_review",
    ...(existing.length?{replaces:existing.map(item=>item.id)}:{})};
  }
 }
 return output.map((item,index)=>item??{id:freshId(),text:events[index],
  ...(old.length?{status:"needs_review"}:{})});
}
const legacyMatches=(ref,oldItems)=>{
 const match=oldItems.filter(item=>item.id===ref||item.text===ref);
 return match.length===1?match[0].id:null;
};
/** Normalize newly generated or edited episode material. Does not silently
 * migrate ambiguous duplicate-text eventRefs: keep them for manual review.
 * On an already populated eventItems snapshot, text-only edits use old IDs.
 */
export function normalizeEpisodeEvents(episode,previous=episode){
 const old=Array.isArray(previous?.eventItems)&&previous.eventItems.every(validItem)?
  previous.eventItems:previous?.events?.map(text=>({id:freshId(),text}))??[];
 const current=validEpisodeEventItems(episode)&&episode.eventItems?.length===episode.events.length?
  episode.eventItems:reconcileEventItems(episode.events,old);
 const converted=(episode.sequences??[]).map(sequence=>({
  ...sequence,
  ...(sequence.eventRefs?{eventRefs:sequence.eventRefs.map(ref=>
   current.some(item=>item.id===ref)?ref:legacyMatches(ref,old)??ref)}:{}),
 }));
 return {...episode,eventItems:current,...(episode.sequences?{sequences:converted}:{})};
}
/** Only migrate missing identities or uniquely resolvable legacy text refs.
 * Ambiguous or missing refs stay unresolved and must not trigger endless writes. */
export function needsEpisodeEventNormalization(episode){
 if(!episode.eventItems)return episode.events.length>0;
 if(!validEpisodeEventItems(episode))return true;
 const ids=new Set(episode.eventItems.map(item=>item.id));
 return (episode.sequences??[]).some(sequence=>(sequence.eventRefs??[]).some(ref=>
  !ids.has(ref)&&legacyMatches(ref,episode.eventItems)!==null));
}
export function unresolvedEventRefs(episode){
 const ids=new Set(episode.eventItems?.map(item=>item.id)??[]);
 return (episode.sequences??[]).flatMap(sequence=>
  (sequence.eventRefs??[]).filter(ref=>!ids.has(ref)).map(ref=>({sequenceId:sequence.id,ref})));
}
