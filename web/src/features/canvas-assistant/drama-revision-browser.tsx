import {useEffect,useRef,useState} from "react";
import type {WorkspacePendingRegistration} from "./drama-creative-workspace";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import type {DramaShot} from "./canvas-drama-pipeline";
import {commitAssistantCanvasGraphWithSaveBarrier} from "@/stores/canvas/use-canvas-sqlite-store";
import type {CanvasBackendProject} from "@/features/backend-sync/canvas-api";

type Choice={id:string;name:string;kind:string;variants:{id:string;name:string}[]};
type Scope={versionId:string|null;total:number;groups:{episodeId:string;total:number;sequenceIds:string[]}[];entries:DramaShot[];entryDigests:{id:string;digest:string}[];referenceChoices:Choice[]};
function ShotDraftEditor({shot,choices,onSave,onPendingChange,pendingKey}:{shot:DramaShot;choices:Choice[];onSave:(changes:Record<string,unknown>)=>Promise<void>;onPendingChange?:WorkspacePendingRegistration;pendingKey?:string}){
    const [description,setDescription]=useState(shot.description);
    const [action,setAction]=useState(shot.action??"");
    const [dialogue,setDialogue]=useState(shot.dialogue??"");
    const [extra,setExtra]=useState(shot);
    const [busy,setBusy]=useState(false);
    const [error,setError]=useState("");
    const updates={description,action,dialogue,shotSize:extra.shotSize??"",camera:extra.camera??"",
        durationSec:extra.durationSec??null,sceneId:extra.sceneId??null,sceneVariantId:extra.sceneVariantId??null,
        characterVariantIds:extra.characterVariantIds,propIds:extra.propIds,keyPropIds:extra.keyPropIds,sourceRefs:extra.sourceRefs??[]};
    const previous={description:shot.description,action:shot.action??"",dialogue:shot.dialogue??"",shotSize:shot.shotSize??"",
        camera:shot.camera??"",durationSec:shot.durationSec??null,sceneId:shot.sceneId??null,
        sceneVariantId:shot.sceneVariantId??null,characterVariantIds:shot.characterVariantIds,
        propIds:shot.propIds,keyPropIds:shot.keyPropIds,sourceRefs:shot.sourceRefs??[]};
    const changed=JSON.stringify(updates)!==JSON.stringify(previous);
    const serialized=JSON.stringify(updates);
    const onSaveRef=useRef(onSave);onSaveRef.current=onSave;
    useEffect(()=>{
        if(!pendingKey||!onPendingChange)return;
        onPendingChange(pendingKey,changed?()=>onSaveRef.current(JSON.parse(serialized) as Record<string,unknown>):null);
        return ()=>onPendingChange(pendingKey,null);
    },[pendingKey,onPendingChange,changed,serialized]);
    return <div className="grid gap-2 p-1">
        {([{label:"画面描述",value:description,set:setDescription},{label:"动作",value:action,set:setAction},
            {label:"对白",value:dialogue,set:setDialogue}]).map(field=><label key={field.label} className="grid gap-1">{field.label}
                <textarea className="min-w-0 rounded border bg-transparent p-2" rows={3} value={field.value}
                    disabled={busy} onChange={event=>field.set(event.target.value)}/></label>)}
        {([{key:"shotSize",label:"景别"},{key:"camera",label:"机位 / 运镜"}] as const).map(field=><label key={field.key} className="grid gap-1">{field.label}
            <input className="rounded border bg-transparent p-1" value={extra[field.key]??""} disabled={busy}
                onChange={event=>setExtra(current=>({...current,[field.key]:event.target.value}))}/></label>)}
        <label className="grid gap-1">时长（秒）
            <input className="rounded border bg-transparent p-1" type="number" min="0.1" step="0.1" disabled={busy}
                value={extra.durationSec??""} onChange={event=>{
                    const value=event.target.valueAsNumber;
                    if(!event.target.value||value>0)setExtra(current=>({...current,durationSec:value>0?value:undefined}));
                }}/></label>
        <label className="grid gap-1">场景
            <select className="min-w-0 rounded border bg-transparent p-1" value={extra.sceneId??""} disabled={busy}
                onChange={event=>setExtra(current=>({...current,sceneId:event.target.value||undefined,sceneVariantId:undefined}))}>
                <option value="">未指定</option>
                {extra.sceneId&&!choices.some(item=>item.id===extra.sceneId)&&<option value={extra.sceneId}>待匹配 · {extra.sceneId}</option>}
                {choices.filter(item=>item.kind==="scene").map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
        <label className="grid gap-1">场景变体
            <select className="min-w-0 rounded border bg-transparent p-1" value={extra.sceneVariantId??""} disabled={busy}
                onChange={event=>setExtra(current=>({...current,sceneVariantId:event.target.value||undefined}))}>
                <option value="">默认</option>
                {choices.find(item=>item.id===extra.sceneId)?.variants.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
        {([{key:"characterVariantIds",label:"角色造型",options:choices.filter(item=>item.kind==="character").flatMap(item=>item.variants.map(variant=>({id:variant.id,name:item.name+" · "+variant.name})))},
            {key:"propIds",label:"可见道具",options:choices.filter(item=>item.kind==="prop")},
            {key:"keyPropIds",label:"关键道具",options:choices.filter(item=>item.kind==="prop"&&extra.propIds.includes(item.id))}] as const).map(field=>
                <label key={field.key} className="grid gap-1">{field.label}
                    <select multiple className="min-w-0 rounded border bg-transparent p-1" disabled={busy} value={extra[field.key]}
                        onChange={event=>{
                            const ids=Array.from(event.target.selectedOptions,option=>option.value);
                            setExtra(current=>({...current,[field.key]:ids,...(field.key==="propIds"?{keyPropIds:current.keyPropIds.filter(id=>ids.includes(id))}:{})}));
                        }}>
                        {extra[field.key].filter(id=>!field.options.some(item=>item.id===id)).map(id=><option key={id} value={id}>待匹配 · {id}</option>)}
                        {field.options.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                </label>)}
        <label className="grid gap-1">原文段落 ID（每行一个）
            <textarea className="rounded border bg-transparent p-1" rows={2} value={(extra.sourceRefs??[]).join("\n")} disabled={busy}
                onChange={event=>setExtra(current=>({...current,sourceRefs:event.target.value.split("\n").map(item=>item.trim()).filter(Boolean)}))}/>
        </label>
        <button disabled={busy} onClick={async()=>{
            setBusy(true);setError("");
            try{await onSave(updates);}catch(error){setError(error instanceof Error?error.message:"保存失败");}
            finally{setBusy(false);}
        }}>{busy?"保存中…":"保存镜头草案"}</button>
        {error&&<p role="alert">{error}</p>}
    </div>;
}
export function DramaRevisionBrowser({projectId,nodeId,initialEpisodeId,initialSequenceId,initialShotId,onPendingChange}:{projectId:string;nodeId:string;initialEpisodeId?:string;initialSequenceId?:string;initialShotId?:string;onPendingChange?:WorkspacePendingRegistration}){
    const [groups,setGroups]=useState<Scope["groups"]>([]);
    const [revisionId,setRevisionId]=useState<string|null>(null);
    const [episodeId,setEpisode]=useState(initialEpisodeId??"");
    const [sequenceId,setSequence]=useState(initialSequenceId??"");
    const [pinnedShot,setPinnedShot]=useState(initialShotId??"");
    const [offset,setOffset]=useState(0);
    const [page,setPage]=useState<Scope>();
    const [error,setError]=useState("");
    const [loading,setLoading]=useState(true);
    const [editing,setEditing]=useState(false);
    const [refresh,setRefresh]=useState(0);
    const path=`/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/revision-scope?nodeId=${encodeURIComponent(nodeId)}&draft=${editing}`;
    useEffect(()=>{
        let active=true;
        canvasApi<Scope>(path+"&summaryOnly=true","GET").then(result=>{
            if(!active)return;
            setGroups(result.groups);setRevisionId(result.versionId);setEpisode(result.groups.some(g=>g.episodeId===initialEpisodeId)?initialEpisodeId!:result.groups[0]?.episodeId??"");setLoading(false);
        }).catch(()=>{if(active){setError("无法读取已确认分镜索引");setLoading(false);}});
        return ()=>{active=false;};
    },[path,initialEpisodeId]);
    useEffect(()=>{
        if(!episodeId)return;
        let active=true;setLoading(true);setPage(undefined);
        const version=revisionId?`&versionId=${encodeURIComponent(revisionId)}`:"";
        canvasApi<Scope>(`${path}${version}&episodeId=${encodeURIComponent(episodeId)}&sequenceId=${encodeURIComponent(sequenceId)}&offset=${offset}&limit=${pinnedShot?1:10}`+(pinnedShot?`&entryId=${encodeURIComponent(pinnedShot)}`:""),"GET")
            .then(result=>{if(active){setPage(result);setError("");}})
            .catch(()=>{if(active)setError("无法读取当前镜头页");})
            .finally(()=>{if(active)setLoading(false);});
        return ()=>{active=false;};
    },[path,episodeId,sequenceId,offset,revisionId,refresh,pinnedShot]);
    return <div className="grid min-w-0 gap-2 text-sm">
        {pinnedShot&&<button type="button" className="underline text-left" onClick={()=>{setPinnedShot("");setOffset(0);}}>显示当前剧集完整镜头列表</button>}
        <label><input type="checkbox" checked={editing} onChange={event=>{setEditing(event.target.checked);setPage(undefined);}}/> 编辑当前镜头草案</label>
        <label className="grid gap-1">浏览已确认剧集
            <select className="min-w-0 rounded border bg-transparent p-1" value={episodeId} onChange={event=>{
                setEpisode(event.target.value);setSequence("");setOffset(0);setPinnedShot("");
            }}>{groups.map(group=><option key={group.episodeId} value={group.episodeId}>{group.episodeId} · {group.total} 镜头</option>)}</select>
        </label>
        {!!episodeId&&<select aria-label="浏览场次" className="min-w-0 rounded border bg-transparent p-1" value={sequenceId}
            onChange={event=>{setSequence(event.target.value);setOffset(0);setPinnedShot("");}}>
            <option value="">全部场次</option>
            {groups.find(item=>item.episodeId===episodeId)?.sequenceIds.map(id=><option key={id} value={id}>{id}</option>)}
        </select>}
        {loading&&<p role="status">正在读取…</p>}
        {error&&<p role="alert">{error}</p>}
        {!loading&&!groups.length&&!error&&<p>尚无已确认镜头，可打开编辑器规划分镜。</p>}
        {page?.entries.map(shot=><details key={shot.id}>
            <summary>镜头 {shot.order} · {shot.shotSize??shot.id}</summary>
            <p className="whitespace-pre-wrap break-words">{shot.description}</p>
            {shot.action&&<p>{shot.action}</p>}{shot.dialogue&&<p>{shot.dialogue}</p>}
            {editing&&<ShotDraftEditor key={page.entryDigests.find(item=>item.id===shot.id)?.digest} shot={shot} choices={page.referenceChoices} onPendingChange={onPendingChange} pendingKey={`${nodeId}:shot:${shot.id}`} onSave={async changes=>{
                const expectedDigest=page.entryDigests.find(item=>item.id===shot.id)?.digest;
                await commitAssistantCanvasGraphWithSaveBarrier(projectId,()=>canvasApi<CanvasBackendProject>(
                    `/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/shot-draft`,"PATCH",
                    {nodeId,shotId:shot.id,operationId:crypto.randomUUID(),expectedDigest,changes}),
                    {textVersionNodeId:nodeId,keepCreativePointers:true});
                setRefresh(current=>current+1);
            }}/>}
        </details>)}
        {!!page&&page.total>10&&<div className="flex items-center justify-between gap-2">
            <button disabled={!offset||loading} onClick={()=>setOffset(current=>Math.max(0,current-10))}>上一页</button>
            <span>{offset+1}–{Math.min(offset+10,page.total)} / {page.total}</span>
            <button disabled={offset+10>=page.total||loading} onClick={()=>setOffset(current=>current+10)}>下一页</button>
        </div>}
    </div>;
}
