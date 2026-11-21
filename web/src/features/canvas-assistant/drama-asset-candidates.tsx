import { useState } from "react";
import { Button } from "antd";
import type { DramaAsset } from "./canvas-drama-pipeline";

import {suggestAssetMatches,type AssetDecision} from "./drama-asset-merge";

export function DramaAssetCandidates({assets,candidates,onApply,onDiscard,disabled}:{
    assets:DramaAsset[];candidates:DramaAsset[];
    onApply:(decisions:Record<string,AssetDecision>)=>void;
    onDiscard:()=>void;disabled:boolean;
}){
    const [decisions,setDecisions]=useState<Record<string,AssetDecision>>({});
    return <details open className="grid gap-2 rounded-lg border p-3">
        <summary>审核资产候选 · {candidates.length} 项</summary>
        {candidates.map(candidate=>{
            const matches=suggestAssetMatches(candidate,assets);
            const decision=decisions[candidate.id]??{action:"skip"};
            const compatible=assets.filter(asset=>asset.kind===candidate.kind);
            return <section key={candidate.id} className="grid gap-2 border-b py-3">
                <strong>{candidate.name}</strong>
                <p className="whitespace-pre-wrap text-sm">{candidate.description}</p>
                {matches.length>0&&<p className="text-xs">可能匹配 {matches.map(asset=>asset.name).join("、")}</p>}
                <select aria-label={`${candidate.name}处理方式`} value={decision.action} disabled={disabled}
                    onChange={event=>setDecisions(current=>({...current,[candidate.id]:{
                        action:event.target.value as AssetDecision["action"],
                        targetId:matches[0]?.id??compatible[0]?.id,
                    }}))}>
                    <option value="skip">跳过</option><option value="new">新增资产</option>
                    <option value="reuse">复用已有资产</option>
                    {candidate.kind!=="prop"&&<option value="variant">添加为已有资产的变体</option>}
                </select>
                {(decision.action==="reuse"||decision.action==="variant")&&
                    <select aria-label={`${candidate.name}匹配目标`} value={decision.targetId??""} disabled={disabled}
                        onChange={event=>setDecisions(current=>({...current,[candidate.id]:{...decision,targetId:event.target.value}}))}>
                        <option value="">选择资产</option>
                        {compatible.map(asset=><option key={asset.id} value={asset.id}>{asset.name} · {asset.id}</option>)}
                    </select>}
            </section>;
        })}
        <div className="flex gap-2 pt-2">
            <Button disabled={disabled} onClick={()=>onApply(decisions)}>合入所选资产</Button>
            <Button disabled={disabled} onClick={onDiscard}>丢弃候选</Button>
        </div>
    </details>;
}
