/** @typedef {{id:string,title:string,synopsis:string,ending:string,events:string[],sourceRefs:string[],targetDurationSec?:number,sequences?:{id:string,title:string,sourceRefs?:string[],eventRefs?:string[]}[]}} DramaEpisode */

/** @param {string} value @returns {{episodes:DramaEpisode[]}|null} */
export function readEpisodeDraft(value) {
 try {
  const draft=JSON.parse(value.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,"$1"));
  if(!Array.isArray(draft?.episodes)||!draft.episodes.every(episode=>episode&&
   typeof episode.id==="string"&&episode.id.trim()&&
   [episode.title,episode.synopsis,episode.ending].every(item=>typeof item==="string")&&
   [episode.sourceRefs,episode.events].every(items=>Array.isArray(items)&&items.every(item=>typeof item==="string"))&&
   (episode.targetDurationSec===undefined||Number.isFinite(episode.targetDurationSec)&&episode.targetDurationSec>0)&&
   (episode.sequences===undefined||Array.isArray(episode.sequences)&&episode.sequences.every(sequence=>
    sequence&&typeof sequence.id==="string"&&sequence.id.trim()&&typeof sequence.title==="string"&&
     [sequence.sourceRefs,sequence.eventRefs].every(refs=>refs===undefined||
      Array.isArray(refs)&&refs.every(ref=>typeof ref==="string"&&ref.length<=256)))&&
    new Set(episode.sequences.map(sequence=>sequence.id)).size===episode.sequences.length)))
   return null;
  if(new Set(draft.episodes.map(episode=>episode.id)).size!==draft.episodes.length)return null;
  return draft;
 }catch{return null;}
}

/** @typedef {{id:string,episodeId:string,order:number,description:string,characterVariantIds:string[],sceneId?:string,sceneVariantId?:string,propIds:string[],keyPropIds:string[],shotSize?:string,camera?:string,action?:string,dialogue?:string,sourceRefs?:string[],sequenceId?:string,durationSec?:number}} DramaShot */

/** @param {string} value @returns {{shots: DramaShot[]}|null} */
export function readStoryboardDraft(value) {
    const strings = (items) =>
        Array.isArray(items) && items.every(item => typeof item === "string");
    try {
        const draft = JSON.parse(value.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1"));
        if (!Array.isArray(draft?.shots) || !draft.shots.every((shot) => shot &&
            typeof shot.id === "string" && shot.id.trim() && typeof shot.episodeId === "string" &&
            shot.episodeId.trim() && Number.isSafeInteger(shot.order) && shot.order >= 0 &&
            typeof shot.description === "string" &&
            [shot.sceneId, shot.sceneVariantId, shot.shotSize, shot.camera, shot.action, shot.dialogue, shot.sequenceId]
                .every(field => field === undefined || typeof field === "string") &&
            (shot.durationSec === undefined || Number.isFinite(shot.durationSec) && shot.durationSec > 0) &&
            [shot.characterVariantIds, shot.propIds, shot.keyPropIds].every(strings) &&
            (shot.sourceRefs === undefined || strings(shot.sourceRefs)))) return null;
        if (new Set(draft.shots.map((shot) => shot.id)).size !== draft.shots.length) return null;
        return draft;
    } catch { return null; }
}

export const dramaNodeSpecs = /** @type {const} */ ({
 "drama:source":{title:"故事",height:340},
 "drama:assets":{title:"资产",height:400},
 "drama:episodes":{title:"剧集规划",height:400},
 "drama:storyboard":{title:"分镜配置",height:400},
});

export function isAssistantDramaNodeType(type){
 return Object.hasOwn(dramaNodeSpecs,type);
}

export function validAssistantDramaConnection(from,to){
 if(!isAssistantDramaNodeType(from)||!isAssistantDramaNodeType(to))return true;
 return from==="drama:source"&&(to==="drama:assets"||to==="drama:episodes")||
  (from==="drama:assets"||from==="drama:episodes")&&to==="drama:storyboard";
}

/** @typedef {{id:string,name:string,description:string}} DramaVariant */
/** @typedef {DramaVariant & {kind:"character"|"scene"|"prop",sourceRefs:string[],aliases?:string[],variants?:DramaVariant[]}} DramaAsset */
const strings=value=>Array.isArray(value)&&value.every(item=>typeof item==="string");
const entry=value=>value&&typeof value.id==="string"&&value.id.trim()&&
 typeof value.name==="string"&&typeof value.description==="string";

/** @param {string} value @returns {{assets:DramaAsset[]}|null} */
export function readAssetDraft(value){
 try{
  const draft=JSON.parse(value.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,"$1"));
  if(!Array.isArray(draft?.assets)||!draft.assets.every(asset=>entry(asset)&&
   ["character","scene","prop"].includes(asset.kind)&&strings(asset.sourceRefs)&&
   (asset.aliases===undefined||strings(asset.aliases)&&asset.aliases.length<=64)&&
   (asset.variants===undefined||Array.isArray(asset.variants)&&asset.variants.every(entry))))return null;
  const ids=draft.assets.flatMap(asset=>[asset.id,...(asset.variants??[]).map(variant=>variant.id)]);
  return new Set(ids).size===ids.length?draft:null;
 }catch{return null;}
}

