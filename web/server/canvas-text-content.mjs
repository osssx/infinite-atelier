/** @typedef {{id:string,title:string,synopsis:string,ending:string,events:string[],sourceRefs:string[]}} DramaEpisode */

/** @param {string} value @returns {{episodes:DramaEpisode[]}|null} */
export function readEpisodeDraft(value) {
 try {
  const draft=JSON.parse(value.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,"$1"));
  if(!Array.isArray(draft?.episodes)||!draft.episodes.every(episode=>episode&&
   typeof episode.id==="string"&&episode.id.trim()&&
   [episode.title,episode.synopsis,episode.ending].every(item=>typeof item==="string")&&
   [episode.sourceRefs,episode.events].every(items=>Array.isArray(items)&&items.every(item=>typeof item==="string"))))
   return null;
  if(new Set(draft.episodes.map(episode=>episode.id)).size!==draft.episodes.length)return null;
  return draft;
 }catch{return null;}
}

/** @typedef {{id:string,episodeId:string,order:number,description:string,characterVariantIds:string[],sceneId?:string,sceneVariantId?:string,propIds:string[],keyPropIds:string[],shotSize?:string,camera?:string,action?:string,dialogue?:string,sourceRefs?:string[]}} DramaShot */

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
            [shot.sceneId, shot.sceneVariantId, shot.shotSize, shot.camera, shot.action, shot.dialogue]
                .every(field => field === undefined || typeof field === "string") &&
            [shot.characterVariantIds, shot.propIds, shot.keyPropIds].every(strings) &&
            (shot.sourceRefs === undefined || strings(shot.sourceRefs)))) return null;
        if (new Set(draft.shots.map((shot) => shot.id)).size !== draft.shots.length) return null;
        return draft;
    } catch { return null; }
}

/** @param {string} type @param {string} content */
export function canvasTextContentPatch(type,content) {
 if(type==="text")return {content};
 if(type==="drama:storyboard"){
  const draft=readStoryboardDraft(content);
  return draft?.shots.length?{dramaDraft:JSON.stringify(draft)}:null;
 }
 if(type!=="drama:episodes")return null;
 const draft=readEpisodeDraft(content);
 return draft?.episodes.length?{dramaDraft:JSON.stringify(draft)}:null;
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
