/** P2 read-only scope preview. Never mutates a draft or silently refreshes a Config.
 * Precise nested fingerprints are optional for legacy archives. Where they are
 * missing, return a broad affected scope or explicit review items, never "safe".
 */
import {readAssetDraft,readEpisodeDraft,readStoryboardDraft} from "../canvas-text-content.mjs";
import {inspectDramaDependencies} from "./drama-dependencies.mjs";

const sorted=values=>[...values].sort();
const parsed=(node,read)=>read(node?.metadata?.dramaConfirmed??"")??read(node?.metadata?.dramaDraft??"")??null;
const incoming=(document,nodeId)=>document.connections
 .filter(edge=>edge.toNodeId===nodeId).flatMap(edge=>
  document.nodes.filter(item=>item.id===edge.fromNodeId&&item.type.startsWith("drama:")));
const hasAsset=(shot,asset)=>{
 if(!asset)return false;
 return (shot.sceneId===asset.id||shot.propIds?.includes(asset.id)||shot.keyPropIds?.includes(asset.id)||
  (asset.variants??[]).some(item=>hasVariant(shot,item.id)));
};
const hasVariant=(shot,id)=>shot.characterVariantIds?.includes(id)||shot.sceneVariantId===id;
const connectedConfigs=(document,nodeId)=>document.nodes.filter(node=>
 node.type==="config"&&node.metadata?.dramaShotId&&
 (node.metadata.dramaVideoSource?.nodeId===nodeId||
  document.connections.some(edge=>edge.fromNodeId===nodeId&&edge.toNodeId===node.id)));
const referencesMatch=(refs,ids,paragraphs)=>refs.some(ref=>ids.has(ref)||
 paragraphs.some(item=>item.replaces?.includes(ref)&&ids.has(item.id)));
