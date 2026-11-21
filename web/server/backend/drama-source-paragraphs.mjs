import {randomUUID} from "node:crypto";

/** Preserve exact anchors first, then edited paragraphs between unchanged anchors. */
export function reconcileSourceParagraphs(text,previous=[]){
 const lines=text.split(/\r?\n/).map((text,index)=>({text,line:index+1})).filter(item=>item.text.trim());
 const used=new Set();
 const replaces=new Map();
 const matched=lines.map(line=>{
  const candidates=previous.filter(item=>item.text===line.text&&!used.has(item.id));
  if(candidates.length!==1)return null;
  used.add(candidates[0].id);
  return candidates[0];
 });
 const anchors=[{next:-1,old:-1},...matched.flatMap((item,index)=>item?
  [{next:index,old:previous.findIndex(old=>old.id===item.id)}]:[]),{next:lines.length,old:previous.length}];
 for(let index=1;index<anchors.length;index++){
  const left=anchors[index-1],right=anchors[index];
  if(right.old<=left.old)continue;
  const oldGap=previous.slice(left.old+1,right.old);
  const newGap=lines.slice(left.next+1,right.next);
  if(oldGap.length===newGap.length&&oldGap.every((item,offset)=>item.text===newGap[offset].text)){
   oldGap.forEach((item,offset)=>{
    if(!used.has(item.id)){matched[left.next+1+offset]=item;used.add(item.id);}
   });
   continue;
  }
  if(right.next-left.next===2&&right.old-left.old===2){
   const old=previous[left.old+1];
   if(old&&!used.has(old.id)){
    matched[left.next+1]=old;
    used.add(old.id);
   }
  }else if(oldGap.length&&newGap.length){
   for(let next=left.next+1;next<right.next;next++)replaces.set(next,oldGap.map(item=>item.id));
  }
 }
 return lines.map((line,index)=>({
  id:matched[index]?.id??`p_${randomUUID()}`,text:line.text,line:line.line,
  status:matched[index]?.status??(previous.length?"needs_review":"located"),
  ...(replaces.has(index)?{replaces:replaces.get(index)}:{}),
 }));
}

export function resolveSourceReference(reference,paragraphs){
 const exact=paragraphs.find(item=>item.id===reference);
 if(exact)return {status:exact.status,paragraphIds:[exact.id]};
 const replacements=paragraphs.filter(item=>item.replaces?.includes(reference));
 return {status:replacements.length?"needs_review":"unresolved",paragraphIds:replacements.map(item=>item.id)};
}
