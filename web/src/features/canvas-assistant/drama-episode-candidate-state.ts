import {createContext,useContext,useEffect,useId,useRef} from "react";
import type {DramaEpisode} from "./drama-episode-fields";
import type {WorkspacePendingRegistration} from "./drama-creative-workspace";

export type EpisodeCandidateChanges=Partial<Omit<DramaEpisode,"id"|"eventItems"|"targetDurationSec">>&{targetDurationSec?:number|null};
export type DramaEpisodeCandidate={episodes?:DramaEpisode[];episodeCount?:number;revision?:number;
 manualChanges?:{originalEpisodeIds:string[];editedEpisodeIds:string[];removedEpisodeIds:string[];updatedAt:string}|null};
export type DramaRun={id:string;episodeId:string;status:string;error?:string;candidate?:DramaEpisodeCandidate&{
 shots?:{id:string;description:string}[];completedSequenceIds?:string[];adoptedShotIds?:string[];shotCount?:number}};
export const candidateRevision=(run:DramaRun)=>run.candidate?.revision??0;
export const hasEpisodeDetails=(run:DramaRun)=>Boolean(run.candidate?.episodes?.length);

// Detail cache is valid only for the same candidate version. Preserve the
// active edit's snapshot until the user confirms/cancels; server CAS fences it.
export function mergeCandidateRuns(current:DramaRun[],incoming:DramaRun[],protectedId?:string):DramaRun[]{
 const merged=incoming.filter(item=>item.status!=="discarded").map(item=>{
  const loaded=current.find(old=>old.id===item.id);
  if(loaded&&item.id===protectedId)return loaded;
  if(loaded&&(item.candidate?.episodes||item.candidate?.episodeCount!==undefined)){
   if(candidateRevision(loaded)>candidateRevision(item)||loaded.status==="adopted"&&item.status!=="adopted")return loaded;
   if(candidateRevision(loaded)===candidateRevision(item)&&hasEpisodeDetails(loaded)&&!hasEpisodeDetails(item))
    return {...item,candidate:{...item.candidate,episodes:loaded.candidate!.episodes}};
  }
  return loaded?.candidate?.shots?.length&&item.candidate?.shotCount===loaded.candidate.shots.length
    ?{...item,candidate:{...item.candidate,shots:loaded.candidate.shots}}:item;
 });
 const protectedRun=current.find(item=>item.id===protectedId);
 if(protectedRun&&!merged.some(item=>item.id===protectedId))merged.unshift(protectedRun);
 return merged;
}

export type EpisodeOptimizeScope={projectId:string;runId:string;episodeId:string;revision:number};
export type EpisodeOptimizeField="title"|"synopsis"|"events"|"ending"|"sequenceTitle";
export type CandidateFieldSession={activeKey:string|null;setActiveKey:(key:string|null)=>void;register?:WorkspacePendingRegistration;runId:string;optimization?:EpisodeOptimizeScope};
export const CandidateFieldContext=createContext<CandidateFieldSession|null>(null);
export function useCandidateFieldSession(editing:boolean,save:()=>Promise<void>){
 const session=useContext(CandidateFieldContext),key=useId();
 const saveRef=useRef(save);saveRef.current=save;
 const setActive=session?.setActiveKey,register=session?.register,runId=session?.runId;
 useEffect(()=>{
  if(!editing||!setActive||!runId)return;
  setActive(key);register?.("episode-candidate:"+runId+":"+key,()=>saveRef.current());
  return ()=>{register?.("episode-candidate:"+runId+":"+key,null);setActive(null);};
 },[editing,setActive,register,runId,key]);
 return {candidate:Boolean(session),otherEditing:Boolean(session?.activeKey&&session.activeKey!==key),optimization:session?.optimization};
}