/** @param {DramaAsset} asset */
export function canvasDramaAssetFields({id,kind,name,description,sourceRefs,variants,aliases}){
 return {id,kind,name,description,sourceRefs,...(aliases===undefined?{}:{aliases}),...(variants===undefined?{}:{
  variants:variants.map(({id,name,description})=>({id,name,description})),
 })};
}

/** @param {string} type @param {string} content */
export function canvasTextContentPatch(type,content) {
 if(type==="text")return {content};
 if(type==="drama:source")return {dramaDraft:content,content};
 if(type==="drama:assets"){
  const draft=readAssetDraft(content);
  return draft?{dramaDraft:JSON.stringify({assets:draft.assets.map(canvasDramaAssetFields)})}:null;
 }
 if(type==="drama:storyboard"){
  const draft=readStoryboardDraft(content);
  return draft?.shots.length?{dramaDraft:JSON.stringify(draft)}:null;
 }
 if(type!=="drama:episodes")return null;
 const draft=readEpisodeDraft(content);
 return draft?.episodes.length?{dramaDraft:JSON.stringify(draft)}:null;
}

/** @typedef {Partial<Pick<DramaAsset,"name"|"description"|"sourceRefs">>} DramaAssetChanges */
/** @typedef {Partial<Omit<DramaEpisode,"id">>} DramaEpisodeChanges */
/** @param {unknown} value @param {string} type @param {boolean} [variant] */
export function validDramaEntryChanges(value,type,variant=false){
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const scalar=type==="patch_drama_episode"?["title","synopsis","ending"]:["name","description"];
 const lists=type==="patch_drama_episode"?["events","sourceRefs"]:variant?[]:["sourceRefs"];
 const entries=Object.entries(value);
 return entries.length>0&&entries.every(([key,field])=>scalar.includes(key)?
  typeof field==="string"&&field.length<=12000:lists.includes(key)&&strings(field))&&
  JSON.stringify(value).length<=12000;
}

export function dramaEntryContentPatch(node,action){
 const isAsset=action.type==="patch_drama_asset";
 if(node.type!==(isAsset?"drama:assets":"drama:episodes")||
  !validDramaEntryChanges(action.changes,action.type,action.variantId!==undefined))return null;
 const body=dramaDraftBody(node.metadata);
 if(isAsset){
  const draft=readAssetDraft(body);
  const asset=draft?.assets.find(item=>item.id===action.assetId);
  const target=action.variantId===undefined?asset:asset?.variants?.find(item=>item.id===action.variantId);
  if(!target)return null;
  Object.assign(target,action.changes);
  return {dramaDraft:JSON.stringify(draft)};
 }
 const draft=readEpisodeDraft(body);
 const episode=draft?.episodes.find(item=>item.id===action.episodeId);
 if(!episode)return null;
 Object.assign(episode,action.changes);
 return {dramaDraft:JSON.stringify(draft)};
}

