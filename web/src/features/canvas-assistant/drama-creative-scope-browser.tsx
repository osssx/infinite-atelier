import {useEffect,useRef,useState} from "react";
import type {WorkspacePendingRegistration} from "./drama-creative-workspace";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import type {CanvasBackendProject} from "@/features/backend-sync/canvas-api";
import {commitAssistantCanvasGraphWithSaveBarrier,ensureCreativeNodesLoaded} from "@/stores/canvas/use-canvas-sqlite-store";

type ScopedEntry={id:string;name?:string;kind?:string;description?:string;
    title?:string;synopsis?:string;ending?:string;variants?:{id:string;name:string;description?:string}[];
    sequences?:{id:string;title:string}[]};
type ScopedPage={versionId:string|null;total:number;offset:number;limit:number;
    entries:ScopedEntry[];entryDigests:{id:string;digest:string}[]};
const perPage=10;

type Field="name"|"description"|"title"|"synopsis"|"ending";
type PendingEdit={nodeId:string;kind:"assets"|"episodes";entryId:string;expectedDigest:string;
    changes:Partial<Record<Field,string>>;variantId?:string;sequenceId?:string};
const fieldsLabel:Record<Field,string>={name:"名称",description:"描述",title:"标题",synopsis:"剧情概要",ending:"结尾"};
function DraftEntryFields({value,fields,onSave,onStage,disabled=false,pendingKey,onPendingChange}:{value:Partial<Record<Field,string>>;
    fields:Field[];onSave:(changes:Partial<Record<Field,string>>)=>Promise<void>;
    onStage?:(changes:Partial<Record<Field,string>>)=>void;disabled?:boolean;
    pendingKey?:string;onPendingChange?:WorkspacePendingRegistration}){
    const [values,setValues]=useState<Partial<Record<Field,string>>>(value);
    const [busy,setBusy]=useState(false);
    const [error,setError]=useState("");
    const changes=Object.fromEntries(fields.filter(field=>values[field]!==value[field])
        .map(field=>[field,values[field]??""])) as Partial<Record<Field,string>>;
    const saveRef=useRef(onSave);saveRef.current=onSave;
    const pendingJson=JSON.stringify(changes);
    useEffect(()=>{
        if(!onPendingChange||!pendingKey)return;
        onPendingChange(pendingKey,Object.keys(changes).length?()=>saveRef.current(changes):null);
        return ()=>onPendingChange(pendingKey,null);
    // Changes are tracked by their stable serialized value, not a new callback per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    },[pendingKey,onPendingChange,pendingJson]);
    const cannotSubmit=disabled||busy||!Object.keys(changes).length||
        ("name" in changes&&!changes.name?.trim())||("title" in changes&&!changes.title?.trim());
    return <div className="grid min-w-0 gap-2 border-t p-2">
        {fields.map(field=><label key={field} className="grid min-w-0 gap-1">{fieldsLabel[field]}
            {field==="name"||field==="title"?
                <input className="min-w-0 rounded border bg-transparent p-1" maxLength={12000}
                    value={values[field]??""} disabled={busy}
                    onChange={event=>setValues(current=>({...current,[field]:event.target.value}))}/>:
                <textarea className="min-w-0 rounded border bg-transparent p-1" rows={3} maxLength={12000}
                    value={values[field]??""} disabled={busy}
                    onChange={event=>setValues(current=>({...current,[field]:event.target.value}))}/>}
        </label>)}
        <button type="button" disabled={cannotSubmit}
            onClick={async()=>{
                setBusy(true);setError("");
                try{await onSave(changes);}
                catch(error){setError(error instanceof Error?error.message:"局部草案保存失败");}
                finally{setBusy(false);}
            }}>{busy?"正在保存…":"保存当前条目草案"}</button>
        {onStage&&<button type="button" disabled={cannotSubmit} onClick={()=>{onStage(changes);setValues(value);}}>
            加入批量修改
        </button>}
        {error&&<p role="alert">{error}</p>}
    </div>;
}
/** P3: quiet by default. No payload is fetched for an offscreen or collapsed
 * creative card. Every request returns at most one page of the selected stage.
 */
export function DramaCreativeScopeBrowser({projectId,nodeId,kind,initialEntryId,onPendingChange}:{
    projectId:string;nodeId:string;kind:"assets"|"episodes";initialEntryId?:string;
    onPendingChange?:WorkspacePendingRegistration;
}){
    const [expanded,setExpanded]=useState(Boolean(initialEntryId));
    const [pinnedEntry,setPinnedEntry]=useState(initialEntryId??"");
    const [draft,setDraft]=useState(false);
    const [offset,setOffset]=useState(0);
    const [refresh,setRefresh]=useState(0);
    const [pending,setPending]=useState<PendingEdit[]>([]);
    const [batchBusy,setBatchBusy]=useState(false);
    const [batchError,setBatchError]=useState("");
    const [page,setPage]=useState<ScopedPage|null>(null);
    const [error,setError]=useState("");
    const [loading,setLoading]=useState(false);
    useEffect(()=>{
        if(!expanded)return;
        let current=true;
        setLoading(true);setError("");
        const url=`/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/revision-scope?`+
            `nodeId=${encodeURIComponent(nodeId)}&draft=${draft}&offset=${offset}&limit=${pinnedEntry?1:perPage}`+
            (pinnedEntry?`&entryId=${encodeURIComponent(pinnedEntry)}`:"");
        void canvasApi<ScopedPage>(url,"GET").then(result=>{
            if(current)setPage(result);
        }).catch(error=>{
            if(current){setPage(null);setError(error instanceof Error?error.message:"无法读取创作分页");}
        }).finally(()=>{if(current)setLoading(false);});
        return ()=>{current=false;};
    },[expanded,projectId,nodeId,draft,offset,refresh,pinnedEntry]);
    const label=kind==="assets"?"资产":"剧集";
    const save=async(entryId:string,expectedDigest:string,changes:Partial<Record<Field,string>>,
        target?:{variantId?:string;sequenceId?:string})=>{
        await commitAssistantCanvasGraphWithSaveBarrier(projectId,()=>canvasApi<CanvasBackendProject>(
            `/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/entry-draft`,"PATCH",
            {nodeId,kind,entryId,expectedDigest,operationId:crypto.randomUUID(),changes,...target}),
            {textVersionNodeId:nodeId,keepCreativePointers:true,invalidateCreativeNodeId:nodeId});
        await ensureCreativeNodesLoaded(projectId,[nodeId]);
        setPending(current=>current.filter(item=>item.entryId!==entryId));
        setRefresh(current=>current+1);
    };
    const stage=(entryId:string,expectedDigest:string,changes:Partial<Record<Field,string>>,
        target?:{variantId?:string;sequenceId?:string})=>{
        if(pending.some(item=>item.entryId===entryId)){
            setBatchError("同一条目已有暂存修改，请先清除或提交，避免覆盖同一条目。");
            return;
        }
        if(pending.length>=16){setBatchError("一次最多暂存 16 项修改。");return;}
        setPending(current=>[...current,{nodeId,kind,entryId,expectedDigest,changes,...target}]);
        setBatchError("");
    };
    const commitBatch=async()=>{
        if(!pending.length||batchBusy)return;
        setBatchBusy(true);setBatchError("");
        try{
            await commitAssistantCanvasGraphWithSaveBarrier(projectId,({expectedRevision})=>
                canvasApi<CanvasBackendProject>(
                    `/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/batch-draft`,"POST",
                    {operationId:crypto.randomUUID(),expectedRevision,edits:pending}),
                {keepCreativePointers:true,invalidateCreativeNodeIds:[nodeId]});

            setPending([]);setRefresh(value=>value+1);
        }catch(error){
            setBatchError(error instanceof Error?error.message:"批量修改未提交，所有暂存项均未落盘");
            throw error;
        }finally{setBatchBusy(false);}
    };
    const batchSaveRef=useRef(commitBatch);batchSaveRef.current=commitBatch;
    useEffect(()=>{
        if(!onPendingChange)return;
        const id=`${nodeId}:batch`;
        onPendingChange(id,pending.length?()=>batchSaveRef.current():null);
        return ()=>onPendingChange(id,null);
    },[nodeId,onPendingChange,pending.length]);
    return <section aria-label={label+"独立存储分页浏览"} className="grid min-w-0 gap-2 rounded-xl border p-2 text-xs">
        <button type="button" aria-expanded={expanded} className="text-left font-medium"
            onClick={()=>setExpanded(value=>!value)}>
            {expanded?"收起":"按需浏览"}{draft?"草案":"已确认"}{label}（每次 10 项）
        </button>
        {expanded&&<>
            {pinnedEntry&&<button type="button" className="underline" onClick={()=>{setPinnedEntry("");setOffset(0);}}>显示完整列表</button>}
            <label><input type="checkbox" checked={draft} onChange={event=>{
                setDraft(event.target.checked);setOffset(0);setPage(null);
            }}/> 浏览当前草案</label>
            {draft&&<div aria-label="批量范围草案修改" className="flex flex-wrap items-center gap-2">
                <span>已暂存 {pending.length} 项（全部通过后一次提交）</span>
                <button type="button" disabled={!pending.length||batchBusy} onClick={()=>void commitBatch().catch(()=>{/* Error shown beside pending batch. */})}>
                    {batchBusy?"正在批量提交…":"提交全部暂存修改"}
                </button>
                <button type="button" disabled={!pending.length||batchBusy} onClick={()=>{setPending([]);setBatchError("");}}>
                    清空暂存
                </button>
                {batchError&&<p role="alert">{batchError}</p>}
            </div>}
            {loading&&<p role="status">正在读取当前页…</p>}
            {error&&<p role="alert">{error}</p>}
            {page&&<>
                <p role="status">{label}共 {page.total} 项 · {page.versionId?"已确认版本 "+page.versionId:
                    draft?"当前草案":"无已确认版本"}</p>
                {page.entries.map(entry=><details key={entry.id} className="min-w-0 rounded border p-1">
                    <summary className="break-words font-medium">
                        {entry.title??entry.name??entry.id}{entry.kind?" · "+entry.kind:""}
                    </summary>
                    <p className="whitespace-pre-wrap break-words">{kind==="assets"?entry.description:entry.synopsis}</p>
                    {kind==="assets"&&!!entry.variants?.length&&<p>变体：{entry.variants.map(item=>item.name).join("、")}</p>}
                    {kind==="episodes"&&<>
                        <p>场次：{entry.sequences?.length??0}</p>
                        {entry.sequences?.map(item=><p key={item.id}>{item.title} · {item.id}</p>)}
                    </>}
                    {draft&&page.entryDigests.find(item=>item.id===entry.id)?.digest&&(()=>{
                        const digest=page.entryDigests.find(item=>item.id===entry.id)!.digest;
                        return <div className="grid gap-2">
                            <details aria-label="编辑当前资产或剧集条目" className="rounded border p-1">
                                <summary>编辑当前条目</summary>
                                <DraftEntryFields key={digest+"-entry"} value={entry} pendingKey={`${nodeId}:${entry.id}:entry`} onPendingChange={onPendingChange} fields={kind==="assets"?
                                    ["name","description"]:["title","synopsis","ending"]}
                                    onSave={changes=>save(entry.id,digest,changes)} disabled={batchBusy}
                                    onStage={changes=>stage(entry.id,digest,changes)}/>
                            </details>
                            {kind==="assets"&&entry.variants?.map(variant=><details
                                key={variant.id} className="rounded border p-1">
                                <summary>编辑变体：{variant.name}</summary>
                                <DraftEntryFields key={digest+"-"+variant.id} value={variant} pendingKey={`${nodeId}:${entry.id}:variant:${variant.id}`} onPendingChange={onPendingChange}
                                    fields={["name","description"]}
                                    onSave={changes=>save(entry.id,digest,changes,{variantId:variant.id})}
                                    disabled={batchBusy}
                                    onStage={changes=>stage(entry.id,digest,changes,{variantId:variant.id})}/>
                            </details>)}
                            {kind==="episodes"&&entry.sequences?.map(sequence=><details
                                key={sequence.id} className="rounded border p-1">
                                <summary>编辑场次标题：{sequence.title}</summary>
                                <DraftEntryFields key={digest+"-"+sequence.id} value={sequence} pendingKey={`${nodeId}:${entry.id}:sequence:${sequence.id}`} onPendingChange={onPendingChange} fields={["title"]}
                                    onSave={changes=>save(entry.id,digest,changes,{sequenceId:sequence.id})}
                                    disabled={batchBusy}
                                    onStage={changes=>stage(entry.id,digest,changes,{sequenceId:sequence.id})}/>
                            </details>)}
                        </div>;
                    })()}
                </details>)}
                {page.total>perPage&&<div className="flex justify-between gap-2">
                    <button type="button" disabled={loading||offset===0}
                        onClick={()=>setOffset(value=>Math.max(0,value-perPage))}>上一页</button>
                    <span>{page.total?offset+1:0}–{Math.min(offset+perPage,page.total)} / {page.total}</span>
                    <button type="button" disabled={loading||offset+perPage>=page.total}
                        onClick={()=>setOffset(value=>value+perPage)}>下一页</button>
                </div>}
            </>}
        </>}
    </section>;
}
