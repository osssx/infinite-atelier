import type { DramaAsset } from "./canvas-drama-pipeline";

export type AssetDecision = {action:"skip"|"new"|"reuse"|"variant"; targetId?:string};
const normalized=(name:string)=>name.trim().toLocaleLowerCase();

export function suggestAssetMatches(candidate:DramaAsset,assets:DramaAsset[]){
    const names=new Set([candidate.name,...candidate.aliases??[]].map(normalized));
    return assets.filter(asset=>asset.kind===candidate.kind&&
        (asset.id===candidate.id||[asset.name,...asset.aliases??[]].some(name=>names.has(normalized(name)))));
}

export function mergeAssetCandidates(assets:DramaAsset[],candidates:DramaAsset[],decisions:Record<string,AssetDecision>){
    const merged=assets.map(asset=>({...asset,variants:asset.variants?.map(variant=>({...variant}))}));
    for(const candidate of candidates){
        const decision=decisions[candidate.id];
        if(!decision||decision.action==="skip")continue;
        if(decision.action==="new"){
            merged.push({...candidate,id:`asset_${crypto.randomUUID()}`,
                variants:candidate.variants?.map(variant=>({...variant,id:`variant_${crypto.randomUUID()}`}))});
            continue;
        }
        const target=merged.find(asset=>asset.id===decision.targetId&&asset.kind===candidate.kind);
        if(!target)throw Error("请选择同类别的已有资产");
        target.sourceRefs=[...new Set([...target.sourceRefs,...candidate.sourceRefs])];
        if(decision.action==="variant"){
            if(target.kind==="prop")throw Error("道具请复用已有资产或新增");
            target.variants=[...(target.variants??[]),{id:`variant_${crypto.randomUUID()}`,
                name:candidate.name,description:candidate.description}];
        }
    }
    return merged;
}

