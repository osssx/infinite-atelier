import { useContext, useRef, useState } from "react";
import {AssetReviewBusyContext,useAssetReview,type AssetReviewState} from "./drama-asset-directory-state";
import { Button } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { DramaAsset, DramaAssetKind } from "./canvas-drama-pipeline";
import { dramaNodeControl, dramaNodePrimary } from "./drama-node-style";

import {suggestAssetMatches,type AssetDecision} from "./drama-asset-merge";

const kindLabel:Record<DramaAssetKind,string>={character:"角色",scene:"场景",prop:"道具"};
const selectClass="min-h-8 w-full min-w-0 rounded-lg border px-2.5 py-1.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] disabled:opacity-50";

export function DramaAssetCandidates({assets,candidates,onApply,onDiscard,disabled,candidateId="",expanded=false}:{
    assets:DramaAsset[];candidates:DramaAsset[];
    onApply:(decisions:Record<string,AssetDecision>)=>void|Promise<void>;
    onDiscard:()=>void;disabled:boolean;candidateId?:string;expanded?:boolean;
}){
    const [review,updateReview]=useAssetReview(candidateId);
    const {decisions,kind,query,status}=review;
    const setDecisions=(update:(current:Record<string,AssetDecision>)=>Record<string,AssetDecision>)=>updateReview(current=>({...current,decisions:update(current.decisions)}));
    const [submitting,setSubmitting]=useState(false);
    const [submitError,setSubmitError]=useState("");
    const inFlight=useRef(false);
    const setReviewBusy=useContext(AssetReviewBusyContext);
    const appearance=useThemeStore(state=>state.theme);
    const theme=canvasThemes[appearance];
    const control=dramaNodeControl(theme);
    const selectStyle={...control,outlineColor:theme.node.activeStroke,colorScheme:appearance};
    const primary=dramaNodePrimary(theme);
    const visible=candidates.filter(candidate=>{
        const decision=decisions[candidate.id];
        return (kind==="all"||candidate.kind===kind)&&
            [candidate.name,...(candidate.aliases??[]),candidate.description].some(text=>text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))&&
            (status==="all"||(status==="pending"&&!decision)||(status==="selected"&&decision&&decision.action!=="skip")||(status==="skipped"&&decision?.action==="skip"));
    });
    const reviewed=candidates.filter(candidate=>Boolean(decisions[candidate.id])).length;
    const selected=candidates.filter(candidate=>decisions[candidate.id]&&decisions[candidate.id].action!=="skip").length;
    const invalid=candidates.filter(candidate=>{
        const decision=decisions[candidate.id];
        return decision&&(decision.action==="reuse"||decision.action==="variant")&&
            (!assets.some(a=>a.id===decision.targetId&&a.kind===candidate.kind)||(decision.action==="variant"&&candidate.kind==="prop"));
    }).length;
    const locked=disabled||submitting;
    const bulk=(action:"new"|"skip")=>{
        if(locked||!visible.length)return;
        setDecisions(current=>({...current,...Object.fromEntries(visible.map(candidate=>[candidate.id,{action}]))}));
    };
    const clearVisible=()=>setDecisions(current=>{
        const next={...current};for(const candidate of visible)delete next[candidate.id];return next;
    });
    const submit=async()=>{
        // Disable double clicks synchronously, before React commits state.
        if(disabled||inFlight.current||invalid||(expanded&&!selected))return;
        inFlight.current=true;setReviewBusy?.(true);setSubmitting(true);setSubmitError("");
        try{await onApply(Object.fromEntries(candidates.flatMap(candidate=>decisions[candidate.id]?[[candidate.id,decisions[candidate.id]]]:[])));}
        catch(error){setSubmitError(error instanceof Error?error.message:"资产合入失败");}
        finally{inFlight.current=false;setReviewBusy?.(false);setSubmitting(false);}
    };
    return <details open className={expanded?"flex min-h-0 min-w-0 flex-1 flex-col gap-3 rounded-xl border p-3":"min-w-0 space-y-2 rounded-xl border p-3"}
        data-asset-candidate-review="" style={{...control,colorScheme:appearance}}>
        <summary className="cursor-pointer rounded-md text-xs font-semibold focus-visible:outline focus-visible:outline-2"
            style={{outlineColor:theme.node.activeStroke}}>审核资产候选 · {candidates.length} 项</summary>
        {expanded&&<div className="shrink-0 space-y-2" data-asset-review-toolbar="">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{color:theme.node.muted}}>
                <span>待审核 {candidates.length-reviewed}</span><span>待合入 {selected}</span><span>明确跳过 {reviewed-selected}</span>
                {invalid>0&&<span role="alert">有 {invalid} 项匹配目标无效</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <select aria-label="候选资产类别" className="min-h-9 rounded-lg border px-2 text-xs" style={selectStyle} value={kind} disabled={locked}
                    onChange={e=>{const kind=e.target.value as AssetReviewState["kind"];updateReview(current=>({...current,kind}));}}>
                    <option value="all">全部类别 ({candidates.length})</option>
                    {(Object.keys(kindLabel) as DramaAssetKind[]).map(k=><option key={k} value={k}>{kindLabel[k]} ({candidates.filter(c=>c.kind===k).length})</option>)}
                </select>
                <select aria-label="候选审核状态" className="min-h-9 rounded-lg border px-2 text-xs" style={selectStyle} value={status} disabled={locked}
                    onChange={e=>{const status=e.target.value as AssetReviewState["status"];updateReview(current=>({...current,status}));}}>
                    <option value="all">全部状态</option><option value="pending">待审核</option><option value="selected">待合入</option><option value="skipped">已跳过</option>
                </select>
                <input aria-label="搜索资产候选" placeholder="搜索名称、别名或描述" className="min-h-9 min-w-0 flex-1 rounded-lg border px-3 text-xs" style={selectStyle}
                    value={query} disabled={locked} onChange={e=>{const query=e.target.value;updateReview(current=>({...current,query}));}}/>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b pb-2" style={{borderColor:theme.node.stroke}}>
                <span className="mr-auto text-xs" style={{color:theme.node.muted}}>当前筛选 {visible.length} 项</span>
                <Button size="small" style={control} disabled={locked||!visible.length} onClick={()=>bulk("new")}>筛选项全部新增</Button>
                <Button size="small" style={control} disabled={locked||!visible.length} onClick={()=>bulk("skip")}>筛选项全部跳过</Button>
                <Button size="small" style={control} disabled={locked||!visible.length} onClick={clearVisible}>重置筛选项</Button>
            </div>
        </div>}
        <div data-asset-candidate-scroll-region="" role="region" aria-label="待审核资产候选列表"
            tabIndex={0} data-canvas-no-zoom
            className={expanded?"thin-scrollbar grid min-h-0 min-w-0 flex-1 content-start gap-2 overflow-y-auto overscroll-contain pr-1":"thin-scrollbar grid min-h-0 min-w-0 gap-2 overflow-y-auto overscroll-contain pr-1"}
            style={{maxHeight:expanded?"min(62dvh, 620px)":"min(42vh, 352px)",scrollbarColor:`${theme.node.code.scrollbar} transparent`,outlineColor:theme.node.activeStroke}}
            onWheel={event=>event.stopPropagation()}
            onPointerDown={event=>event.stopPropagation()}>
        {(expanded?visible:candidates).map(candidate=>{
            const matches=suggestAssetMatches(candidate,assets);
            const decision=decisions[candidate.id]??{action:"skip"};
            const compatible=assets.filter(asset=>asset.kind===candidate.kind);
            return <section key={candidate.id} className="grid min-w-0 gap-2 rounded-lg border p-2.5"
                style={{background:theme.node.code.surface,borderColor:theme.node.stroke}}>
                <div className="flex min-w-0 items-start justify-between gap-2">
                    <strong className="min-w-0 break-words text-xs font-semibold">{candidate.name}</strong>
                    <span className="shrink-0 text-[11px]" style={{color:theme.node.muted}}>{kindLabel[candidate.kind]}{expanded?` · ${!decisions[candidate.id]?"待审核":decision.action==="skip"?"已跳过":"待合入"}`:""}</span>
                </div>
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">{candidate.description}</p>
                {matches.length>0&&<p className="break-words text-xs" style={{color:theme.node.muted}}>可能匹配 {matches.map(asset=>asset.name).join("、")}</p>}
                <div className="flex min-w-0 flex-wrap items-end gap-2">
                <label className="grid w-full min-w-0 max-w-60 gap-1">
                    <span className="text-[11px]" style={{color:theme.node.muted}}>处理方式</span>
                <select className={selectClass} style={selectStyle} aria-label={`${candidate.name}处理方式`} value={expanded&&!decisions[candidate.id]?"pending":decision.action} disabled={locked}
                    onChange={event=>{const value=event.target.value;setDecisions(current=>{
                        if(value==="pending"){const next={...current};delete next[candidate.id];return next;}
                        const action=value as AssetDecision["action"];
                        return {...current,[candidate.id]:{action,targetId:action==="reuse"||action==="variant"?(expanded?(matches.length===1?matches[0].id:undefined):matches[0]?.id??compatible[0]?.id):undefined}};
                    });}}>
                    {expanded&&<option value="pending">待审核</option>}
                    <option value="skip">跳过</option><option value="new">新增资产</option>
                    <option value="reuse" disabled={!compatible.length}>复用已有资产</option>
                    {candidate.kind!=="prop"&&<option value="variant" disabled={!compatible.length}>添加为已有资产的变体</option>}
                </select>
                </label>
                {(decision.action==="reuse"||decision.action==="variant")&&
                    <label className="grid min-w-0 flex-1 basis-40 gap-1">
                        <span className="text-[11px]" style={{color:theme.node.muted}}>匹配目标</span>
                    <select className={selectClass} style={selectStyle} aria-label={`${candidate.name}匹配目标`} value={decision.targetId??""} disabled={disabled||submitting}
                        onChange={event=>setDecisions(current=>({...current,[candidate.id]:{...decision,targetId:event.target.value}}))}>
                        <option value="">选择资产</option>
                        {compatible.map(asset=><option key={asset.id} value={asset.id}>{asset.name||"未命名资产"}</option>)}
                    </select>
                    </label>}
                </div>
            </section>;
        })}
        {expanded&&!visible.length&&<p className="p-3 text-xs" style={{color:theme.node.muted}}>没有符合筛选条件的候选资产。</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t pt-2" style={{borderColor:theme.node.stroke}}>
            {expanded&&<span className="mr-auto text-xs" style={{color:theme.node.muted}}>未审核项按跳过处理；合入将结束本批审核。</span>}
            <Button size="small" style={primary} className="disabled:opacity-50" disabled={locked||!!invalid||(expanded&&!selected)} loading={submitting} onClick={()=>void submit()}>合入所选资产</Button>
            <Button size="small" style={control} className="disabled:opacity-50" disabled={disabled||submitting} onClick={onDiscard}>丢弃候选</Button>
        </div>
        {submitError&&<p role="alert" className="break-words rounded-md border p-2 text-xs" style={control}>{submitError}</p>}
    </details>;
}
