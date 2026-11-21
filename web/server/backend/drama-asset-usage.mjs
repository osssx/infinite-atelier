import {readAssetDraft,readStoryboardDraft} from "../canvas-text-content.mjs";

export function removedDramaAssetUsages(document,nodeId,nextAssets){
 const node=document.nodes.find(item=>item.id===nodeId);
 const before=readAssetDraft(node?.metadata?.dramaConfirmed??"")?.assets??[];
 const ids=assets=>new Set(assets.flatMap(asset=>[asset.id,...(asset.variants??[]).map(item=>item.id)]));
 const previous=ids(before),next=ids(nextAssets);
 const removed=new Set([...previous].filter(id=>!next.has(id)));
 const usages=[];
 for(const board of document.nodes){
  if(board.type!=="drama:storyboard"||!document.connections.some(edge=>edge.fromNodeId===nodeId&&edge.toNodeId===board.id))continue;
  for(const [state,content] of [["draft",board.metadata?.dramaDraft],["confirmed",board.metadata?.dramaConfirmed]]){
   for(const shot of readStoryboardDraft(content??"")?.shots??[]){
    const references=[...shot.characterVariantIds,...shot.propIds,...shot.keyPropIds,shot.sceneId,shot.sceneVariantId];
    for(const id of new Set(references.filter(id=>removed.has(id)))){
     usages.push({assetId:id,nodeId:board.id,shotId:shot.id,episodeId:shot.episodeId,state});
    }
   }
  }
 }
 return usages;
}
