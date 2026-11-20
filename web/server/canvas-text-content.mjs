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

/** @param {string} type @param {string} content */
export function canvasTextContentPatch(type,content) {
 if(type==="text")return {content};
 if(type!=="drama:episodes")return null;
 const draft=readEpisodeDraft(content);
 return draft?.episodes.length?{dramaDraft:JSON.stringify(draft)}:null;
}
