import { useRef, useState } from "react";
import { Button } from "antd";
import type { DramaAsset } from "./canvas-drama-pipeline";

import {suggestAssetMatches,type AssetDecision} from "./drama-asset-merge";

export function DramaAssetCandidates({assets,candidates,onApply,onDiscard,disabled}:{
    assets:DramaAsset[];candidates:DramaAsset[];
    onApply:(decisions:Record<string,AssetDecision>)=>void|Promise<void>;
    onDiscard:()=>void;disabled:boolean;
}){
    const [decisions,setDecisions]=useState<Record<string,AssetDecision>>({});
    const [submitting,setSubmitting]=useState(false);
    const [submitError,setSubmitError]=useState("");
    const inFlight=useRef(false);
    const submit=async()=>{
        // Disable double clicks synchronously, before React commits state.
        if(disabled||inFlight.current)return;
        inFlight.current=true;setSubmitting(true);setSubmitError("");
        try{await onApply(decisions);}
        catch(error){setSubmitError(error instanceof Error?error.message:"资产合入失败");}
        finally{inFlight.current=false;setSubmitting(false);}
    };
    return <details open className="grid min-w-0 gap-2 rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">审核资产候选 · {candidates.length} 项</summary>
        <div data-asset-candidate-scroll-region="" role="region" aria-label="待审核资产候选列表"
            tabIndex={0} data-canvas-no-zoom
            className="thin-scrollbar min-h-0 min-w-0 overflow-y-auto overscroll-contain pr-1"
            style={{maxHeight:"min(42vh, 352px)"}}
            onWheel={event=>event.stopPropagation()}
            onPointerDown={event=>event.stopPropagation()}>
        {candidates.map(candidate=>{
            const matches=suggestAssetMatches(candidate,assets);
            const decision=decisions[candidate.id]??{action:"skip"};
            const compatible=assets.filter(asset=>asset.kind===candidate.kind);
            return <section key={candidate.id} className="grid min-w-0 gap-2 border-b py-3 last:border-b-0">
                <strong className="break-words">{candidate.name}</strong>
                <p className="whitespace-pre-wrap break-words text-sm">{candidate.description}</p>
                {matches.length>0&&<p className="text-xs">可能匹配 {matches.map(asset=>asset.name).join("、")}</p>}
                <select aria-label={`${candidate.name}处理方式`} value={decision.action} disabled={disabled||submitting}
                    onChange={event=>setDecisions(current=>({...current,[candidate.id]:{
                        action:event.target.value as AssetDecision["action"],
                        targetId:matches[0]?.id??compatible[0]?.id,
                    }}))}>
                    <option value="skip">跳过</option><option value="new">新增资产</option>
                    <option value="reuse">复用已有资产</option>
                    {candidate.kind!=="prop"&&<option value="variant">添加为已有资产的变体</option>}
                </select>
                {(decision.action==="reuse"||decision.action==="variant")&&
                    <select aria-label={`${candidate.name}匹配目标`} value={decision.targetId??""} disabled={disabled||submitting}
                        onChange={event=>setDecisions(current=>({...current,[candidate.id]:{...decision,targetId:event.target.value}}))}>
                        <option value="">选择资产</option>
                        {compatible.map(asset=><option key={asset.id} value={asset.id}>{asset.name} · {asset.id}</option>)}
                    </select>}
            </section>;
        })}
        </div>
        <div className="flex flex-wrap gap-2 border-t pt-2">
            <Button disabled={disabled||submitting} loading={submitting} onClick={()=>void submit()}>合入所选资产</Button>
            <Button disabled={disabled||submitting} onClick={onDiscard}>丢弃候选</Button>
        </div>
        {submitError&&<p role="alert" className="break-words text-xs">{submitError}</p>}
    </details>;
}