function dramaDraftBody(metadata){
 return [metadata?.dramaDraft,metadata?.dramaConfirmed,metadata?.content].find(value=>value?.trim())??"";
}

export function validStoryboardDraftReferences(node,content,nodes,connections){
 if(node.type!=="drama:storyboard")return true;
 const draft=readStoryboardDraft(content);
 if(!draft)return false;
 const previous=new Map(readStoryboardDraft(dramaDraftBody(node.metadata))?.shots.map(shot=>[shot.id,shot]));
 const upstreamIds=new Set(connections.filter(edge=>edge.toNodeId===node.id).map(edge=>edge.fromNodeId));
 const upstream=nodes.filter(item=>upstreamIds.has(item.id));
 const episodes=new Set(upstream.filter(item=>item.type==="drama:episodes")
  .flatMap(item=>readEpisodeDraft(dramaDraftBody(item.metadata))?.episodes.map(episode=>episode.id)??[]));
 const assets=upstream.filter(item=>item.type==="drama:assets")
  .flatMap(item=>readAssetDraft(dramaDraftBody(item.metadata))?.assets??[]);
 const characters=new Set(assets.filter(asset=>asset.kind==="character")
  .flatMap(asset=>[asset.id,...(asset.variants??[]).map(variant=>variant.id)]));
 const scenes=assets.filter(asset=>asset.kind==="scene");
 const props=new Set(assets.filter(asset=>asset.kind==="prop").map(asset=>asset.id));
 return draft.shots.every(shot=>{
  const before=previous.get(shot.id);
  const sceneChanged=before?.sceneId!==shot.sceneId||before?.sceneVariantId!==shot.sceneVariantId;
  return (before?.episodeId===shot.episodeId||episodes.has(shot.episodeId))&&
   shot.characterVariantIds.every(id=>before?.characterVariantIds.includes(id)||characters.has(id))&&
   (!sceneChanged||(
    (!shot.sceneId||scenes.some(asset=>asset.id===shot.sceneId))&&
    (!shot.sceneVariantId||scenes.some(asset=>(!shot.sceneId||asset.id===shot.sceneId)&&
     asset.variants?.some(variant=>variant.id===shot.sceneVariantId)))))&&
   shot.propIds.every(id=>before?.propIds.includes(id)||props.has(id))&&
   shot.keyPropIds.every(id=>shot.propIds.includes(id)&&(before?.keyPropIds.includes(id)||props.has(id))||
    before?.keyPropIds.includes(id)&&!before.propIds.includes(id)&&!shot.propIds.includes(id));
 });
}
/** @typedef {Partial<Pick<DramaShot,"description"|"shotSize"|"camera"|"action"|"dialogue">>} StoryboardShotChanges */

const storyboardShotFields=new Set(["description","shotSize","camera","action","dialogue"]);

/** @param {unknown} value @returns {value is StoryboardShotChanges} */
export function validStoryboardShotChanges(value){
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const entries=Object.entries(value);
 return entries.length>0&&entries.every(([key,text])=>
  storyboardShotFields.has(key)&&typeof text==="string"&&text.length<=12000);
}

/**
 * Apply one content edit to the latest stored draft. Identity and asset links
 * stay outside the editable fields for this operation.
 * @param {string} type
 * @param {{dramaDraft?:string,dramaConfirmed?:string,content?:string}|undefined} metadata
 * @param {string} shotId
 * @param {StoryboardShotChanges} changes
 */
export function storyboardShotContentPatch(type,metadata,shotId,changes){
 if(type!=="drama:storyboard"||!validStoryboardShotChanges(changes))return null;
 const content=[metadata?.dramaDraft,metadata?.dramaConfirmed,metadata?.content].find(value=>value?.trim())??"";
 const draft=readStoryboardDraft(content);
 if(!draft?.shots.some(shot=>shot.id===shotId))return null;
 return {dramaDraft:JSON.stringify({...draft,shots:draft.shots.map(shot=>
  shot.id===shotId?{...shot,...changes}:shot)})};
}
