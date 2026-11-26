import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";

export const storyArtFields=[
 {key:"palette",label:"色彩方案"},
 {key:"lighting",label:"光影"},
 {key:"characterDesign",label:"角色设计规则"},
 {key:"anchors",label:"一致性锚点"},
] as const;
export function resolveStoryDraft(node:CanvasNodeData){
 const meta=node.metadata;
 return meta?.dramaDraft??meta?.content??meta?.dramaConfirmed??"";
}
/** A compact response carries only a bounded projection, not the editable body. */
export function resolveStorySummary(node:CanvasNodeData):CanvasNodeMetadata["dramaStorySummary"]|null{
 const meta=node.metadata;
 if(meta?.creativePayloadRef&&meta.dramaDraft===undefined&&meta.content===undefined&&meta.dramaConfirmed===undefined)
  return meta.dramaStorySummary??null;
 const source=resolveStoryDraft(node);
 const confirmed=meta?.dramaConfirmed;
 return {preview:source.slice(0,360),length:source.length,hasText:Boolean(source.trim()),
  confirmedTextMatches:Boolean(source.trim())&&source===confirmed,hadConfirmed:Boolean(confirmed?.trim()),
  hasStoredText:[meta?.dramaDraft,meta?.content,confirmed].some(value=>Boolean(value?.trim()))};
}
export function storyVersionConfirmed(node:CanvasNodeData){
 const meta=node.metadata;
 const visual=meta?.dramaConfirmedVisual;
 return Boolean(resolveStorySummary(node)?.confirmedTextMatches)&&(!visual||
  (visual.visualStyle===(meta?.dramaFilmStyle??"")&&storyArtFields.every(({key})=>
   (visual.artDirection?.[key]??"")===(meta?.dramaArtDirection?.[key]??""))));
}
export function storyDraftStatusLabel(node:CanvasNodeData){
 const summary=resolveStorySummary(node);
 return !summary?"待查看":summary.hadConfirmed?"草案已修改":"草案";
}
export type StoryDraftPatch=Partial<CanvasNodeMetadata>;

function equalValue(a:unknown,b:unknown):boolean{
 if(a===b)return true;
 if(!a||!b||typeof a!=="object"||typeof b!=="object")return false;
 const left=a as Record<string,unknown>,right=b as Record<string,unknown>;
 return Object.keys(left).length===Object.keys(right).length&&Object.keys(left).every(key=>
  Object.prototype.hasOwnProperty.call(right,key)&&equalValue(left[key],right[key]));
}
/** The attempted patch owns only its changed fields (including nested art keys).
 * Text and sync metadata are one atomic unit. A late external edit wins. */
export function storyDraftPatchMatches(before:CanvasNodeMetadata|undefined,current:CanvasNodeMetadata|undefined,patch:StoryDraftPatch){
 return (Object.keys(patch) as (keyof CanvasNodeMetadata)[]).every(key=>{
  if(key==="dramaArtDirection"&&patch.dramaArtDirection){
   return storyArtFields.every(({key:field})=>
    equalValue(before?.dramaArtDirection?.[field]??"",patch.dramaArtDirection?.[field]??"")||
    equalValue(current?.dramaArtDirection?.[field]??"",patch.dramaArtDirection?.[field]??""));
  }
  return equalValue(current?.[key],patch[key]);
 });
}
export function rollbackStoryDraftPatch(before:CanvasNodeMetadata|undefined,current:CanvasNodeMetadata|undefined,patch:StoryDraftPatch):StoryDraftPatch|null{
 if(!storyDraftPatchMatches(before,current,patch))return null;
 const revert=Object.fromEntries(Object.keys(patch).map(key=>[key,before?.[key as keyof CanvasNodeMetadata]])) as StoryDraftPatch;
 if(patch.dramaArtDirection&&current?.dramaArtDirection&&!equalValue(current.dramaArtDirection,patch.dramaArtDirection)){
  const art={...current.dramaArtDirection};
  for(const {key} of storyArtFields)if((before?.dramaArtDirection?.[key]??"")!==(patch.dramaArtDirection[key]??""))
   art[key]=before?.dramaArtDirection?.[key]??"";
  revert.dramaArtDirection=art;
 }
 return revert;
}
/** Callers commit only explicit edits; the promise resolves after project persistence. */
export type PersistStoryDraft=(patch:StoryDraftPatch)=>Promise<void>;
