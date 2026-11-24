import { useRef, useState } from "react";
import { Button } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { DramaAsset, DramaAssetKind } from "./canvas-drama-pipeline";
import { dramaNodeControl, dramaNodePrimary } from "./drama-node-style";

import {suggestAssetMatches,type AssetDecision} from "./drama-asset-merge";

const kindLabel:Record<DramaAssetKind,string>={character:"角色",scene:"场景",prop:"道具"};
const selectClass="min-h-8 w-full min-w-0 rounded-lg border px-2.5 py-1.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] disabled:opacity-50";

export function DramaAssetCandidates({assets,candidates,onApply,onDiscard,disabled}:{
    assets:DramaAsset[];candidates:DramaAsset[];
    onApply:(decisions:Record<string,AssetDecision>)=>void|Promise<void>;
    onDiscard:()=>void;disabled:boolean;
}){
    const [decisions,setDecisions]=useState<Record<string,AssetDecision>>({});
    const [submitting,setSubmitting]=useState(false);
    const [submitError,setSubmitError]=useState("");
    const inFlight=useRef(false);
    const appearance=useThemeStore(state=>state.theme);
    const theme=canvasThemes[appearance];
    const control=dramaNodeControl(theme);
    const selectStyle={...control,outlineColor:theme.node.activeStroke,colorScheme:appearance};
    const primary=dramaNodePrimary(theme);
    const submit=async()=>{
        // Disable double clicks synchronously, before React commits state.
        if(disabled||inFlight.current)return;
        inFlight.current=true;setSubmitting(true);setSubmitError("");
        try{await onApply(decisions);}
        catch(error){setSubmitError(error instanceof Error?error.message:"资产合入失败");}
        finally{inFlight.current=false;setSubmitting(false);}
    };
    return <details open className="min-w-0 space-y-2 rounded-xl border p-3"
        data-asset-candidate-review="" style={{...control,colorScheme:appearance}}>
        <summary className="cursor-pointer rounded-md text-xs font-semibold focus-visible:outline focus-visible:outline-2"
            style={{outlineColor:theme.node.activeStroke}}>审核资产候选 · {candidates.length} 项</summary>
        <div data-asset-candidate-scroll-region="" role="region" aria-label="待审核资产候选列表"
            tabIndex={0} data-canvas-no-zoom
            className="thin-scrollbar grid min-h-0 min-w-0 gap-2 overflow-y-auto overscroll-contain pr-1"
            style={{maxHeight:"min(42vh, 352px)",scrollbarColor:`${theme.node.code.scrollbar} transparent`,outlineColor:theme.node.activeStroke}}
            onWheel={event=>event.stopPropagation()}
            onPointerDown={event=>event.stopPropagation()}>
        {candidates.map(candidate=>{
            const matches=suggestAssetMatches(candidate,assets);
            const decision=decisions[candidate.id]??{action:"skip"};
            const compatible=assets.filter(asset=>asset.kind===candidate.kind);
            return <section key={candidate.id} className="grid min-w-0 gap-2 rounded-lg border p-2.5"
                style={{background:theme.node.code.surface,borderColor:theme.node.stroke}}>
                <div className="flex min-w-0 items-start justify-between gap-2">
                    <strong className="min-w-0 break-words text-xs font-semibold">{candidate.name}</strong>
                    <span className="shrink-0 text-[11px]" style={{color:theme.node.muted}}>{kindLabel[candidate.kind]}</span>
                </div>
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">{candidate.description}</p>
                {matches.length>0&&<p className="break-words text-xs" style={{color:theme.node.muted}}>可能匹配 {matches.map(asset=>asset.name).join("、")}</p>}
                <div className="flex min-w-0 flex-wrap items-end gap-2">
                <label className="grid w-full min-w-0 max-w-60 gap-1">
                    <span className="text-[11px]" style={{color:theme.node.muted}}>处理方式</span>
                <select className={selectClass} style={selectStyle} aria-label={`${candidate.name}处理方式`} value={decision.action} disabled={disabled||submitting}
                    onChange={event=>setDecisions(current=>({...current,[candidate.id]:{
                        action:event.target.value as AssetDecision["action"],
                        targetId:matches[0]?.id??compatible[0]?.id,
                    }}))}>
                    <option value="skip">跳过</option><option value="new">新增资产</option>
                    <option value="reuse">复用已有资产</option>
                    {candidate.kind!=="prop"&&<option value="variant">添加为已有资产的变体</option>}
                </select>
                </label>
                {(decision.action==="reuse"||decision.action==="variant")&&
                    <label className="grid min-w-0 flex-1 basis-40 gap-1">
                        <span className="text-[11px]" style={{color:theme.node.muted}}>匹配目标</span>
                    <select className={selectClass} style={selectStyle} aria-label={`${candidate.name}匹配目标`} value={decision.targetId??""} disabled={disabled||submitting}
                        onChange={event=>setDecisions(current=>({...current,[candidate.id]:{...decision,targetId:event.target.value}}))}>
                        <option value="">选择资产</option>
                        {compatible.map(asset=><option key={asset.id} value={asset.id}>{asset.name} · {asset.id}</option>)}
                    </select>
                    </label>}
                </div>
            </section>;
        })}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t pt-2" style={{borderColor:theme.node.stroke}}>
            <Button size="small" style={primary} className="disabled:opacity-50" disabled={disabled||submitting} loading={submitting} onClick={()=>void submit()}>合入所选资产</Button>
            <Button size="small" style={control} className="disabled:opacity-50" disabled={disabled||submitting} onClick={onDiscard}>丢弃候选</Button>
        </div>
        {submitError&&<p role="alert" className="break-words rounded-md border p-2 text-xs" style={control}>{submitError}</p>}
    </details>;
}
