import {createHash} from "node:crypto";
import {stableJson} from "./repository.mjs";
import {readAssetDraft,readEpisodeDraft,readStoryboardDraft} from "../canvas-text-content.mjs";

const hash=value=>createHash("sha256").update(stableJson(value)).digest("hex");

export function dramaDependencies(document,nodeId){
 return document.connections.filter(edge=>edge.toNodeId===nodeId).flatMap(edge=>{
  const node=document.nodes.find(item=>item.id===edge.fromNodeId&&item.type.startsWith("drama:"));
  if(!node)return [];
  const content=node.metadata?.dramaConfirmed??"";
  const entries=readAssetDraft(content)?.assets??readEpisodeDraft(content)?.episodes??
   readStoryboardDraft(content)?.shots??node.metadata?.dramaSourceParagraphs??[];
  return [{nodeId:node.id,edgeId:edge.id,revisionId:node.metadata?.dramaConfirmedVersionId??null,
   mediaRevisionId:node.metadata?.dramaAssetReferenceRevisionId??null,
   mediaEntries:node.metadata?.dramaAssetReferenceEntries??[],
   visualDigest:hash(node.metadata?.dramaConfirmedVisual??{}),
   digest:hash(content),entries:entries.map(item=>({id:item.id,digest:hash(item)}))}];
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
   changes.push({nodeId:dependency.nodeId,kind:"visual_updated",entryIds:[]});
  if(latest.mediaRevisionId!==(dependency.mediaRevisionId??null)){
   const oldEntries=dependency.mediaEntries??[],newEntries=latest.mediaEntries;
   const mediaIds=new Set([...oldEntries.map(item=>item.id),...newEntries.map(item=>item.id)]);
   changes.push({nodeId:dependency.nodeId,kind:"references_updated",entryIds:[...mediaIds].filter(id=>
    oldEntries.find(item=>item.id===id)?.digest!==newEntries.find(item=>item.id===id)?.digest)});
  }
  if(latest.digest===dependency.digest)continue;
  const ids=new Set([...dependency.entries.map(item=>item.id),...latest.entries.map(item=>item.id)]);
  changes.push({nodeId:dependency.nodeId,kind:"updated",entryIds:[...ids].filter(id=>
   dependency.entries.find(item=>item.id===id)?.digest!==latest.entries.find(item=>item.id===id)?.digest)});
 }
 for(const dependency of current){
  if(!previous.some(item=>item.nodeId===dependency.nodeId&&item.edgeId===dependency.edgeId))
   changes.push({nodeId:dependency.nodeId,kind:"connected",entryIds:dependency.entries.map(item=>item.id)});
 }
 return {status:changes.length?"stale":"current",changes};
}