export function previewDramaImpact(document,nodeId){
 const node=document.nodes.find(item=>item.id===nodeId);
 const report=inspectDramaDependencies(document,nodeId);
 const impact={assetIds:new Set(),episodeIds:new Set(),sequenceIds:new Set(),
  shotIds:new Set(),mediaShotIds:new Set(),configIds:new Set(),needsReview:new Set()};
 const byId=new Map(document.nodes.map(item=>[item.id,item]));
 const ancestors=incoming(document,nodeId);
 const episodes=parsed(node,readEpisodeDraft)?.episodes??[];
 const assets=parsed(node,readAssetDraft)?.assets??[];
 const shots=parsed(node,readStoryboardDraft)?.shots??[];
 const configs=connectedConfigs(document,nodeId);
 const markShots=predicate=>{for(const shot of shots)if(predicate(shot))impact.shotIds.add(shot.id)};
 for(const change of report.changes){
   const upstream=byId.get(change.nodeId);
   const kind=upstream?.type;
   if(change.kind==="references_updated"&&!change.entryIds.length)
    impact.needsReview.add("reference-scope-unknown:"+change.nodeId);
   if(change.kind==="updated"&&!change.entryIds.length)
    impact.needsReview.add("content-scope-unknown:"+change.nodeId);
   if(change.kind==="disconnected"||change.kind==="connected"){   impact.needsReview.add("connection:"+change.nodeId);
   continue;
  }
  if(change.kind==="visual_updated"){
   impact.needsReview.add("visual:"+change.nodeId);
   continue;
  }
  if(kind==="drama:source"&&change.kind==="updated"){
   const paragraphs=upstream.metadata?.dramaSourceParagraphs??[];
   const ids=new Set(change.entryIds);
   const entries=node.type==="drama:assets"?assets:node.type==="drama:episodes"?episodes:[];
   for(const item of entries){
    const sequences=item.sequences??[];
    const found=referencesMatch(item.sourceRefs??[],ids,paragraphs);
    const matchedSequences=sequences.filter(seq=>
     referencesMatch(seq.sourceRefs??[],ids,paragraphs));
    if(found||matchedSequences.length){
     if(node.type==="drama:assets")impact.assetIds.add(item.id);
     else{
      impact.episodeIds.add(item.id);
      for(const seq of matchedSequences)impact.sequenceIds.add(item.id+"/"+seq.id);
      if(found&&sequences.length&&!matchedSequences.length)
       impact.needsReview.add("sequence-unmapped:"+item.id);
     }
    }else if(!(item.sourceRefs?.length)&&!sequences.some(seq=>seq.sourceRefs?.length)){
     impact.needsReview.add("source-unmapped:"+item.id);
    }
   }
   for(const id of change.entryIds){
    if(paragraphs.find(paragraph=>paragraph.id===id)?.status==="needs_review")
     impact.needsReview.add("paragraph:"+id);
   }
   continue;
  }
  if(node.type!=="drama:storyboard")continue;
  const allAssets=ancestors.flatMap(parent=>parsed(parent,readAssetDraft)?.assets??[]);
  const assetById=new Map(allAssets.map(asset=>[asset.id,asset]));
  if(kind==="drama:episodes"&&change.kind==="updated"){
   for(const id of change.entryIds){
    impact.episodeIds.add(id);
    const detail=change.entryDetails?.find(entry=>entry.id===id);
    if(detail?.bodyChanged===false&&Array.isArray(detail.sequenceIds)&&detail.sequenceIds.length>0){
     for(const seqId of detail.sequenceIds){
      impact.sequenceIds.add(id+"/"+seqId);
      markShots(shot=>shot.episodeId===id&&shot.sequenceId===seqId);
     }
     for(const shot of shots.filter(shot=>shot.episodeId===id&&!shot.sequenceId))
      impact.needsReview.add("sequence-unmapped-shot:"+shot.id);
    }else markShots(shot=>shot.episodeId===id);
   }
  }else if(kind==="drama:assets"&&change.kind==="updated"){
   for(const id of change.entryIds){
    impact.assetIds.add(id);
    const asset=assetById.get(id),detail=change.entryDetails?.find(entry=>entry.id===id);
    if(!asset){impact.needsReview.add("asset-missing:"+id);continue;}
    if(detail?.bodyChanged===false&&Array.isArray(detail.variantIds)&&detail.variantIds.length>0){
     for(const variantId of detail.variantIds)
      markShots(shot=>hasVariant(shot,variantId));
    }else markShots(shot=>hasAsset(shot,asset));
   }
  }else if(kind==="drama:assets"&&change.kind==="references_updated"){
   for(const entryId of change.entryIds){
    // Reference slots use assetId or variantId, never reference node names.
    const asset=allAssets.find(item=>item.id===entryId||
     item.variants?.some(variant=>variant.id===entryId));
    if(!asset){impact.needsReview.add("reference-missing:"+entryId);continue;}
    for(const shot of shots)if(asset.id===entryId?hasAsset(shot,asset):hasVariant(shot,entryId))
     impact.mediaShotIds.add(shot.id);
   }
  }
 }
 for(const config of configs){
  const shotId=config.metadata.dramaShotId;
  if(impact.shotIds.has(shotId))impact.configIds.add(config.id);
  else if(impact.mediaShotIds.has(shotId)){
   const source=config.metadata.dramaVideoSource;
   // A manually selected first frame or text-only Config does not necessarily
   // use this asset's slot. Unknown legacy sources require manual review.
   if(!source||!Array.isArray(source.referenceKeys))
    impact.needsReview.add("config-unknown:"+config.id);
   else if(source.referenceKeys.length&&
    (config.metadata.videoMode==="omni_reference"||config.metadata.videoMode===undefined))
    impact.configIds.add(config.id);
   else if(!source.referenceKeys.length&&config.metadata.videoMode==="omni_reference")
    impact.needsReview.add("config-reference-empty:"+config.id);
  }
 }
 // A confirmed storyboard can be current relative to its directly confirmed
 // episode/assets, while their underlying story source has changed. This is
 // only a *pending* downstream preview: never silently regenerate/publish it.
 const pending={assetIds:new Set(),episodeIds:new Set(),sequenceIds:new Set(),
  shotIds:new Set(),configIds:new Set(),needsReview:new Set()};
 if(node.type==="drama:storyboard"){
  for(const parent of ancestors.filter(item=>["drama:assets","drama:episodes"].includes(item.type))){
   const upstream=previewDramaImpact(document,parent.id);
   if(upstream.status==="current")continue;
   for(const note of upstream.impact.needsReview)pending.needsReview.add(parent.id+":"+note);
   if(parent.type==="drama:episodes"){
    const sequences=new Set(upstream.impact.sequenceIds);
    for(const episodeId of upstream.impact.episodeIds){
     pending.episodeIds.add(episodeId);
     for(const sequence of sequences)if(sequence.startsWith(episodeId+"/"))
      pending.sequenceIds.add(sequence);
     const scoped=[...sequences].some(sequence=>sequence.startsWith(episodeId+"/"));
     const unknown=upstream.impact.needsReview.some(note=>note==="sequence-unmapped:"+episodeId);
     for(const shot of shots)if(shot.episodeId===episodeId&&
      (!scoped||unknown||!shot.sequenceId||sequences.has(episodeId+"/"+shot.sequenceId)))
      pending.shotIds.add(shot.id);
    }
   }else{
    const sharedAssets=parsed(parent,readAssetDraft)?.assets??[];
    for(const id of upstream.impact.assetIds){
     pending.assetIds.add(id);
     const asset=sharedAssets.find(item=>item.id===id);
     if(!asset){pending.needsReview.add("asset-missing:"+id);continue;}
     for(const shot of shots)if(hasAsset(shot,asset))pending.shotIds.add(shot.id);
    }
   }
  }
  for(const config of configs)if(pending.shotIds.has(config.metadata.dramaShotId))
   pending.configIds.add(config.id);
 }
 return {...report,impact:{...Object.fromEntries(Object.entries(impact).map(([key,values])=>[key,sorted(values)])),
  pending:Object.fromEntries(Object.entries(pending).map(([key,values])=>[key,sorted(values)]))}};
}
