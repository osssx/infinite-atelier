import {createHash} from "node:crypto";
import {stableJson} from "./repository.mjs";
import {readAssetDraft,readEpisodeDraft,readStoryboardDraft} from "../canvas-text-content.mjs";

const hash=value=>createHash("sha256").update(stableJson(value)).digest("hex");
/** Nested hashes allow exact scope in new snapshots; old snapshots stay readable. */
const describeEntry=(item,type)=>{
 const result={id:item.id,digest:hash(item)};
 if(type==="drama:assets"){
  const {variants:_,...body}=item;
  return {...result,bodyDigest:hash(body),variants:(item.variants??[]).map(variant=>({id:variant.id,digest:hash(variant)}))};
 }
 if(type==="drama:episodes"){
  const {sequences:_,events:__,eventItems:___,...body}=item;
  const events=(item.eventItems??(item.events??[]).map((text,index)=>({id:"legacy-event-"+index,text})))
   .map(event=>({id:event.id,digest:hash(event)}));
  return {...result,bodyDigest:hash(body),events,
   sequences:(item.sequences??[]).map(sequence=>({id:sequence.id,digest:hash(sequence)}))};
 }
 return result;
};
const changedNested=(oldEntries=[],newEntries=[])=>{
 const ids=new Set([...oldEntries.map(item=>item.id),...newEntries.map(item=>item.id)]);
 return [...ids].filter(id=>oldEntries.find(item=>item.id===id)?.digest!==newEntries.find(item=>item.id===id)?.digest);
};


export function dramaDependencies(document,nodeId){
 return document.connections.filter(edge=>edge.toNodeId===nodeId).flatMap(edge=>{
  const node=document.nodes.find(item=>item.id===edge.fromNodeId&&item.type.startsWith("drama:"));
  if(!node)return [];
  const content=node.metadata?.dramaConfirmed??"";
  const entries=readAssetDraft(content)?.assets??readEpisodeDraft(content)?.episodes??
   readStoryboardDraft(content)?.shots??node.metadata?.dramaSourceParagraphs??[];
  return [{nodeId:node.id,edgeId:edge.id,revisionId:node.metadata?.dramaConfirmedVersionId??null,
   mediaRevisionId:node.metadata?.dramaAssetReferenceRevisionId??null,
   mediaEntries:structuredClone(node.metadata?.dramaAssetReferenceEntries??[]),
   visualDigest:hash(node.metadata?.dramaConfirmedVisual??{}),
    visualStyle:node.metadata?.dramaConfirmedVisual?.visualStyle??null,
   digest:hash(content),entries:entries.map(item=>describeEntry(item,node.type))}];
 });
}

export function inspectDramaDependencies(document,nodeId){
 const node=document.nodes.find(item=>item.id===nodeId);
 if(!node)throw Object.assign(Error("drama_storyboard_not_found"),{code:"drama_storyboard_not_found",statusCode:404});
 const previous=node.metadata?.dramaInputDependencies;
 const current=dramaDependencies(document,nodeId);
 if(!previous)return {status:"unknown",changes:[]};
 const changes=[];
 for(const dependency of previous){
  const latest=current.find(item=>item.nodeId===dependency.nodeId&&item.edgeId===dependency.edgeId);
  if(!latest){changes.push({nodeId:dependency.nodeId,kind:"disconnected",entryIds:[]});continue;}
  if(dependency.visualDigest&&latest.visualDigest!==dependency.visualDigest)
   changes.push({nodeId:dependency.nodeId,kind:"visual_updated",entryIds:[],
     visualStyleChanged:dependency.visualStyle===undefined?null:dependency.visualStyle!==latest.visualStyle,
     previousVisualStyle:dependency.visualStyle??null});
  if(latest.mediaRevisionId!==(dependency.mediaRevisionId??null)){
   const oldEntries=dependency.mediaEntries??[],newEntries=latest.mediaEntries;
   const mediaIds=new Set([...oldEntries.map(item=>item.id),...newEntries.map(item=>item.id)]);
   changes.push({nodeId:dependency.nodeId,kind:"references_updated",entryIds:[...mediaIds].filter(id=>
    oldEntries.find(item=>item.id===id)?.digest!==newEntries.find(item=>item.id===id)?.digest)});
  }
  if(latest.digest===dependency.digest)continue;
   const oldEntries=dependency.entries??[],newEntries=latest.entries;
   const entryIds=changedNested(oldEntries,newEntries);
   changes.push({nodeId:dependency.nodeId,kind:"updated",entryIds,
    entryDetails:entryIds.map(id=>{
     const before=oldEntries.find(item=>item.id===id),after=newEntries.find(item=>item.id===id);
     return {id,bodyChanged:!before?.bodyDigest||!after?.bodyDigest||before.bodyDigest!==after.bodyDigest,
      ...(before?.variants&&after?.variants?{variantIds:changedNested(before.variants,after.variants)}:{}),
      ...(before?.sequences&&after?.sequences?{sequenceIds:changedNested(before.sequences,after.sequences)}:{}),
       ...(before?.events&&after?.events?{eventIds:changedNested(before.events,after.events)}:{})};
    })});
  } for(const dependency of current){
  if(!previous.some(item=>item.nodeId===dependency.nodeId&&item.edgeId===dependency.edgeId))
   changes.push({nodeId:dependency.nodeId,kind:"connected",entryIds:dependency.entries.map(item=>item.id)});
 }
 return {status:changes.length?"stale":"current",changes};
}
