import {createContext,useContext,useState,type Dispatch,type SetStateAction} from "react";
import type {DramaAsset,DramaAssetKind} from "./canvas-drama-pipeline";
import type {AssetDecision} from "./drama-asset-merge";

export type AssetDirectorySelection={kind:DramaAssetKind;activeId:string;query:string;page:number;view?:"list"|"cards"};
export const initialAssetDirectory:AssetDirectorySelection={kind:"character",activeId:"",query:"",page:0};
export function selectAssetDirectory(assets:readonly DramaAsset[],assetId?:string):AssetDirectorySelection{
 const active=assets.find(a=>a.id===assetId)??assets[0];
 if(!active)return initialAssetDirectory;
 const index=assets.filter(a=>a.kind===active.kind).findIndex(a=>a.id===active.id);
 return {kind:active.kind,activeId:active.id,query:"",page:Math.floor(index/10)};
}

export type AssetAdoptionMapping={assetIds:Record<string,string>;variantIds:Record<string,string>};
export type AssetReviewState={candidateId:string;decisions:Record<string,AssetDecision>;kind:"all"|DramaAssetKind;query:string;status:"all"|"pending"|"selected"|"skipped"};
export const emptyAssetReview=(candidateId:string):AssetReviewState=>({candidateId,decisions:{},kind:"all",query:"",status:"all"});
export const AssetReviewContext=createContext<[AssetReviewState,Dispatch<SetStateAction<AssetReviewState>>]|null>(null);
export const AssetReviewNavigationContext=createContext<(()=>void)|null>(null);
export const AssetCandidateNavigationContext=createContext<(()=>void)|null>(null);
export const AssetReviewBusyContext=createContext<((busy:boolean)=>void)|null>(null);
export function useAssetReview(candidateId:string){
 const shared=useContext(AssetReviewContext);
 const local=useState(()=>emptyAssetReview(candidateId));
 const [stored,setStored]=shared??local;
 const state=stored.candidateId===candidateId?stored:emptyAssetReview(candidateId);
 const update=(change:(current:AssetReviewState)=>AssetReviewState)=>setStored(current=>change(current.candidateId===candidateId?current:emptyAssetReview(candidateId)));
 return [state,update] as const;
}
/** Select the actual canonical asset returned by the transaction, never a
 * temporary candidate ID or a guessed index. */
export function adoptedAssetSelection(assets:DramaAsset[],candidates:DramaAsset[],mapping:AssetAdoptionMapping):AssetDirectorySelection|undefined{
 for(const candidate of candidates){
  const id=mapping.assetIds[candidate.id];
  const asset=assets.find(item=>item.id===id);
  if(asset)return {kind:asset.kind,activeId:asset.id,query:"",page:Math.floor(assets.filter(item=>item.kind===asset.kind).findIndex(item=>item.id===asset.id)/10)};
 }
}

export const AssetDirectoryContext=createContext<[AssetDirectorySelection,Dispatch<SetStateAction<AssetDirectorySelection>>]|null>(null);

/** Workspace owns navigation, not the mounted tab. Local fallback keeps the
 * fields independently usable in tests and standalone callers. */
export function useAssetDirectory(){
 const shared=useContext(AssetDirectoryContext);
 const local=useState(initialAssetDirectory);
 return shared??local;
}
