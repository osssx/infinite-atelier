import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import {readEpisodeDraft} from "../../../server/canvas-text-content.mjs";
import {readStoryboardDraft} from "./canvas-drama-pipeline";

export type DramaAssetUsageEntry={key:string;label:string;rank:number};
export type DramaAssetUsage=Record<string,DramaAssetUsageEntry[]>;

/** Keep identity separate from display text. A shot can be referenced in both
 * draft and confirmed versions, and an asset can be used by several boards. */
export function buildDramaAssetUsage(assetNodeId:string,nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[]):DramaAssetUsage{
 const boards=nodes.filter(node=>node.type==="drama:storyboard"&&connections.some(edge=>edge.fromNodeId===assetNodeId&&edge.toNodeId===node.id));
 const usage=new Map<string,DramaAssetUsageEntry[]>();
 let rank=0;
 for(const [boardIndex,board] of boards.entries()){
  const upstream=nodes.filter(node=>node.type==="drama:episodes"&&connections.some(edge=>edge.fromNodeId===node.id&&edge.toNodeId===board.id));
  const episodeIds=[...new Set(upstream.flatMap(node=>[
   ...(readEpisodeDraft(node.metadata?.dramaConfirmed??"")?.episodes??[]),
   ...(readEpisodeDraft(node.metadata?.dramaDraft??"")?.episodes??[]),
  ].map(episode=>episode.id)))];
  const episodeOrder=new Map(episodeIds.map((id,index)=>[id,index]));
  const shots=[
   ...(readStoryboardDraft(board.metadata?.dramaDraft??"")?.shots??[]),
   ...(readStoryboardDraft(board.metadata?.dramaConfirmed??"")?.shots??[]),
  ];
  // Prefer the draft's current numbering, but retain confirmed-only usage.
  const byShot=new Map<string,typeof shots[number]>();
  const refs=new Map<string,Set<string>>();
  for(const shot of shots){
   if(!byShot.has(shot.id))byShot.set(shot.id,shot);
   const ids=refs.get(shot.id)??new Set<string>();
   for(const id of [...shot.characterVariantIds,...shot.propIds,...shot.keyPropIds,shot.sceneId,shot.sceneVariantId])if(id)ids.add(id);
   refs.set(shot.id,ids);
  }
  const sorted=[...byShot.values()].sort((a,b)=>(episodeOrder.get(a.episodeId)??Infinity)-(episodeOrder.get(b.episodeId)??Infinity)||a.order-b.order);
  for(const shot of sorted){
   const episodeIndex=episodeOrder.get(shot.episodeId);
   const label=[boards.length>1?`分镜 ${boardIndex+1}`:"",episodeIndex===undefined?"":`第 ${episodeIndex+1} 集`,`镜头 ${shot.order}`].filter(Boolean).join(" · ");
   const entry={key:JSON.stringify([board.id,shot.id]),label,rank:rank++};
   for(const id of refs.get(shot.id)??[]){
    const entries=usage.get(id)??[];
    entries.push(entry);usage.set(id,entries);
   }
  }
 }
 return Object.fromEntries(usage);
}

export function collectDramaAssetUsage(usage:DramaAssetUsage,ids:readonly string[]):DramaAssetUsageEntry[]{
 const entries=new Map<string,DramaAssetUsageEntry>();
 for(const id of ids)for(const item of usage[id]??[])entries.set(item.key,item);
 return [...entries.values()].sort((a,b)=>a.rank-b.rank);
}
